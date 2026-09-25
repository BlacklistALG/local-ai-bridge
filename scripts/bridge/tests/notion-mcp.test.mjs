import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NOTION_ORIGIN, pkce, validCallback, discoverOAuth, getAccessToken, parseRpcResponse, parseCard, notionId, matchesSchema, NotionMcpTransport } from '../lib/notion-mcp.mjs';

const BOARD = Object.freeze({
  dataSourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  databaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  viewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
});
const cardId = '11111111-2222-4333-8444-555555555555';

test('public transport requires recipient board configuration and has no working defaults', () => {
  assert.throws(() => new NotionMcpTransport('.'), /Invalid Notion page ID/);
  for (const key of ['dataSourceId', 'databaseId', 'viewId']) {
    assert.throws(() => new NotionMcpTransport('.', { ...BOARD, [key]: undefined }), /Invalid Notion page ID/);
  }
  const custom = { dataSourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', databaseId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', viewId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
  const transport = new NotionMcpTransport('.', custom);
  assert.equal(transport.dataSourceId, custom.dataSourceId);
  assert.equal(transport.databaseId, custom.databaseId);
  assert.equal(transport.viewId, custom.viewId);
});
const makeResult = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const schema = {
  Task: { type: 'title' }, 'Local task ID': { type: 'text' }, Progress: { type: 'text' },
  Status: { type: 'select', options: [{ name: 'Ready' }, { name: 'Review' }, { name: 'Done' }] },
  Updated: { type: 'last_edited_time' },
};
const cardResult = (properties, source = BOARD.dataSourceId, id = cardId) => makeResult({
  url: `https://app.notion.com/p/${id.replaceAll('-', '')}`,
  text: `<page><ancestor-path><parent-data-source url="collection://${source}" name="Tasks"/></ancestor-path><properties>\n${JSON.stringify(properties)}\n</properties></page>`,
});

test('PKCE uses a random verifier with S256, and state is independent', () => {
  const proof = pkce();
  assert.match(proof.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(proof.challenge, createHash('sha256').update(proof.verifier).digest('base64url'));
  assert.notEqual(proof.verifier, proof.state);
  assert.notEqual(pkce().verifier, proof.verifier);
});

test('callback requires exact loopback host/path, nonempty code and constant-time comparable state', () => {
  const expected = { state: 'secret-state', host: '127.0.0.1:43210' };
  assert.equal(validCallback('/oauth/callback?code=ok&state=secret-state', expected), true);
  for (const value of ['/oauth/callback?code=ok&state=wrong', '/other?code=ok&state=secret-state', 'http://evil.example/oauth/callback?code=ok&state=secret-state', '/oauth/callback?code=ok&state=secret-state&error=access_denied', '/oauth/callback?state=secret-state', '/oauth/callback?code=ok&state=éééééééééééé']) {
    assert.equal(validCallback(value, expected), false);
  }
});

test('OAuth discovery pins issuer, authorization service and every endpoint', async () => {
  const metadata = { issuer: NOTION_ORIGIN, code_challenge_methods_supported: ['S256'], authorization_endpoint: `${NOTION_ORIGIN}/authorize`, token_endpoint: `${NOTION_ORIGIN}/token`, registration_endpoint: `${NOTION_ORIGIN}/register` };
  const fetchImpl = async url => new Response(JSON.stringify(url.endsWith('oauth-protected-resource') ? { resource: NOTION_ORIGIN, authorization_servers: [NOTION_ORIGIN] } : metadata), { headers: { 'content-type': 'application/json' } });
  assert.equal((await discoverOAuth(fetchImpl)).token_endpoint, `${NOTION_ORIGIN}/token`);
  metadata.token_endpoint = 'https://evil.example/token';
  await assert.rejects(discoverOAuth(fetchImpl), /unexpected authentication endpoint/);
});

function memoryStore(initial) {
  let value = initial; let tail = Promise.resolve();
  return {
    read: async () => structuredClone(value),
    write: async next => { value = structuredClone(next); },
    withLock: callback => { const result = tail.then(callback); tail = result.catch(() => {}); return result; },
  };
}

test('concurrent token use serializes refresh and stores rotation before returning', async () => {
  const store = memoryStore({ client_id: 'client', access_token: 'expired', refresh_token: 'old-refresh', expires_at: 0 });
  let refreshes = 0;
  const fetchImpl = async (_url, options) => {
    refreshes++;
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'old-refresh');
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 });
  };
  assert.deepEqual(await Promise.all([getAccessToken(store, fetchImpl), getAccessToken(store, fetchImpl)]), ['new-access', 'new-access']);
  assert.equal(refreshes, 1);
  assert.equal((await store.read()).refresh_token, 'new-refresh');
});

