import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const paths = root => ({
  lease: path.join(root, 'data', 'notion-watch.json'),
  gate: path.join(root, 'data', 'notion-watch-start.lock'),
  stop: path.join(root, 'data', 'notion-watch-stop.json'),
  status: path.join(root, 'data', 'notion-watch-status.json'),
});

async function readJson(filename, fallback = null) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function leaseAlive(lease) {
  // Never reclaim an unknown-host lease; a user may have moved the directory.
  return lease && (lease.host !== os.hostname() || alive(lease.pid ?? lease.launcherPid));
}
async function eligible(root) {
  const config = await readJson(path.join(root, 'config.json'), {});
  if (config.notion?.syncMode !== 'direct-mcp') return { enabled: false, reason: 'Direct Notion sync is not enabled.' };
  try { await access(path.join(root, '.private', 'notion-oauth.enc')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, reason: 'Notion has not been authorized for this bridge.' }; throw error; }
  return { enabled: true, config };
}

/** Serialize short launch/lease changes independently from queue and sync locks. */
async function gate(root) {
  const filename = paths(root).gate;
  await mkdir(path.dirname(filename), { recursive: true });
  const deadline = Date.now() + 3000;
  while (true) {
    let handle;
    try {
      handle = await open(filename, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() }));
      await handle.sync();
      return async () => { await handle.close(); await unlink(filename); };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await unlink(filename).catch(() => {}); throw error; }
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = await readJson(filename); } catch { /* A writer may not have finished its lock metadata. */ }
      if (owner?.host === os.hostname() && Number.isInteger(owner.pid) && !alive(owner.pid)) {
        // A dead owner's lock is never automatically removed: an additional
        // writer could be recovering it concurrently. Return an actionable state.
        throw Object.assign(new Error('Confirm the prior watcher process stopped, then remove only data/notion-watch-start.lock.'), { code: 'STALE_NOTION_WATCH_LOCK' });
      }
      if (Date.now() >= deadline) throw Object.assign(new Error('Notion watcher launch is busy.'), { code: 'NOTION_WATCH_BUSY' });
      await wait(25);
    }
  }
}

async function signature(root) {
  return (await Promise.all(['data/state.json', 'config.json', 'notion-map.json'].map(async filename => {
    try { const value = await stat(path.join(root, filename), { bigint: true }); return `${filename}:${value.mtimeNs}:${value.size}`; }
    catch (error) { if (error.code === 'ENOENT') return `${filename}:missing`; throw error; }
  }))).join('|');
}

function safeWatchError(error) {
  if (error?.code === 'NOTION_SYNC_BUSY') return { code: 'NOTION_SYNC_BUSY', message: 'Another sync pass is active; the watcher will retry.' };
  if (error?.code === 'STALE_NOTION_SYNC_LOCK') return { code: 'STALE_NOTION_SYNC_LOCK', message: 'An interrupted sync left a lock. Confirm the previous process stopped, inspect the mapping, then remove only data/notion-sync.lock.' };
  return { code: 'NOTION_WATCH_FAILED', message: 'The Notion watcher could not complete a pass. Check its connection and the local sync status, then retry.' };
}

/** Start one hidden watcher when direct MCP auth is configured. Never registers startup. */
export async function ensureWatcher(directory) {
  const root = path.resolve(directory);
  const enabled = await eligible(root);
  if (!enabled.enabled) return { started: false, running: false, reason: enabled.reason };
  const p = paths(root);
  const release = await gate(root);
  let child;
  let lease;
  try {
    const existing = await readJson(p.lease);
    if (leaseAlive(existing)) return { started: false, running: true, pid: existing.pid, status: existing.status ?? 'running' };
    const nonce = randomUUID();
    lease = { nonce, host: os.hostname(), pid: null, launcherPid: process.pid, status: 'starting', startedAt: now() };
    await atomicJson(p.lease, lease);
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watch', root, nonce], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    lease.pid = child.pid;
    await atomicJson(p.lease, lease);
    child.unref();
    return { started: true, running: true, pid: child.pid, status: 'starting' };
  } catch (error) {
    if (!child?.pid && lease && (await readJson(p.lease))?.nonce === lease.nonce) await unlink(p.lease);
    throw error;
  } finally { await release(); }
}

