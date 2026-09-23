import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectDotbot, dotbotClientCandidates, parseSkillRequests } from '../src/dotbot.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dotbot-client.mjs');
const fakeEnv = (extra = {}) => ({ DOTSWARM_DOTBOT_CLIENT: FAKE, DOTBOT_API_KEY: 'dot_test', ...extra });

async function connect(env, limits) {
  const reasons = [];
  const dotbot = await connectDotbot({ env, onSkip: (r) => reasons.push(r), limits });
  return { dotbot, reasons };
}

test('without a client or a key DotBot stays off and says why', async () => {
  let r = await connect({});
  assert.equal(r.dotbot, null);
  assert.match(r.reasons[0], /no DotBot client installed/);

  r = await connect(fakeEnv({ DOTBOT_API_KEY: '' }));
  assert.equal(r.dotbot, null);
  assert.match(r.reasons[0], /no DotBot key/);

  // A module that is not the DotBot client.
  r = await connect({ DOTSWARM_DOTBOT_CLIENT: fileURLToPath(new URL('../src/findings.mjs', import.meta.url)), DOTBOT_API_KEY: 'dot_test' });
  assert.equal(r.dotbot, null);
  assert.match(r.reasons[0], /lacks createApi/);

  // A client that throws while loading.
  const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dotbot-broken-')), 'index.mjs');
  fs.writeFileSync(broken, 'throw new Error("boom");\n');
  r = await connect({ DOTSWARM_DOTBOT_CLIENT: path.dirname(broken), DOTBOT_API_KEY: 'dot_test' });
  assert.equal(r.dotbot, null);
  assert.match(r.reasons[0], /failed to start: boom/);
});

test('the client is found by environment variable, then beside this plugin', () => {
  const [first, second] = dotbotClientCandidates({ DOTSWARM_DOTBOT_CLIENT: '/opt/dotbot/client' });
  assert.equal(first, path.join(path.resolve('/opt/dotbot/client'), 'index.mjs'));
  assert.match(second, /[\\/]dotbot[\\/]client[\\/]index\.mjs$/);
  assert.equal(dotbotClientCandidates({})[0], second);
});

test('searches every work unit in parallel and turns failures and timeouts into per-unit errors', async () => {
  const { dotbot } = await connect(fakeEnv(), { searchMs: 200 });
  assert.equal(dotbot.baseUrl, 'https://dotbot.test');
  const started = Date.now();
  const units = await dotbot.findSkills(['print a greeting from bash', 'this one will fail', 'this one is slow', '  ']);
  assert.ok(Date.now() - started < 2000, 'a slow search does not hold up the others');
  assert.equal(units.length, 3);
  assert.equal(units[0].results[0].id, 'fixture-alpha');
  assert.equal(units[0].results[0].contentHash.length, 64);
  assert.deepEqual(units[0].results[0].requires, ['runtime:bash']);
  assert.equal(units[0].results.length, 2);
  assert.match(units[1].error, /network down/);
  assert.match(units[2].error, /longer than 200 ms/);
  assert.deepEqual(units[2].results, []);
});

test('loads skills into a directory and reports each failure without throwing', async () => {
  const { dotbot } = await connect(fakeEnv());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotbot-load-'));
  const { loaded, failed } = await dotbot.loadSkills(
    [{ id: 'fixture-alpha', unit: 'greeting' }, { id: 'missing-skill' }, { id: 'tampered', unit: 'x' }],
    { dir, idempotencyPrefix: 'dotswarm:sw-test' },
  );
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'fixture-alpha');
  assert.equal(loaded[0].idempotencyKey, 'dotswarm:sw-test:fixture-alpha');
  assert.equal(loaded[0].unit, 'greeting');
  assert.ok(fs.existsSync(path.join(dir, 'fixture-alpha', 'SKILL.md')));
  assert.deepEqual(failed.map((f) => f.id), ['missing-skill', 'tampered']);
  assert.match(failed[1].reason, /Refusing to load/);

  const noKeys = (await connect(fakeEnv({ FAKE_DOTBOT_NO_KEYS: '1' }))).dotbot;
  const refused = await noKeys.loadSkills([{ id: 'fixture-alpha' }], { dir, idempotencyPrefix: 'p' });
  assert.equal(refused.loaded.length, 0);
  assert.match(refused.failed[0].reason, /no trusted signing keys/);
});

test('skill assignments are validated', () => {
  assert.deepEqual(parseSkillRequests(undefined), []);
  assert.deepEqual(parseSkillRequests([{ id: 'fixture-alpha', work_unit: ' greeting ', content_hash: 'A'.repeat(64) }]), [
    { id: 'fixture-alpha', contentHash: 'a'.repeat(64), unit: 'greeting' },
  ]);
  assert.throws(() => parseSkillRequests('fixture-alpha'), /array/);
  assert.throws(() => parseSkillRequests([{ id: 'Not An Id' }]), /not a skill id/);
  assert.throws(() => parseSkillRequests([{ id: 'ok', content_hash: 'xyz' }]), /SHA-256/);
  assert.throws(() => parseSkillRequests(Array.from({ length: 11 }, () => ({ id: 'a' }))), /at most 10/);
});
