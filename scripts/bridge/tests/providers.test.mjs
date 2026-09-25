import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdapter, subscriptionEnvironment } from '../lib/providers.mjs';

const codexHelp = '--ignore-user-config --ignore-rules --ephemeral --json --sandbox --output-schema';
const reviewFor = { taskId: 'editing-task', diffHash: 'a'.repeat(64), testsHash: 'b'.repeat(64) };
const claudeAuth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'private@example.invalid' };
const codexEvents = [
  { type: 'thread.started', thread_id: 'codex-session' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE REASONING' } },
  { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'UNPUBLISHED PROGRESS' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Final answer' } },
  { type: 'turn.completed' },
];
const claudeEvents = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'claude-session' },
  { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Final answer', session_id: 'claude-session', modelUsage: { 'claude-opus-5-5': {} } },
];

function fakeSpawn(options = {}) {
  const calls = [];
  let worker;
  const spawn = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    const isKiller = path.basename(executable).toLowerCase() === 'taskkill.exe';
    const isWorker = !isKiller && !args.some(arg => ['--version', '--help', 'auth', 'login'].includes(arg));
    if (isWorker) { worker = child; child.pid = options.workerPid; }
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.on('close', () => { child.closed = true; });
    child.kill = () => {
      child.killed = true;
      child.killCalls = (child.killCalls ?? 0) + 1;
      if (isWorker && options.ignoreWorkerKill) return false;
      if (isWorker && options.killCloseDelay) setTimeout(() => child.emit('close', null), options.killCloseDelay);
      else queueMicrotask(() => child.emit('close', null));
      return true;
    };
    const call = { executable, args, options: spawnOptions, input: '', child };
    calls.push(call);
    if (isKiller) {
      queueMicrotask(() => {
        if (options.taskkill === 'hang') return;
        if (options.taskkill === 'error') return child.emit('error', new Error('Simulated taskkill startup failure'));
        if (options.taskkill === 'nonzero') return child.emit('close', 128);
        child.emit('close', 0);
        if (!options.noWorkerClose) setTimeout(() => worker.emit('close', null), options.workerCloseDelay ?? 0);
      });
      return child;
    }
    child.stdin.on('data', chunk => { call.input += chunk; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      let stdout;
      let stderr = '';
      let code = 0;
      if (args.includes('--version')) stdout = options.version ?? '2.1.281 (Claude Code)';
      else if (args.includes('--help')) stdout = codexHelp;
      else if (args.includes('auth')) stdout = JSON.stringify(options.auth ?? claudeAuth);
      else if (args.includes('login')) { stdout = ''; stderr = options.codexAuth ?? 'Logged in using ChatGPT'; }
      else {
        if (options.hang) return;
        stdout = (options.events ?? (args.includes('exec') ? codexEvents : claudeEvents)).map(event => JSON.stringify(event)).join('\n');
        code = options.exitCode ?? 0;
      }
      // Exercise chunks split in the middle of JSON objects and no final newline.
      const middle = Math.floor(stdout.length / 2);
      child.stdout.write(stdout.slice(0, middle));
      child.stdout.write(stdout.slice(middle));
      if (stderr) child.stderr.write(stderr);
      child.emit('close', code);
    }));
    return child;
  };
  return { spawn, calls };
}

async function fixture(t, options = {}, config = {}, dependencies = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'department-provider-test-'));
  const workspace = path.join(root, 'work', 'jobs', 'test-job');
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeSpawn(options);
  const env = { ...process.env, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', OPENAI_API_KEY: 'secret-openai', ANTHROPIC_API_KEY: 'secret-anthropic', ANTHROPIC_BASE_URL: 'https://other.invalid', NODE_OPTIONS: '--require malicious', CUSTOM_PASSWORD: 'secret-password' };
  const run = createAdapter(root, { subscriptionOnlyConfirmed: true, ...config }, { spawn: fake.spawn, env, ...dependencies });
  return { ...fake, root, workspace, run, job: { workspace, prompt: 'Inspect this workspace.' }, role: { provider: 'claude', model: 'claude-opus-5-5', executable: process.execPath } };
}

