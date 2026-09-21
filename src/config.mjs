// Paths, defaults, and environment resolution for the swarm plugin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_NAME = 'swarm';
export const TEAM_PROFILE_PACKAGE = '@deepseek-ai/dsh-experimental-agent-team-profile';
export const TEAM_PROFILE_VERSION = '0.1.5-alpha.2';

export const DEFAULTS = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  // The only image-capable model the API currently lists; design swarms need read_image.
  visionModel: 'deepseek-flash',
  modes: ['build', 'refactor'],
  maxAgents: 3,
  maxAgentsCap: 7,
  // workspace-write blocks spawning native toolchain binaries on Windows (esbuild, workerd).
  permissionMode: 'danger-full-access',
  permissionModes: ['danger-full-access', 'workspace-write', 'read-only'],
  initializeTimeoutMs: 120_000,
  requestTimeoutMs: 30_000,
});

/** Directory for generated DSH homes, swarm logs, and worktrees. Never committed. */
export function workDir() {
  return path.resolve(process.env.DEEPASTRA_SWARM_HOME || path.join(ROOT, 'work'));
}

export function dshHome() {
  return path.join(workDir(), 'dsh-home');
}

export function swarmsDir() {
  return path.join(workDir(), 'swarms');
}

export function profileDir() {
  return path.join(dshHome(), 'profiles', PROFILE_NAME);
}

/**
 * Resolve the dsh launcher script (run through the current node executable so no
 * .cmd shim is involved). Order: DEEPASTRA_DSH_BIN, then the pinned harness install.
 */
export function dshBin() {
  const override = process.env.DEEPASTRA_DSH_BIN;
  if (override) return path.resolve(override);
  return path.join(ROOT, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

export function dshInstalled() {
  return fs.existsSync(dshBin());
}

export function findingsServerPath() {
  return path.join(ROOT, 'src', 'findings-server.mjs');
}

/** Whether a DeepSeek key is discoverable by dsh (env, DSH_HOME .env, or credentials file). */
export function deepseekKeySource() {
  if (process.env.DEEPSEEK_API_KEY) return 'environment';
  const home = dshHome();
  for (const [file, label] of [
    [path.join(home, '.credentials.yaml'), 'DSH_HOME/.credentials.yaml'],
    [path.join(home, '.env'), 'DSH_HOME/.env'],
  ]) {
    try {
      if (fs.readFileSync(file, 'utf8').includes('DEEPSEEK_API_KEY')) return label;
    } catch { /* absent */ }
  }
  return null;
}

/** Environment handed to every dsh subprocess. Telemetry off, home pinned. */
export function dshEnv(extra = {}) {
  return {
    ...process.env,
    DSH_HOME: dshHome(),
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    ...extra,
  };
}

/** Tool-result error codes that are the harness's own guards working, not team failures. */
export const BENIGN_TOOL_ERRORS = new Set([
  'FS_NOT_OBSERVED', 'FS_STALE_VERSION', 'FS_EDIT_NOT_FOUND', 'FS_NOT_FOUND', 'SEARCH_FAILED',
]);

/** Optional USD per million tokens for the cost line; unset means tokens only. */
export function tokenPrices() {
  const input = Number(process.env.DEEPASTRA_PRICE_INPUT_PER_M);
  const output = Number(process.env.DEEPASTRA_PRICE_OUTPUT_PER_M);
  return Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0) ? { input, output } : null;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}
