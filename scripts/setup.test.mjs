import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, makeConfig, setup } from './setup.mjs';

async function temporary(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'local-bridge-setup-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('default setup requires recipient configuration and never inherits author identity', () => {
  const config = makeConfig({});
  assert.equal(config.subscriptionOnlyConfirmed, false);
  assert.equal(config.sandboxMode, 'read-only');
  assert.deepEqual(config.notion, { syncMode: 'disabled' });
  assert.deepEqual(config.projects, {});
  for (const role of Object.values(config.roles)) { assert.equal(role.model, ''); assert.equal(role.executable, ''); }
});

test('setup argument parsing rejects unknown, duplicate and relative destinations', () => {
  assert.throws(() => parseOptions(['--destination', 'relative']));
  assert.throws(() => parseOptions(['--destination', path.resolve('new'), '--api-key', 'no']));
  assert.throws(() => parseOptions(['--destination', path.resolve('new'), '--destination', path.resolve('other')]));
  assert.equal(parseOptions(['--destination', path.resolve('new'), '--confirm-subscriptions-only']).confirmed, true);
});

test('fresh setup copies only runtime source and leaves original files unchanged on repeat', async t => {
  const root = await temporary(t);
  const destination = path.join(root, 'private-install');
  const result = await setup({ destination }, { platform: 'win32' });
  assert.equal(result.modelInvoked, false);
  assert.equal(result.notionEnabled, false);
  const config = JSON.parse(await readFile(path.join(destination, 'config.json'), 'utf8'));
  assert.equal(config.subscriptionOnlyConfirmed, false);
  assert.deepEqual(config.notion, { syncMode: 'disabled' });
  const files = await readdir(destination);
  for (const excluded of ['.private', 'data', 'work', 'notion-map.json', '.git']) assert.equal(files.includes(excluded), false);
  await writeFile(path.join(destination, 'sentinel.txt'), 'preserve existing installation');
  await assert.rejects(setup({ destination }, { platform: 'win32' }), /already exists/);
  assert.equal(await readFile(path.join(destination, 'sentinel.txt'), 'utf8'), 'preserve existing installation');
});

test('setup fails closed for unsupported platforms and destinations inside distributable', async t => {
  const root = await temporary(t);
  await assert.rejects(setup({ destination: path.join(root, 'new') }, { platform: 'linux' }), /Windows only/);
  const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await assert.rejects(setup({ destination: path.join(skill, 'private') }, { platform: 'win32' }), /outside the shareable/);
});

test('setup rejects missing executables and malformed model IDs before creating destination', async t => {
  const root = await temporary(t);
  const destination = path.join(root, 'bad');
  await assert.rejects(setup({ destination, codex: path.join(root, 'missing.exe') }, { platform: 'win32' }));
  await assert.rejects(setup({ destination, 'codex-model': 'model;command' }, { platform: 'win32' }), /model ID/);
  assert.equal((await readdir(root)).length, 0);
});
