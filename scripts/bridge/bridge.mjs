#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './lib/store.mjs';
import { summarizeDepartment } from './lib/department-status.mjs';
import { Runner } from './lib/runner.mjs';
import { createAdapter } from './lib/providers.mjs';
import { Workflow } from './lib/workflow.mjs';
import { NotionSync } from './lib/notion-sync.mjs';
import { NotionMcpTransport } from './lib/notion-mcp.mjs';
import { ensureWatcher, stopWatcher } from './lib/notion-watch.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const store = new Store(root);
const [command = 'help', ...args] = process.argv.slice(2);
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const summary = job => ({ id: job.id, title: job.title, role: job.role, model: job.model,
  origin: job.origin, status: job.status, dependsOn: job.dependsOn, workspace: job.workspace,
  createdAt: job.createdAt, updatedAt: job.updatedAt, resultPath: job.resultPath, error: job.error,
  modelVerified: job.modelVerified, project: job.project, allowedPaths: job.allowedPaths,
  projectWorkspace: job.projectWorkspace?.path, validation: job.validation ? { passed: job.validation.passed, diffHash: job.validation.diffHash, files: job.validation.files } : undefined,
  reviewFor: job.reviewFor, integration: job.integration });

try {
  switch (command) {
    case 'roles':
      output(Object.entries(config.roles).map(([id, r]) => ({ id, name: r.name, provider: r.provider, model: r.model })));
      break;
    case 'submit': {
      if (args[0] !== '--file' || !args[1] || args.length !== 2) throw new Error('Use submit --file <job.json>.');
      const input = JSON.parse((await readFile(path.resolve(args[1]), 'utf8')).replace(/^\uFEFF/, ''));
      const role = Object.hasOwn(config.roles, input.role) ? config.roles[input.role] : null;
      if (!role) throw new Error('Unknown role. Run roles to see supported roles.');
      if (input.reviewFor) throw new Error('Use review <editing-task-id> <reviewer-role> to create a bound independent review.');
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('A nonempty prompt is required.');
      const job = await store.enqueue({
        role: input.role, title: input.title, prompt: `${role.instructions}\n\nTask:\n${input.prompt}`,
        dependsOn: input.dependsOn ?? [], origin: input.origin ?? 'coordinator', requestKey: input.requestKey,
        mode: input.mode ?? 'read-only', project: input.project, allowedPaths: input.allowedPaths, acceptanceCriteria: input.acceptanceCriteria
      });
      output(summary(job));
      break;
    }
    case 'list': output((await store.list()).map(summary)); break;
    case 'status': output(summarizeDepartment(await store.list())); break;
    case 'show': {
      if (!args[0]) throw new Error('Use show <task-id>.');
      const job = await store.get(args[0]);
      if (!job) throw new Error('Task not found.');
      output({ ...summary(job), result: job.result, sessionId: job.sessionId, acceptanceCriteria: job.acceptanceCriteria, projectReview: job.projectReview });
      break;
    }
    case 'run': {
      const runner = new Runner(root, { adapter: createAdapter(root, config) });
      const results = await runner.runBatch({ maxParallel: config.maxParallel });
      output(results.map(summary));
      break;
    }
    case 'accept': {
      if (!args[0]) throw new Error('Use accept <task-id>.');
      output(summary(await store.update(args[0], { status: 'done' }, { expectedStatus: 'review' })));
      break;
    }
    case 'review': {
      if (args.length !== 2) throw new Error('Use review <editing-task-id> <reviewer-role>.');
      output(summary(await new Workflow(root).requestReview(args[0], args[1])));
      break;
    }
    case 'integrate': {
      if (args.length !== 2) throw new Error('After assessing the review, use integrate <editing-task-id> <review-task-id>.');
      output(summary(await new Workflow(root).integrate(args[0], args[1])));
      break;
    }
    case 'projects': output(config.projects ?? {}); break;
    case 'notion-sync': {
      const transport = new NotionMcpTransport(root, config.notion);
      try { const result = await new NotionSync(root, { transport }).syncOnce(); output(result); if (!result.ok) process.exitCode = 1; }
      finally { await transport.close(); }
      break;
    }
    case 'notion-start': output(await ensureWatcher(root)); break;
    case 'notion-stop': output(await stopWatcher(root)); break;
    case 'notion-status': {
      let watcher = null;
      try { watcher = JSON.parse(await readFile(path.join(root, 'data', 'notion-watch-status.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      output({ sync: await new NotionSync(root).getStatus(), watcher });
      break;
    }
    case 'cancel': {
      if (!args[0]) throw new Error('Use cancel <task-id>.');
      const current = await store.get(args[0]);
      if (!current) throw new Error('Task not found.');
      if (current.status === 'running') throw new Error('A running task cannot be cancelled from another command in this version. Stop its runner; interrupted work is blocked for review.');
      output(summary(await store.update(args[0], { status: 'cancelled' }, { expectedStatus: current.status })));
      break;
    }
    case 'reconcile': {
      if (args.length !== 3 || args[0] !== '--provider' || !['codex', 'claude'].includes(args[1]) || args[2] !== '--confirmed-stopped') {
        throw new Error('After confirming all interrupted worker processes have stopped, use reconcile --provider <codex|claude> --confirmed-stopped. Never use this solely to clear a blocked status.');
      }
      output((await store.reconcileProvider(args[1])).map(summary));
      break;
    }
    case 'notion-export': {
      output({ syncMode: config.notion.syncMode, dataSourceId: config.notion.dataSourceId,
        instruction: 'This export does not send data. Use notion-status to check live synchronization.',
        cards: await new NotionSync(root).exportCards() });
      break;
    }
    default:
      output({ name: 'AI Department bridge', stage: 'Isolated editing, independent review, local integration and Notion sync', commands: [
        'roles', 'projects', 'submit --file <job.json>', 'run', 'list', 'status', 'show <id>', 'accept <id>', 'cancel <id>', 'review <editing-id> <role>', 'integrate <editing-id> <review-id>', 'notion-sync', 'notion-start', 'notion-stop', 'notion-status', 'notion-export'
      ], subscriptionsOnly: true, autoStartInstalled: false, notion: config.notion.boardUrl });
  }
  if (['submit','run','accept','cancel','review','integrate','reconcile'].includes(command)) {
    try { await ensureWatcher(root); }
    catch (error) { process.stderr.write(JSON.stringify({ warning: 'Queue action completed but the Notion watcher needs attention.', detail: error.message }) + '\n'); }
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
