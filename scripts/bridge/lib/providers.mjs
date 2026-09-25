import { spawn as nativeSpawn } from 'node:child_process';
import { realpath, stat, lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ENV = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE',
  'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME',
]);
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_TEXT = 256 * 1024;
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, summary: { type: 'string', minLength: 1 } },
  required: ['approved', 'summary'],
  additionalProperties: false,
};

async function reviewSchemaFile(workspace) {
  const schemaPath = path.join(workspace, 'review-schema.json');
  const content = `${JSON.stringify(REVIEW_SCHEMA, null, 2)}\n`;
  let handle;
  try { handle = await open(schemaPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(schemaPath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(schemaPath) !== schemaPath || await readFile(schemaPath, 'utf8') !== content) {
      throw new Error('Existing review schema is not the expected regular file in this task folder.');
    }
    return schemaPath;
  }
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return schemaPath;
}

function strictReviewText(text) {
  let decision;
  try { decision = JSON.parse(text); }
  catch { throw new Error('Review worker must return only a JSON decision with approved and summary.'); }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).length !== 2 ||
      !Object.hasOwn(decision, 'approved') || !Object.hasOwn(decision, 'summary') ||
      typeof decision.approved !== 'boolean' || typeof decision.summary !== 'string' || !decision.summary.trim()) {
    throw new Error('Review worker returned an invalid decision; approved must be boolean and summary nonempty, with no additional properties.');
  }
  // Redact the summary before serializing so escaping and JSON validity are preserved.
  return JSON.stringify({ approved: decision.approved, summary: publicText(decision.summary) });
}

// Only non-secret OS/runtime settings reach the child. In particular, do not
// inherit API keys, provider URLs, proxy credentials, NODE_OPTIONS or SDK tokens.
export function subscriptionEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_ENV.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  env.NO_COLOR = '1';
  env.CLAUDE_CODE_DISABLE_FAST_MODE = '1';
  env.DISABLE_EXTRA_USAGE_COMMAND = '1';
  return env;
}

function publicText(value) {
  return String(value ?? '').slice(0, MAX_TEXT)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[redacted]');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function atLeast(version, minimum) {
  const actual = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!actual) return false;
  const numbers = actual.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (numbers[i] !== minimum[i]) return numbers[i] > minimum[i];
  }
  return true;
}

function timeoutValue(config) {
  const value = config.workerTimeoutMs ?? 300_000;
  if (!Number.isFinite(value) || value < 1000 || value > 900_000) {
    throw new Error('workerTimeoutMs must be between 1000 and 900000.');
  }
  return value;
}

function terminateChild(child, spawn, env, attemptFinished, options) {
  // Node's Windows kill does not terminate grandchildren. taskkill receives
  // only a numeric PID and is called directly, never through a shell.
  const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  let active = true;
  let completed = false;
  let killer;
  let killerClosed = false;
  let watchdog;
  const directKill = () => {
    if (!active || completed) return;
    completed = true;
    clearTimeout(watchdog);
    if (killer && !killerClosed) { try { killer.kill(); } catch {} }
    try { child.kill('SIGKILL'); } catch {}
    attemptFinished();
  };
  const cleanup = () => {
    active = false;
    clearTimeout(watchdog);
    if (killer && !killerClosed) { try { killer.kill(); } catch {} }
  };
  if (options.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0 && systemRoot) {
    try {
      killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore', env });
      killer.on('error', directKill);
      killer.on('close', code => {
        killerClosed = true;
        if (!active || completed) return;
        if (code !== 0) return directKill();
        completed = true;
        clearTimeout(watchdog);
        attemptFinished();
      });
      watchdog = setTimeout(directKill, Math.min(1000, options.terminationTimeoutMs / 2));
      return cleanup;
    } catch {}
  }
  directKill();
  return cleanup;
}

