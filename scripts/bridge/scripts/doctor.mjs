import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscriptionEnvironment } from '../lib/providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); }
async function main() {
  check('platform', process.platform === 'win32', 'Release supported on Windows only.');
  check('node', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  let config;
  try { config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')); }
  catch { check('configuration', false, 'Create a private installation with the skill setup helper.'); return; }
  check('subscription settings', config.subscriptionOnlyConfirmed === true, 'User must confirm included-usage-only account settings; this flag is not a provider billing guarantee.');
  const authRequested = process.argv.includes('--auth');
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    const native = typeof role.executable === 'string' && path.isAbsolute(role.executable) && /\.exe$/i.test(role.executable) && await stat(role.executable).then(s => s.isFile(), () => false);
    check(`${name} executable`, native, native ? 'Native executable exists.' : 'Set an absolute installed .exe path.');
    check(`${name} model`, typeof role.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(role.model), 'Specify an exact model available to your account.');
    if (!authRequested || !native) continue;
    const args = role.provider === 'claude' ? ['--safe-mode', 'auth', 'status', '--json'] : ['login', 'status', '-c', 'forced_login_method="chatgpt"'];
    if (!['codex', 'claude'].includes(role.provider)) { check(`${name} provider`, false, 'Unsupported provider.'); continue; }
    const result = spawnSync(role.executable, args, { cwd: root, env: subscriptionEnvironment(), shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    let ok = false;
    if (result.status === 0 && role.provider === 'codex') ok = /^\s*Logged in using ChatGPT\s*$/im.test(`${result.stdout}\n${result.stderr}`) && !/API[ _-]?key/i.test(`${result.stdout}\n${result.stderr}`);
    if (result.status === 0 && role.provider === 'claude') {
      try { const a = JSON.parse(result.stdout); ok = a.loggedIn === true && a.authMethod === 'claude.ai' && a.apiProvider === 'firstParty' && ['pro','max','team','enterprise'].includes(String(a.subscriptionType).toLowerCase()); } catch {}
    }
    check(`${name} subscription authentication`, ok, ok ? 'Subscription authentication verified; no model invoked.' : 'Sign in through the provider app, then retry. Raw account output is not printed.');
  }
  check('Notion setting', ['disabled','direct-mcp'].includes(config.notion?.syncMode), config.notion?.syncMode === 'direct-mcp' ? 'Configured only: use notion-status and a live transition to verify.' : 'Optional synchronization is disabled.');
}
await main();
console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks, modelInvoked: false }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;
