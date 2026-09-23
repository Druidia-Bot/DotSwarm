// Optional DotBot integration: skill search at planning time and verified skill loading into
// the swarm directory. DotSwarm ships none of DotBot's code; it imports the DotBot client
// library at runtime when one is installed and a DotBot key is configured. Every failure here
// (no client, no key, network, timeout, a skill that fails verification) returns null or an
// error entry, and the swarm runs exactly as it would without DotBot.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.mjs';

export const DOTBOT_LIMITS = Object.freeze({
  connectMs: 3000,
  searchMs: 8000,
  loadMs: 30_000,
  resultsPerUnit: 3,
  maxUnits: 15,
  maxSkills: 10,
});

const REQUIRED_EXPORTS = ['createApi', 'readConfig', 'loadPublicKeys', 'loadSkillInto'];

/**
 * Where the DotBot client library might be: DOTSWARM_DOTBOT_CLIENT (its folder or index.mjs),
 * then a DotBot plugin installed beside this one in the same marketplace.
 */
export function dotbotClientCandidates(env = process.env) {
  const candidates = [];
  if (env.DOTSWARM_DOTBOT_CLIENT) {
    const given = path.resolve(env.DOTSWARM_DOTBOT_CLIENT);
    candidates.push(given.endsWith('.mjs') ? given : path.join(given, 'index.mjs'));
  }
  candidates.push(path.join(ROOT, '..', 'dotbot', 'client', 'index.mjs'));
  return candidates;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const message = (error) => String(error?.message ?? error).slice(0, 300);

/**
 * Connect to DotBot if a client and a key are available. Never throws; returns null when
 * DotBot is not usable, with the reason in `onSkip` for diagnostics.
 * @param {{ env?: NodeJS.ProcessEnv, importModule?: (url: string) => Promise<any>, onSkip?: (reason: string) => void, limits?: Partial<typeof DOTBOT_LIMITS> }} [options]
 */
export async function connectDotbot({ env = process.env, importModule = (url) => import(url), onSkip = () => {}, limits = {} } = {}) {
  const limit = { ...DOTBOT_LIMITS, ...limits };
  const skip = (reason) => {
    onSkip(reason);
    return null;
  };
  try {
    const file = dotbotClientCandidates(env).find((candidate) => fs.existsSync(candidate));
    if (!file) return skip('no DotBot client installed');
    const client = await withTimeout(importModule(pathToFileURL(file).href), limit.connectMs, 'loading the DotBot client');
    const missing = REQUIRED_EXPORTS.filter((name) => typeof client?.[name] !== 'function');
    if (missing.length) return skip(`the DotBot client at ${file} lacks ${missing.join(', ')}`);
    const config = client.readConfig(env);
    if (!config?.apiKey) return skip('no DotBot key configured');
    const keys = client.loadPublicKeys(env) ?? {};
    const api = client.createApi({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    return createDotbot({ client, api, keys, capabilities: config.capabilities ?? [], baseUrl: config.baseUrl, limits: limit });
  } catch (error) {
    return skip(`DotBot client failed to start: ${message(error)}`);
  }
}

/** The operations DotSwarm uses, over an already-configured DotBot client. Exported for tests. */
export function createDotbot({ client, api, keys, capabilities, baseUrl, limits = {} }) {
  const limit = { ...DOTBOT_LIMITS, ...limits };
  return {
    baseUrl,

    /**
     * Search once per work unit, in parallel, each under its own time limit. A unit whose search
     * fails carries an error instead of results; the call itself never fails.
     */
    async findSkills(units, { perUnit = limit.resultsPerUnit } = {}) {
      const list = units.map((u) => String(u ?? '').trim()).filter(Boolean).slice(0, limit.maxUnits);
      return Promise.all(list.map(async (unit) => {
        try {
          const response = await withTimeout(api.search({ query: unit, capabilities, limit: perUnit }), limit.searchMs, 'skill search');
          const results = (response?.results ?? []).slice(0, perUnit).map((r) => ({
            id: r.id, score: r.score, version: r.version, contentHash: r.contentHash, name: r.name, description: r.description,
            ...(r.whenNotToUse ? { whenNotToUse: r.whenNotToUse } : {}),
            ...(r.capabilityTags?.length ? { requires: r.capabilityTags } : {}),
          }));
          return { unit, searchMode: response?.searchMode ?? null, results };
        } catch (error) {
          return { unit, results: [], error: message(error) };
        }
      }));
    },

    /**
     * Load skills into `dir`, verifying each against the client's trusted keys before writing.
     * Each request may pin a content hash (resume) and carry the idempotency key of an earlier
     * load of the same version, so loading it again is not charged again.
     */
    async loadSkills(requests, { dir, idempotencyPrefix }) {
      const loaded = [];
      const failed = [];
      if (Object.keys(keys).length === 0) {
        return { loaded, failed: requests.map((r) => ({ id: r.id, unit: r.unit ?? null, reason: 'the DotBot client has no trusted signing keys, so nothing can be verified' })) };
      }
      for (const request of requests.slice(0, limit.maxSkills)) {
        const idempotencyKey = request.idempotencyKey ?? `${idempotencyPrefix}:${request.id}`;
        try {
          const result = await withTimeout(client.loadSkillInto({
            api, keys, id: request.id, version: request.version, contentHash: request.contentHash, dir, idempotencyKey,
          }), limit.loadMs, `loading skill ${request.id}`);
          loaded.push({
            id: result.manifest.skillId,
            version: result.manifest.version,
            contentHash: result.manifest.contentHash,
            keyId: result.manifest.keyId,
            path: result.path,
            unit: request.unit ?? null,
            idempotencyKey,
            credits: result.charge?.credits ?? null,
            replayed: Boolean(result.charge?.replayed),
          });
        } catch (error) {
          failed.push({ id: request.id, unit: request.unit ?? null, reason: message(error) });
        }
      }
      return { loaded, failed };
    },
  };
}

/** Validate the coordinator's skill assignments from swarm_start. */
export function parseSkillRequests(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('skills must be an array of { id, work_unit?, content_hash? }');
  if (value.length > DOTBOT_LIMITS.maxSkills) throw new Error(`at most ${DOTBOT_LIMITS.maxSkills} skills per swarm`);
  return value.map((item) => {
    const id = String(item?.id ?? '').trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`skill id ${JSON.stringify(item?.id)} is not a skill id from swarm_find_skills`);
    const contentHash = item.content_hash ? String(item.content_hash).trim().toLowerCase() : undefined;
    if (contentHash && !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error(`content_hash for ${id} must be a SHA-256 hex digest`);
    return { id, ...(contentHash ? { contentHash } : {}), ...(item.work_unit ? { unit: String(item.work_unit).trim().slice(0, 300) } : {}) };
  });
}
