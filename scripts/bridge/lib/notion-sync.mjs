import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.mjs';
import { notionValueEquals } from './notion-values.mjs';

const STATUS = { queued: 'Ready', running: 'Working', review: 'Review', done: 'Done', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString();
const fault = (code, message) => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const httpStatus = error => Number(error?.status ?? error?.statusCode ?? error?.response?.status);
const authenticationError = error => [401, 403].includes(httpStatus(error)) || ['unauthorized', 'restricted_resource', 'NOTION_AUTH_REQUIRED'].includes(error?.code);

// Never persist response bodies or exception messages: transports may include credentials,
// prompts, or complete HTTP requests in them. Categories provide actionable safe diagnostics.
function publicError(error, taskId) {
  let code = 'NOTION_SYNC_FAILED';
  let message = 'Notion synchronization failed. Local tasks are safe; inspect the transport connection and retry.';
  if (authenticationError(error)) {
    code = 'NOTION_AUTH_REQUIRED';
    message = 'Reconnect the Notion transport and grant it access to the department board, then retry. No model API key is needed.';
  } else if (httpStatus(error) === 429) {
    code = 'NOTION_RATE_LIMITED'; message = 'Notion rate limits persisted after bounded retries. Synchronization will retry on the next pass.';
  } else if (httpStatus(error) >= 500) {
    code = 'NOTION_UNAVAILABLE'; message = 'Notion remained unavailable after bounded retries. Synchronization will retry on the next pass.';
  } else if (SAFE_ERRORS[error?.code]) {
    code = error.code; message = SAFE_ERRORS[code];
  }
  return { code, message, ...(taskId ? { taskId } : {}), at: timestamp() };
}

const SAFE_ERRORS = {
  NOTION_CREATE_UNCERTAIN: 'A card creation has an uncertain outcome. The next pass will search by Local task ID; no duplicate creation will be attempted. If it remains missing, inspect Notion before repairing the pending mapping.',
  NOTION_DUPLICATE_CARDS: 'Multiple Notion cards share this Local task ID. Resolve the duplicate cards before retrying.',
  NOTION_ID_MISMATCH: 'The mapped Notion card has a different Local task ID. Inspect the mapping before retrying.',
  NOTION_VERIFY_FAILED: 'Notion did not return the expected fields after a write. The next pass will reconcile the card.',
  INVALID_NOTION_MAP: 'The local Notion mapping is invalid. Repair it before synchronization; local jobs are unaffected.',
  INVALID_NOTION_TRANSPORT: 'The Notion transport must provide findByTaskId, createCard, updateCard, and fetchCard.',
  NOTION_SYNC_BUSY: 'Another Notion sync process owns the lock. Wait for it to finish.',
  STALE_NOTION_SYNC_LOCK: 'An interrupted Notion sync left a lock. Confirm its process stopped, inspect the mapping, then remove only data/notion-sync.lock.',
};

function safeText(value, limit = 500) {
  // Only approved progress fields enter this function. Common accidental token forms
  // are additionally redacted; raw prompts, result content and errors never enter it.
  return String(value ?? '').replace(/\b(?:secret_|ntn_|sk-|sk_|ghp_|gho_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, limit);
}

/** Flat scalar properties matching the existing department board schema. */
export function notionProperties(job, config) {
  const role = Object.hasOwn(config.roles ?? {}, job.role) ? config.roles[job.role] : {};
  const progress = [`Local status: ${job.status}.`, `Updated ${safeText(job.updatedAt, 40)}.`];
  if (job.createdAt) progress.push(`Created ${safeText(job.createdAt, 40)}.`);
  if (job.startedAt) progress.push(`Started ${safeText(job.startedAt, 40)}.`);
  if (job.completedAt) progress.push(`Worker completed ${safeText(job.completedAt, 40)}.`);
  if (job.finishedAt) progress.push(`Finished ${safeText(job.finishedAt, 40)}.`);
  const project = typeof job.project === 'string' ? job.project : job.project?.name ?? job.projectId;
  if (project) progress.push(`Project: ${safeText(project, 120)}.`);
  if (job.validation) progress.push(`Tests: ${job.validation.passed ? 'passed' : 'failed'}.`);
  if (job.reviewFor?.taskId) progress.push(`Reviewing task: ${safeText(job.reviewFor.taskId, 80)}.`);
  if (job.reviewFor && typeof job.result === 'string') {
    try {
      const decision = JSON.parse(job.result);
      if (typeof decision.approved === 'boolean') progress.push(`Review decision: ${decision.approved ? 'approved' : 'changes requested'}.`);
    } catch { /* Only expose a validated boolean, never the private review text. */ }
  }
  if (job.projectReview?.reviewerTaskId) progress.push(`Reviewed by task: ${safeText(job.projectReview.reviewerTaskId, 80)}.`);
  if (job.integration?.commit) progress.push(`Integrated locally: ${safeText(job.integration.commit, 64)}.`);
  if (job.integrationInProgress) progress.push('Integration in progress or awaiting recovery.');
  if (job.error) progress.push('Attention required. Read local task details for the diagnostic.');
  return {
    Task: safeText(job.title, 200), Status: STATUS[job.status] ?? 'Blocked',
    Owner: safeText(role.name ?? 'Coordinator', 100),
    Model: `${safeText(job.model ?? role.model, 120)}${job.modelVerified === true ? '' : ' (requested)'}`,
    Area: job.origin === 'grok' ? 'Daily Assistant' : 'IT Department',
    'Local task ID': job.id, 'Depends on': (job.dependsOn ?? []).join(', ').slice(0, 1800),
    ...(job.acceptanceCriteria ? { 'Acceptance criteria': safeText(job.acceptanceCriteria, 1800) } : {}),
    Progress: progress.join(' ').slice(0, 1800),
  };
}

function cardId(card) { return typeof card === 'string' ? card : card?.id ?? card?.pageId; }
function matches(card, expected) {
  const properties = card?.properties;
  return properties && Object.entries(expected).every(([key, value]) => notionValueEquals(properties[key], value));
}
function assertIdentity(card, taskId) {
  if (card?.properties?.['Local task ID'] !== taskId) throw fault('NOTION_ID_MISMATCH');
}

async function readJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}

async function atomicJson(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * Deterministic local-to-Notion sync; no model invocation or secrets in durable files.
 * Transport methods use flat scalar properties. findByTaskId returns null, a card,
 * or an array (duplicates are rejected). fetchCard returns {id, properties}.
 * A returned status has ok:false on transport failure; local queue writes are untouched.
 */
export class NotionSync {
  constructor(root, { transport, maxRetries = 3, retryBaseMs = 250, retryMaxMs = 5_000, lockTimeoutMs = 10_000, sleep = wait } = {}) {
    this.root = path.resolve(root);
    this.store = new Store(this.root);
    this.transport = transport;
    this.maxRetries = Math.min(5, Math.max(0, maxRetries));
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.sleep = sleep;
    this.mapPath = path.join(this.root, 'notion-map.json');
    this.statusPath = path.join(this.root, 'data', 'notion-sync-status.json');
    this.lockPath = path.join(this.root, 'data', 'notion-sync.lock');
  }

  async getStatus() {
    return readJson(this.statusPath, { ok: null, lastSuccess: null, lastError: null, pendingCount: null });
  }

  async exportCards() {
    const [config, jobs, mapping] = await Promise.all([this.store.config(), this.store.list(), this._readMap()]);
    return jobs.map(job => ({ taskId: job.id, pageId: mapping.jobs[job.id] ?? null, properties: notionProperties(job, config) }));
  }

  async _readMap() {
    let mapping;
    try { mapping = await readJson(this.mapPath, { jobs: {}, sync: {} }); }
    catch { throw fault('INVALID_NOTION_MAP'); }
    if (!mapping || !mapping.jobs || typeof mapping.jobs !== 'object' || Array.isArray(mapping.jobs)
      || Object.values(mapping.jobs).some(value => typeof value !== 'string')
      || (mapping.sync !== undefined && (!mapping.sync || typeof mapping.sync !== 'object' || Array.isArray(mapping.sync)))) {
      throw fault('INVALID_NOTION_MAP');
    }
    mapping.sync ??= {};
    return mapping;
  }

  async _lock() {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      let handle;
      try {
        handle = await open(this.lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: timestamp() }));
        await handle.sync();
        return async () => { await handle.close(); await unlink(this.lockPath); };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {}); await unlink(this.lockPath).catch(() => {}); throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(this.lockPath, 'utf8')); }
        catch (readError) { if (readError.code === 'ENOENT') continue; }
        if (owner?.host === os.hostname() && !processAlive(owner.pid)) throw fault('STALE_NOTION_SYNC_LOCK', SAFE_ERRORS.STALE_NOTION_SYNC_LOCK);
        if (Date.now() >= deadline) throw fault('NOTION_SYNC_BUSY', SAFE_ERRORS.NOTION_SYNC_BUSY);
        await wait(25);
      }
    }
  }

  async _call(method, ...args) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.transport[method](...args); }
      catch (error) {
        const status = httpStatus(error);
        // A server failure during create can mean that Notion committed the card.
        // Only a definite rate-limit rejection is safe to replay automatically.
        const retryable = status === 429 || (method !== 'createCard' && status >= 500 && status <= 599);
        if (!retryable || attempt >= this.maxRetries) throw error;
        const retryAfter = error?.retryAfterMs !== undefined ? Number(error.retryAfterMs)
          : Number(error?.retryAfter ?? error?.headers?.get?.('retry-after') ?? error?.headers?.['retry-after']) * 1000;
        const backoff = this.retryBaseMs * (2 ** attempt);
        // A Retry-After longer than our bound is deferred to a later pass rather
        // than ignored or allowed to block the local runner indefinitely.
        if (Number.isFinite(retryAfter) && retryAfter > this.retryMaxMs) throw error;
        await this.sleep(Math.min(this.retryMaxMs, Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter : 0)));
      }
    }
  }

  async _find(taskId) {
    const found = await this._call('findByTaskId', taskId);
    const cards = Array.isArray(found) ? found : found ? [found] : [];
    if (cards.length > 1) throw fault('NOTION_DUPLICATE_CARDS');
    if (!cards.length) return null;
    const id = cardId(cards[0]);
    if (typeof id !== 'string' || !id) throw fault('NOTION_VERIFY_FAILED');
    const card = await this._call('fetchCard', id);
    assertIdentity(card, taskId);
    return { id, properties: card.properties };
  }

  async _syncCard(job, config, mapping) {
    const expected = notionProperties(job, config);
    const taskId = job.id;
    const prior = mapping.sync[taskId] ?? {};
    let pageId = mapping.jobs[taskId];
    let card;
    let changed = false;
    if (pageId) {
      try { card = await this._call('fetchCard', pageId); assertIdentity(card, taskId); }
      catch (error) { if (httpStatus(error) !== 404) throw error; pageId = null; }
    }
    if (!pageId) {
      card = await this._find(taskId);
      if (card) pageId = card.id;
      else {
        if (prior.pendingCreate) throw fault('NOTION_CREATE_UNCERTAIN');
        // Write intent before the network call. A crash at any later point never
        // blindly reissues create; reconciliation always searches by stable ID.
        mapping.sync[taskId] = { ...prior, pendingCreate: { at: timestamp(), outcome: 'pending' } };
        await atomicJson(this.mapPath, mapping);
        try {
          const created = await this._call('createCard', expected);
          pageId = cardId(created);
          if (typeof pageId !== 'string' || !pageId) throw fault('NOTION_CREATE_UNCERTAIN');
          changed = true;
        } catch (error) {
          // Definite rejection means nothing was created and a later pass may retry.
          const status = httpStatus(error);
          if ((status >= 400 && status < 500 && status !== 408) || authenticationError(error)) {
            mapping.sync[taskId] = { ...prior };
            await atomicJson(this.mapPath, mapping);
            throw error;
          }
          mapping.sync[taskId].pendingCreate.outcome = 'uncertain';
          await atomicJson(this.mapPath, mapping);
          // Recover a lost create response immediately when the card is searchable.
          card = await this._find(taskId);
          if (!card) throw fault('NOTION_CREATE_UNCERTAIN');
          pageId = card.id;
        }
      }
      mapping.jobs[taskId] = pageId;
      mapping.sync[taskId] = { ...prior };
      await atomicJson(this.mapPath, mapping);
      card = await this._call('fetchCard', pageId);
      assertIdentity(card, taskId);
    }
    if (!matches(card, expected)) {
      await this._call('updateCard', pageId, expected);
      card = await this._call('fetchCard', pageId);
      assertIdentity(card, taskId);
      if (!matches(card, expected)) throw fault('NOTION_VERIFY_FAILED');
      changed = true;
    }
    mapping.sync[taskId] = { fingerprint: hash(expected), lastVerifiedAt: timestamp() };
    await atomicJson(this.mapPath, mapping);
    return changed;
  }

  async syncOnce() {
    const release = await this._lock();
    let status = { ok: false, lastSuccess: null, lastError: null, pendingCount: null };
    let syncedCount = 0;
    let changedCount = 0;
    try {
      status = { ...status, ...await this.getStatus(), ok: false, checkedAt: timestamp() };
      for (const method of ['findByTaskId', 'createCard', 'updateCard', 'fetchCard']) {
        if (typeof this.transport?.[method] !== 'function') throw fault('INVALID_NOTION_TRANSPORT');
      }
      const [config, jobs, mapping] = await Promise.all([this.store.config(), this.store.list(), this._readMap()]);
      const errors = [];
      const successful = new Map();
      for (const job of jobs) {
        try {
          if (await this._syncCard(job, config, mapping)) changedCount += 1;
          successful.set(job.id, hash(notionProperties(job, config)));
          syncedCount += 1;
        } catch (error) {
          errors.push(publicError(error, job.id));
          if (authenticationError(error)) break;
        }
      }
      // Jobs may advance while the network is in flight. Report pending rather than
      // claiming the initial snapshot is current; the watcher handles the next pass.
      const latestJobs = await this.store.list();
      const pendingCount = latestJobs.filter(job => successful.get(job.id) !== hash(notionProperties(job, config))).length;
      const ok = errors.length === 0 && pendingCount === 0;
      status = { ...status, ok, pendingCount, lastError: errors[0] ?? null, errors,
        lastSuccess: ok ? timestamp() : status.lastSuccess, checkedAt: timestamp(), syncedCount, changedCount };
    } catch (error) {
      status = { ...status, ok: false, lastError: publicError(error), checkedAt: timestamp(), syncedCount, changedCount };
      try { status.pendingCount = (await this.store.list()).length; } catch { status.pendingCount = null; }
    }
    try { await atomicJson(this.statusPath, status); }
    finally { await release(); }
    return status;
  }
}

export default NotionSync;
