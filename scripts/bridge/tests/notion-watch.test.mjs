import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ensureWatcher, stopWatcher, watch } from '../lib/notion-watch.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(action, message) {
  for (let count = 0; count < 120; count += 1) { if (await action()) return; await wait(10); }
  assert.fail(message);
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'department-watch-test-'));
  const config = { roles: { worker: { name: 'Astra Senior 1', provider: 'codex', model: 'test-model' } }, notion: { syncMode: 'entry-agent-connector' } };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const store = new Store(root);
  const job = await store.enqueue({ role: 'worker', title: 'Test task', prompt: 'Private input' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const cards = new Map();
  const counts = { create: 0, update: 0, fetch: 0, closed: 0 };
  const transport = {
    async findByTaskId(id) { return [...cards.values()].filter(card => card.properties['Local task ID'] === id); },
    async createCard(properties) {
      counts.create += 1;
      const card = { id: `page-${counts.create}`, properties: structuredClone(properties) }; cards.set(card.id, card); return card;
    },
    async updateCard(id, properties) { counts.update += 1; cards.get(id).properties = structuredClone(properties); return cards.get(id); },
    async fetchCard(id) { counts.fetch += 1; return structuredClone(cards.get(id)); },
    async close() { counts.closed += 1; },
  };
  return { root, config, store, job, transport, cards, counts };
}

test('auto-start requires both direct sync mode and local bridge authorization', async t => {
  const { root, config } = await setup(t);
  assert.equal((await ensureWatcher(root)).running, false);
  config.notion.syncMode = 'direct-mcp';
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const result = await ensureWatcher(root);
  assert.equal(result.started, false);
  assert.match(result.reason, /authorized/);
});

test('watcher notices changes, avoids its own map feedback, and stops without killing processes', async t => {
  const { root, store, job, transport, cards, counts } = await setup(t);
  const controller = new AbortController();
  const done = watch(root, { transportFactory: async () => transport, pollMs: 10, reconcileMs: 5000, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(() => cards.has('page-1'), 'initial task did not sync');
  await wait(60);
  const fetches = counts.fetch;
  await wait(80);
  assert.equal(counts.fetch, fetches, 'the watcher must absorb its own mapping writes');
  await store.update(job.id, { status: 'running' });
  await eventually(() => cards.get('page-1').properties.Status === 'Working', 'changed queue state did not sync');
  assert.equal(counts.create, 1);
  const stopped = await stopWatcher(root, { waitMs: 1000 });
  assert.equal(stopped.stopped, true);
  const result = await done;
  assert.equal(result.running, false);
  assert.equal(counts.closed, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'notion-watch-status.json'), 'utf8')).running, false);
});

test('one watcher lease excludes a second watcher and a stale stop nonce is ignored', async t => {
  const { root, transport, cards } = await setup(t);
  const controller = new AbortController();
  const done = watch(root, { transportFactory: async () => transport, pollMs: 10, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(() => cards.size === 1, 'watcher did not start');
  await writeFile(path.join(root, 'data', 'notion-watch-stop.json'), JSON.stringify({ nonce: 'previous-watcher-nonce' }));
  const duplicate = await watch(root, { transportFactory: async () => assert.fail('second watcher created a transport') });
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.running, true);
  await wait(60);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'notion-watch-status.json'), 'utf8')).running, true);
  controller.abort();
  await done;
});

test('periodic reconciliation repairs a remote card even when the queue is unchanged', async t => {
  const { root, transport, cards } = await setup(t);
  const controller = new AbortController();
  const done = watch(root, { transportFactory: async () => transport, pollMs: 10, reconcileMs: 60, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(() => cards.size === 1, 'initial task did not sync');
  await wait(20);
  cards.get('page-1').properties.Status = 'Done';
  await eventually(() => cards.get('page-1').properties.Status === 'Ready', 'periodic reconciliation did not repair drift');
  controller.abort(); await done;
});

test('transient errors are retried and raw transport details never enter watcher status', async t => {
  const { root, transport, cards } = await setup(t);
  const controller = new AbortController();
  let attempts = 0;
  const done = watch(root, { transportFactory: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Bearer SECRET_VALUE');
    return transport;
  }, pollMs: 10, retryMs: 40, reconcileMs: 5000, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(async () => {
    try { return Boolean(JSON.parse(await readFile(path.join(root, 'data', 'notion-watch-status.json'), 'utf8')).lastError); } catch { return false; }
  }, 'failed pass was not persisted');
  const failedStatus = await readFile(path.join(root, 'data', 'notion-watch-status.json'), 'utf8');
  assert.doesNotMatch(failedStatus, /SECRET_VALUE|Bearer/);
  await eventually(() => cards.size === 1, 'retry failed to recover');
  assert.equal(attempts, 2);
  controller.abort(); await done;
});

test('crashed watcher lease can be replaced and old stop requests cannot stop the replacement', async t => {
  const { root, transport, cards } = await setup(t);
  await mkdir(path.join(root, 'data'), { recursive: true });
  // An invalid PID is definitely not alive; no real process is signalled or killed.
  await writeFile(path.join(root, 'data', 'notion-watch.json'), JSON.stringify({ pid: -1, host: os.hostname(), nonce: 'dead-watcher' }));
  await writeFile(path.join(root, 'data', 'notion-watch-stop.json'), JSON.stringify({ nonce: 'dead-watcher' }));
  const controller = new AbortController();
  const done = watch(root, { transportFactory: async () => transport, pollMs: 10, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(() => cards.size === 1, 'stale lease was not recovered');
  const lease = JSON.parse(await readFile(path.join(root, 'data', 'notion-watch.json'), 'utf8'));
  assert.notEqual(lease.nonce, 'dead-watcher');
  assert.equal(lease.pid, process.pid);
  controller.abort(); await done;
});

test('ensureWatcher reuses a live watcher instead of starting an extra process', async t => {
  const { root, config, transport, cards } = await setup(t);
  config.notion.syncMode = 'direct-mcp';
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await mkdir(path.join(root, '.private'), { recursive: true });
  await writeFile(path.join(root, '.private', 'notion-oauth.enc'), 'test marker, not a credential');
  const controller = new AbortController();
  const done = watch(root, { transportFactory: async () => transport, pollMs: 10, signal: controller.signal });
  t.after(async () => { controller.abort(); await done; });
  await eventually(() => cards.size === 1, 'watcher did not start');
  const result = await ensureWatcher(root);
  assert.equal(result.started, false);
  assert.equal(result.running, true);
  assert.equal(result.pid, process.pid);
  controller.abort(); await done;
});
