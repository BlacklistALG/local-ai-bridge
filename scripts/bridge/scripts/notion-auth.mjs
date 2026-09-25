import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginNotion, NotionMcpClient, CredentialStore, NotionConnectionError } from '../lib/notion-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const command = process.argv[2] || 'login';
  if (command === 'login') {
    await loginNotion(root);
    process.stdout.write('NOTION_CONNECTED\n');
  } else if (command === 'status') {
    const store = new CredentialStore(root);
    process.stdout.write(JSON.stringify({ configured: await store.exists() }) + '\n');
  } else if (command === 'tools') {
    const client = await new NotionMcpClient(root).connect();
    process.stdout.write(JSON.stringify(client.tools.map(({ name, inputSchema }) => ({ name, inputSchema })), null, 2) + '\n');
  } else { throw new Error('Use login, status, or tools.'); }
} catch (error) {
  process.stderr.write((error instanceof NotionConnectionError ? error.message : 'Notion connection setup failed.') + '\n');
  process.exitCode = 1;
}
