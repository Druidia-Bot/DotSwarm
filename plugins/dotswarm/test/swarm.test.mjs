import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DOTSWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-swarm-test-'));
const { SwarmManager, attentionReason } = await import('../src/swarm.mjs');
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
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
  assert.equal(status.teammatesOverBudget, undefined);
  swarm.spec.maxAgents = 0;
  assert.deepEqual(swarm.status().teammatesOverBudget, { budget: 0, spawned: 1 }, 'a Lead past its teammate budget is reported');
  swarm.spec.maxAgents = 2;
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('exit-early') });
  await assert.rejects(manager.start({ objective: 'x', workspace }), /boot failure/);
  assert.equal(manager.list().find((s) => s.workspace === workspace).phase, 'failed');
});

test('a Lead turn that ends in a provider error reports the error and wakes failed, and a steer retries', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('turn-error') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'x', workspace, max_agents: 1 });
  assert.equal(await swarm.waitForAttention(5000), 'failed');
  // The wake comes on turn/end; the session reports idle just after it.
  const idleBy = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < idleBy) await swarm.waitForChange(500);
  const status = swarm.status();
  assert.equal(status.phase, 'idle');
  assert.equal(status.error, 'Lead turn 1 ended in an error: DeepSeek API error (HTTP 400) (INVALID_REQUEST, 400, request req-1)');
  const result = await swarm.result();
  assert.equal(result.complete, false);
  assert.match(result.error, /HTTP 400/);

  // The runtime is still up: a steer starts a new Lead turn, which clears the error when it succeeds.
  await swarm.steer('the model is fixed; start again');
  const deadline = Date.now() + 5000;
  while ((swarm.phase !== 'idle' || swarm.problem) && Date.now() < deadline) await swarm.waitForChange(500);
  assert.equal(swarm.status().error, undefined);
  assert.equal((await swarm.result()).complete, true);
});

function tempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-repo-'));
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
  assert.equal(saved.owner.pid, process.pid, 'state.json records the owning server process');
  // ...a swarm another live server process owns as owned-elsewhere, which cannot be resumed here...
  const liveOwner = { pid: process.ppid, heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running', owner: liveOwner }));
  const second = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => second.shutdownAll());
  assert.equal(second.list().find((s) => s.swarmId === first.id).phase, 'owned-elsewhere');
  assert.match(second.get(first.id).status().ownedElsewhere, new RegExp(`pid ${process.ppid}`));
  await assert.rejects(second.resume(first.id), /still running in another DotSwarm server process/);
  await assert.rejects(second.get(first.id).steer('x'), /another DotSwarm server process/);
  // ...and reads it as detached once that owner's heartbeat goes stale.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(path.join(first.dir, 'state.json'), JSON.stringify({ ...saved, phase: 'running', owner: { ...liveOwner, heartbeatAt: stale } }));
  assert.equal(second.get(first.id).phase, 'detached');
  // A swarm whose owner died mid-run is detached, replayed from its log. Our own pid in the
  // record means a previous process that happened to have it, so it reads as gone too.
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

test('attentionReason holds routine progress and wakes on what needs the coordinator', () => {
  const base = { phase: 'running', error: null, newFindings: [], openQuestionIds: [], knownQuestionIds: [], toolErrorCount: 0, knownToolErrorCount: 0 };
  const f = (type, scope = 'pages/home') => ({ type, scope });
  assert.equal(attentionReason(base), null);
  assert.equal(attentionReason({ ...base, newFindings: [f('discovery'), f('result'), f('decision'), f('warning'), f('warning')] }), null);
  assert.equal(attentionReason({ ...base, newFindings: [f('decision', 'step7/plan')] }), 'plan');
  assert.equal(attentionReason({ ...base, newFindings: [f('warning'), f('warning'), f('warning')] }), 'warnings');
  assert.equal(attentionReason({ ...base, newFindings: [f('failure')] }), 'failure');
  assert.equal(attentionReason({ ...base, openQuestionIds: ['F-004'], knownQuestionIds: ['F-004'] }), null);
  assert.equal(attentionReason({ ...base, openQuestionIds: ['F-004', 'F-009'], knownQuestionIds: ['F-004'] }), 'question');
  assert.equal(attentionReason({ ...base, toolErrorCount: 3, knownToolErrorCount: 1 }), null);
  assert.equal(attentionReason({ ...base, toolErrorCount: 4, knownToolErrorCount: 1 }), 'tool-errors');
  assert.equal(attentionReason({ ...base, phase: 'idle' }), 'idle');
  assert.equal(attentionReason({ ...base, phase: 'stopped' }), 'stopped');
  assert.equal(attentionReason({ ...base, phase: 'detached' }), 'detached');
  assert.equal(attentionReason({ ...base, phase: 'owned-elsewhere' }), 'owned-elsewhere');
  assert.equal(attentionReason({ ...base, error: 'runtime exited' }), 'failed');
});

