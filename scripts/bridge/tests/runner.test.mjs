import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { Runner } from '../lib/runner.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-department-test-'));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({
    maxParallel: 2, providerCaps: { codex: 1, claude: 1 },
    roles: { senior: { provider: 'codex', model: 'test-codex' }, peer: { provider: 'claude', model: 'test-claude' } },
    ...overrides,
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new Store(root) };
}

test('idempotency, conflicting keys, and immutable snapshots', async (t) => {
  const { root, store } = await setup(t);
  const request = { role: 'senior', title: 'One', prompt: 'Inspect task one', requestKey: 'one' };
  const jobs = await Promise.all(Array.from({ length: 6 }, () => new Store(root).enqueue(request)));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  assert.equal((await store.list()).length, 1);
  jobs[0].status = 'done';
  jobs[0].dependsOn.push('mutated');
  assert.equal((await store.get(jobs[0].id)).status, 'queued');
  assert.deepEqual((await store.get(jobs[0].id)).dependsOn, []);
  await assert.rejects(store.enqueue({ ...request, prompt: 'A different task' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(store.update(jobs[0].id, { workspace: 'C:/elsewhere' }), { code: 'IMMUTABLE_FIELD' });
  assert.equal(await store.get('__proto__'), null);
  await assert.rejects(store.update('__proto__', { status: 'queued' }), { code: 'UNKNOWN_JOB' });
});

test('dependencies wait for explicit acceptance, not just worker completion', async (t) => {
  const { root, store } = await setup(t);
  const first = await store.enqueue({ role: 'senior', prompt: 'Prepare interface' });
  const second = await store.enqueue({ role: 'peer', prompt: 'Use approved interface', dependsOn: [first.id] });
  const calls = [];
  const prompts = new Map();
  const runner = new Runner(root, { adapter: async (job) => { calls.push(job.id); prompts.set(job.id, job.prompt); return { text: 'Reviewed deliverable', modelVerified: true }; } });
  await runner.runBatch();
  assert.deepEqual(calls, [first.id]);
  assert.equal((await store.get(first.id)).status, 'review');
  assert.equal((await store.get(first.id)).modelVerified, true);
  assert.equal((await store.get(second.id)).status, 'queued');
  assert.equal(await readFile((await store.get(first.id)).resultPath, 'utf8'), 'Reviewed deliverable');
  assert.deepEqual(await runner.runBatch(), []);
  assert.equal(prompts.has(second.id), false, 'Unaccepted prerequisites must never reach a downstream worker');
  await store.update(first.id, { status: 'done' }, { expectedStatus: 'review' });
  await runner.runBatch();
  assert.deepEqual(calls, [first.id, second.id]);
  assert.equal((await store.get(second.id)).status, 'review');
  assert.match(prompts.get(second.id), /Inputs from accepted prerequisite tasks/);
  assert.match(prompts.get(second.id), /Reviewed deliverable/);
  assert.match(prompts.get(second.id), /Use approved interface/);
  assert.equal((await store.get(second.id)).prompt, 'Use approved interface', 'Execution context must not mutate the original request');
});

test('prerequisite context is bounded per result and across the whole handoff', async (t) => {
  const { root, store } = await setup(t);
  const dependencies = [];
  for (let i = 0; i < 4; i += 1) {
    const job = await store.enqueue({ role: 'senior', prompt: `Large prerequisite ${i}` });
    await store.update(job.id, { status: 'running' });
    await store.update(job.id, { status: 'review', result: 'x'.repeat(20_000) });
    await store.update(job.id, { status: 'done' });
    dependencies.push(job.id);
  }
  await store.enqueue({ role: 'peer', prompt: 'Use bounded context', dependsOn: dependencies });
  let received;
  await new Runner(root, { adapter: async (job) => { received = job.prompt; return { text: 'Result', modelVerified: false }; } }).runBatch();
  const prefix = received.indexOf('[\n');
  const suffix = received.lastIndexOf('\n\nCurrent task:');
  const context = JSON.parse(received.slice(prefix, suffix));
  assert.equal(context.length, 4);
  assert.equal(context.reduce((total, item) => total + item.result.length, 0), 48_000);
  assert.ok(context.every((item) => item.result.length <= 16_000 && item.truncated));
});

test('parallel workers honor provider caps and prevent a second runner', async (t) => {
  const { root, store } = await setup(t, { maxParallel: 4 });
  await store.enqueue({ role: 'senior', prompt: 'Codex task A' });
  await store.enqueue({ role: 'senior', prompt: 'Codex task B' });
  await store.enqueue({ role: 'peer', prompt: 'Claude task A' });
  await store.enqueue({ role: 'peer', prompt: 'Claude task B' });
  let active = 0;
  let peak = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const adapter = async (job) => {
    active += 1; peak = Math.max(peak, active); seen.push(job.provider);
    await barrier;
    active -= 1;
    return { text: 'Done' };
  };
  const batch = new Runner(root, { adapter }).runBatch({ maxParallel: 4 });
  for (let i = 0; i < 200 && active < 2; i += 1) await wait(10);
  try {
    assert.equal(active, 2);
    await assert.rejects(new Runner(root, { adapter }).runBatch(), { code: 'RUNNER_BUSY' });
  } finally { release(); }
  await batch;
  assert.equal(peak, 2);
  assert.deepEqual(seen.sort(), ['claude', 'codex']);
  assert.equal((await store.list()).filter((job) => job.status === 'queued').length, 2);
  await assert.rejects(new Runner(root, { adapter }).runBatch({ maxParallel: 5 }), RangeError);
});

test('worker failure stays failed and blocks its dependent without retries', async (t) => {
  const { root, store } = await setup(t);
  const first = await store.enqueue({ role: 'senior', prompt: 'Fail safely' });
  const second = await store.enqueue({ role: 'peer', prompt: 'Wait on first', dependsOn: [first.id] });
  let attempts = 0;
  const runner = new Runner(root, { adapter: async () => { attempts += 1; throw new Error('Provider unavailable'); } });
  await runner.runBatch();
  assert.equal((await store.get(first.id)).status, 'failed');
  await runner.runBatch();
  assert.equal((await store.get(second.id)).status, 'blocked');
  assert.equal(attempts, 1);
});

test('interrupted jobs pause only their provider until explicit reconciliation', async (t) => {
  const { root, store } = await setup(t);
  const job = await store.enqueue({ role: 'senior', prompt: 'Interrupted work' });
  await store.update(job.id, { status: 'running', runId: 'old-run' });
  const affected = await store.enqueue({ role: 'senior', prompt: 'Wait for the same provider' });
  const unaffected = await store.enqueue({ role: 'peer', prompt: 'Other provider can continue' });
  const attempts = [];
  const runner = new Runner(root, { adapter: async (input) => { attempts.push(input.id); return { text: 'Complete' }; } });
  await runner.runBatch();
  assert.deepEqual(attempts, [unaffected.id]);
  const interrupted = await store.get(job.id);
  assert.equal(interrupted.status, 'blocked');
  assert.equal(interrupted.needsReconciliation, true);
  assert.match(interrupted.error, /interrupted/);
  assert.equal((await store.get(affected.id)).status, 'queued');
  await assert.rejects(store.update(job.id, { needsReconciliation: false }), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(store.update(job.id, { status: 'queued' }), { code: 'RECONCILIATION_REQUIRED' });
  assert.deepEqual(await runner.runBatch(), []);
  const reconciled = await store.reconcileProvider('codex');
  assert.equal(reconciled[0].status, 'blocked');
  assert.equal(reconciled[0].needsReconciliation, false);
  await runner.runBatch();
  assert.deepEqual(attempts, [unaffected.id, affected.id]);
  assert.equal((await store.get(job.id)).status, 'blocked', 'Reconciliation must not silently retry interrupted work');
});

test('uncertain termination persists a provider pause even after cancellation', async (t) => {
  const { root, store } = await setup(t);
  const first = await store.enqueue({ role: 'senior', prompt: 'A worker whose shutdown cannot be confirmed' });
  const waiting = await store.enqueue({ role: 'senior', prompt: 'Do not overlap previous provider work' });
  const runner = new Runner(root, { adapter: async () => {
    throw Object.assign(new Error('Could not confirm worker termination.'), { code: 'WORKER_TERMINATION_UNCERTAIN' });
  } });
  await runner.runBatch();
  assert.equal((await store.get(first.id)).status, 'blocked');
  assert.equal((await store.get(first.id)).needsReconciliation, true);
  await store.update(first.id, { status: 'cancelled' });
  assert.deepEqual(await runner.runBatch(), []);
  assert.equal((await store.get(waiting.id)).status, 'queued');
  await store.reconcileProvider('codex');
  assert.equal((await store.get(first.id)).status, 'cancelled');
  const events = (await readFile(store.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.jobId === first.id && event.type === 'provider_reconciled'));
});

test('late worker success cannot overwrite cancellation', async (t) => {
  const { root, store } = await setup(t);
  const job = await store.enqueue({ role: 'senior', prompt: 'Cancellable task' });
  const runner = new Runner(root, { adapter: async (_job, _role, onEvent) => {
    await onEvent({ type: 'progress', message: 'Started' });
    await store.update(job.id, { status: 'cancelled' }, { expectedStatus: 'running' });
    return { text: 'Late answer' };
  } });
  await runner.runBatch();
  assert.equal((await store.get(job.id)).status, 'cancelled');
  await assert.rejects(store.update(job.id, { status: 'done' }), { code: 'INVALID_TRANSITION' });
});

test('independent processes cannot lose or duplicate enqueued jobs', async (t) => {
  const { root, store } = await setup(t);
  const storeUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const code = `import { Store } from ${JSON.stringify(storeUrl)}; const store = new Store(process.argv[1]); for (let n=0;n<4;n++) await store.enqueue({role:'senior',prompt:'Task '+process.argv[2]+' '+n,requestKey:process.argv[2]+'-'+n});`;
  const run = (worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, worker], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('first'), run('second')]);
  const jobs = await store.list();
  assert.equal(jobs.length, 8);
  assert.equal(new Set(jobs.map((job) => job.requestKey)).size, 8);
});

test('a terminated runner lease is recovered without restarting its provider work', async (t) => {
  const { root, store } = await setup(t);
  const job = await store.enqueue({ role: 'senior', prompt: 'Interrupted child process' });
  const storeUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const code = `import { Store } from ${JSON.stringify(storeUrl)}; const store = new Store(process.argv[1]); await store.acquireRunner('interrupted'); await store.claimReady({runId:'interrupted',roles:(await store.config()).roles});`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(stderr)));
  });
  assert.equal((await store.get(job.id)).status, 'running');
  let called = false;
  await new Runner(root, { adapter: async () => { called = true; return { text: 'Should not run' }; } }).runBatch();
  assert.equal(called, false);
  assert.equal((await store.get(job.id)).status, 'blocked');
});

test('an abandoned write lock fails safely instead of being silently removed', async (t) => {
  const { store } = await setup(t);
  const job = await store.enqueue({ role: 'senior', prompt: 'Preserve durable data' });
  await writeFile(store.lockPath, JSON.stringify({ pid: 2147483647, host: os.hostname() }));
  await assert.rejects(store.update(job.id, { status: 'cancelled' }), { code: 'STALE_STORE_LOCK' });
  assert.equal((await store.get(job.id)).status, 'queued');
  assert.match(await readFile(store.lockPath, 'utf8'), /2147483647/);
});
