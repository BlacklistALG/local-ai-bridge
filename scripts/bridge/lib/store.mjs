import { appendFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { validateProjectSpec } from './projects.mjs';

const STATUSES = new Set(['queued', 'running', 'review', 'blocked', 'failed', 'cancelled', 'done']);
const TRANSITIONS = {
  queued: new Set(['running', 'blocked', 'cancelled']),
  running: new Set(['review', 'blocked', 'failed', 'cancelled']),
  review: new Set(['done', 'blocked', 'cancelled']),
  blocked: new Set(['queued', 'cancelled']),
  failed: new Set(['cancelled']),
  cancelled: new Set(),
  done: new Set(),
};
const IMMUTABLE = new Set(['id', 'role', 'provider', 'prompt', 'title', 'dependsOn', 'origin', 'requestKey', 'mode', 'createdAt', 'workspace', 'requestSignature', 'project', 'allowedPaths', 'acceptanceCriteria', 'reviewFor']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const copy = (value) => structuredClone(value);
const now = () => new Date().toISOString();

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function initialState() {
  return { version: 1, jobs: {}, runner: null, pendingEvents: [] };
}

/** Durable local queue. All mutations use one exclusive, process-aware write lock. */
export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dataDirectory = path.join(this.root, 'data');
    this.statePath = path.join(this.dataDirectory, 'state.json');
    this.lockPath = path.join(this.dataDirectory, 'state.lock');
    this.eventsPath = path.join(this.dataDirectory, 'events.jsonl');
  }

  async config() {
    const config = JSON.parse(await readFile(path.join(this.root, 'config.json'), 'utf8'));
    if (!config.roles || typeof config.roles !== 'object' || Array.isArray(config.roles)) {
      throw failure('INVALID_CONFIG', 'config.json must contain a roles object.');
    }
    return config;
  }

  async _read() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version !== 1 || !state.jobs || Array.isArray(state.jobs)) {
        throw failure('INVALID_STATE', 'The queue state is invalid; restore it before continuing.');
      }
      state.pendingEvents ??= [];
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return initialState();
      throw error;
    }
  }

  async _write(state) {
    const temporaryPath = path.join(this.dataDirectory, `state.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporaryPath, this.statePath); }
    catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async _lock() {
    await mkdir(this.dataDirectory, { recursive: true });
    const deadline = Date.now() + 10_000;
    while (true) {
      let handle;
      try {
        handle = await open(this.lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: now() }));
        await handle.sync();
        return async () => {
          await handle.close();
          await unlink(this.lockPath);
        };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await unlink(this.lockPath).catch(() => {});
          throw error;
        }
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(this.lockPath, 'utf8')); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          // Another writer may still be writing its lock metadata. Never delete it.
        }
        if (owner?.host === os.hostname() && !processAlive(owner.pid)) {
          throw failure('STALE_STORE_LOCK', `An interrupted write left ${this.lockPath}. Verify that no coordinator is running, inspect data/state.json, then remove only this lock file to recover.`);
        }
        if (Date.now() >= deadline) {
          throw failure('STORE_BUSY', `The queue write lock is busy or cannot be verified: ${this.lockPath}`);
        }
        await delay(20 + Math.floor(Math.random() * 30));
      }
    }
  }

  _record(state, jobId, type, detail = {}) {
    const event = { id: randomUUID(), at: now(), jobId, type, detail: copy(detail) };
    state.pendingEvents.push(event);
    return event;
  }

  async _mutate(action) {
    const release = await this._lock();
    try {
      const state = await this._read();
      const result = await action(state);
      // Commit events with state first; the outbox survives an interrupted log append.
      await this._write(state);
      if (state.pendingEvents.length) {
        await appendFile(this.eventsPath, state.pendingEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
        state.pendingEvents = [];
        await this._write(state);
      }
      // Log replay after a crash can repeat an event ID. Consumers can deduplicate by ID.
      return copy(result);
    } finally { await release(); }
  }

  async list() {
    return copy(Object.values((await this._read()).jobs));
  }

  async get(id) {
    const { jobs } = await this._read();
    return Object.hasOwn(jobs, id) ? copy(jobs[id]) : null;
  }

  async enqueue({ role, prompt, title, dependsOn = [], origin = 'coordinator', requestKey, mode = 'read-only', project, allowedPaths, acceptanceCriteria, reviewFor } = {}) {
    const config = await this.config();
    if (typeof role !== 'string' || !Object.hasOwn(config.roles, role)) throw failure('UNKNOWN_ROLE', 'Choose a role defined in config.json.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw failure('INVALID_JOB', 'A nonempty prompt is required.');
    if (prompt.length > 100_000) throw failure('INVALID_JOB', 'The prompt exceeds the 100,000 character limit.');
    if (typeof title !== 'undefined' && (typeof title !== 'string' || !title.trim())) throw failure('INVALID_JOB', 'The title must be nonempty text.');
    if (typeof origin !== 'string' || !origin.trim()) throw failure('INVALID_JOB', 'The origin must be nonempty text.');
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string')) throw failure('INVALID_JOB', 'dependsOn must be an array of job IDs.');
    if (!['read-only', 'workspace-write'].includes(mode)) throw failure('INVALID_JOB', 'mode must be read-only or workspace-write.');
    if (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 500)) throw failure('INVALID_JOB', 'requestKey must be nonempty text of at most 500 characters.');
    const input = { role, prompt, title: title ?? prompt.trim().slice(0, 100), dependsOn: [...new Set(dependsOn)].sort(), origin, mode };
    if (mode === 'workspace-write') {
      if (!project || !Object.hasOwn(config.projects ?? {}, project)) throw failure('UNKNOWN_PROJECT', 'Editing requires a registered project.');
      const checked = validateProjectSpec(config.projects[project], allowedPaths);
      if (typeof acceptanceCriteria !== 'string' || !acceptanceCriteria.trim() || acceptanceCriteria.length > 8000) throw failure('INVALID_JOB', 'Editing requires explicit acceptanceCriteria of at most 8000 characters.');
      Object.assign(input, { project, allowedPaths: checked.allowedPaths, acceptanceCriteria });
    }
    if (reviewFor) {
      if (mode !== 'read-only' || typeof reviewFor.taskId !== 'string' || !/^[a-f0-9]{64}$/.test(reviewFor.diffHash) || !/^[a-f0-9]{64}$/.test(reviewFor.testsHash)) throw failure('INVALID_REVIEW', 'A review requires an exact patch and test snapshot.');
      input.reviewFor = copy(reviewFor);
    }
    const signature = JSON.stringify(input);
    return this._mutate(async (state) => {
      if (requestKey !== undefined) {
        const existing = Object.values(state.jobs).find((job) => job.requestKey === requestKey);
        if (existing) {
          if (existing.requestSignature !== signature) throw failure('IDEMPOTENCY_CONFLICT', 'This requestKey already belongs to a different request.');
          return existing;
        }
      }
      for (const id of input.dependsOn) {
        if (!Object.hasOwn(state.jobs, id)) throw failure('UNKNOWN_DEPENDENCY', `Unknown dependency: ${id}`);
      }
      const id = randomUUID();
      const timestamp = now();
      const job = {
        id, ...input, provider: config.roles[role].provider,
        requestKey: requestKey ?? null, requestSignature: signature,
        status: 'queued', createdAt: timestamp, updatedAt: timestamp,
        workspace: path.join(this.root, 'work', 'jobs', id),
      };
      await mkdir(job.workspace, { recursive: true });
      state.jobs[id] = job;
      this._record(state, id, 'queued', { role, origin });
      return job;
    });
  }

  async update(id, patch, { expectedStatus } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('INVALID_UPDATE', 'A job update must be an object.');
    if (Object.hasOwn(patch, 'needsReconciliation') && patch.needsReconciliation !== true) {
      throw failure('RECONCILIATION_REQUIRED', 'Only reconcileProvider can clear a worker incident after an operator confirms the previous processes have stopped.');
    }
    for (const field of Object.keys(patch)) {
      if (IMMUTABLE.has(field) || ['__proto__', 'constructor', 'prototype'].includes(field)) throw failure('IMMUTABLE_FIELD', `Job field cannot be changed: ${field}`);
    }
    return this._mutate((state) => {
      const job = Object.hasOwn(state.jobs, id) ? state.jobs[id] : null;
      if (!job) throw failure('UNKNOWN_JOB', `Unknown job: ${id}`);
      const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
      if (expectedStatus !== undefined && !expected.includes(job.status)) throw failure('STATUS_CONFLICT', `Job is ${job.status}; expected ${expected.join(' or ')}.`);
      if (job.integrationInProgress && (patch.status === 'cancelled' || patch.integrationInProgress === true)) throw failure('INTEGRATION_BUSY', 'Integration is in progress or needs recovery; inspect its source commit before changing the task.');
      if (patch.status === 'cancelled' && Object.values(state.jobs).some(other => other.integrationInProgress && other.projectReview?.reviewerTaskId === id)) throw failure('INTEGRATION_BUSY', 'This review is being applied by an integration; inspect that integration before cancelling.');
      if (patch.integrationInProgress === true) {
        const reviewId = patch.projectReview?.reviewerTaskId ?? job.projectReview?.reviewerTaskId;
        const reviewer = Object.hasOwn(state.jobs, reviewId) ? state.jobs[reviewId] : null;
        if (!reviewer || !['review', 'done'].includes(reviewer.status) || reviewer.needsReconciliation) throw failure('REVIEW_UNAVAILABLE', 'The independent review changed before integration could start.');
      }
      if (job.needsReconciliation && ['queued', 'running', 'review', 'done'].includes(patch.status)) {
        throw failure('RECONCILIATION_REQUIRED', 'Reconcile this provider before restarting or accepting an interrupted job.');
      }
      if (patch.status !== undefined && (!STATUSES.has(patch.status) || (patch.status !== job.status && !TRANSITIONS[job.status].has(patch.status)))) {
        throw failure('INVALID_TRANSITION', `Cannot change a ${job.status} job to ${patch.status}.`);
      }
      const previousStatus = job.status;
      if (job.mode === 'workspace-write' && patch.status === 'done' && !job.integration?.commit && !patch.integration?.commit) throw failure('INTEGRATION_REQUIRED', 'Editing tasks are accepted only after tested, reviewed integration.');
      Object.assign(job, copy(patch), { updatedAt: now() });
      if (['done', 'failed', 'cancelled'].includes(job.status)) job.finishedAt ??= now();
      this._record(state, id, job.status !== previousStatus ? job.status : 'updated', { previousStatus });
      return job;
    });
  }

  async event(id, type, detail = {}) {
    if (type && typeof type === 'object') { detail = type; type = type.type ?? 'worker'; }
    return this._mutate((state) => {
      if (!Object.hasOwn(state.jobs, id)) throw failure('UNKNOWN_JOB', `Unknown job: ${id}`);
      return this._record(state, id, String(type), detail);
    });
  }

  /** Operator action only: call after confirming all previous provider workers have stopped. */
  async reconcileProvider(provider) {
    if (typeof provider !== 'string' || !provider.trim()) throw failure('INVALID_PROVIDER', 'A provider name is required.');
    return this._mutate((state) => {
      const jobs = Object.values(state.jobs);
      if (jobs.some((job) => job.provider === provider && job.status === 'running')) {
        throw failure('PROVIDER_BUSY', 'A worker for this provider is still marked running. Stop and inspect it before confirming reconciliation.');
      }
      const reconciled = [];
      for (const job of jobs) {
        if (job.provider !== provider || job.needsReconciliation !== true) continue;
        job.needsReconciliation = false;
        job.reconciledAt = now();
        job.updatedAt = now();
        this._record(state, job.id, 'provider_reconciled', { provider, previousWorkersConfirmedStopped: true });
        reconciled.push(job);
      }
      return reconciled;
    });
  }

  async acquireRunner(runId) {
    return this._mutate((state) => {
      if (state.runner && (state.runner.host !== os.hostname() || processAlive(state.runner.pid))) {
        throw failure('RUNNER_BUSY', 'Another runner owns the queue. Wait for it to finish; jobs were not started twice.');
      }
      const recovered = [];
      for (const job of Object.values(state.jobs)) {
        if (job.status === 'running') {
          job.status = 'blocked';
          job.needsReconciliation = true;
          job.updatedAt = now();
          job.error = 'Worker execution was interrupted. Confirm that previous provider processes have stopped and reconcile the provider before starting more work. Inspect the workspace before explicitly requeueing; no automatic retry was attempted.';
          this._record(state, job.id, 'blocked', { reason: 'interrupted_execution' });
          recovered.push(job);
        }
      }
      state.runner = { runId, pid: process.pid, host: os.hostname(), acquiredAt: now() };
      return recovered;
    });
  }

  async releaseRunner(runId) {
    return this._mutate((state) => {
      if (state.runner?.runId !== runId) throw failure('RUNNER_LEASE_LOST', 'This runner no longer owns the queue.');
      // A coordinator exception must never leave a job falsely marked as actively running.
      for (const job of Object.values(state.jobs)) {
        if (job.status === 'running' && job.runId === runId) {
          job.status = 'blocked';
          job.needsReconciliation = true;
          job.updatedAt = now();
          job.error = 'The runner stopped without recording a completed result. Confirm that previous provider processes have stopped and reconcile the provider before starting more work. Inspect the workspace before retrying.';
          this._record(state, job.id, 'blocked', { reason: 'incomplete_execution' });
        }
      }
      state.runner = null;
      return true;
    });
  }

  async claimReady({ runId, maxParallel = 2, providerCaps = {}, roles }) {
    return this._mutate((state) => {
      if (state.runner?.runId !== runId) throw failure('RUNNER_LEASE_LOST', 'This runner does not own the queue.');
      const claimed = [];
      const blocked = [];
      const providerCounts = {};
      const pausedProviders = new Set(Object.values(state.jobs).filter((job) => job.needsReconciliation === true).map((job) => job.provider));
      for (const job of Object.values(state.jobs)) {
        if (job.status !== 'queued') continue;
        const failedDependency = job.dependsOn.find((id) => !state.jobs[id] || ['failed', 'cancelled', 'blocked'].includes(state.jobs[id].status));
        if (failedDependency || !Object.hasOwn(roles, job.role)) {
          job.status = 'blocked';
          job.updatedAt = now();
          job.error = failedDependency ? `Dependency ${failedDependency} requires attention.` : 'The assigned role is missing from config.json.';
          this._record(state, job.id, 'blocked', { reason: job.error });
          blocked.push(job);
          continue;
        }
        if (job.dependsOn.some((id) => state.jobs[id].status !== 'done')) continue;
        const provider = roles[job.role].provider;
        if (pausedProviders.has(provider)) continue;
        const providerLimit = providerCaps[provider] ?? 1;
        if (!Number.isInteger(providerLimit) || providerLimit < 1 || providerLimit > 4) throw failure('INVALID_CONFIG', 'Provider concurrency caps must be integers from 1 to 4.');
        if (claimed.length >= maxParallel || (providerCounts[provider] ?? 0) >= providerLimit) continue;
        Object.assign(job, { status: 'running', provider, runId, startedAt: now(), updatedAt: now() });
        delete job.error;
        providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;
        this._record(state, job.id, 'running', { provider, runId });
        claimed.push(job);
      }
      return { claimed, blocked };
    });
  }
}

export default Store;
