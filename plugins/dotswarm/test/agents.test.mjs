import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-codex-home-'));
const { agentsStatus, codexHome, installAgents, MANAGED_MARKER } = await import('../src/agents.mjs');

const agentPath = (name) => path.join(codexHome(), 'agents', `${name}.toml`);

test('setup installs the subagents, refreshes its own, and never touches the user files', () => {
  assert.deepEqual(agentsStatus().map((a) => a.state), ['missing', 'missing', 'missing']);

  const installed = installAgents();
  assert.deepEqual(installed.map((a) => a.name), ['dotswarm-designer', 'dotswarm-imager', 'dotswarm-writer']);
  assert.deepEqual(installed.map((a) => a.state), ['installed', 'installed', 'installed']);
  for (const agent of installed) assert.ok(fs.readFileSync(agent.path, 'utf8').startsWith(MANAGED_MARKER));
  assert.match(fs.readFileSync(agentPath('dotswarm-imager'), 'utf8'), /image generation tool/);

  // Running setup again changes nothing.
  assert.deepEqual(installAgents().map((a) => a.state), ['current', 'current', 'current']);

  // A stale managed copy is refreshed.
  fs.writeFileSync(agentPath('dotswarm-designer'), `${MANAGED_MARKER}\nname = "dotswarm-designer"\n`);
  assert.equal(agentsStatus().find((a) => a.name === 'dotswarm-designer').state, 'outdated');
  assert.equal(installAgents().find((a) => a.name === 'dotswarm-designer').state, 'updated');
  assert.match(fs.readFileSync(agentPath('dotswarm-designer'), 'utf8'), /You are the designer/);

  // A file the user took ownership of is left exactly as it is.
  const mine = 'name = "dotswarm-writer"\nmodel = "my-model"\n';
  fs.writeFileSync(agentPath('dotswarm-writer'), mine);
  assert.equal(agentsStatus().find((a) => a.name === 'dotswarm-writer').state, 'user-owned');
  assert.equal(installAgents().find((a) => a.name === 'dotswarm-writer').state, 'user-owned');
  assert.equal(fs.readFileSync(agentPath('dotswarm-writer'), 'utf8'), mine);
});
