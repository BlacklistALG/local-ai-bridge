import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeDepartment } from '../lib/department-status.mjs';

test('summarizes an empty queue', () => {
  assert.deepEqual(summarizeDepartment([]), { total: 0, byStatus: {}, byProvider: {} });
});

test('counts mixed jobs without copying private task data or changing the input', () => {
  const jobs = [
    { status: 'queued', provider: 'codex', prompt: 'PRIVATE_PROMPT', title: 'PRIVATE_TITLE', result: 'PRIVATE_RESULT' },
    { status: 'review', provider: 'claude', workspace: 'PRIVATE_WORKSPACE', credentials: 'PRIVATE_CREDENTIALS' },
    { status: 'queued', provider: 'codex', config: 'PRIVATE_CONFIG' },
  ];
  const snapshot = structuredClone(jobs);
  const summary = summarizeDepartment(jobs);
  assert.deepEqual(summary, { total: 3, byStatus: { queued: 2, review: 1 }, byProvider: { codex: 2, claude: 1 } });
  assert.deepEqual(jobs, snapshot);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_/);
});

test('handles missing and unusual keys without prototype pollution', () => {
  const summary = summarizeDepartment([
    { status: '__proto__', provider: 'constructor' },
    { status: 'constructor', provider: '__proto__' },
    { status: 'toString', provider: 'toString' },
    { status: 'unexpected', provider: 'other' },
    { status: '', provider: null },
    {},
  ]);
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.byStatus, Object.fromEntries([
    ['__proto__', 1], ['constructor', 1], ['toString', 1], ['unexpected', 1], ['unknown', 2],
  ]));
  assert.deepEqual(summary.byProvider, Object.fromEntries([
    ['constructor', 1], ['__proto__', 1], ['toString', 1], ['other', 1], ['unknown', 2],
  ]));
  assert.equal(Object.getPrototypeOf(summary.byStatus), Object.prototype);
  assert.equal(Object.getPrototypeOf(summary.byProvider), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
});

test('status CLI reads the local queue and emits only aggregate counts', async (t) => {
  const source = path.dirname(fileURLToPath(new URL('../bridge.mjs', import.meta.url)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-department-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(source, 'lib'), path.join(root, 'lib'), { recursive: true });
  await cp(path.join(source, 'bridge.mjs'), path.join(root, 'bridge.mjs'));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ roles: {}, notion: { boardUrl: 'PRIVATE_CONFIG' } }));
  await writeFile(path.join(root, 'data', 'state.json'), JSON.stringify({
    version: 1,
    jobs: {
      one: { status: 'queued', provider: 'codex', prompt: 'PRIVATE_PROMPT', title: 'PRIVATE_TITLE' },
      two: { status: 'review', provider: 'claude', result: 'PRIVATE_RESULT', workspace: 'PRIVATE_WORKSPACE' },
      three: { status: 'queued', provider: 'codex', credentials: 'PRIVATE_CREDENTIALS' },
    },
    runner: null,
    pendingEvents: [],
  }));

  const run = (command) => spawnSync(process.execPath, [path.join(root, 'bridge.mjs'), command], {
    cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
  });
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, '');
  assert.deepEqual(JSON.parse(status.stdout), {
    total: 3, byStatus: { queued: 2, review: 1 }, byProvider: { codex: 2, claude: 1 },
  });
  assert.doesNotMatch(status.stdout, /PRIVATE_/);

  const help = run('help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(JSON.parse(help.stdout).commands.includes('status'));
  const list = run('list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).length, 3);
});
