import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  assert.equal(status.cost.swarmTokens.input, 600);
  assert.equal(status.cost.byMember.worker.input, 100);
  assert.equal(status.cost.estimatedUsd, undefined);
  assert.deepEqual(status.openQuestions, []);
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'coordinator', message: 'may I edit wrangler.jsonc?' });
  assert.equal(swarm.status().openQuestions[0].message, 'may I edit wrangler.jsonc?');
  assert.equal(swarm.status({ sinceFinding: 'F-001' }).findings.new.length, 0);
  assert.equal(swarm.status({ sinceFinding: 'F-000' }).findings.new.length, 1);
  assert.equal(swarm.status().findings.latestId, 'F-001');

  const result = await swarm.result();
  assert.equal(result.complete, true);
  assert.equal(result.report.summary, 'All done.');
  assert.match(result.report.changes, /hello\.txt/);

  const member = swarm.inspect('member:worker');
  assert.equal(member.messages[0].text, 'worker done');
  assert.deepEqual(member.recentTools, ['read']);
  assert.throws(() => swarm.inspect('member:nobody'), /unknown member/);
  assert.equal(swarm.inspect('events', 5).length, 5);

  const steered = await swarm.steer('also add a newline');
  assert.equal(steered.findingId, 'F-002');
  assert.equal(swarm.phase, 'running');
  const steerDeadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < steerDeadline) await swarm.waitForChange(500);
  assert.match((await swarm.result()).report.summary, /Steered/);
  assert.equal(swarm.inspect('prompts').length, 2);
  assert.deepEqual(swarm.status().steers, { sent: 1, read: 1 });
  assert.equal(swarm.status().permissionMode, 'danger-full-access');
  assert.equal(swarm.inspect('findings')[1].type, 'steer');
  const task = await swarm.addTask({ subject: 'Fix wrangler config', description: 'set the var', writeScopes: ['wrangler.jsonc'] });
  assert.equal(task.findingId, 'F-003');
  assert.match(swarm.inspect('findings')[2].message, /^TASK REQUEST[\s\S]*Subject: Fix wrangler config[\s\S]*Write scopes: wrangler\.jsonc/);
  await assert.rejects(swarm.addTask({ subject: '', description: 'x' }), /required/);
  const benign = swarm.status();
  assert.ok(!benign.toolErrors.some((e) => e.code === 'FS_NOT_OBSERVED'));

  assert.equal(manager.list()[0].swarmId, swarm.id);
  const stopped = await swarm.stop();
  assert.equal(stopped.phase, 'stopped');
  await assert.rejects(swarm.steer('x'), /cannot be steered/);
});

test('a runtime that dies during start reports failed with stderr', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('exit-early') });
  await assert.rejects(manager.start({ objective: 'x', workspace }), /boot failure/);
  assert.equal(manager.list().find((s) => s.workspace === workspace).phase, 'failed');
});

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-repo-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

test('isolation defaults to a worktree for git repos, and swarms persist, detach, and resume', async (t) => {
  const repo = tempGitRepo();
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: repo }).isolate, true);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir() }).isolate, false);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: repo, isolate: false }).isolate, false);

  const first = await manager.start({ objective: 'Build it', workspace: repo, max_agents: 1 });
  assert.equal(first.branch, `swarm/${first.id}`);
  assert.notEqual(first.workspace, repo);
  assert.ok(fs.existsSync(path.join(first.workspace, 'README.md')), 'worktree checked out');
  const deadline = Date.now() + 5000;
  while (first.phase !== 'idle' && Date.now() < deadline) await first.waitForChange(500);
  assert.equal((await first.result()).branch, first.branch);
  await first.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(first.dir, 'state.json'), 'utf8'));
  assert.equal(saved.phase, 'stopped');
  assert.equal(saved.branch, first.branch);

  // A later server process sees the clean stop as stopped...
  const later = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => later.shutdownAll());
  assert.equal(later.get(first.id).phase, 'stopped');
  // ...and a swarm whose owner died mid-run as detached, replayed from its log.
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running' }));
  const crashed = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => crashed.shutdownAll());
  const detached = crashed.get(first.id);
  assert.equal(detached.phase, 'detached');
  assert.match(detached.status().detached, /swarm_resume/);
  assert.deepEqual(detached.status().tasks.counts, { pending: 0, in_progress: 0, completed: 1 });
  assert.equal(detached.inspect('member:worker').messages[0].text, 'worker done');
  await assert.rejects(detached.steer('x'), /detached/);

  const resumed = await crashed.resume(first.id, { instruction: 'verify task-1 then finish', mode: 'refactor', design: true });
  assert.notEqual(resumed.id, first.id);
  assert.equal(resumed.spec.mode, 'refactor');
  assert.equal(resumed.spec.design, true);
  assert.equal(resumed.spec.model, 'deepseek-flash', 'a design continuation of a default-model swarm switches to the vision model');
  assert.ok(fs.existsSync(path.join(resumed.dir, 'screens')));
  assert.equal(resumed.status().mode, 'refactor');
  assert.equal(resumed.status().design, true);
  assert.equal(resumed.workspace, first.workspace, 'reuses the existing worktree');
  assert.equal(resumed.branch, first.branch);
  assert.equal(resumed.spec.isolate, false);
  const prompt = fs.readFileSync(path.join(resumed.dir, 'lead-prompt.md'), 'utf8');
  assert.match(prompt, new RegExp(`RESUMING PREVIOUS SWARM ${first.id}`));
  assert.match(prompt, /task-1 \[completed, was worker\] Explore/);
  assert.match(prompt, /verify task-1 then finish/);
  assert.match(prompt, /PREVIOUS LEAD'S LAST MESSAGE/);
  assert.match(prompt, /REFACTOR MODE/);
  assert.match(prompt, /UX AND DESIGN ITERATION/);
  assert.equal(resumed.findings.readAll().length, first.findings.readAll().length, 'ledger carried over');
  assert.equal(crashed.list().find((s) => s.swarmId === resumed.id).resumedFrom, first.id);
  await assert.rejects(crashed.resume(resumed.id), /still running/);
  const d2 = Date.now() + 5000;
  while (resumed.phase !== 'idle' && Date.now() < d2) await resumed.waitForChange(500);
  assert.equal(resumed.status().resumedFrom, first.id);
  await resumed.stop();
});

test('spec validation', () => {
  const manager = new SwarmManager();
  assert.throws(() => manager.normalizeSpec({ workspace: os.tmpdir() }), /objective is required/);
  assert.throws(() => manager.normalizeSpec({ objective: 'x', workspace: path.join(os.tmpdir(), 'nope-' + Date.now()) }), /does not exist/);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), max_agents: 99 }).maxAgents, 7);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), permission_mode: 'read-only' }).permissionMode, 'read-only');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), permission_mode: 'bogus' }).permissionMode, 'danger-full-access');
  const plain = manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir() });
  assert.equal(plain.design, false);
  assert.equal(plain.mode, 'build');
  assert.equal(plain.model, 'deepseek-v4-flash');
  const design = manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), design: true });
  assert.equal(design.model, 'deepseek-flash', 'design swarms switch to the vision model');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), design: true, model: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), mode: 'refactor' }).mode, 'refactor');
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace: os.tmpdir(), mode: 'nonsense' }).mode, 'build');
});
