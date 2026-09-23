import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.DOTSWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-dotbot-test-'));
const { SwarmManager } = await import('../src/swarm.mjs');
const { DshClient } = await import('../src/dsh-client.mjs');
const { connectDotbot } = await import('../src/dotbot.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeDsh = path.join(here, 'fixtures', 'fake-dsh.mjs');
const fakeClientFile = path.join(here, 'fixtures', 'fake-dotbot-client.mjs');
const fakeClient = await import(new URL('./fixtures/fake-dotbot-client.mjs', import.meta.url).href);

const launch = ({ swarm, patchFile }) => new DshClient({
  command: process.execPath, args: [fakeDsh, '--profile', 'swarm', '--patch', patchFile], cwd: swarm.workspace,
  env: { ...process.env, FAKE_DSH_MODE: 'normal' }, initializeTimeoutMs: 10_000, requestTimeoutMs: 5000,
});

const dotbot = await connectDotbot({ env: { DOTSWARM_DOTBOT_CLIENT: fakeClientFile, DOTBOT_API_KEY: 'dot_test' } });
assert.ok(dotbot, 'fake DotBot connects');

async function settle(swarm) {
  const deadline = Date.now() + 5000;
  while (swarm.phase !== 'idle' && Date.now() < deadline) await swarm.waitForChange(500);
}

test('assigned skills are loaded into the swarm directory, recorded in the ledger, and handed to the Lead', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-dotbot-ws-'));
  const manager = new SwarmManager({ launch, dotbot });
  t.after(() => manager.shutdownAll());
  const swarm = await manager.start({
    objective: 'Greet', workspace,
    skills: [{ id: 'fixture-alpha', work_unit: '1. print the greeting' }, { id: 'missing-skill', work_unit: '2. something else' }],
  });

  const skillDir = path.join(swarm.dir, 'skills', 'fixture-alpha');
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'written under the swarm directory, not the workspace');
  assert.equal(fs.existsSync(path.join(workspace, 'fixture-alpha')), false);
  assert.equal(swarm.skills.loaded[0].idempotencyKey, `dotswarm:${swarm.id}:fixture-alpha`);
  assert.deepEqual(swarm.skills.failed.map((f) => f.id), ['missing-skill']);

  const ledger = swarm.findings.readAll().filter((f) => f.scope === 'skills');
  assert.equal(ledger[0].type, 'decision');
  assert.equal(ledger[0].author, 'dotbot');
  assert.match(ledger[0].message, new RegExp(`fixture-alpha v1\\.0\\.0 \\(content hash ${fakeClient.hashFor('fixture-alpha')}\\) loaded and verified`));
  assert.match(ledger[1].message, /missing-skill was not loaded \(Skill or version not found\.\); work unit "2\. something else" proceeds without it/);

  const prompt = fs.readFileSync(path.join(swarm.dir, 'lead-prompt.md'), 'utf8');
  assert.match(prompt, /SKILLS ASSIGNED BY THE COORDINATOR/);
  assert.ok(prompt.includes(`- 1. print the greeting: ${skillDir.split(path.sep).join('/')}/SKILL.md (skill fixture-alpha v1.0.0)`));
  assert.doesNotMatch(prompt, /missing-skill/);

  const spec = JSON.parse(fs.readFileSync(path.join(swarm.dir, 'spec.json'), 'utf8'));
  assert.equal(spec.skills[0].contentHash, fakeClient.hashFor('fixture-alpha'));

  await settle(swarm);
  const result = await swarm.result();
  assert.match(result.skills[0], /^fixture-alpha@[0-9a-f]{12} /);
  // Skill ledger entries are decisions and discoveries, so they never show up as open warnings.
  assert.deepEqual(result.ledger.open, []);
});

test('resume fetches the same versions by content hash with the same idempotency key', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-dotbot-ws-'));
  const manager = new SwarmManager({ launch, dotbot });
  t.after(() => manager.shutdownAll());
  const first = await manager.start({ objective: 'Greet', workspace, skills: [{ id: 'fixture-alpha', work_unit: 'greeting' }] });
  await settle(first);
  await first.stop();

  const later = new SwarmManager({ launch, dotbot });
  t.after(() => later.shutdownAll());
  const before = fakeClient.calls.length;
  const resumed = await later.resume(first.id, { instruction: 'finish' });
  const load = fakeClient.calls.slice(before).find((c) => c.kind === 'load');
  assert.equal(load.contentHash, fakeClient.hashFor('fixture-alpha'), 'pinned to the hash the first swarm loaded');
  assert.equal(load.version, null);
  assert.equal(load.idempotencyKey, `dotswarm:${first.id}:fixture-alpha`, 'same key, so the same version is not charged again');
  assert.ok(fs.existsSync(path.join(resumed.dir, 'skills', 'fixture-alpha', 'SKILL.md')));
  assert.equal(resumed.skills.loaded[0].unit, 'greeting');
  assert.match(fs.readFileSync(path.join(resumed.dir, 'lead-prompt.md'), 'utf8'), /- greeting: .*\/skills\/fixture-alpha\/SKILL\.md/);
  assert.equal(resumed.spec.skillRequests.length, 1);
});

test('without DotBot, resume falls back to the previous verified copy, and skills are otherwise ignored', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-dotbot-ws-'));
  const withDotbot = new SwarmManager({ launch, dotbot });
  t.after(() => withDotbot.shutdownAll());
  const first = await withDotbot.start({ objective: 'Greet', workspace, skills: [{ id: 'fixture-alpha' }] });
  await settle(first);
  await first.stop();

  const offline = new SwarmManager({ launch });
  t.after(() => offline.shutdownAll());
  const resumed = await offline.resume(first.id);
  assert.equal(resumed.skills.loaded[0].reused, true);
  assert.equal(resumed.skills.loaded[0].path, first.skills.loaded[0].path);
  assert.match(resumed.findings.readAll().at(-1).message, /re-used from the previous swarm/);

  await settle(resumed);
  await resumed.stop();

  // With the previous copy gone as well, the skill is noted and the work proceeds.
  fs.rmSync(path.join(first.dir, 'skills'), { recursive: true, force: true });
  const again = await offline.resume(resumed.id);
  assert.equal(again.skills.loaded.length, 0);
  assert.match(again.skills.failed[0].reason, /DotBot is not configured/);

  // A fresh swarm without DotBot ignores the argument entirely.
  const plain = await offline.start({ objective: 'Greet', workspace, skills: [{ id: 'fixture-alpha' }] });
  assert.equal(plain.spec.skillRequests, undefined);
  assert.equal(plain.skills, null);
  assert.doesNotMatch(fs.readFileSync(path.join(plain.dir, 'lead-prompt.md'), 'utf8'), /SKILLS ASSIGNED/);
});
