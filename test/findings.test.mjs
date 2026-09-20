import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Findings } from '../src/findings.mjs';
import { ROOT } from '../src/config.mjs';

test('ledger appends numbered rows and filters by scope and type', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'findings-')), 'f.jsonl');
  const f = new Findings(file);
  assert.deepEqual(f.list(), []);
  const a = f.append({ author: 'lead', type: 'decision', scope: 'plan', message: 'three tasks' });
  const b = f.append({ author: 'worker', type: 'warning', scope: 'db/migrations', message: 'id type change breaks 018' });
  assert.equal(a.id, 'F-001');
  assert.equal(b.id, 'F-002');
  assert.equal(f.list({ scope: 'db' }).length, 1);
  assert.equal(f.list({ type: 'decision' })[0].id, 'F-001');
  assert.deepEqual(f.list({ since: 'F-001' }).map((r) => r.id), ['F-002']);
  assert.deepEqual(f.list({ since: 'F-002' }), []);
  assert.equal(f.lastId(), 'F-002');
  assert.throws(() => f.append({ type: 'nope', scope: 's', message: 'm' }), /type must be/);
  assert.throws(() => f.append({ type: 'warning', scope: '', message: 'm' }), /scope is required/);
});

test('findings MCP server serves record_finding and list_findings over stdio', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'findings-')), 'f.jsonl');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'findings-server.mjs')],
    env: { ...process.env, SWARM_FINDINGS_FILE: file },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['list_findings', 'record_finding']);
  const rec = await client.callTool({ name: 'record_finding', arguments: { author: 'tester', type: 'failure', scope: 'tests', message: 'three tests fail' } });
  assert.match(rec.content[0].text, /F-001/);
  const list = await client.callTool({ name: 'list_findings', arguments: { type: 'failure' } });
  assert.match(list.content[0].text, /F-001 \[failure\] \(tests\) by tester/);
  const bad = await client.callTool({ name: 'record_finding', arguments: { author: 'x', type: 'bogus', scope: 's', message: 'm' } });
  assert.equal(bad.isError, true);
  const none = await client.callTool({ name: 'list_findings', arguments: { since: 'F-001' } });
  assert.match(none.content[0].text, /No findings newer than F-001/);
  await client.close();
});
