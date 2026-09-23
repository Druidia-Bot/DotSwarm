// A stand-in for the DotBot client library with the same exports DotSwarm uses. Tests point
// DOTSWARM_DOTBOT_CLIENT at this file. Behaviour is chosen by the query or skill id:
// a query containing "fail" throws, "slow" never answers; skill "missing-skill" is not found,
// "tampered" fails verification. Every load is appended to FAKE_DOTBOT_LOG when set.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const seenKeys = new Set();
export const calls = [];

export function readConfig(env = process.env) {
  return { apiKey: env.DOTBOT_API_KEY || '', baseUrl: 'https://dotbot.test', capabilities: ['runtime:node'] };
}

export function loadPublicKeys(env = process.env) {
  return env.FAKE_DOTBOT_NO_KEYS ? {} : { 'test-key': 'MCowBQYDK2VwAyEAplaceholderplaceholderplaceholderAAA=' };
}

export const hashFor = (id) => createHash('sha256').update(`skill:${id}`).digest('hex');

export function createApi({ baseUrl, apiKey }) {
  return {
    baseUrl,
    apiKey,
    async search({ query, capabilities, limit }) {
      calls.push({ kind: 'search', query, capabilities, limit });
      if (query.includes('fail')) throw new Error('Could not reach https://dotbot.test: network down');
      if (query.includes('slow')) return new Promise(() => {});
      return {
        searchMode: 'hybrid',
        reranked: true,
        results: [
          { id: 'fixture-alpha', name: 'Fixture alpha', score: 0.91, version: '1.0.0', contentHash: hashFor('fixture-alpha'), description: 'Prints a greeting.', whenNotToUse: 'Outside tests.', capabilityTags: ['runtime:bash'] },
          { id: 'fixture-beta', name: 'Fixture beta', score: 0.42, version: '2.1.0', contentHash: hashFor('fixture-beta'), description: 'Another fixture.', capabilityTags: [] },
        ].slice(0, limit ?? 10),
      };
    },
  };
}

export async function loadSkillInto({ id, version, contentHash, dir, idempotencyKey }) {
  const replayed = seenKeys.has(idempotencyKey);
  seenKeys.add(idempotencyKey);
  const entry = { kind: 'load', id, version: version ?? null, contentHash: contentHash ?? null, dir, idempotencyKey };
  calls.push(entry);
  if (process.env.FAKE_DOTBOT_LOG) fs.appendFileSync(process.env.FAKE_DOTBOT_LOG, JSON.stringify(entry) + '\n');
  if (id === 'missing-skill') throw new Error('Skill or version not found.');
  if (id === 'tampered') throw new Error('Refusing to load: SKILL.md does not match its manifest hash.');
  if (contentHash && contentHash !== hashFor(id)) throw new Error('Skill or version not found.');
  const target = path.join(dir, id);
  fs.mkdirSync(target, { recursive: true });
  const skillMd = `---\nname: ${id}\nversion: 1.0.0\n---\n# ${id}\n`;
  fs.writeFileSync(path.join(target, 'SKILL.md'), skillMd);
  return {
    path: target,
    skillMd,
    manifest: { skillId: id, version: '1.0.0', contentHash: hashFor(id), keyId: 'test-key' },
    charge: { credits: 5, balance: 95, replayed },
    files: ['SKILL.md'],
  };
}