/** Request a nonce-matched graceful stop. No process is killed, including reused PIDs. */
export async function stopWatcher(directory, { waitMs = 2500 } = {}) {
  const root = path.resolve(directory);
  const p = paths(root);
  const release = await gate(root);
  let lease;
  try {
    lease = await readJson(p.lease);
    if (!leaseAlive(lease)) {
      if (lease) await unlink(p.lease);
      return { stopped: true, running: false };
    }
    await atomicJson(p.stop, { nonce: lease.nonce, requestedAt: now() });
  } finally { await release(); }
  const deadline = Date.now() + Math.max(0, Math.min(5000, waitMs));
  while (Date.now() < deadline) {
    const current = await readJson(p.lease);
    if (!current || current.nonce !== lease.nonce || !leaseAlive(current)) return { stopped: true, running: false, pid: lease.pid };
    await wait(50);
  }
  return { stopped: false, stopRequested: true, running: true, pid: lease.pid, reason: 'The watcher will stop after its current network operation.' };
}

/**
 * Long-running deterministic queue watcher. The optional transportFactory(root, notionConfig)
 * and short intervals support isolated tests without credentials or model calls.
 */
export async function watch(directory, { transportFactory, pollMs = 2000, reconcileMs = 60000, retryMs = 15000, nonce, signal } = {}) {
  const root = path.resolve(directory);
  const p = paths(root);
  if (!transportFactory && !(await eligible(root)).enabled) return { started: false, reason: 'Direct Notion sync needs configuration and authorization.' };
  const releaseGate = await gate(root);
  let lease;
  try {
    const existing = await readJson(p.lease);
    const reservation = nonce && existing?.nonce === nonce && existing.pid === process.pid && existing.host === os.hostname();
    if (leaseAlive(existing) && !reservation) return { started: false, running: true, pid: existing.pid };
    // A launched child must not take over a newer reservation after another start.
    if (nonce && !reservation) return { started: false, running: false, reason: 'Watcher reservation changed.' };
    lease = { nonce: nonce ?? randomUUID(), host: os.hostname(), pid: process.pid, status: 'running', startedAt: existing?.startedAt ?? now() };
    await atomicJson(p.lease, lease);
  } finally { await releaseGate(); }

  let transport;
  let priorSignature = null;
  let nextSyncAt = 0;
  let pending = false;
  let state = { running: true, pid: process.pid, startedAt: lease.startedAt, lastCheckAt: now(), lastSyncAt: null, lastError: null };
  const factory = transportFactory ?? (async (folder, notionConfig) => {
    const { NotionMcpTransport } = await import('./notion-mcp.mjs');
    return new NotionMcpTransport(folder, notionConfig);
  });
  try {
    const { NotionSync } = await import('./notion-sync.mjs');
    while (!signal?.aborted) {
      const stop = await readJson(p.stop);
      if (stop?.nonce === lease.nonce) break;
      const config = await readJson(path.join(root, 'config.json'), {});
      if (!transportFactory && config.notion?.syncMode !== 'direct-mcp') break;
      const currentSignature = await signature(root);
      const changed = currentSignature !== priorSignature;
      if (changed || (pending && !state.lastError) || Date.now() >= nextSyncAt) {
        try {
          transport ??= await factory(root, config.notion ?? {});
          const result = await new NotionSync(root, { transport }).syncOnce();
          state = { ...state, lastSyncAt: result.checkedAt, lastError: result.lastError, pendingCount: result.pendingCount };
          pending = result.pendingCount > 0;
          nextSyncAt = Date.now() + (result.ok ? reconcileMs : retryMs);
        } catch (error) {
          state.lastError = safeWatchError(error);
          nextSyncAt = Date.now() + retryMs;
          await transport?.close?.().catch(() => {});
          transport = undefined;
        }
        // Sync updates mapping metadata itself; absorb those timestamps so they
        // do not cause a feedback loop. pendingCount captures concurrent job edits.
        priorSignature = await signature(root);
      }
      state.lastCheckAt = now();
      await atomicJson(p.status, state);
      await wait(Math.max(10, pollMs));
    }
  } catch (error) {
    state.lastError = safeWatchError(error);
  } finally {
    await transport?.close?.().catch(() => {});
    state = { ...state, running: false, stoppedAt: now() };
    await atomicJson(p.status, state);
    const release = await gate(root);
    try {
      if ((await readJson(p.lease))?.nonce === lease.nonce) await unlink(p.lease);
      if ((await readJson(p.stop))?.nonce === lease.nonce) await unlink(p.stop);
    } finally { await release(); }
  }
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--watch') {
  // No stdout/stderr or credentials are emitted by the detached helper.
  await watch(process.argv[3], { nonce: process.argv[4] }).catch(() => { process.exitCode = 1; });
}
