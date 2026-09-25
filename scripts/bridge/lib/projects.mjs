import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, unlink, realpath, lstat, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { subscriptionEnvironment } from './providers.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const contained = (parent, child) => { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const splitZero = (text) => text.split('\0').filter(Boolean);

/** Commands come only from trusted project registration, never from worker output. */
export function validateProjectSpec(config, allowedPaths) {
  if (!config || typeof config.path !== 'string' || !path.isAbsolute(config.path)) throw fail('INVALID_PROJECT', 'A registered project needs an absolute repository path.');
  const command = config.testCommand;
  if (!command || typeof command.executable !== 'string' || !path.isAbsolute(command.executable) || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw fail('INVALID_PROJECT', 'A registered test command needs an absolute executable and an array of arguments.');
  if (/\.(?:cmd|bat|ps1)$/i.test(command.executable) || /^(?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?$/i.test(path.basename(command.executable))) throw fail('INVALID_PROJECT', 'Register a test executable directly; shell commands are not supported.');
  const timeoutMs = command.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw fail('INVALID_PROJECT', 'Test timeout must be between 100 and 600000 milliseconds.');
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) throw fail('INVALID_SCOPE', 'Editing tasks need explicit allowedPaths.');
  const scope = [...new Set(allowedPaths.map((item) => {
    if (typeof item !== 'string' || !item || item.includes('\\') || item.startsWith('/') || /[\0\r\n,:*?\[\]()!]/.test(item) || item.split('/').some((segment) => ['.', '..', '.git'].includes(segment.toLowerCase())) || item.includes('//')) throw fail('INVALID_SCOPE', 'allowedPaths must be relative file names or directory prefixes ending in /; no globs, permission delimiters, or .git paths.');
    return item;
  }))].sort();
  return { path: path.resolve(config.path), allowedPaths: scope, testCommand: { executable: command.executable, args: [...command.args], timeoutMs } };
}

async function gitExecutable() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe')]
    : ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw fail('GIT_UNAVAILABLE', 'Git is required at a standard installation path.');
}