test('invalid grant removes dead tokens and never prints server-supplied credentials', async () => {
  const store = memoryStore({ client_id: 'client', access_token: 'expired', refresh_token: 'dead-refresh', expires_at: 0 });
  const fetchImpl = async () => Response.json({ error: 'invalid_grant', error_description: 'SECRET_MUST_NOT_APPEAR' }, { status: 400 });
  await assert.rejects(getAccessToken(store, fetchImpl), error => error.code === 'REAUTH_REQUIRED' && !error.message.includes('SECRET_MUST_NOT_APPEAR'));
  const saved = await store.read();
  assert.equal(saved.access_token, undefined); assert.equal(saved.refresh_token, undefined);
  await assert.rejects(getAccessToken(store, fetchImpl), error => error.code === 'REAUTH_REQUIRED');
});

test('MCP response parser accepts JSON/SSE, matches response ID, and strips server error text', () => {
  assert.deepEqual(parseRpcResponse('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}', 'application/json', 2), { ok: true });
  assert.deepEqual(parseRpcResponse('event: message\r\ndata: {"jsonrpc":"2.0","method":"ping"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\r\n\r\n', 'text/event-stream', 3), { ok: true });
  assert.throws(() => parseRpcResponse('{"id":2,"result":{}}', 'application/json', 1), /requested MCP response/);
  assert.throws(() => parseRpcResponse('{"id":2,"error":{"code":-1,"message":"secret"}}', 'application/json', 2), error => !error.message.includes('secret'));
});

test('card parser requires exact parent data source and rejects unofficial URLs', () => {
  assert.equal(parseCard(cardResult({ 'Local task ID': 'job-1', Status: 'Review' }), BOARD.dataSourceId).id, cardId);
  assert.throws(() => parseCard(cardResult({}, cardId), BOARD.dataSourceId), error => error.code === 'NOTION_SCOPE');
  assert.throws(() => notionId(`https://evil.example/${cardId}`), /outside the official/);
  assert.throws(() => notionId('bogus'), /Invalid/);
});

test('runtime tool input schema validation checks union, required values, object and array types', () => {
  const input = { type: 'object', required: ['data'], additionalProperties: false, properties: { data: { anyOf: [{ type: 'object', required: ['mode'], properties: { mode: { const: 'view' } } }, { type: 'string' }] } } };
  assert.equal(matchesSchema(input, { data: { mode: 'view' } }), true);
  assert.equal(matchesSchema(input, { data: { mode: 'sql' } }), false);
  assert.equal(matchesSchema(input, {}), false);
  assert.equal(matchesSchema(input, { data: 'ok', secret: true }), false);
});

