// Generate and verify the `swarm` dsh profile under our private DSH_HOME.
// Layers: dsh-base + dsh-sdk-app (in-box) + the experimental Agent Teams bundle
// (installed into the profile with pnpm through `dsh plugin`).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROFILE_NAME, TEAM_PROFILE_PACKAGE, TEAM_PROFILE_VERSION, dshBin, dshEnv, dshHome, profileDir } from './config.mjs';

const execFileAsync = promisify(execFile);

export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', TEAM_PROFILE_PACKAGE];

export const PROFILE_PATCH = `# DotSwarm profile layer. Privacy defaults: never contribute session logs
# or plugin inventory to upstream requests. The per-swarm patch adds the findings server.
- id: session-log-deepseek
  config:
    enabled: false
- id: plugin-package-inventory-deepseek
  config:
    enabled: false
`;

export function profileManifest() {
  return {
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: { [TEAM_PROFILE_PACKAGE]: TEAM_PROFILE_VERSION },
    dsh: { profile: { bundles: BUNDLES, patchReload: 'startup' } },
  };
}

/** Write manifest and patch. Re-asserts the bundle order after any pnpm reconcile. */
export function writeProfileFiles() {
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(profileManifest(), null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), PROFILE_PATCH);
  return dir;
}

export function teamBundleInstalled() {
  return fs.existsSync(path.join(profileDir(), 'node_modules', ...TEAM_PROFILE_PACKAGE.split('/'), 'package.json'));
}

export async function runDsh(args, { timeout = 300_000 } = {}) {
  const bin = dshBin();
  if (!fs.existsSync(bin)) throw new Error(`dsh is not installed at ${bin}; run swarm_setup or: npm run setup`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      env: dshEnv(), cwd: dshHome(), windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: (error.stderr ?? '') + (error.message ?? ''), code: error.code };
  }
}

/** Install the Agent Teams bundle into the profile with pnpm via `dsh plugin`. */
export async function installTeamBundle() {
  fs.mkdirSync(dshHome(), { recursive: true });
  writeProfileFiles();
  const result = await runDsh(['plugin', '--profile', PROFILE_NAME, 'install']);
  writeProfileFiles(); // pnpm reconcile may rewrite the bundle list; restore the exact layer order
  return result;
}

/** Compose the profile tree without booting it and check the rows we depend on. */
export async function verifyProfile() {
  const result = await runDsh(['--profile', PROFILE_NAME, '--dump-config'], { timeout: 120_000 });
  const text = result.stdout + '\n' + result.stderr;
  const rows = {
    sdkServer: /sdk-jsonrpc-server/.test(text),
    agentTeam: /id:\s*agent-team\b/.test(text),
    teamTools: /tool-agent-team/.test(text),
    subagentDisabled: /tool-subagent\b[\s\S]{0,80}disabled:\s*true/.test(text),
  };
  return { ok: result.ok && rows.sdkServer && rows.agentTeam && rows.teamTools, rows, tail: text.slice(-3000) };
}