test('environment retains OS settings but strips provider keys, URLs, tokens and injection settings', () => {
  const clean = subscriptionEnvironment({ Path: 'safe-path', SystemRoot: 'safe-root', CODEX_HOME: 'safe-home', OPENAI_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', AWS_ACCESS_KEY_ID: 'secret', HTTP_PROXY: 'secret', NODE_OPTIONS: 'injection' });
  assert.equal(clean.Path, 'safe-path');
  assert.equal(clean.CODEX_HOME, 'safe-home');
  assert.equal(clean.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal('NODE_OPTIONS' in clean, false);
});

test('Claude preflights subscription and version, uses stdin, exposes only final response', async t => {
  const f = await fixture(t);
  const events = [];
  const result = await f.run(f.job, f.role, event => events.push(event));
  assert.deepEqual(result, { text: 'Final answer', sessionId: 'claude-session', model: 'claude-opus-5-5', modelVerified: true });
  assert.equal(f.calls.length, 3);
  const call = f.calls.at(-1);
  assert.equal(call.input, f.job.prompt);
  assert.equal(call.options.cwd, f.workspace);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args.includes('--bare'), false);
  assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(call.args.includes('--json-schema'), false);
  assert.equal(JSON.stringify(events).includes('PRIVATE REASONING'), false);
  assert.equal(JSON.stringify(events).includes('private@example'), false);
  assert.equal(JSON.stringify(call.options.env).includes('secret-'), false);
});

test('Claude refuses live execution before subscription-only confirmation', async t => {
  const f = await fixture(t, {}, { subscriptionOnlyConfirmed: false });
  await assert.rejects(f.run(f.job, f.role), /usage credits/);
  assert.equal(f.calls.length, 0);
});

test('Codex also refuses dispatch before included-usage settings are confirmed', async t => {
  const f = await fixture(t, {}, { subscriptionOnlyConfirmed: false });
  await assert.rejects(f.run(f.job, { ...f.role, provider: 'codex', model: 'fixture-codex' }), /usage credits/);
  assert.equal(f.calls.length, 0);
});

test('Claude rejects old Opus runtime before authentication or inference', async t => {
  const f = await fixture(t, { version: '2.1.267 (Claude Code)' });
  await assert.rejects(f.run(f.job, f.role), /2\.1\.280/);
  assert.equal(f.calls.length, 1);
});

test('Claude rejects API or unexpected subscription auth without exposing account data', async t => {
  const f = await fixture(t, { auth: { ...claudeAuth, authMethod: 'api_key' } });
  await assert.rejects(f.run(f.job, f.role), error => /API billing is not permitted/.test(error.message) && !error.message.includes('private@example'));
  assert.equal(f.calls.length, 2);
});

test('Claude rejects model fallback without returning its answer', async t => {
  const f = await fixture(t, { events: [{ type: 'system', subtype: 'init', model: 'claude-opus-5' }, { type: 'result', subtype: 'success', result: 'Wrong model result' }] });
  await assert.rejects(f.run(f.job, f.role), /different model/);
  assert.equal(f.calls.at(-1).child.killed, true);
});

test('Codex forces ChatGPT auth, read-only sandbox and ignores user config', async t => {
  const f = await fixture(t);
  const events = [];
  const result = await f.run(f.job, { ...f.role, provider: 'codex', model: 'gpt-6-sol' }, event => events.push(event));
  assert.equal(result.text, 'Final answer');
  assert.equal(result.modelVerified, false);
  assert.equal(result.sessionId, 'codex-session');
  const call = f.calls.at(-1);
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.equal(call.args.includes('--ignore-rules'), false);
  assert.ok(call.args.includes('forced_login_method="chatgpt"'));
  assert.ok(call.args.includes('approval_policy="never"'));
  assert.equal(call.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(call.args.includes('--output-schema'), false);
  assert.equal(call.args.at(-1), '-');
  assert.equal(JSON.stringify(events).includes('PRIVATE REASONING'), false);
  assert.equal(JSON.stringify(events).includes('UNPUBLISHED PROGRESS'), false);
});

test('Codex refuses API-key login before inference', async t => {
  const f = await fixture(t, { codexAuth: 'Logged in using an API key - sk-PRIVATEVALUE123' });
  await assert.rejects(f.run(f.job, { ...f.role, provider: 'codex', model: 'gpt-6-sol' }), /ChatGPT subscription sign-in/);
  assert.equal(f.calls.length, 3);
});

test('workspace-write requires both a configured capability and an explicit job mode', async t => {
  const f = await fixture(t, {}, { sandboxMode: 'workspace-write' });
  const role = { ...f.role, provider: 'codex', model: 'gpt-6-sol' };
  await f.run(f.job, role);
  let args = f.calls.at(-1).args;
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  const projectPath = path.join(path.dirname(path.dirname(f.job.workspace)), 'projects', 'edit-test');
  await mkdir(projectPath, { recursive: true });
  const editJob = { ...f.job, id: 'edit-test', mode: 'workspace-write', allowedPaths: ['src/', 'tests/example.test.mjs'], projectWorkspace: { path: projectPath } };
  await f.run(editJob, role);
  args = f.calls.at(-1).args;
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  const blocked = await fixture(t);
  await assert.rejects(blocked.run({ ...blocked.job, mode: 'workspace-write' }, role), /explicit adapter configuration/);
  await assert.rejects(f.run({ ...f.job, mode: 'workspace-write' }, f.role), /verified isolated/);
  await f.run(editJob, f.role);
  args = f.calls.at(-1).args;
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Edit(/src/**),Edit(/tests/example.test.mjs)');
  assert.equal(f.calls.at(-1).options.cwd, projectPath);
});

test('adapter refuses external workspaces and relative executables', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ ...f.job, workspace: os.tmpdir() }, f.role), /outside/);
  await assert.rejects(f.run(f.job, { ...f.role, executable: 'claude.cmd' }), /absolute native/);
  assert.equal(f.calls.length, 0);
});

test('Claude rejects permission delimiters in editing paths before dispatching a worker', async t => {
  const f = await fixture(t, {}, { sandboxMode: 'workspace-write' });
  const projectPath = path.join(f.root, 'work', 'projects', 'delimiter-test');
  await mkdir(projectPath, { recursive: true });
  const editJob = { ...f.job, id: 'delimiter-test', mode: 'workspace-write', projectWorkspace: { path: projectPath } };
  for (const injectedPath of ['foo),Edit,Edit(foo', 'src/a,b.txt', 'src/a(b).txt', 'src/a).txt', 'src/!secret']) {
    await assert.rejects(f.run({ ...editJob, allowedPaths: [injectedPath] }, f.role), /Invalid editing scope/);
  }
  assert.ok(f.calls.every(call => call.args.includes('--version') || call.args.includes('auth')), 'No worker may receive a broadened permission rule');
});

test('Claude review schema preserves read-only tools and prefers structured output over a prose preface', async t => {
  const decision = { approved: true, summary: 'The exact patch satisfies the acceptance criteria.' };
  const events = [...claudeEvents.slice(0, -1), { ...claudeEvents.at(-1), result: 'I reviewed the change. Here is my decision:\n' + JSON.stringify(decision), structured_output: decision }];
  const f = await fixture(t, { events });
  const result = await f.run({ ...f.job, mode: 'read-only', reviewFor }, f.role);
  assert.deepEqual(JSON.parse(result.text), decision);
  const args = f.calls.at(-1).args;
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema, { type: 'object', properties: { approved: { type: 'boolean' }, summary: { type: 'string', minLength: 1 } }, required: ['approved', 'summary'], additionalProperties: false });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
});

test('invalid structured review decisions are refused without falling back to prose', async t => {
  for (const decision of [{ approved: 'true', summary: 'Incorrect type.' }, { approved: true, summary: '' }, { approved: true, summary: '   ' }, { approved: true, summary: 'Extra field.', extra: true }, null, []]) {
    const events = [...claudeEvents.slice(0, -1), { ...claudeEvents.at(-1), result: '{"approved":true,"summary":"Do not use this fallback."}', structured_output: decision }];
    const f = await fixture(t, { events });
    await assert.rejects(f.run({ ...f.job, mode: 'read-only', reviewFor }, f.role), /invalid decision/);
  }
});

test('review decisions reject prose but preserve valid JSON when structured_output is absent', async t => {
  const prose = await fixture(t, { events: [...claudeEvents.slice(0, -1), { ...claudeEvents.at(-1), result: 'Here is my decision: {"approved":true,"summary":"Good."}' }] });
  await assert.rejects(prose.run({ ...prose.job, reviewFor }, prose.role), /only a JSON decision/);
  const decision = { approved: false, summary: 'A correctness issue remains.' };
  const valid = await fixture(t, { events: [...claudeEvents.slice(0, -1), { ...claudeEvents.at(-1), result: JSON.stringify(decision) }] });
  assert.deepEqual(JSON.parse((await valid.run({ ...valid.job, reviewFor }, valid.role)).text), decision);
});

test('Codex reviews use an exact schema file in the task folder and retain read-only sandbox', async t => {
  const decision = { approved: true, summary: 'Reviewed patch and tests.' };
  const events = codexEvents.map(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.phase !== 'commentary' ? { ...event, item: { ...event.item, text: JSON.stringify(decision) } } : event);
  const f = await fixture(t, { events });
  const job = { ...f.job, mode: 'read-only', reviewFor };
  const role = { ...f.role, provider: 'codex', model: 'gpt-6-sol' };
  assert.deepEqual(JSON.parse((await f.run(job, role)).text), decision);
  const args = f.calls.at(-1).args;
  const schemaPath = args[args.indexOf('--output-schema') + 1];
  assert.equal(schemaPath, path.join(f.workspace, 'review-schema.json'));
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['approved', 'summary']);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--cd') + 1], f.workspace);
  assert.equal(args.at(-1), '-');
  assert.deepEqual(JSON.parse((await f.run(job, role)).text), decision, 'The unchanged regular schema file may be reused');
});

test('Codex review schema creation preserves incompatible existing files and rejects editing mode', async t => {
  const f = await fixture(t);
  const schemaPath = path.join(f.workspace, 'review-schema.json');
  await writeFile(schemaPath, 'Existing task artifact must survive.\n');
  await assert.rejects(f.run({ ...f.job, reviewFor }, { ...f.role, provider: 'codex', model: 'gpt-6-sol' }), /Existing review schema/);
  assert.equal(await readFile(schemaPath, 'utf8'), 'Existing task artifact must survive.\n');
  assert.ok(f.calls.every(call => call.args.includes('--version') || call.args.includes('--help') || call.args.includes('login')));
  const untouched = await fixture(t, {}, { sandboxMode: 'workspace-write' });
  await assert.rejects(untouched.run({ ...untouched.job, reviewFor, mode: 'workspace-write' }, untouched.role), /must use read-only/);
  assert.equal(untouched.calls.length, 0);
});

test('adapter refuses truncated success and nonzero exits', async t => {
  const f = await fixture(t, { events: [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }] });
  await assert.rejects(f.run(f.job, f.role), /complete final response/);
  const bad = await fixture(t, { exitCode: 1 });
  await assert.rejects(bad.run(bad.job, bad.role), /exited unsuccessfully/);
});

test('adapter bounds worker time and cancels its process', async t => {
  const f = await fixture(t, { hang: true }, { workerTimeoutMs: 1000 });
  await assert.rejects(f.run(f.job, f.role), /timed out/);
  assert.equal(f.calls.at(-1).child.killed, true);
  assert.equal(f.calls.at(-1).child.closed, true);
});

function cancelOnStart(f) {
  const controller = new AbortController();
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const state = { settled: false };
  const result = f.run({ ...f.job, signal: controller.signal }, f.role, event => {
    if (event.type === 'process') {
      assert.equal(event.pid, 12345);
      started();
      controller.abort();
    }
  }).then(
    value => { state.settled = true; return { value }; },
    error => { state.settled = true; return { error }; },
  );
  return { start, result, state };
}

test('cancellation does not release the worker before direct-kill close is observed', async t => {
  const f = await fixture(t, { hang: true, workerPid: 12345, killCloseDelay: 60 }, {}, { platform: 'linux', terminationTimeoutMs: 300 });
  const run = cancelOnStart(f);
  await run.start;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(run.state.settled, false);
  const { error } = await run.result;
  assert.match(error.message, /cancelled/);
  assert.equal(error.code, undefined);
  assert.equal(f.calls.at(-1).child.closed, true);
});

test('Windows taskkill failures and stalls fall back to direct kill and await close', async t => {
  for (const taskkill of ['nonzero', 'error', 'hang']) {
    await t.test(taskkill, async t => {
      const f = await fixture(t, { hang: true, workerPid: 12345, taskkill, killCloseDelay: 10 }, {}, { platform: 'win32', terminationTimeoutMs: 160 });
      const { error } = await cancelOnStart(f).result;
      assert.match(error.message, /cancelled/);
      assert.equal(error.code, undefined);
      const workerCall = f.calls.find(call => call.args.includes('-p'));
      const killerCall = f.calls.find(call => path.basename(call.executable).toLowerCase() === 'taskkill.exe');
      assert.equal(workerCall.child.killCalls, 1);
      assert.equal(workerCall.child.closed, true);
      assert.deepEqual(killerCall.args, ['/PID', '12345', '/T', '/F']);
      assert.equal(killerCall.options.shell, false);
      assert.equal(killerCall.options.windowsHide, true);
    });
  }
});

test('successful taskkill still waits for observed worker close', async t => {
  const f = await fixture(t, { hang: true, workerPid: 12345, taskkill: 'success', workerCloseDelay: 60 }, {}, { platform: 'win32', terminationTimeoutMs: 300 });
  const run = cancelOnStart(f);
  await run.start;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(run.state.settled, false);
  const { error } = await run.result;
  assert.match(error.message, /cancelled/);
  const workerCall = f.calls.find(call => call.args.includes('-p'));
  assert.equal(workerCall.child.closed, true);
  assert.equal(workerCall.child.killCalls, undefined);
});

test('unconfirmed shutdown is bounded and identifiable even when taskkill reports success', async t => {
  for (const taskkill of ['success', 'nonzero']) {
    await t.test(taskkill, async t => {
      const f = await fixture(t, { hang: true, workerPid: 12345, taskkill, noWorkerClose: true, ignoreWorkerKill: true }, {}, { platform: 'win32', terminationTimeoutMs: 60 });
      const { error } = await cancelOnStart(f).result;
      assert.equal(error.code, 'WORKER_TERMINATION_UNCERTAIN');
      assert.equal(error.workerPid, 12345);
      assert.match(error.message, /pause this provider/);
      const workerCall = f.calls.find(call => call.args.includes('-p'));
      assert.equal(workerCall.child.closed, undefined);
      assert.equal(workerCall.child.stdout.destroyed, true);
    });
  }
});

test('final response redacts recognizable credentials', async t => {
  const f = await fixture(t, { events: [{ type: 'result', subtype: 'success', result: 'key sk-test1234567890 and password=secret123' }] });
  const result = await f.run(f.job, f.role);
  assert.equal(result.text.includes('test1234567890'), false);
  assert.equal(result.text.includes('secret123'), false);
});