async function execute(executable, args, { cwd, env = {}, timeoutMs = 30_000, input, allowFailure = false } = {}) {
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...subscriptionEnvironment(), ...env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let incident = null;
    let terminating = false;
    let terminationConfirmed = false;
    let childClosed = false;
    let settled = false;
    let watchdog;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (error) reject(error); else resolve(result);
    };
    const finishIncident = () => {
      if (childClosed && terminationConfirmed) settle(incident);
    };
    const uncertain = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.unref();
      settle(fail('TEST_TERMINATION_UNCERTAIN', 'The command exceeded its limit, but process-tree termination could not be confirmed. Confirm its processes have stopped before any further validation or integration.'));
    };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      watchdog = setTimeout(uncertain, 5000);
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.unref();
        killer.on('error', uncertain);
        killer.on('close', (code) => { if (code === 0) { terminationConfirmed = true; finishIncident(); } else uncertain(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); terminationConfirmed = true; finishIncident(); }
        catch { uncertain(); }
      }
    };
    const timer = setTimeout(() => { incident = fail('TEST_TIMEOUT', 'The configured command exceeded its timeout; its process tree was terminated.'); terminate(); }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { incident = fail('OUTPUT_LIMIT', 'The command exceeded the 16 MiB output limit.'); terminate(); return; }
      output[stream].push(chunk);
    });
    child.on('error', (error) => settle(error));
    child.on('close', (exitCode, signal) => {
      childClosed = true;
      if (incident) { finishIncident(); return; }
      settle(null, { exitCode, signal, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  if (!allowFailure && outcome.exitCode !== 0) throw fail('PROJECT_COMMAND_FAILED', outcome.stderr.trim() || `Command exited with ${outcome.exitCode}.`);
  return outcome;
}

export class Projects {
  constructor(root) { this.root = path.resolve(root); this.directory = path.join(this.root, 'work', 'projects'); }

  async _git(cwd, args, options = {}) {
    // Trust only this registered source or verified task copy for this invocation.
    return execute(await gitExecutable(), ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-c', `core.hooksPath=${path.join(this.directory, 'disabled-hooks')}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], { cwd, ...options });
  }

  async _clean(sourcePath) {
    const state = await this._git(sourcePath, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (state.stdout.trim()) throw fail('DIRTY_TARGET', 'The registered project has existing changes. Preserve them and finish or commit them before this operation.');
  }

  async createWorkspace(job, projectConfig) {
    if (!job || typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(job.id) || typeof job.project !== 'string' || !job.project) throw fail('INVALID_PROJECT_JOB', 'An editing job needs a safe task ID and a registered project name.');
    const config = validateProjectSpec(projectConfig, job.allowedPaths);
    const sourcePath = await realpath(config.path);
    if (samePath(sourcePath, this.directory) || contained(this.directory, sourcePath)) throw fail('INVALID_PROJECT', 'The registered source cannot be inside the isolated project worktree directory.');
    const top = (await this._git(sourcePath, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!samePath(sourcePath, await realpath(top))) throw fail('INVALID_PROJECT', 'Register the repository root, not a nested folder.');
    await this._clean(sourcePath);
    const sourceBranch = (await this._git(sourcePath, ['symbolic-ref', 'HEAD'])).stdout.trim();
    const baseCommit = (await this._git(sourcePath, ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = `ai-department/${job.id}`;
    const workspacePath = path.join(this.directory, job.id);
    await mkdir(this.directory, { recursive: true });
    if (!contained(await realpath(this.root), await realpath(this.directory))) throw fail('INVALID_WORKSPACE', 'The project directory escaped the department folder.');
    await this._git(sourcePath, ['worktree', 'add', '-b', branch, workspacePath, baseCommit]);
    const gitPointerHash = hash(await readFile(path.join(workspacePath, '.git')));
    const commonDirectory = (await this._git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
    return { path: await realpath(workspacePath), sourcePath, sourceBranch, branch: `refs/heads/${branch}`, baseCommit, commonDirectory: await realpath(commonDirectory), gitPointerHash, project: job.project, allowedPaths: config.allowedPaths, testCommand: config.testCommand, createdAt: new Date().toISOString() };
  }

  async _workspace(job) {
    const metadata = job?.projectWorkspace;
    if (!metadata || metadata.project !== job.project || !Array.isArray(metadata.allowedPaths)) throw fail('MISSING_WORKSPACE', 'This task has no verified project workspace.');
    const expected = path.join(this.directory, job.id);
    const actual = await realpath(metadata.path);
    const projectDirectory = await realpath(this.directory);
    if (!contained(await realpath(this.root), projectDirectory) || !samePath(actual, await realpath(expected)) || !contained(projectDirectory, actual)) throw fail('INVALID_WORKSPACE', 'The project workspace escaped its assigned task folder.');
    const pointerPath = path.join(actual, '.git');
    if (!(await lstat(pointerPath)).isFile() || hash(await readFile(pointerPath)) !== metadata.gitPointerHash) throw fail('WORKSPACE_GIT_CHANGED', 'The worktree Git pointer changed.');
    const branch = (await this._git(actual, ['symbolic-ref', 'HEAD'])).stdout.trim();
    const head = (await this._git(actual, ['rev-parse', 'HEAD'])).stdout.trim();
    const common = (await this._git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
    if (branch !== metadata.branch || head !== metadata.baseCommit || !samePath(await realpath(common), metadata.commonDirectory)) throw fail('WORKSPACE_GIT_CHANGED', 'The task branch, base commit, or repository changed. Workers must leave changes uncommitted for review.');
    return metadata;
  }

  async _checkFile(workspace, file, allowedPaths) {
    if (file.includes('\\') || file.split('/').some((part) => part.toLowerCase() === '.git') || !allowedPaths.some((scope) => scope.endsWith('/') ? file.startsWith(scope) : file === scope)) throw fail('OUT_OF_SCOPE', `Changed path is outside the task scope: ${file}`);
    const absolute = path.resolve(workspace, file);
    if (!contained(workspace, absolute)) throw fail('OUT_OF_SCOPE', `Changed path escapes the workspace: ${file}`);
    let current = workspace;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw fail('UNSAFE_LINK', `Symlink changes and changes through symlinks are not supported: ${file}`); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
  }

  /** Snapshot the complete proposed patch using a temporary index; preserve the worker's own index. */
  async inspectChanges(job) {
    const metadata = await this._workspace(job);
    const tracked = splitZero((await this._git(metadata.path, ['diff', '--name-only', '-z', '--no-renames', metadata.baseCommit, '--'])).stdout);
    const untracked = splitZero((await this._git(metadata.path, ['ls-files', '--others', '-z'])).stdout);
    const files = [...new Set([...tracked, ...untracked])].sort();
    if (!files.length) throw fail('NO_CHANGES', 'The editing task did not produce a change.');
    for (const file of files) await this._checkFile(metadata.path, file, metadata.allowedPaths);
    const originalModes = splitZero((await this._git(metadata.path, ['ls-tree', '-r', '-z', metadata.baseCommit])).stdout);
    for (const entry of originalModes) {
      const separator = entry.indexOf('\t');
      if (/^(?:120000|160000) /.test(entry) && files.includes(entry.slice(separator + 1))) throw fail('UNSAFE_LINK', `Changes to symlinks and submodules are not supported: ${entry.slice(separator + 1)}`);
    }
    await mkdir(job.workspace, { recursive: true });
    const index = path.join(job.workspace, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this._git(metadata.path, ['read-tree', metadata.baseCommit], { env });
      await this._git(metadata.path, ['add', '--all', '--'], { env });
      const staged = splitZero((await this._git(metadata.path, ['ls-files', '--stage', '-z'], { env })).stdout);
      for (const entry of staged) {
        const separator = entry.indexOf('\t');
        if (/^(?:120000|160000) /.test(entry) && files.includes(entry.slice(separator + 1))) throw fail('UNSAFE_LINK', `Symlink and submodule changes are not supported: ${entry.slice(separator + 1)}`);
      }
      const capturedFiles = splitZero((await this._git(metadata.path, ['diff', '--cached', '--name-only', '--no-renames', '-z', metadata.baseCommit, '--'], { env })).stdout).sort();
      if (JSON.stringify(capturedFiles) !== JSON.stringify(files)) throw fail('UNTRACKED_ARTIFACT', 'The workspace contains ignored or unstable changes that cannot be included in the reviewed patch. Remove those task artifacts before validation.');
      const patch = (await this._git(metadata.path, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', metadata.baseCommit, '--'], { env })).stdout;
      const treeHash = (await this._git(metadata.path, ['write-tree'], { env })).stdout.trim();
      const patchPath = path.join(job.workspace, 'changes.patch');
      await writeFile(patchPath, patch, 'utf8');
      return { diffHash: hash(patch), files, patchPath, baseCommit: metadata.baseCommit, treeHash, inspectedAt: new Date().toISOString() };
    } finally { await unlink(index).catch(() => {}); await unlink(`${index}.lock`).catch(() => {}); }
  }

  async runTests(job) {
    const metadata = await this._workspace(job);
    const before = await this.inspectChanges(job);
    const command = metadata.testCommand;
    const result = await execute(command.executable, command.args, { cwd: metadata.path, timeoutMs: command.timeoutMs, allowFailure: true });
    const after = await this.inspectChanges(job);
    if (before.diffHash !== after.diffHash) throw fail('TESTS_CHANGED_FILES', 'The configured test command changed the proposed patch. Validate the resulting change again before review.');
    return { ...after, passed: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, commandHash: hash(JSON.stringify(command)), testedAt: new Date().toISOString() };
  }

  async recordReview(job, review) {
    const current = await this.inspectChanges(job);
    const commandHash = hash(JSON.stringify(job.projectWorkspace.testCommand));
    if (!job.validation?.passed || job.validation.diffHash !== current.diffHash || job.validation.treeHash !== current.treeHash || job.validation.baseCommit !== current.baseCommit || job.validation.commandHash !== commandHash) throw fail('VALIDATION_REQUIRED', 'Passing configured tests for the current patch are required before review.');
    if (!review || typeof review.reviewerTaskId !== 'string' || !review.reviewerTaskId || review.reviewerTaskId === job.id || typeof review.reviewerRole !== 'string' || !review.reviewerRole || review.reviewerRole === job.role || !['review', 'done'].includes(review.reviewerStatus)) throw fail('INDEPENDENT_REVIEW_REQUIRED', 'Review must come from a completed, separate task assigned to a different role.');
    if (typeof review.approved !== 'boolean' || review.diffHash !== current.diffHash || review.testsHash !== job.validation.commandHash || typeof review.summary !== 'string' || !review.summary.trim()) throw fail('STALE_REVIEW', 'The reviewer must provide a decision and summary for the exact current patch and configured test command.');
    return { reviewerTaskId: review.reviewerTaskId, reviewerRole: review.reviewerRole, approved: review.approved, summary: review.summary, diffHash: current.diffHash, testsHash: review.testsHash, reviewedAt: new Date().toISOString() };
  }

  async _sourceUnchanged(metadata) {
    if (!samePath(await realpath(metadata.sourcePath), metadata.sourcePath)) throw fail('TARGET_DRIFT', 'The registered source path changed.');
    const branch = (await this._git(metadata.sourcePath, ['symbolic-ref', 'HEAD'])).stdout.trim();
    const head = (await this._git(metadata.sourcePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (branch !== metadata.sourceBranch || head !== metadata.baseCommit) throw fail('TARGET_DRIFT', 'The source branch or commit changed after task creation. Rebase in a new task, test, and obtain a fresh review before integration.');
  }

  /** Apply only an independently approved, tested patch. Never push or publish. */
  async integrate(job) {
    if (job?.needsReconciliation) throw fail('RECONCILIATION_REQUIRED', 'Confirm the interrupted task processes have stopped and reconcile them before integration.');
    const metadata = await this._workspace(job);
    const locks = path.join(this.directory, 'locks');
    await mkdir(locks, { recursive: true });
    const lockPath = path.join(locks, `${hash(metadata.sourcePath.toLowerCase())}.lock`);
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw fail('PROJECT_BUSY', 'Another integration owns this project. Interrupted integration locks require inspection; they are not removed automatically.'); throw error; }
    let applied = false;
    let committed = false;
    let patch;
    let integration;
    try {
      await lock.writeFile(JSON.stringify({ jobId: job.id, pid: process.pid, createdAt: new Date().toISOString() }));
      const current = await this.inspectChanges(job);
      const validation = job.validation;
      const review = job.projectReview;
      const commandHash = hash(JSON.stringify(metadata.testCommand));
      if (!validation?.passed || validation.diffHash !== current.diffHash || validation.baseCommit !== current.baseCommit || validation.treeHash !== current.treeHash || validation.commandHash !== commandHash) throw fail('VALIDATION_REQUIRED', 'Integration requires passing tests for the exact current patch and registered command.');
      if (!review?.approved || review.diffHash !== current.diffHash || review.testsHash !== commandHash || !review.reviewerTaskId || review.reviewerTaskId === job.id || !review.reviewerRole || review.reviewerRole === job.role) throw fail('INDEPENDENT_REVIEW_REQUIRED', 'Integration requires approval from a separate completed review task for the exact tested patch.');
      await this._sourceUnchanged(metadata);
      await this._clean(metadata.sourcePath);
      patch = await readFile(current.patchPath, 'utf8');
      if (hash(patch) !== current.diffHash) throw fail('STALE_REVIEW', 'The saved patch changed before integration.');
      await this._git(metadata.sourcePath, ['apply', '--check', '--index', '--binary', '-'], { input: patch });
      await this._sourceUnchanged(metadata);
      await this._clean(metadata.sourcePath);
      await this._git(metadata.sourcePath, ['apply', '--index', '--binary', '-'], { input: patch });
      applied = true;
      const tree = (await this._git(metadata.sourcePath, ['write-tree'])).stdout.trim();
      const unstaged = (await this._git(metadata.sourcePath, ['diff', '--name-only', '-z'])).stdout;
      if (tree !== current.treeHash || unstaged) throw fail('TARGET_DRIFT', 'The target changed during integration; the reviewed patch was not committed.');
      await this._sourceUnchanged(metadata);
      const commit = (await this._git(metadata.sourcePath, ['-c', 'user.name=AI Department', '-c', 'user.email=ai-department@localhost', 'commit-tree', tree, '-p', metadata.baseCommit], { input: `AI Department: ${String(job.title ?? job.id).replace(/[\r\n]/g, ' ')}\n\nTask: ${job.id}\nReview: ${review.reviewerTaskId}\nPatch-SHA256: ${current.diffHash}\n` })).stdout.trim();
      await this._git(metadata.sourcePath, ['update-ref', '-m', `AI Department integrate ${job.id}`, metadata.sourceBranch, commit, metadata.baseCommit]);
      committed = true;
      integration = { commit, branch: metadata.sourceBranch, sourcePath: metadata.sourcePath, diffHash: current.diffHash, reviewerTaskId: review.reviewerTaskId, integratedAt: new Date().toISOString() };
      return integration;
    } catch (error) {
      if (applied && !committed) {
        try { await this._git(metadata.sourcePath, ['apply', '--reverse', '--index', '--binary', '-'], { input: patch }); }
        catch { throw fail('INTEGRATION_RECOVERY_REQUIRED', `${error.message} The target changed concurrently, so automatic reversal was unsafe. Inspect the project; no reset, clean, or unrelated-file removal was attempted.`); }
      }
      throw error;
    } finally {
      try { await lock.close(); await unlink(lockPath); }
      catch (error) {
        // A cleanup error must never hide an already-created commit from the queue.
        if (committed && integration) integration.lockCleanupWarning = `The commit succeeded, but the project lock needs inspection: ${error.message}`;
        else throw error;
      }
    }
  }
}

export default Projects;
