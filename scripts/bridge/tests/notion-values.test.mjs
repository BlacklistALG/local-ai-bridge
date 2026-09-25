import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalNotionText, notionValueEquals } from '../lib/notion-values.mjs';
import { NotionMcpTransport } from '../lib/notion-mcp.mjs';
import { NotionSync, notionProperties } from '../lib/notion-sync.mjs';
import { Store } from '../lib/store.mjs';

test('board distinguishes requested changes from an approved review without revealing its private text', () => {
  const properties = notionProperties({ id: 'review', role: 'reviewer', status: 'done', title: 'Review', reviewFor: { taskId: 'edit' }, result: JSON.stringify({ approved: false, summary: 'PRIVATE_REVIEW' }) }, { roles: {} });
  assert.match(properties.Progress, /Review decision: changes requested/);
  assert.doesNotMatch(JSON.stringify(properties), /PRIVATE_REVIEW/);
});

test('Notion auto-links are equivalent only to their exact visible host/path text', () => {
  assert.equal(canonicalNotionText('Read [WORKFLOW-QUICKSTART.md](http://WORKFLOW-QUICKSTART.md).'), 'Read WORKFLOW-QUICKSTART.md.');
  assert.equal(notionValueEquals('Visit [example.com/help](https://example.com/help).', 'Visit example.com/help.'), true);
  assert.equal(canonicalNotionText('[example.com/help/](https://example.com/help/)'), 'example.com/help/');
  assert.equal(canonicalNotionText('Plain WORKFLOW-QUICKSTART.md'), 'Plain WORKFLOW-QUICKSTART.md');
});

test('intentional destinations and URL components are not discarded', () => {
  for (const value of [
    '[WORKFLOW-QUICKSTART.md](https://elsewhere.example/guide)',
    '[example.com/help](https://example.com/help?token=x)',
    '[example.com/help?token=x](https://example.com/help?token=x)',
    '[example.com#section](https://example.com#section)',
    '[user:password@example.com](https://user:password@example.com)',
    '[example.com](https://example.com/)',
    '[example.com](https://EXAMPLE.COM)',
    '[example.com/help](https://example.com/%68elp)',
    '[example.com](ftp://example.com)',
    '[example.com](https://example.com "Intentional title")',
    '\\[example.com](https://example.com)',
    '[example.com](javascript:example.com)',
  ]) assert.equal(canonicalNotionText(value), value);
  assert.equal(notionValueEquals('[guide](https://one.example)', '[guide](https://two.example)'), false);
  assert.equal(notionValueEquals(undefined, ''), false);
  assert.equal(notionValueEquals(1, '1'), false);
});

test('transport verification tolerates auto-links but rejects changed link destinations', () => {
  const transport = new NotionMcpTransport('unused', { client: {}, dataSourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', viewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  assert.doesNotThrow(() => transport.verify({ properties: { Progress: 'Read [NOTES.md](http://NOTES.md)' } }, { Progress: 'Read NOTES.md' }));
  assert.throws(() => transport.verify({ properties: { Progress: 'Read [NOTES.md](http://another.example)' } }, { Progress: 'Read NOTES.md' }), { code: 'NOTION_VERIFY_FAILED' });
});

test('sync accepts a fetched auto-link after create and never rewrites it repeatedly', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notion-normalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ roles: { worker: { provider: 'codex', model: 'test', name: 'Astra CTO' } } }));
  await new Store(root).enqueue({ role: 'worker', title: 'Write NOTES.md', prompt: 'Private task' });
  let card;
  let creates = 0;
  let updates = 0;
  const transport = {
    async findByTaskId() { return card ? structuredClone(card) : null; },
    async createCard(properties) { creates += 1; card = { id: 'page', properties: { ...properties, Task: properties.Task.replace('NOTES.md', '[NOTES.md](http://NOTES.md)') } }; return structuredClone(card); },
    async fetchCard() { return structuredClone(card); },
    async updateCard(_id, properties) { updates += 1; card.properties = { ...properties }; return structuredClone(card); },
  };
  const sync = new NotionSync(root, { transport });
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(creates, 1);
  assert.equal(updates, 0);
  assert.equal(card.properties.Task, 'Write [NOTES.md](http://NOTES.md)');
  card.properties.Task = 'Write [NOTES.md](http://wrong.example)';
  assert.equal((await sync.syncOnce()).ok, true);
  assert.equal(updates, 1, 'a truly different remote destination must still be repaired');
});
