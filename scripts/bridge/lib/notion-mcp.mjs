import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { notionValueEquals } from './notion-values.mjs';

export const NOTION_ORIGIN = 'https://mcp.notion.com';
export const NOTION_ENDPOINT = `${NOTION_ORIGIN}/mcp`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BODY = 8 * 1024 * 1024;

export class NotionConnectionError extends Error {
  constructor(message, code = 'NOTION_CONNECTION') {
    super(message); this.name = 'NotionConnectionError'; this.code = code;
    if (['REAUTH_REQUIRED', 'invalid_grant', 'invalid_client'].includes(code)) this.status = 401;
    if (code === 'access_denied') this.status = 403;
    if (code === 'RATE_LIMITED') this.status = 429;
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url') };
}

export function validCallback(url, { state, host, pathname = '/oauth/callback' }) {
  const parsed = new URL(url, `http://${host}`);
  if (parsed.host !== host || parsed.pathname !== pathname || parsed.searchParams.get('error')) return false;
  const actual = Buffer.from(parsed.searchParams.get('state') || '');
  const expected = Buffer.from(state);
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Boolean(parsed.searchParams.get('code'));
}

function officialEndpoint(value, pathname) {
  const url = new URL(value);
  if (url.origin !== NOTION_ORIGIN || url.pathname !== pathname || url.search || url.hash || url.username || url.password) {
    throw new NotionConnectionError('Notion returned an unexpected authentication endpoint.');
  }
  return url.href;
}

async function boundedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) throw new NotionConnectionError('Notion response exceeded the size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonRequest(url, options = {}, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new NotionConnectionError('Cannot reach the official Notion service.'); }
  const text = await boundedText(response);
  let data;
  try { data = JSON.parse(text); } catch { throw new NotionConnectionError(`Notion returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok) {
    const code = ['invalid_grant', 'invalid_client', 'access_denied', 'temporarily_unavailable'].includes(data?.error) ? data.error : 'request_failed';
    throw new NotionConnectionError(`Notion authentication failed (HTTP ${response.status}; ${code}).`, code);
  }
  return data;
}

export async function discoverOAuth(fetchImpl = fetch) {
  const resource = await jsonRequest(`${NOTION_ORIGIN}/.well-known/oauth-protected-resource`, {}, fetchImpl);
  if (resource.resource !== NOTION_ORIGIN || !resource.authorization_servers?.includes(NOTION_ORIGIN)) throw new NotionConnectionError('Unexpected Notion authorization service.');
  const metadata = await jsonRequest(`${NOTION_ORIGIN}/.well-known/oauth-authorization-server`, {}, fetchImpl);
  if (metadata.issuer !== NOTION_ORIGIN || !metadata.code_challenge_methods_supported?.includes('S256')) throw new NotionConnectionError('Notion authentication discovery did not advertise required PKCE.');
  return {
    authorization_endpoint: officialEndpoint(metadata.authorization_endpoint, '/authorize'),
    token_endpoint: officialEndpoint(metadata.token_endpoint, '/token'),
    registration_endpoint: officialEndpoint(metadata.registration_endpoint, '/register'),
  };
}

// Only this bridge's own tokens cross stdin/stdout here. They are never emitted to logs.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$entropy = [System.Text.Encoding]::UTF8.GetBytes('AI Department Notion OAuth v1')
if ($payload.operation -eq 'protect') {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload.value)
  $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
  [Console]::Out.Write([Convert]::ToBase64String($result))
} elseif ($payload.operation -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String([string]$payload.value)
  $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($result))
} else { throw 'Unsupported operation' }
`;
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Console]::In.ReadToEnd()
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($target, $acl)
`;
function powershell(script, input) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: MAX_BODY,
  });
  if (result.error || result.status !== 0) throw new NotionConnectionError('Windows could not securely store or read this bridge connection.');
  return result.stdout;
}

export class CredentialStore {
  constructor(root) { this.directory = path.join(path.resolve(root), '.private'); this.filename = path.join(this.directory, 'notion-oauth.enc'); }
  async prepare() {
    if (process.platform !== 'win32') throw new NotionConnectionError('Secure Notion credentials require Windows CurrentUser DPAPI on this installation.');
    await fs.mkdir(this.directory, { recursive: true });
    powershell(ACL_SCRIPT, this.directory);
  }
  async exists() { try { await fs.access(this.filename); return true; } catch { return false; } }
  async read() {
    let encrypted;
    try { encrypted = await fs.readFile(this.filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') throw new NotionConnectionError('Notion is not connected. Run the Notion login helper.', 'REAUTH_REQUIRED'); throw error; }
    try { return JSON.parse(powershell(DPAPI_SCRIPT, JSON.stringify({ operation: 'unprotect', value: encrypted }))); }
    catch { throw new NotionConnectionError('The saved Notion connection cannot be read by this Windows user.', 'REAUTH_REQUIRED'); }
  }
  async write(value) {
    await this.prepare();
    const encrypted = powershell(DPAPI_SCRIPT, JSON.stringify({ operation: 'protect', value: JSON.stringify(value) }));
    const temp = `${this.filename}.${randomBytes(8).toString('hex')}.tmp`;
    try { await fs.writeFile(temp, encrypted, { flag: 'wx' }); await fs.rename(temp, this.filename); }
    finally { await fs.rm(temp, { force: true }); }
  }
  async withLock(callback) {
    await this.prepare();
    const lock = path.join(this.directory, 'notion-oauth.lock');
    const deadline = Date.now() + 40000;
    let handle;
    while (!handle) {
      try { handle = await fs.open(lock, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) {
        if (error.code !== 'EEXIST') throw new NotionConnectionError('Notion connection lock could not be acquired.');
        try {
          const old = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (Number.isInteger(old.pid) && old.pid > 0) {
            try { process.kill(old.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') await fs.rm(lock, { force: true }); }
          }
        } catch { /* A writer can be in the middle of creating its lock. */ }
        if (Date.now() > deadline) throw new NotionConnectionError('Another process is updating the Notion connection. Try again later.');
        await delay(200);
      }
    }
    try { return await callback(); }
    finally { await handle.close(); await fs.rm(lock, { force: true }); }
  }
}

function tokenRecord(tokens, previous = {}) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new NotionConnectionError('Notion did not return the required renewable credentials.');
  }
  return { ...previous, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000,
    ...(tokens.workspace_id ? { workspace_id: tokens.workspace_id } : {}), ...(tokens.user_id ? { user_id: tokens.user_id } : {}) };
}

export async function loginNotion(root, { onAuthorize = url => process.stdout.write(`${url}\n`), timeoutMs = 600000, fetchImpl = fetch, store = new CredentialStore(root) } = {}) {
  await store.prepare();
  const metadata = await discoverOAuth(fetchImpl);
  const proof = pkce();
  let callbackResolve;
  let completed = false;
  const callback = new Promise(resolve => { callbackResolve = resolve; });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const host = `127.0.0.1:${server.address().port}`;
    if (completed || request.method !== 'GET' || request.headers.host !== host || !validCallback(request.url, { state: proof.state, host })) {
      response.writeHead(400); response.end('The connection callback is invalid or expired.'); return;
    }
    completed = true;
    callbackResolve(new URL(request.url, `http://${host}`).searchParams.get('code'));
    response.end('Notion authorization received. You can return to Codex.');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let timer;
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    const client = await jsonRequest(metadata.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Local AI Bridge', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    }, fetchImpl);
    if (typeof client.client_id !== 'string' || !client.client_id) throw new NotionConnectionError('Notion did not register the local bridge.');
    const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope: 'default', state: proof.state, code_challenge: proof.challenge, code_challenge_method: 'S256', resource: NOTION_ORIGIN });
    await onAuthorize(`${metadata.authorization_endpoint}?${params}`);
    const code = await Promise.race([callback, new Promise((_, reject) => { timer = setTimeout(() => reject(new NotionConnectionError('Notion authorization timed out.', 'REAUTH_REQUIRED')), timeoutMs); })]);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: proof.verifier, resource: NOTION_ORIGIN });
    if (client.client_secret) body.set('client_secret', client.client_secret);
    const tokens = await jsonRequest(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() }, fetchImpl);
    await store.withLock(() => store.write(tokenRecord(tokens, { version: 1, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), authorized_at: new Date().toISOString() })));
    return { connected: true };
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

