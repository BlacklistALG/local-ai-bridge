import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { NotionSync, notionProperties } from '../lib/notion-sync.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (status, message = 'transport failure') => Object.assign(new Error(message), { status });

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'department-notion-test-'));
  const config = { roles: { senior: { name: 'Astra Senior 1', model: 'test-astra', provider: 'codex' } } };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const job = await store.enqueue({ role: 'senior', title: 'Build useful feature', prompt: 'PRIVATE PROMPT never publish' });
  return { root, config, store, job };
}

function memoryTransport() {
  const cards = new Map();
  const counts = { create: 0, update: 0, find: 0, fetch: 0 };
  return {
    cards, counts,
    async findByTaskId(id) { counts.find += 1; return [...cards.values()].filter(card => card.properties['Local task ID'] === id).map(card => structuredClone(card)); },
    async createCard(properties) {
      counts.create += 1;
      const card = { id: `page-${counts.create}`, properties: structuredClone(properties) };
      cards.set(card.id, card); return structuredClone(card);
    },
    async updateCard(id, properties) { counts.update += 1; cards.get(id).properties = structuredClone(properties); return structuredClone(cards.get(id)); },
    async fetchCard(id) { counts.fetch += 1; if (!cards.has(id)) throw error(404); return structuredClone(cards.get(id)); },
  };
}

test('repeated sync is idempotent and verifies status changes without publishing private payloads', async t => {
  const { root, store, job } = await setup(t);
  const transport = memoryTransport();
  const sync = new NotionSync(root, { transport });
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(transport.counts.create, 1);
  assert.equal(transport.counts.update, 0);
  assert.equal(transport.cards.get('page-1').properties.Status, 'Ready');
  await store.update(job.id, { status: 'running' });
  await sync.syncOnce();
  assert.equal(transport.cards.get('page-1').properties.Status, 'Working');
  await store.update(job.id, { status: 'review', result: 'PRIVATE RESULT', error: 'SECRET DIAGNOSTIC sk-1234567890' });
  const reviewed = await sync.syncOnce();
  assert.equal(reviewed.ok, true);
  assert.equal(transport.cards.get('page-1').properties.Status, 'Review');
  assert.equal(transport.counts.update, 2);
  assert.doesNotMatch(JSON.stringify([...transport.cards.values()]), /PRIVATE|SECRET|1234567890/);
  assert.equal(reviewed.pendingCount, 0);
  assert.ok(reviewed.lastSuccess);
  assert.deepEqual(await sync.getStatus(), reviewed);
  assert.equal((await sync.exportCards())[0].pageId, 'page-1');
});

test('existing legacy mapping is reused and remote drift is repaired from local state', async t => {
  const { root, job, config } = await setup(t);
  const transport = memoryTransport();
  transport.cards.set('previous-page', { id: 'previous-page', properties: { ...notionProperties(job, config), Status: 'Done' } });
  await writeFile(path.join(root, 'notion-map.json'), JSON.stringify({ databaseId: 'board', jobs: { [job.id]: 'previous-page' } }));
  assert.equal((await new NotionSync(root, { transport }).syncOnce()).ok, true);
  assert.equal(transport.counts.create, 0);
  assert.equal(transport.counts.update, 1);
  assert.equal(transport.cards.get('previous-page').properties.Status, 'Ready');
  const mapping = JSON.parse(await readFile(path.join(root, 'notion-map.json'), 'utf8'));
  assert.equal(mapping.databaseId, 'board');
  assert.equal(mapping.jobs[job.id], 'previous-page');
});

test('lost create response reconciles by stable task ID without creating twice', async t => {
  const { root, job } = await setup(t);
  const transport = memoryTransport();
  const create = transport.createCard;
  transport.createCard = async properties => { await create(properties); throw error(503, 'Bearer TOP_SECRET'); };
  const sync = new NotionSync(root, { transport, retryBaseMs: 1 });
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(transport.counts.create, 1);
  const mapping = JSON.parse(await readFile(path.join(root, 'notion-map.json'), 'utf8'));
  assert.equal(mapping.jobs[job.id], 'page-1');
  assert.equal(mapping.sync[job.id].pendingCreate, undefined);
  assert.doesNotMatch(JSON.stringify(mapping), /TOP_SECRET|Bearer/);
});

test('uncertain creation remains pending until lookup can see it; it is never replayed', async t => {
  const { root, job } = await setup(t);
  const transport = memoryTransport();
  const create = transport.createCard;
  const find = transport.findByTaskId;
  let visible = false;
  transport.createCard = async properties => { await create(properties); throw error(503); };
  transport.findByTaskId = async id => visible ? find(id) : [];
  const sync = new NotionSync(root, { transport });
  const first = await sync.syncOnce();
  assert.equal(first.ok, false);
  assert.equal(first.pendingCount, 1);
  assert.equal(first.lastError.code, 'NOTION_CREATE_UNCERTAIN');
  assert.equal((await sync.syncOnce()).ok, false);
  assert.equal(transport.counts.create, 1);
  const mapping = JSON.parse(await readFile(path.join(root, 'notion-map.json'), 'utf8'));
  assert.equal(mapping.sync[job.id].pendingCreate.outcome, 'uncertain');
  visible = true;
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(transport.counts.create, 1);
});