function execute(spawn, executable, args, options) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    let shutdownTimer;
    let stoppingError;
    let workerClosed = false;
    let terminationAttemptFinished = false;
    let cleanupTermination = () => {};
    let bytes = 0;
    let stdout = '';
    let stderr = '';
    let pending = '';
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      cleanupTermination();
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    const stop = message => {
      if (settled || stoppingError) return;
      stoppingError = new Error(message);
      clearTimeout(timer);
      shutdownTimer = setTimeout(() => {
        const error = Object.assign(new Error(`${message} Worker shutdown could not be confirmed; pause this provider before starting another worker.`), {
          code: 'WORKER_TERMINATION_UNCERTAIN',
          workerPid: Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null,
        });
        // A possibly orphaned process must not keep the coordinator alive or
        // continue filling its pipes after the bounded shutdown deadline.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref?.();
        finish(error);
      }, options.terminationTimeoutMs);
      cleanupTermination = terminateChild(child, spawn, options.env, () => {
        terminationAttemptFinished = true;
        if (workerClosed) finish(stoppingError);
      }, options);
    };
    const abort = () => stop('Worker cancelled.');
    if (options.signal?.aborted) return finish(new Error('Worker cancelled.'));
    try {
      child = spawn(executable, args, {
        cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return finish(new Error('Could not start the configured worker executable.'));
    }
    timer = setTimeout(() => stop('Worker timed out.'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => {
      if (Number.isInteger(child.pid) && child.pid > 0) stop('Worker process reported an error.');
      else finish(new Error('Could not start the configured worker executable.'));
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled || stoppingError) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return stop('Worker output exceeded the safety limit.');
      if (options.capture) stdout += chunk;
      else {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length > MAX_LINE) return stop('Worker event exceeded the safety limit.');
          try { options.onLine(line); } catch (error) { return stop(error.message); }
        }
        if (pending.length > MAX_LINE) stop('Worker event exceeded the safety limit.');
      }
    });
    child.stderr.on('data', chunk => {
      if (settled || stoppingError) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return stop('Worker output exceeded the safety limit.');
      // Preflight stderr is inspected in memory; never return it to users/logs.
      if (options.capture) stderr += chunk;
    });
    child.on('close', code => {
      workerClosed = true;
      if (settled) return;
      if (stoppingError) {
        if (terminationAttemptFinished) finish(stoppingError);
        return;
      }
      if (!options.capture && pending.trim()) {
        try { options.onLine(pending); } catch (error) { return finish(error); }
      }
      finish(null, code);
    });
    child.stdin.on('error', () => stop('Worker input stream closed unexpectedly.'));
    child.stdin.end(options.input ?? '');
    if (Number.isInteger(child.pid) && child.pid > 0) options.onSpawn?.(child.pid);
  });
}

function resultParser(provider, expectedModel, emit, isReview = false) {
  let text = '';
  let sessionId = null;
  let model = null;
  let complete = false;
  let failed = false;
  const observeModel = value => {
    if (typeof value !== 'string' || !value) return;
    if (value !== expectedModel) throw new Error('Worker selected a different model; run stopped.');
    model = value;
  };
  return {
    line(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      observeModel(event.model);
      observeModel(event.message?.model);
      if (provider === 'claude') {
        if (event.type === 'system' && event.subtype === 'init') {
          sessionId = typeof event.session_id === 'string' ? event.session_id : null;
          emit({ type: 'progress', status: 'started', message: 'Claude worker started.' });
        }
        if (event.type === 'assistant' && event.message?.content?.some(block => block.type === 'tool_use')) {
          emit({ type: 'progress', status: 'working', message: 'Claude is reading project files.' });
        }
        if (event.type === 'result') {
          for (const used of Object.keys(event.modelUsage ?? {})) observeModel(used);
          failed ||= event.is_error === true || (event.subtype && event.subtype !== 'success');
          complete = true;
          text = Object.hasOwn(event, 'structured_output') ? JSON.stringify(event.structured_output) : typeof event.result === 'string' ? event.result : '';
          if (typeof event.session_id === 'string') sessionId = event.session_id;
        }
      } else {
        if (event.type === 'thread.started') {
          sessionId = typeof event.thread_id === 'string' ? event.thread_id : null;
          emit({ type: 'progress', status: 'started', message: 'Codex worker started.' });
        }
        if (event.type === 'item.started') {
          emit({ type: 'progress', status: 'working', message: 'Codex is working on the task.' });
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.phase !== 'commentary') {
          text = typeof event.item.text === 'string' ? event.item.text : '';
        }
        if (event.type === 'turn.completed') complete = true;
        if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      }
    },
    result() {
      if (failed) throw new Error('Worker reported an error; inspect its sign-in and subscription usage in the provider app.');
      if (!complete || !text.trim()) throw new Error('Worker finished without a complete final response.');
      // Codex exec does not always report the actual model. The returned model
      // is the requested model unless the stream verified it explicitly.
      return { text: isReview ? strictReviewText(text) : publicText(text), sessionId, model: model ?? expectedModel, modelVerified: model !== null };
    },
  };
}

