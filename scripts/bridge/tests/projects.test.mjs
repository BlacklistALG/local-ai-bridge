import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Projects, validateProjectSpec } from '../lib/projects.mjs';

const gitPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
function git(cwd, args, input) {
  const result = spawnSync(gitPath, args, { cwd, input, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function fixture(t, { files = {}, commandArgs } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-dept-projects-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const source = path.join(root, 'source');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Test Author']);
  git(source, ['config', 'user.email', 'test@localhost']);
  git(source, ['config', 'core.autocrlf', 'false']);
  const content = { 'value.mjs': 'export const value = 1;\n', 'value.test.mjs': "import { value } from './value.mjs'; if (value !== 2) throw new Error('expected value 2');\n", 'untouched.txt': 'keep me\n', ...files };
  for (const [file, text] of Object.entries(content)) { await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await writeFile(path.join(source, file), text); }
  git(source, ['add', '--all']);
  git(source, ['commit', '-m', 'baseline']);
  const manager = new Projects(path.join(root, 'bridge'));
  const config = { path: source, testCommand: { executable: process.execPath, args: commandArgs ?? ['value.test.mjs'], timeoutMs: 5000 } };
  const makeJob = async (id = 'task-one', allowedPaths = ['value.mjs']) => {
    const job = { id, project: 'pilot', role: 'sol-mid', provider: 'codex', allowedPaths, title: 'Update value', workspace: path.join(root, 'bridge', 'work', 'jobs', id) };
    job.projectWorkspace = await manager.createWorkspace(job, config);
    return job;
  };
  const job = await makeJob();
  return { root, source, manager, config, makeJob, job };
}

async function change(job, text = 'export const value = 2;\n') { await writeFile(path.join(job.projectWorkspace.path, 'value.mjs'), text); }
async function approve(manager, job) {
  job.validation = await manager.runTests(job);
  job.projectReview = await manager.recordReview(job, { reviewerTaskId: 'separate-review-task', reviewerRole: 'opus-senior', reviewerStatus: 'review', approved: true, diffHash: job.validation.diffHash, testsHash: job.validation.commandHash, summary: 'Reviewed the exact patch and its passing test result.' });
}

test('isolates changes, validates tests, binds independent review, and integrates an exact local commit', async (t) => {
  const { source, manager, job } = await fixture(t);
  assert.notEqual(job.projectWorkspace.path, source);
  await change(job);
  assert.equal(await readFile(path.join(source, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  await approve(manager, job);
  assert.equal(job.validation.passed, true);
  assert.deepEqual(job.validation.files, ['value.mjs']);
  assert.equal(git(job.projectWorkspace.path, ['diff', '--cached', '--name-only']), '', 'inspection preserves the worker index');
  const integrated = await manager.integrate(job);
  assert.equal(git(source, ['rev-parse', 'HEAD']), integrated.commit);
  assert.equal(git(source, ['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(source, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(await readFile(path.join(source, 'untouched.txt'), 'utf8'), 'keep me\n');
  assert.match(git(source, ['log', '-1', '--format=%B']), /separate-review-task/);
});

test('rejects out-of-scope edits before tests or integration', async (t) => {
  const { manager, job } = await fixture(t);
  await change(job);
  await writeFile(path.join(job.projectWorkspace.path, 'untouched.txt'), 'unauthorized\n');
  await assert.rejects(manager.runTests(job), { code: 'OUT_OF_SCOPE' });
});

test('rejects new out-of-scope files including ignored task artifacts', async (t) => {
  const { manager, job } = await fixture(t, { files: { '.gitignore': '*.scratch\n' } });
  await change(job);
  await writeFile(path.join(job.projectWorkspace.path, 'secret.scratch'), 'extra');
  await assert.rejects(manager.inspectChanges(job), { code: 'OUT_OF_SCOPE' });
});

test('new files and deletions are captured and integrated together', async (t) => {
  const { source, manager, makeJob } = await fixture(t);
  const job = await makeJob('add-delete', ['value.mjs', 'untouched.txt', 'nested/']);
  await change(job);
  await unlink(path.join(job.projectWorkspace.path, 'untouched.txt'));
  await mkdir(path.join(job.projectWorkspace.path, 'nested'));
  await writeFile(path.join(job.projectWorkspace.path, 'nested', 'new.txt'), 'included\n');
  await approve(manager, job);
  assert.deepEqual(job.validation.files, ['nested/new.txt', 'untouched.txt', 'value.mjs']);
  await manager.integrate(job);
  assert.equal(await readFile(path.join(source, 'nested', 'new.txt'), 'utf8'), 'included\n');
  await assert.rejects(readFile(path.join(source, 'untouched.txt')), { code: 'ENOENT' });
});

test('failed tests cannot receive an accepted review', async (t) => {
  const { manager, job } = await fixture(t);
  await change(job, 'export const value = 3;\n');
  job.validation = await manager.runTests(job);
  assert.equal(job.validation.passed, false);
  await assert.rejects(manager.recordReview(job, {}), { code: 'VALIDATION_REQUIRED' });
  await assert.rejects(manager.integrate(job), { code: 'VALIDATION_REQUIRED' });
});

test('same-role and same-task reviews are refused', async (t) => {
  const { manager, job } = await fixture(t);
  await change(job);
  job.validation = await manager.runTests(job);
  const valid = { reviewerTaskId: 'reviewer', reviewerRole: 'opus-senior', reviewerStatus: 'review', approved: true, diffHash: job.validation.diffHash, testsHash: job.validation.commandHash, summary: 'Looks correct.' };
  await assert.rejects(manager.recordReview(job, { ...valid, reviewerTaskId: job.id }), { code: 'INDEPENDENT_REVIEW_REQUIRED' });
  await assert.rejects(manager.recordReview(job, { ...valid, reviewerRole: job.role }), { code: 'INDEPENDENT_REVIEW_REQUIRED' });
  await assert.rejects(manager.recordReview(job, { ...valid, reviewerStatus: 'running' }), { code: 'INDEPENDENT_REVIEW_REQUIRED' });
});

test('a stale patch or test-command review is refused', async (t) => {
  const { manager, job } = await fixture(t);
  await change(job);
  await approve(manager, job);
  await change(job, 'export const value = 2; // changed after approval\n');
  await assert.rejects(manager.integrate(job), { code: 'VALIDATION_REQUIRED' });
  await change(job);
  job.projectReview.testsHash = 'stale';
  await assert.rejects(manager.integrate(job), { code: 'INDEPENDENT_REVIEW_REQUIRED' });
});

test('dirty source is preserved and blocks integration and new task creation', async (t) => {
  const { source, manager, job, makeJob } = await fixture(t);
  await change(job);
  await approve(manager, job);
  await writeFile(path.join(source, 'untouched.txt'), 'user change\n');
  await assert.rejects(manager.integrate(job), { code: 'DIRTY_TARGET' });
  await assert.rejects(makeJob('task-two'), { code: 'DIRTY_TARGET' });
  assert.equal(await readFile(path.join(source, 'untouched.txt'), 'utf8'), 'user change\n');
  assert.equal(await readFile(path.join(source, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('two concurrent nonconflicting task workspaces remain isolated and stale bases cannot integrate', async (t) => {
  const { manager, job, makeJob, source } = await fixture(t);
  const second = await makeJob('task-two', ['untouched.txt']);
  await change(job);
  await writeFile(path.join(second.projectWorkspace.path, 'untouched.txt'), 'other worker\n');
  // This task has an independent check suited to its unchanged value source.
  second.projectWorkspace.testCommand = { executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 };
  await Promise.all([approve(manager, job), approve(manager, second)]);
  assert.equal(await readFile(path.join(job.projectWorkspace.path, 'untouched.txt'), 'utf8'), 'keep me\n');
  await manager.integrate(job);
  await assert.rejects(manager.integrate(second), { code: 'TARGET_DRIFT' });
  assert.equal(await readFile(path.join(source, 'untouched.txt'), 'utf8'), 'keep me\n');
});

test('worker commits or branch switching invalidate the assigned workspace', async (t) => {
  const { manager, job } = await fixture(t);
  await change(job);
  git(job.projectWorkspace.path, ['add', '--all']);
  git(job.projectWorkspace.path, ['commit', '-m', 'worker commit not allowed']);
  await assert.rejects(manager.inspectChanges(job), { code: 'WORKSPACE_GIT_CHANGED' });
});

test('a concurrent unrelated staged edit is preserved while only this integration patch is reversed', async (t) => {
  const { manager, job, source } = await fixture(t);
  await change(job);
  await approve(manager, job);
  const base = git(source, ['rev-parse', 'HEAD']);
  const originalGit = manager._git.bind(manager);
  let injected = false;
  manager._git = async (cwd, args, options) => {
    const result = await originalGit(cwd, args, options);
    if (!injected && cwd === source && args[0] === 'apply' && !args.includes('--check')) {
      injected = true;
      await writeFile(path.join(source, 'untouched.txt'), 'concurrent staged work\n');
      git(source, ['add', 'untouched.txt']);
    }
    return result;
  };
  await assert.rejects(manager.integrate(job), { code: 'TARGET_DRIFT' });
  assert.equal(git(source, ['rev-parse', 'HEAD']), base);
  assert.equal(await readFile(path.join(source, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(await readFile(path.join(source, 'untouched.txt'), 'utf8'), 'concurrent staged work\n');
  assert.equal(git(source, ['diff', '--cached', '--name-only']), 'untouched.txt');
});

test('concurrent modifications to an applied path are preserved for explicit recovery', async (t) => {
  const { manager, job, source } = await fixture(t);
  await change(job);
  await approve(manager, job);
  const base = git(source, ['rev-parse', 'HEAD']);
  const originalGit = manager._git.bind(manager);
  let injected = false;
  manager._git = async (cwd, args, options) => {
    const result = await originalGit(cwd, args, options);
    if (!injected && cwd === source && args[0] === 'apply' && !args.includes('--check')) {
      injected = true;
      await writeFile(path.join(source, 'value.mjs'), 'user edited this concurrently\n');
    }
    return result;
  };
  await assert.rejects(manager.integrate(job), { code: 'INTEGRATION_RECOVERY_REQUIRED' });
  assert.equal(git(source, ['rev-parse', 'HEAD']), base);
  assert.equal(await readFile(path.join(source, 'value.mjs'), 'utf8'), 'user edited this concurrently\n');
});

test('simultaneous duplicate integration calls create exactly one commit', async (t) => {
  const { manager, job, source } = await fixture(t);
  await change(job);
  await approve(manager, job);
  const results = await Promise.allSettled([manager.integrate(job), manager.integrate(job)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'PROJECT_BUSY');
  assert.equal(git(source, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(git(source, ['status', '--porcelain']), '');
});

test('tests which modify the patch require fresh validation', async (t) => {
  const { manager, job } = await fixture(t, { commandArgs: ['-e', "require('node:fs').appendFileSync('value.mjs', '// test changed content\\n')"] });
  await change(job);
  await assert.rejects(manager.runTests(job), { code: 'TESTS_CHANGED_FILES' });
});

test('existing tracked symlink changes are blocked even on hosts that check them out as regular files', async (t) => {
  const { manager, makeJob, source } = await fixture(t);
  const blob = git(source, ['hash-object', '-w', '--stdin'], 'value.mjs');
  git(source, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  await writeFile(path.join(source, 'link'), 'value.mjs');
  git(source, ['commit', '-m', 'add tracked symbolic link']);
  // A real symlink is only required on Unix; Windows core.symlinks commonly uses text placeholders.
  if (process.platform !== 'win32') { await unlink(path.join(source, 'link')); const { symlink } = await import('node:fs/promises'); await symlink('value.mjs', path.join(source, 'link')); }
  const job = await makeJob('link-task', ['link']);
  await unlink(path.join(job.projectWorkspace.path, 'link'));
  await assert.rejects(manager.inspectChanges(job), { code: 'UNSAFE_LINK' });
});

test('registration rejects traversal, wildcards, and shell test commands', () => {
  const project = { path: path.resolve('source'), testCommand: { executable: process.execPath, args: ['--test'] } };
  for (const scope of [['../secret'], ['src/*'], ['.git/config'], ['/absolute'], ['src\\file'], ['foo),Edit,Edit(foo'], ['src/a,b'], ['src/a(b)'], ['src/a)'], ['src/!secret'], []]) assert.throws(() => validateProjectSpec(project, scope), { code: 'INVALID_SCOPE' });
  assert.throws(() => validateProjectSpec({ ...project, testCommand: { executable: path.resolve('cmd.exe'), args: ['/c', 'test'] } }, ['src/']), { code: 'INVALID_PROJECT' });
  assert.throws(() => validateProjectSpec({ ...project, testCommand: { executable: 'node', args: ['--test'] } }, ['src/']), { code: 'INVALID_PROJECT' });
});

test('configured test command timeout is bounded and leaves source untouched', async (t) => {
  const { manager, job, source } = await fixture(t, { commandArgs: ['-e', 'setTimeout(()=>{},10000)'] });
  job.projectWorkspace.testCommand.timeoutMs = 150;
  await change(job);
  await assert.rejects(manager.runTests(job), (error) => ['TEST_TIMEOUT', 'TEST_TERMINATION_UNCERTAIN'].includes(error.code));
  assert.equal(git(source, ['status', '--porcelain']), '');
});
