// Paths, defaults, and environment resolution for DotSwarm.
// The plugin directory is read-only (Codex caches it); everything generated
// lives in a per-user data directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin directory: this file's parent. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const PROFILE_NAME = 'swarm';
export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const DSH_VERSION = '0.1.5-rc.2';
export const TEAM_PROFILE_PACKAGE = '@deepseek-ai/dsh-experimental-agent-team-profile';
export const TEAM_PROFILE_VERSION = '0.1.5-alpha.2';

export const DEFAULTS = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  // The only image-capable model the API currently lists; design swarms need read_image.
  visionModel: 'deepseek-flash',
  // build: implement a spec. brief: read sources and condense them for the coordinator.
  // verify: run every check and fix mechanical defects. refactor: resolve an audit list.
  modes: ['build', 'brief', 'verify', 'refactor'],
  briefWords: 12_000,
  briefWordsCap: 30_000,
  maxAgents: 3,
  maxAgentsCap: 7,
  // workspace-write blocks spawning native toolchain binaries on Windows (esbuild, workerd).
  permissionMode: 'danger-full-access',
  permissionModes: ['danger-full-access', 'workspace-write', 'read-only'],
  initializeTimeoutMs: 120_000,
  requestTimeoutMs: 30_000,
});

/** Per-user data directory: DOTSWARM_HOME, else %LOCALAPPDATA%\DotSwarm on Windows or ~/.dotswarm. */
export function dataDir() {
  if (process.env.DOTSWARM_HOME) return path.resolve(process.env.DOTSWARM_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DotSwarm');
  }
  return path.join(os.homedir(), '.dotswarm');
}

/** Alias kept for the swarm and monitor modules. */
export function workDir() {
  return dataDir();
}

export function harnessDir() {
  return path.join(dataDir(), 'harness');
}

export function dshHome() {
  return path.join(dataDir(), 'dsh-home');
}

export function swarmsDir() {
  return path.join(dataDir(), 'swarms');
}

export function profileDir() {
  return path.join(dshHome(), 'profiles', PROFILE_NAME);
}

/** The dsh launcher script, run through the current node executable. */
export function dshBin() {
  const override = process.env.DOTSWARM_DSH_BIN;
  if (override) return path.resolve(override);
  return path.join(harnessDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

export function dshInstalled() {
  return fs.existsSync(dshBin());
}

export function findingsServerPath() {
  return path.join(ROOT, 'src', 'findings-server.mjs');
}

export function keyFile() {
  return path.join(dshHome(), '.env');
}

/** Whether a DeepSeek key is discoverable by dsh (env, DSH_HOME .env, or credentials file). */
export function deepseekKeySource() {
  if (process.env.DEEPSEEK_API_KEY) return 'environment';
  const home = dshHome();
  for (const [file, label] of [
    [path.join(home, '.credentials.yaml'), 'dsh-home/.credentials.yaml'],
    [path.join(home, '.env'), 'dsh-home/.env'],
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
  const input = Number(process.env.DOTSWARM_PRICE_INPUT_PER_M);
  const output = Number(process.env.DOTSWARM_PRICE_OUTPUT_PER_M);
  return Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0) ? { input, output } : null;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}
