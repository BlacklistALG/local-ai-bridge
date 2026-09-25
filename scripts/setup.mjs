import { mkdir, readFile, writeFile, readdir, copyFile, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(skillRoot, 'scripts', 'bridge');
const workerInstructions = 'Complete only the assigned bounded task. Report results, validation, and limitations. Do not invoke this bridge, spawn other agents, publish, send messages, or change account settings. You report to the coordinating assistant; the user is Product Owner.';

export function parseOptions(args) {
  const accepted = new Set(['destination', 'codex', 'claude', 'codex-model', 'claude-model']);
  const options = { confirmed: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm-subscriptions-only') { options.confirmed = true; continue; }
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !accepted.has(key) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Unknown or missing setup argument. Read references/setup.md.');
    if (options[key] !== undefined) throw new Error(`Duplicate --${key}.`);
    options[key] = args[++i];
  }
  if (!options.destination || !path.isAbsolute(options.destination)) throw new Error('--destination must be an absolute path to a new private folder.');
  return options;
}

export function makeConfig(options) {
  const role = (provider, name) => ({ name, provider, model: options[`${provider}-model`] ?? '', executable: options[provider] ?? '', instructions: workerInstructions });
  return {
    subscriptionOnlyConfirmed: options.confirmed === true,
    maxParallel: 2, providerCaps: { codex: 1, claude: 1 }, workerTimeoutMs: 300000,
    sandboxMode: 'read-only', projects: {}, notion: { syncMode: 'disabled' },
    roles: { 'codex-worker': role('codex', 'Codex worker'), 'claude-worker': role('claude', 'Claude worker') },
  };
}

async function sourceFiles(folder, prefix = '') {
  const output = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Runtime bundle must not contain symlinks.');
    if (entry.isDirectory() && ['lib', 'scripts', 'tests'].includes(relative)) output.push(...await sourceFiles(path.join(folder, entry.name), relative));
    else if (entry.isFile() && (['bridge.mjs', 'package.json', '.gitignore'].includes(relative) || /^(lib|scripts|tests)\/[^/]+\.mjs$/.test(relative))) output.push(relative);
  }
  return output;
}

export async function setup(options, { platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('This release supports Windows only; macOS/Linux require platform validation and a different credential store.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const destination = path.resolve(options.destination);
  const relative = path.relative(skillRoot, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Keep the private installation outside the shareable skill folder.');
  for (const provider of ['codex', 'claude']) {
    if (options[provider]) {
      if (!path.isAbsolute(options[provider]) || path.extname(options[provider]).toLowerCase() !== '.exe' || !(await lstat(options[provider])).isFile()) throw new Error(`--${provider} must name an existing absolute native .exe path.`);
    }
    const model = options[`${provider}-model`];
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(model)) throw new Error(`Invalid exact ${provider} model ID.`);
  }
  try { await access(destination); throw new Error('Destination already exists. Reuse it or choose a new folder; setup never overwrites an installation.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = await sourceFiles(runtime);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination); // Exclusive: a competing setup must not be overwritten.
  for (const relativeFile of files) {
    const target = path.join(destination, relativeFile);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(runtime, relativeFile), target, constants.COPYFILE_EXCL);
  }
  const config = makeConfig(options);
  await copyFile(path.join(skillRoot, 'LICENSE'), path.join(destination, 'LICENSE'), constants.COPYFILE_EXCL);
  await writeFile(path.join(destination, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(destination, 'INSTALLATION.md'), '# Private Local AI Bridge installation\n\nDo not publish this folder. It can contain credentials, prompts, and project work.\n\nRun `node scripts/doctor.mjs` here to inspect configuration. Finish setup using the skill references. Nothing is authenticated or connected merely by copying the files. No model was invoked, watcher started, or system service installed.\n', { flag: 'wx' });
  return { destination, configuredRoles: Object.keys(config.roles), subscriptionOnlyConfirmed: config.subscriptionOnlyConfirmed, notionEnabled: false, modelInvoked: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await setup(parseOptions(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