function mockClient({ duplicate = false, omitVerify = false, wrongParent = false, filtered = false, uncertainCreate = false } = {}) {
  let properties = { Task: 'Task', 'Local task ID': 'job-1', Status: 'Ready', Progress: '' };
  const calls = [];
  const names = ['fetch', 'get-tool-access', 'query-data-sources', 'create-pages', 'update-page'];
  const tools = names.map(name => ({ name: `notion-${name}`, inputSchema: { type: 'object', properties: name === 'query-data-sources' ? { data: {} } : {} } }));
  return {
    calls, tools,
    connect: async function () { return this; },
    tool: name => tools.find(item => item.name === `notion-${name}`),
    close: async () => {},
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'fetch' && args.id.startsWith('collection:')) return makeResult({ text: `<data-source-state>${JSON.stringify({ url: `collection://${BOARD.dataSourceId}`, schema })}</data-source-state>` });
      if (name === 'fetch' && args.id.startsWith('view:')) return makeResult({ text: `<view>${JSON.stringify({ dataSourceUrl: `{{collection://${BOARD.dataSourceId}}}`, displayProperties: ['Local task ID'], ...(filtered ? { advancedFilter: {} } : {}) })}</view>` });
      if (name === 'get-tool-access') return makeResult({ current_tool_access: { query_data_sources: { status: 'available_with_limit' } } });
      if (name === 'fetch') return cardResult(properties, wrongParent ? cardId : BOARD.dataSourceId);
      if (name === 'query-data-sources') return makeResult({ results: [properties, ...(duplicate ? [properties] : [])].map(item => ({ ...item, url: `https://app.notion.com/p/${cardId.replaceAll('-', '')}` })), has_more: false });
      if (name === 'update-page') { if (!omitVerify) properties = { ...properties, ...args.properties }; return makeResult({ success: true }); }
      if (name === 'create-pages') { if (!omitVerify) properties = args.pages[0].properties; return makeResult(uncertainCreate ? { success: true } : { pages: [{ id: cardId }] }); }
      throw new Error('Unexpected mock call');
    },
  };
}

test('transport uses unmetered view mode and exact task match for recovery', async () => {
  const client = mockClient(); const transport = new NotionMcpTransport('.', { ...BOARD, client });
  assert.equal((await transport.findByTaskId('job-1')).id, cardId);
  assert.equal(await transport.findByTaskId('job'), null);
  const query = client.calls.find(item => item.name === 'query-data-sources');
  assert.equal(query.args.data.mode, 'view');
  assert.equal(query.args.data.view_url, `view://${BOARD.viewId}`);
});

test('transport fails closed for duplicate IDs or a filtered recovery view', async () => {
  await assert.rejects(new NotionMcpTransport('.', { ...BOARD, client: mockClient({ duplicate: true }) }).findByTaskId('job-1'), error => error.code === 'NOTION_DUPLICATE_CARDS');
  await assert.rejects(new NotionMcpTransport('.', { ...BOARD, client: mockClient({ filtered: true }) }).findByTaskId('job-1'), /unfiltered board view/);
});

test('transport checks parent and task identity before updates, then verifies exact values', async () => {
  const client = mockClient(); const transport = new NotionMcpTransport('.', { ...BOARD, client });
  assert.equal((await transport.updateCard(cardId, { Status: 'Review' })).properties.Status, 'Review');
  await assert.rejects(transport.updateCard(cardId, { 'Local task ID': 'different' }), error => error.code === 'NOTION_SCOPE');
  const scoped = mockClient({ wrongParent: true });
  await assert.rejects(new NotionMcpTransport('.', { ...BOARD, client: scoped }).updateCard(cardId, { Status: 'Done' }), error => error.code === 'NOTION_SCOPE');
  assert.equal(scoped.calls.some(item => item.name === 'update-page'), false);
  await assert.rejects(new NotionMcpTransport('.', { ...BOARD, client: mockClient({ omitVerify: true }) }).updateCard(cardId, { Status: 'Review' }), error => error.code === 'NOTION_VERIFY_FAILED');
});

test('create is data-source-scoped, verified, and uncertain outcomes are never retried by transport', async () => {
  const client = mockClient(); const transport = new NotionMcpTransport('.', { ...BOARD, client });
  await transport.createCard({ Task: 'New task', 'Local task ID': 'job-2', Status: 'Ready' });
  assert.equal(client.calls.find(item => item.name === 'create-pages').args.parent.data_source_id, BOARD.dataSourceId);
  const uncertain = mockClient({ uncertainCreate: true });
  await assert.rejects(new NotionMcpTransport('.', { ...BOARD, client: uncertain }).createCard({ Task: 'New task', 'Local task ID': 'job-2' }), error => error.code === 'NOTION_WRITE_UNCERTAIN');
  assert.equal(uncertain.calls.filter(item => item.name === 'create-pages').length, 1);
});

test('board schema prevents system, unknown, non-text, and invalid enum writes', async () => {
  const client = mockClient(); const transport = new NotionMcpTransport('.', { ...BOARD, client });
  await transport.initialize();
  for (const properties of [{ Updated: 'fake' }, { Unknown: 'x' }, { Status: 'Made up' }, { Progress: { content: 'x' } }]) assert.throws(() => transport.validateProperties(properties));
  assert.equal(client.calls.some(item => item.name === 'update-page'), false);
});