export async function getAccessToken(store, fetchImpl = fetch, forceRefresh = false) {
  return store.withLock(async () => {
    let auth = await store.read();
    if (!forceRefresh && auth.access_token && auth.expires_at > Date.now() + 300000) return auth.access_token;
    if (!auth.refresh_token || !auth.client_id) throw new NotionConnectionError('Notion must be reconnected.', 'REAUTH_REQUIRED');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id });
    if (auth.client_secret) body.set('client_secret', auth.client_secret);
    let tokens;
    try { tokens = await jsonRequest(`${NOTION_ORIGIN}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() }, fetchImpl); }
    catch (error) {
      if (['invalid_grant', 'invalid_client'].includes(error.code)) {
        const { access_token, refresh_token, expires_at, ...rest } = auth;
        await store.write({ ...rest, reconnect_required: true });
        throw new NotionConnectionError('Notion authorization expired or was revoked. Reconnect it.', 'REAUTH_REQUIRED');
      }
      throw error;
    }
    auth = tokenRecord(tokens, auth);
    await store.write(auth);
    return auth.access_token;
  });
}

export function parseRpcResponse(text, contentType, expectedId) {
  const messages = [];
  try {
    if (contentType.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) messages.push(JSON.parse(data));
      }
    } else { messages.push(JSON.parse(text)); }
  } catch { throw new NotionConnectionError('Notion sent an invalid MCP response.'); }
  const response = messages.find(item => item.id === expectedId);
  if (!response) throw new NotionConnectionError('Notion did not return the requested MCP response.');
  if (response.error) throw new NotionConnectionError(`Notion MCP rejected a request (code ${Number(response.error.code) || 'unknown'}).`);
  return response.result;
}

export class NotionMcpClient {
  constructor(root, { store = new CredentialStore(root), fetchImpl = fetch } = {}) { this.store = store; this.fetchImpl = fetchImpl; this.nextId = 1; this.sessionId = null; this.tools = []; this.initialized = false; }
  async rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++;
    const token = await getAccessToken(this.store, this.fetchImpl);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocolVersion || '2025-03-26', 'User-Agent': 'AI-Department-Local-Bridge/1.0' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response;
    try { response = await this.fetchImpl(NOTION_ENDPOINT, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(45000), body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) }); }
    catch { throw new NotionConnectionError('Notion synchronization could not reach the official MCP service.'); }
    if (response.status === 401 || response.status === 403) throw new NotionConnectionError('Notion refused the saved connection. Reconnect it.', 'REAUTH_REQUIRED');
    if (!response.ok) {
      const error = new NotionConnectionError(`Notion synchronization failed (HTTP ${response.status}).`, response.status === 429 ? 'RATE_LIMITED' : 'NOTION_HTTP');
      error.status = response.status;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) error.retryAfterMs = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw error;
    }
    if (response.headers.get('mcp-session-id')) this.sessionId = response.headers.get('mcp-session-id');
    if (notification) { await response.body?.cancel(); return; }
    return parseRpcResponse(await boundedText(response), response.headers.get('content-type') || '', id);
  }
  async connect() {
    if (this.initialized) return this;
    const result = await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ai-department-local-bridge', version: '1.0.0' } });
    this.protocolVersion = result.protocolVersion;
    await this.rpc('notifications/initialized', undefined, { notification: true });
    let cursor;
    for (let page = 0; page < 10; page++) {
      const listing = await this.rpc('tools/list', cursor ? { cursor } : {});
      this.tools.push(...(listing.tools || []));
      cursor = listing.nextCursor;
      if (!cursor) break;
    }
    if (cursor || !this.tools.length) throw new NotionConnectionError('Notion tool discovery did not complete.');
    this.initialized = true;
    return this;
  }
  tool(baseName) {
    const normalized = baseName.replaceAll('_', '-');
    const tool = this.tools.find(item => item.name === `notion-${normalized}` || item.name === normalized || item.name === baseName);
    if (!tool) throw new NotionConnectionError(`The Notion connection does not provide the ${normalized} tool.`);
    return tool;
  }
  async call(baseName, args) {
    await this.connect();
    const tool = this.tool(baseName);
    if (!matchesSchema(tool.inputSchema, args)) throw new NotionConnectionError(`The discovered Notion ${baseName} input schema is incompatible with this bridge.`);
    const result = await this.rpc('tools/call', { name: tool.name, arguments: args });
    if (result?.isError) {
      const error = new NotionConnectionError(`The Notion ${baseName} operation failed. No status was accepted.`, 'NOTION_TOOL_ERROR');
      // Use only documented machine codes; never retain server error messages or bodies.
      try {
        const payload = toolPayload(result);
        const code = payload.code || payload.error?.code;
        const statuses = { unauthorized: 401, restricted_resource: 403, object_not_found: 404, rate_limited: 429, internal_server_error: 500, service_unavailable: 503 };
        if (Object.hasOwn(statuses, code)) error.status = statuses[code];
        if (error.status === 429 && Number.isFinite(payload.retry_after)) error.retryAfterMs = payload.retry_after * 1000;
      } catch { /* An opaque tool error remains a safe, non-accepted result. */ }
      throw error;
    }
    return result;
  }
  async close() { /* Stateless HTTP connection; no persistent socket/server to shut down. */ }
}

export function matchesSchema(schema, value) {
  if (!schema || schema === true) return true;
  if (schema === false) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.anyOf && !schema.anyOf.some(item => matchesSchema(item, value))) return false;
  if (schema.oneOf && schema.oneOf.filter(item => matchesSchema(item, value)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(item => matchesSchema(item, value))) return false;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.includes(actual) && !(types.includes('integer') && Number.isInteger(value))) return false;
  if (actual === 'object') {
    if (schema.required?.some(key => value[key] === undefined)) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key] && !matchesSchema(schema.properties[key], item)) return false;
      if (!schema.properties?.[key] && schema.additionalProperties === false) return false;
      if (!schema.properties?.[key] && typeof schema.additionalProperties === 'object' && !matchesSchema(schema.additionalProperties, item)) return false;
    }
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => matchesSchema(schema.items, item))) return false;
  }
  return true;
}

export function toolPayload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const blocks = result?.content?.filter(block => block.type === 'text') || [];
  if (blocks.length !== 1) throw new NotionConnectionError('Notion returned an unsupported result shape.');
  try { return JSON.parse(blocks[0].text); }
  catch { return { text: blocks[0].text }; }
}

function jsonTag(text, tag) {
  const match = text?.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  if (!match) throw new NotionConnectionError(`Notion did not return the required ${tag} data.`);
  try { return JSON.parse(match[1]); }
  catch { throw new NotionConnectionError(`Notion returned unreadable ${tag} data.`); }
}

export function notionId(value) {
  if (typeof value !== 'string') throw new NotionConnectionError('Invalid Notion page ID.');
  let candidate = value;
  if (/^https?:/.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['app.notion.com', 'www.notion.so', 'notion.so', 'www.notion.com', 'notion.com'].includes(url.hostname)) throw new NotionConnectionError('Notion page URL is outside the official service.');
    candidate = url.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  const compact = candidate.replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(compact)) throw new NotionConnectionError('Invalid Notion page ID.');
  return `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`.toLowerCase();
}

export function parseCard(result, expectedDataSourceId) {
  const payload = result?.content ? toolPayload(result) : result;
  const expected = notionId(expectedDataSourceId);
  const source = payload.text?.match(/<parent-data-source\s+url="(?:\{\{)?collection:\/\/([a-f0-9-]+)(?:\}\})?"/i)?.[1];
  if (!source || notionId(source) !== expected) throw new NotionConnectionError('Refused to read or edit a card outside the AI Department task database.', 'NOTION_SCOPE');
  const properties = jsonTag(payload.text, 'properties');
  const id = notionId(payload.url || properties.url);
  return { id, url: `https://app.notion.com/p/${id.replaceAll('-', '')}`, properties };
}

function unwrapArgs(client, name, args) {
  const schema = client.tool(name).inputSchema;
  return schema.properties?.data && !schema.properties?.id && !schema.properties?.page_id ? { data: args } : args;
}

export class NotionMcpTransport {
  constructor(root, { client = new NotionMcpClient(root), dataSourceId, databaseId, viewId } = {}) {
    // Each installation supplies its own board. Missing IDs fail closed; no author's board is a fallback.
    this.client = client;
    this.dataSourceId = notionId(dataSourceId);
    this.databaseId = notionId(databaseId);
    this.viewId = notionId(viewId);
    this.ready = false;
  }

  async initialize() {
    if (this.ready) return this;
    await this.client.connect();
    const source = toolPayload(await this.client.call('fetch', { id: `collection://${this.dataSourceId}` }));
    const dataSource = jsonTag(source.text, 'data-source-state');
    if (dataSource.url !== `collection://${this.dataSourceId}` || dataSource.schema?.['Local task ID']?.type !== 'text') throw new NotionConnectionError('The AI Department board schema changed incompatibly.');
    this.schema = dataSource.schema;
    const view = jsonTag(toolPayload(await this.client.call('fetch', { id: `view://${this.viewId}` })).text, 'view');
    if (view.dataSourceUrl?.replaceAll('{{', '').replaceAll('}}', '') !== `collection://${this.dataSourceId}` || view.advancedFilter || view.filter || view.filters || !view.displayProperties?.includes('Local task ID')) throw new NotionConnectionError('Exact task recovery requires an unfiltered board view including Local task ID.');
    let access;
    try { this.client.tool('get-tool-access'); access = toolPayload(await this.client.call('get-tool-access', {})).current_tool_access; }
    catch (error) {
      // Older official servers expose access metadata through fetch(self).
      if (this.client.tools?.some(tool => ['notion-get-tool-access', 'get-tool-access'].includes(tool.name))) throw error;
      access = toolPayload(await this.client.call('fetch', { id: 'self' })).self?.current_tool_access;
    }
    if (access?.query_data_sources && !['available', 'available_with_limit'].includes(access.query_data_sources.status)) throw new NotionConnectionError('Notion view-query access is unavailable on this connection.');
    this.ready = true;
    return this;
  }
  validateProperties(properties) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new NotionConnectionError('A card requires a property map.');
    for (const [name, value] of Object.entries(properties)) {
      const spec = this.schema[name];
      if (!spec || spec.readOnly || ['last_edited_time','created_time','formula','rollup'].includes(spec.type)) throw new NotionConnectionError(`The bridge cannot write the ${name} board property.`);
      if (typeof value !== 'string') throw new NotionConnectionError(`The ${name} board property must be plain text.`);
      if (spec.type === 'select' && !spec.options?.some(option => option.name === value)) throw new NotionConnectionError(`The ${name} board option is not in the current schema.`);
      if (value.length > 20000) throw new NotionConnectionError('A card property exceeds the bridge size limit.');
    }
  }
  async finishWrite(result) {
    let payload = toolPayload(result);
    const asyncTask = payload.async_task || (payload.object === 'async_task' ? payload : null);
    if (!asyncTask) return payload;
    const id = asyncTask.id;
    if (typeof id !== 'string') throw new NotionConnectionError('Notion did not identify its pending write.');
    let task = asyncTask;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (task.status === 'succeeded') return task.result || payload;
      if (task.status === 'failed') throw new NotionConnectionError('The background Notion write failed.', 'NOTION_WRITE_UNCERTAIN');
      await delay(Math.min(10000, Math.max(1000, Number(task.poll_after_seconds || 2) * 1000)));
      payload = toolPayload(await this.client.call('get-async-task', { task_id: id }));
      task = payload.async_task || payload;
    }
    throw new NotionConnectionError('The Notion write is still pending; it must be reconciled before retrying.', 'NOTION_WRITE_UNCERTAIN');
  }
  async fetchCard(pageId) {
    await this.initialize();
    const id = notionId(pageId);
    const card = parseCard(await this.client.call('fetch', { id }), this.dataSourceId);
    if (card.id !== id) throw new NotionConnectionError('Notion returned a different card than requested.');
    return card;
  }
  async findByTaskId(taskId) {
    await this.initialize();
    if (typeof taskId !== 'string' || !taskId || taskId.length > 200) throw new NotionConnectionError('A bounded exact local task ID is required.');
    const matches = []; let cursor;
    for (let page = 0; page < 100; page++) {
      const args = { mode: 'view', view_url: `view://${this.viewId}`, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const payload = toolPayload(await this.client.call('query-data-sources', unwrapArgs(this.client, 'query-data-sources', args)));
      if (!Array.isArray(payload.results)) throw new NotionConnectionError('Notion returned an unsupported board-query shape.');
      for (const row of payload.results) {
        if (row['Local task ID'] === taskId) matches.push(notionId(row.url || row.id));
      }
      if (!payload.has_more) { cursor = undefined; break; }
      if (!payload.next_cursor || payload.next_cursor === cursor) throw new NotionConnectionError('Notion did not provide a complete board cursor.');
      cursor = payload.next_cursor;
    }
    if (cursor) throw new NotionConnectionError('Notion recovery query exceeded its bounded page limit.');
    if (matches.length > 1) throw new NotionConnectionError('Multiple Notion cards have the same local task ID; resolve the duplicate before syncing.', 'NOTION_DUPLICATE_CARDS');
    return matches.length ? this.fetchCard(matches[0]) : null;
  }
  async createCard(properties) {
    await this.initialize();
    this.validateProperties(properties);
    if (!properties['Local task ID']) throw new NotionConnectionError('New task cards must include their local task ID.');
    const args = { parent: { data_source_id: this.dataSourceId }, pages: [{ properties }], allow_async: false };
    const payload = await this.finishWrite(await this.client.call('create-pages', unwrapArgs(this.client, 'create-pages', args)));
    const pages = payload.pages || (payload.page ? [payload.page] : (payload.id || payload.url ? [payload] : []));
    if (pages.length !== 1) throw new NotionConnectionError('Notion create outcome is uncertain; reconcile the local task ID before another create.', 'NOTION_WRITE_UNCERTAIN');
    const card = await this.fetchCard(pages[0].id || pages[0].url);
    this.verify(card, properties);
    return card;
  }
  async updateCard(pageId, properties) {
    await this.initialize();
    this.validateProperties(properties);
    const before = await this.fetchCard(pageId);
    if (properties['Local task ID'] && before.properties['Local task ID'] !== properties['Local task ID']) throw new NotionConnectionError('Refused to overwrite a different local task ID.', 'NOTION_SCOPE');
    const args = { page_id: before.id, command: 'update_properties', properties, allow_async: false };
    await this.finishWrite(await this.client.call('update-page', unwrapArgs(this.client, 'update-page', args)));
    const card = await this.fetchCard(before.id);
    this.verify(card, properties);
    return card;
  }
  verify(card, properties) {
    for (const [name, value] of Object.entries(properties)) if (!notionValueEquals(card.properties[name] ?? '', value)) throw new NotionConnectionError(`Notion did not confirm the expected ${name} value.`, 'NOTION_VERIFY_FAILED');
  }
  async close() { await this.client.close(); }
}
