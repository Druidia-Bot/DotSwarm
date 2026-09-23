import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, relocateTeamIdentity } from '../src/stable-prefix.mjs';

const POLICY = 'Agent Teams is available in this session.\n\nThe Lead must wait for required teammates before giving the final answer.';
const identity = (role, name) => `Your Team role is ${role}; your Team name is ${name}; Team id is swarm-sw-260101000000-abcd.`;
const assembly = (role, name) => ({
  sections: [
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'team:policy', text: `${POLICY}\n\n${identity(role, name)}` },
    { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result.' },
  ],
  contexts: [{ name: 'sandbox', text: 'Current DSH file policy: danger-full-access.' }],
  tools: [{ name: 'bash' }],
  variables: {},
});
const systemText = (a) => a.sections.map((s) => s.text).join('\n\n');

test('every member gets the same system prompt, and its own identity in the runtime context', () => {
  const lead = relocateTeamIdentity(assembly('lead', 'lead'));
  const worker = relocateTeamIdentity(assembly('teammate', 'implementer'));
  assert.equal(systemText(lead), systemText(worker));
  assert.doesNotMatch(systemText(lead), /Your Team role/);
  assert.equal(lead.sections.find((s) => s.name === 'team:policy').text, POLICY);
  assert.deepEqual(lead.contexts.at(-1), { name: 'team:identity', text: identity('lead', 'lead') });
  assert.deepEqual(worker.contexts.at(-1), { name: 'team:identity', text: identity('teammate', 'implementer') });
  assert.deepEqual(lead.tools, [{ name: 'bash' }]);
});

test('leaves the assembly alone when there is no runtime context to carry the sentence', () => {
  const input = { ...assembly('lead', 'lead'), contexts: [] };
  assert.equal(relocateTeamIdentity(input), input);
});

test('leaves the assembly alone without a team policy section or identity sentence', () => {
  const noTeam = { ...assembly('lead', 'lead'), sections: [{ name: 'harness:identity', text: 'x' }] };
  assert.equal(relocateTeamIdentity(noTeam), noTeam);
  const reworded = assembly('lead', 'lead');
  reworded.sections[1] = { name: 'team:policy', text: POLICY };
  assert.equal(relocateTeamIdentity(reworded), reworded);
});

test('apply transforms the downstream result of the system-prompt/assemble waterfall', async () => {
  const listeners = new Map();
  apply({ on: (event, listener) => listeners.set(event, listener) });
  const listener = listeners.get('system-prompt/assemble');
  const out = await listener(undefined, {}, async () => assembly('teammate', 'reviewer'));
  assert.equal(out.contexts.at(-1).text, identity('teammate', 'reviewer'));
});
