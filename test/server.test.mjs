import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/config.mjs';

test('the Codex plugin launcher starts the MCP server and exposes the swarm tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'plugins', 'deepastra-swarm', 'server.mjs')],
    env: { ...process.env, DEEPASTRA_SWARM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-server-test-')) },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['swarm_inspect', 'swarm_list', 'swarm_result', 'swarm_resume', 'swarm_start', 'swarm_status', 'swarm_steer', 'swarm_stop', 'swarm_task_add']);
  const list = await client.callTool({ name: 'swarm_list', arguments: {} });
  assert.equal(list.content[0].text, '[]');
  const missing = await client.callTool({ name: 'swarm_status', arguments: { swarm_id: 'nope' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /unknown swarm nope/);
  await client.close();
});
