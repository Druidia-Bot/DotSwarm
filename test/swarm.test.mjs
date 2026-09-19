import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DEEPASTRA_SWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-swarm-test-'));
const { SwarmManager } = await import('../src/swarm.mjs');
const { DshClient } = await import('../src/dsh-client.mjs');
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.mjs');

const fakeLaunch = (mode) => ({ swarm, patchFile }) => {
  assert.ok(fs.existsSync(patchFile), 'per-swarm patch written');
  assert.match(fs.readFileSync(patchFile, 'utf8'), /serverName: findings/);
  return new DshClient({
    command: process.execPath, args: [fake, '--profile', 'swarm', '--patch', patchFile], cwd: swarm.workspace,
    env: { ...process.env, FAKE_DSH_MODE: mode }, initializeTimeoutMs: 10_000, requestTimeoutMs: 5000,
  });
};

test('start, observe, steer, result, stop against the fake runtime', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({
    objective: 'Make hello.txt', workspace, max_agents: 2,
    acceptance_criteria: ['hello.txt exists'], plan: '1. create file',
  });
  assert.match(swarm.id, /^sw-/);
  assert.ok(fs.existsSync(path.join(swarm.dir, 'lead-prompt.md')));
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /Use Agent Teams/);

  const deadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < deadline) await swarm.waitForChange(500);
  const status = swarm.status();
  assert.equal(status.phase, 'idle');
  assert.equal(status.reportReady, true);
  assert.deepEqual(status.tasks.counts, { pending: 0, in_progress: 0, completed: 1 });
  assert.equal(status.roster.find((r) => r.name === 'worker').phase, 'active');
  assert.equal(status.mail.delivered, 1);
  assert.equal(status.toolErrors[0].code, 'ENOENT');
  assert.equal(status.tokens.input, 600);

  const result = await swarm.result();
  assert.equal(result.complete, true);
  assert.equal(result.report.summary, 'All done.');
  assert.match(result.report.changes, /hello\.txt/);

  const member = swarm.inspect('member:worker');
  assert.equal(member.messages[0].text, 'worker done');
  assert.deepEqual(member.recentTools, ['read']);
  assert.throws(() => swarm.inspect('member:nobody'), /unknown member/);
  assert.equal(swarm.inspect('events', 5).length, 5);

  await swarm.steer('also add a newline');
  assert.equal(swarm.phase, 'running');
  const steerDeadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < steerDeadline) await swarm.waitForChange(500);
  assert.match((await swarm.result()).report.summary, /Steered/);
  assert.equal(swarm.inspect('prompts').length, 2);

  assert.equal(manager.list()[0].swarmId, swarm.id);
  const stopped = await swarm.stop();
  assert.equal(stopped.phase, 'stopped');
  await assert.rejects(swarm.steer('x'), /cannot be steered/);
});

test('a runtime that dies during start reports failed with stderr', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('exit-early') });
  await assert.rejects(manager.start({ objective: 'x', workspace }), /boot failure/);
  assert.equal(manager.list()[0].phase, 'failed');
});

test('spec validation', () => {
  const manager = new SwarmManager();
  assert.throws(() => manager.normalizeSpec({ workspace: os.tmpdir() }), /objective is required/);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', workspace: path.join(os.tmpdir(), 'nope-' + Date.now()) }), /does not exist/);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: 99 }).maxAgents, 7);
});
