import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];
const files = [];
const allowed = /^(?:SKILL\.md|README\.md|VALIDATION\.md|LICENSE|\.gitignore|agents\/openai\.yaml|references\/[a-z-]+\.md|scripts\/(?:setup\.mjs|setup\.test\.mjs|check-release\.mjs)|scripts\/bridge\/(?:bridge\.mjs|package\.json|\.gitignore|(?:lib|tests|scripts)\/[^/]+\.mjs))$/;
async function scan(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === '.git' && entry.isDirectory() && !prefix) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { issues.push(`Symlink: ${relative}`); continue; }
    if (entry.isDirectory()) {
      if (!['agents','references','scripts','scripts/bridge','scripts/bridge/lib','scripts/bridge/tests','scripts/bridge/scripts'].includes(relative)) { issues.push(`Unapproved directory: ${relative}`); continue; }
      await scan(path.join(folder, entry.name), relative);
      continue;
    }
    if (!allowed.test(relative)) { issues.push(`Unapproved file: ${relative}`); continue; }
    files.push(relative);
    const text = await readFile(path.join(root, relative), 'utf8');
    if (/\b(?:sk-[A-Za-z0-9_-]{20,}|ntn_[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push(`Possible credential: ${relative}`);
    if (/C:\\{1,2}Users\\{1,2}[^\s"'<>]+/i.test(text)) issues.push(`Personal Windows profile path: ${relative}`);
    if (relative.startsWith('scripts/bridge/lib/') && /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(text)) issues.push(`Fixed identity in runtime: ${relative}`);
  }
}
await scan(root);
for (const required of ['SKILL.md','README.md','LICENSE','VALIDATION.md','scripts/setup.mjs','scripts/bridge/bridge.mjs']) if (!files.includes(required)) issues.push(`Missing ${required}`);
console.log(JSON.stringify({ ok: issues.length === 0, fileCount: files.length, issues, note: 'Heuristic checks supplement review; share source files only, never a private runtime or Git history.' }, null, 2));
if (issues.length) process.exitCode = 1;