test('authentication failure preserves local state and records safe actionable status', async t => {
  const { root } = await setup(t);
  const stateBefore = await readFile(path.join(root, 'data', 'state.json'), 'utf8');
  const transport = memoryTransport();
  transport.findByTaskId = async () => { throw error(401, 'Authorization: Bearer MY_PRIVATE_TOKEN'); };
  const result = await new NotionSync(root, { transport }).syncOnce();
  assert.equal(result.ok, false);
  assert.equal(result.lastError.code, 'NOTION_AUTH_REQUIRED');
  assert.equal(result.pendingCount, 1);
  assert.equal(result.lastSuccess, null);
  assert.equal(transport.counts.create, 0);
  assert.doesNotMatch(await readFile(path.join(root, 'data', 'notion-sync-status.json'), 'utf8'), /MY_PRIVATE_TOKEN|Bearer|Authorization/);
  assert.equal(await readFile(path.join(root, 'data', 'state.json'), 'utf8'), stateBefore);
});

test('definite create rejection clears intent so authorization repair can retry', async t => {
  const { root } = await setup(t);
  const transport = memoryTransport();
  const create = transport.createCard;
  transport.createCard = async () => { throw error(403); };
  const sync = new NotionSync(root, { transport });
  assert.equal((await sync.syncOnce()).lastError.code, 'NOTION_AUTH_REQUIRED');
  transport.createCard = create;
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(transport.counts.create, 1);
});

test('bounded backoff honors Retry-After and retries idempotent server failures', async t => {
  const { root } = await setup(t);
  const transport = memoryTransport();
  const find = transport.findByTaskId;
  const delays = [];
  let attempts = 0;
  transport.findByTaskId = async id => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(error(429), { retryAfter: '0.005' });
    if (attempts === 2) throw error(503);
    return find(id);
  };
  const sync = new NotionSync(root, { transport, retryBaseMs: 2, retryMaxMs: 20, sleep: async ms => delays.push(ms) });
  assert.equal((await sync.syncOnce()).ok, true);
  assert.deepEqual(delays, [5, 4]);
  transport.fetchCard = async () => { throw error(500); };
  const failed = await sync.syncOnce();
  assert.equal(failed.ok, false);
  assert.equal(failed.lastError.code, 'NOTION_UNAVAILABLE');
  assert.equal(delays.length, 5);
  assert.ok(failed.lastSuccess, 'previous successful sync timestamp is preserved');
});

test('a long rate-limit defers to the next pass instead of blocking indefinitely', async t => {
  const { root } = await setup(t);
  const transport = memoryTransport();
  transport.findByTaskId = async () => { throw Object.assign(error(429), { retryAfter: 120 }); };
  const delays = [];
  const result = await new NotionSync(root, { transport, sleep: async ms => delays.push(ms) }).syncOnce();
  assert.equal(result.lastError.code, 'NOTION_RATE_LIMITED');
  assert.deepEqual(delays, []);
});

test('parallel synchronizers serialize writes and create one card', async t => {
  const { root } = await setup(t);
  const transport = memoryTransport();
  const create = transport.createCard;
  transport.createCard = async properties => { await wait(50); return create(properties); };
  const results = await Promise.all(Array.from({ length: 4 }, () => new NotionSync(root, { transport }).syncOnce()));
  assert.ok(results.every(result => result.ok));
  assert.equal(transport.counts.create, 1);
  assert.equal(transport.counts.update, 0);
});

test('live process lock refuses another writer without altering the map or local jobs', async t => {
  const { root } = await setup(t);
  await mkdir(path.join(root, 'data'), { recursive: true });
  const lock = path.join(root, 'data', 'notion-sync.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await assert.rejects(new NotionSync(root, { transport: memoryTransport(), lockTimeoutMs: 0 }).syncOnce(), { code: 'NOTION_SYNC_BUSY' });
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
});

test('duplicate cards and incorrect mappings are visible errors; neither is overwritten', async t => {
  const { root, job, config } = await setup(t);
  const transport = memoryTransport();
  await transport.createCard(notionProperties(job, config));
  await transport.createCard(notionProperties(job, config));
  const sync = new NotionSync(root, { transport });
  assert.equal((await sync.syncOnce()).lastError.code, 'NOTION_DUPLICATE_CARDS');
  assert.equal(transport.counts.update, 0);
  transport.cards.get('page-1').properties['Local task ID'] = 'another-task';
  await writeFile(path.join(root, 'notion-map.json'), JSON.stringify({ jobs: { [job.id]: 'page-1' } }));
  assert.equal((await sync.syncOnce()).lastError.code, 'NOTION_ID_MISMATCH');
  assert.equal(transport.counts.update, 0);
});

test('a write without expected read-back is not reported as synchronized', async t => {
  const { root, store, job } = await setup(t);
  const transport = memoryTransport();
  const sync = new NotionSync(root, { transport });
  await sync.syncOnce();
  await store.update(job.id, { status: 'running' });
  transport.updateCard = async () => ({ id: 'page-1' });
  const result = await sync.syncOnce();
  assert.equal(result.ok, false);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.lastError.code, 'NOTION_VERIFY_FAILED');
});

test('state advancing during a network call is reported pending until the next pass', async t => {
  const { root, store, job } = await setup(t);
  const transport = memoryTransport();
  const create = transport.createCard;
  transport.createCard = async properties => {
    const card = await create(properties);
    await store.update(job.id, { status: 'running' });
    return card;
  };
  const sync = new NotionSync(root, { transport });
  const first = await sync.syncOnce();
  assert.equal(first.ok, false);
  assert.equal(first.pendingCount, 1);
  assert.equal(first.lastError, null);
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(transport.cards.get('page-1').properties.Status, 'Working');
});