test('waitForAttention sleeps through routine findings and wakes on a failure or the end of the run', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Make hello.txt', workspace, max_agents: 1, acceptance_criteria: ['hello.txt exists'] });
  assert.equal(await swarm.waitForAttention(5000), 'idle');

  const since = swarm.findings.lastId() ?? 'F-000';
  swarm.phase = 'running';
  swarm.findings.append({ author: 'lead', type: 'discovery', scope: 'notes', message: 'routine' });
  assert.equal(await swarm.waitForAttention(200, { sinceFinding: since }), 'timeout');
  const status = swarm.status({ sinceFinding: since });
  assert.deepEqual(status.findings.newByType, { discovery: 1 });

  setTimeout(() => swarm.findings.append({ author: 'reviewer', type: 'failure', scope: 'a11y', message: 'broken' }), 100);
  const started = Date.now();
  assert.equal(await swarm.waitForAttention(10_000, { sinceFinding: since }), 'failure');
  assert.ok(Date.now() - started < 5000, 'failure found by the poll, not the deadline');
});

test('swarm_result carries a compact ledger, risky files first, and writes a handoff', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Make hello.txt', workspace, max_agents: 1, acceptance_criteria: ['hello.txt exists'] });
  await swarm.waitForAttention(5000);
  swarm.findings.append({ author: 'reviewer', type: 'failure', scope: 'gate', message: 'release gate exits 0 when blocked' });
  const fixed = swarm.findings.append({ author: 'reviewer', type: 'warning', scope: 'copy', message: 'too long' });
  swarm.findings.append({ author: 'lead', type: 'result', scope: 'copy', message: `Trimmed; resolves ${fixed.id}` });
  await swarm.steer('Owner confirmed: insured and bonded.');
  const result = await swarm.result();
  assert.equal(result.ledger.open.length, 1);
  assert.match(result.ledger.open[0], /release gate/);
  assert.equal(result.ledger.addressedCount, 1);
  assert.equal(result.findings, undefined, 'the full ledger is not returned');
  const handoff = fs.readFileSync(result.handoff, 'utf8');
  for (const needle of ['# Handoff:', 'Make hello.txt', 'insured and bonded', 'release gate exits 0', 'All done.']) {
    assert.ok(handoff.includes(needle), `handoff includes ${needle}`);
  }
});

test('brief and verify swarms work in place; a brief swarm reports its brief', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace }).isolate, true);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace, mode: 'verify' }).isolate, false);
  assert.equal(manager.normalizeSpec({ objective: 'x', workspace, mode: 'brief', brief_words: 50 }).briefWords, 1000);

  const swarm = await manager.start({ objective: 'Brief the sources', workspace, mode: 'brief', max_agents: 1 });
  assert.equal(swarm.branch, null, 'no worktree for a brief swarm');
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /BRIEF MODE/);
  await swarm.waitForAttention(5000);
  assert.equal((await swarm.result()).brief.missing, true);
  fs.writeFileSync(swarm.briefPath, 'one two three four');
  const { brief } = await swarm.result();
  assert.equal(brief.words, 4);
  assert.equal(brief.overBudget, false);
  assert.equal(brief.text, 'one two three four', 'a finished brief comes back inline');
  fs.writeFileSync(swarm.briefPath, 'word '.repeat(swarm.spec.briefWords * 2));
  assert.equal((await swarm.result()).brief.text, undefined, 'an oversized brief is not inlined');
  assert.match(fs.readFileSync(path.join(swarm.dir, 'handoff.md'), 'utf8'), /Brief: .*brief\.md \(read this instead of the sources\)/);
});

test('a design swarm result lists its final screenshots', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Verify the site', workspace, mode: 'verify', design: true, max_agents: 1 });
  await swarm.waitForAttention(5000);
  const screens = path.join(swarm.dir, 'screens');
  for (const f of ['home-390-final.png', 'home-390-v1.png', 'service-deep-1440-final.png']) fs.writeFileSync(path.join(screens, f), '');
  const { screenshots } = await swarm.result();
  assert.equal(screenshots.length, 2);
  assert.ok(screenshots.every((p) => p.endsWith('-final.png')));
  assert.match(fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8'), /<screen>-<viewport>-final.png/);
});

test('owner questions come back complete, numbered, and only from this run', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-ws-'));
  const manager = new SwarmManager({ launch: fakeLaunch('normal') });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({ objective: 'Stage 2', workspace, max_agents: 1 });
  await swarm.waitForAttention(5000);
  // A question left in the ledger by an earlier stage does not count.
  fs.appendFileSync(swarm.findings.file, JSON.stringify({ id: 'F-900', time: '2000-01-01T00:00:00.000Z', author: 'lead', type: 'question', scope: 'owner', message: 'Old stage question' }) + '\n');
  const long = `Information needed: ${'x'.repeat(1500)}`;
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'owner', message: 'Approval: Do you approve the visual direction?' });
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'coordinator', message: 'Which folder holds the logo?' });
  swarm.findings.append({ author: 'lead', type: 'question', scope: 'owner/images', message: long });
  const result = await swarm.result();
  assert.deepEqual(result.ownerQuestions.map((q) => q.n), [1, 2]);
  assert.equal(result.ownerQuestions[0].text, 'Approval: Do you approve the visual direction?');
  assert.equal(result.ownerQuestions[1].text, long, 'long questions are not cut at 500 characters');
  assert.ok(result.openQuestions.every((q) => !q.includes('visual direction')), 'owner questions stay out of the coordinator list');
  assert.ok(result.openQuestions.some((q) => q.includes('logo')));
  assert.match(fs.readFileSync(result.handoff, 'utf8'), /Questions for the owner[\s\S]*1\. Approval: Do you approve/);
});