/** Subscription-only CLI adapter. The third argument is for isolated tests. */
export function createAdapter(root, config = {}, dependencies = {}) {
  const spawn = dependencies.spawn ?? nativeSpawn;
  const envSource = dependencies.env ?? process.env;
  return async (job, roleConfig, onEvent = () => {}) => {
    if (!['codex', 'claude'].includes(roleConfig?.provider)) throw new Error('Unknown worker provider.');
    const { provider, model, executable } = roleConfig;
    const isReview = Boolean(job?.reviewFor);
    if (job?.mode && !['read-only', 'workspace-write'].includes(job.mode)) throw new Error('Unknown workspace permission mode.');
    if (isReview && job.mode && job.mode !== 'read-only') throw new Error('Independent review workers must use read-only mode.');
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error('An exact model ID is required.');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) ||
        (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe')) {
      throw new Error('Configure an absolute native worker executable path.');
    }
    if (typeof job?.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > MAX_TEXT) throw new Error('A nonempty prompt of at most 256 KiB is required.');
    if (config.subscriptionOnlyConfirmed !== true) {
      throw new Error('Confirm paid usage credits and extra usage are disabled for both providers before enabling subscription-only workers.');
    }
    const timeoutMs = timeoutValue(config);
    const departmentRoot = await realpath(root);
    const workspaceRoot = await realpath(config.workspaceRoot ?? path.join(departmentRoot, 'work', 'jobs'));
    if (!inside(departmentRoot, workspaceRoot)) throw new Error('Workspace root must remain inside the department folder.');
    if (typeof job.workspace !== 'string' || !path.isAbsolute(job.workspace)) throw new Error('An absolute job workspace is required.');
    const artifactWorkspace = await realpath(job.workspace);
    if (!inside(workspaceRoot, artifactWorkspace) || !(await stat(artifactWorkspace)).isDirectory()) throw new Error('Job workspace is outside the permitted workspace root.');
    let cwd = artifactWorkspace;
    if (job.mode === 'workspace-write') {
      if (config.sandboxMode !== 'workspace-write') throw new Error('Workspace writes require an explicit adapter configuration.');
      if (!job.projectWorkspace?.path || !Array.isArray(job.allowedPaths) || !job.allowedPaths.length) throw new Error('Editing requires a verified isolated project workspace and explicit paths.');
      const projectRoot = await realpath(path.join(departmentRoot, 'work', 'projects'));
      cwd = await realpath(job.projectWorkspace.path);
      if (cwd !== await realpath(path.join(projectRoot, job.id)) || !inside(projectRoot, cwd)) throw new Error('Project workspace is outside the assigned task folder.');
    }
    if (!(await stat(executable)).isFile()) throw new Error('Configured worker executable does not exist.');
    const env = subscriptionEnvironment(envSource);
    const emit = event => { try { Promise.resolve(onEvent(event)).catch(() => {}); } catch {} };
    const run = (args, options = {}) => execute(spawn, executable, args, {
      env, cwd, timeoutMs, signal: job.signal,
      platform: dependencies.platform ?? process.platform,
      terminationTimeoutMs: Math.min(5000, Math.max(10, dependencies.terminationTimeoutMs ?? 5000)),
      ...options,
    });
    const preflight = async args => {
      const result = await run(args, { capture: true, timeoutMs: Math.min(timeoutMs, 30_000) });
      if (result.code !== 0) throw new Error(`${provider} preflight failed. Check the executable and sign-in in its app.`);
      return result;
    };
    emit({ type: 'progress', status: 'preflight', message: 'Checking subscription sign-in and worker version.' });
    const version = await preflight(['--version']);
    let args;
    if (provider === 'claude') {
      const required = model === 'claude-opus-5-5' ? [2, 1, 280] : [2, 1, 259];
      if (!atLeast(version.stdout, required)) throw new Error(`Claude Code ${required.join('.')} or newer is required for this worker.`);
      const auth = await preflight(['--safe-mode', 'auth', 'status', '--json']);
      let account;
      try { account = JSON.parse(auth.stdout); } catch { throw new Error('Claude subscription sign-in could not be verified.'); }
      if (account.loggedIn !== true || account.authMethod !== 'claude.ai' || account.apiProvider !== 'firstParty' ||
          !['pro', 'max', 'team', 'enterprise'].includes(String(account.subscriptionType).toLowerCase())) {
        throw new Error('Claude worker requires first-party Claude subscription sign-in. API billing is not permitted.');
      }
      const writeRules = job.mode === 'workspace-write' ? job.allowedPaths.map(p => {
        if (/[\\\n\r,:*?\[\]()!]/.test(p) || p.startsWith('/') || p.split('/').some(x => ['.', '..', '.git'].includes(x))) throw new Error('Invalid editing scope.');
        return `Edit(/${p}${p.endsWith('/') ? '**' : ''})`;
      }) : [];
      args = ['--safe-mode', '-p', '--output-format', 'stream-json', '--verbose', '--model', model,
        '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--tools', job.mode === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep', '--allowedTools', ['Read','Glob','Grep',...writeRules].join(','),
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--settings', '{"forceLoginMethod":"claudeai","fastMode":false,"fastModePerSessionOptIn":true,"switchModelsOnFlag":false}',
        '--no-session-persistence', ...(isReview ? ['--json-schema', JSON.stringify(REVIEW_SCHEMA)] : [])];
    } else {
      const help = await preflight(['exec', '--help']);
      for (const flag of ['--ignore-user-config', '--ephemeral', '--json', '--sandbox', ...(isReview ? ['--output-schema'] : [])]) {
        if (!help.stdout.includes(flag)) throw new Error(`Codex worker requires a CLI supporting ${flag}.`);
      }
      const auth = await preflight(['login', 'status', '-c', 'forced_login_method="chatgpt"']);
      const status = `${auth.stdout}\n${auth.stderr}`;
      if (!/^\s*Logged in using ChatGPT\s*$/im.test(status) || /(?:API[ _-]?key|not logged|logged out)/i.test(status)) {
        throw new Error('Codex worker requires ChatGPT subscription sign-in. API billing is not permitted.');
      }
      const configuredSandbox = config.sandboxMode ?? 'read-only';
      if (!['read-only', 'workspace-write'].includes(configuredSandbox)) throw new Error('Only read-only and workspace-write sandboxes are allowed.');
      if (job.mode === 'workspace-write' && configuredSandbox !== 'workspace-write') throw new Error('Workspace writes require an explicit adapter configuration.');
      const sandbox = job.mode === 'workspace-write' ? 'workspace-write' : 'read-only';
      const schemaPath = isReview ? await reviewSchemaFile(artifactWorkspace) : null;
      args = ['exec', '--json', '--color', 'never', '--sandbox', sandbox, '--cd', cwd,
        '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
        '--model', model, '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
        '-c', 'hide_agent_reasoning=true', '-c', 'approval_policy="never"',
        ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
        ...(schemaPath ? ['--output-schema', schemaPath] : []), '-'];
    }
    const parser = resultParser(provider, model, emit, isReview);
    const completed = await run(args, {
      input: job.prompt, onLine: parser.line,
      onSpawn: pid => emit({ type: 'process', status: 'started', pid }),
    });
    if (completed.code !== 0) throw new Error(`${provider} worker exited unsuccessfully. Check sign-in, model availability and subscription limits in its app.`);
    const result = parser.result();
    emit({ type: 'progress', status: 'completed', message: 'Worker completed its response.' });
    return result;
  };
}
