// Setup and doctor as data: used by the CLI and by the swarm_setup / swarm_doctor tools.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULTS, DSH_PACKAGE, DSH_VERSION, TEAM_PROFILE_PACKAGE, dataDir, deepseekKeySource, dshBin, dshHome,
  dshInstalled, harnessDir, keyFile, profileDir,
} from './config.mjs';
import { agentsStatus, codexHome, installAgents } from './agents.mjs';
import { installTeamBundle, runDsh, teamBundleInstalled, verifyProfile, writeProfileFiles } from './profile.mjs';

const execFileAsync = promisify(execFile);

async function commandExists(name) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Install the pinned harness into the data directory with npm. */
export async function installHarness() {
  const dir = harnessDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dotswarm-harness',
    private: true,
    description: 'Pinned DeepSeek Harness executable installed by DotSwarm. Nothing of DotSwarm lives here.',
    dependencies: { [DSH_PACKAGE]: DSH_VERSION },
  }, null, 2) + '\n');
  // npm is a .cmd shim on Windows, which Node refuses to spawn without a shell; one
  // fixed command string keeps the shell path free of interpolated arguments.
  await execFileAsync('npm install --ignore-scripts --no-audit --no-fund --save-exact', [], {
    cwd: dir, windowsHide: true, shell: true, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000,
  });
}

/**
 * Idempotent setup: harness, profile, Agent Teams bundle, composition check.
 * @returns {Promise<{ok: boolean, steps: Array<{label: string, ok: boolean, detail?: string}>, keyFile: string, dataDir: string}>}
 */
export async function runSetup({ reinstall = false, log = () => {} } = {}) {
  const steps = [];
  const step = (label, ok, detail = '') => { steps.push({ label, ok, ...(detail ? { detail } : {}) }); log(`${ok ? 'OK' : '!!'}  ${label}${detail ? `  ${detail}` : ''}`); };
  try {
    if (!dshInstalled() || (reinstall && !process.env.DOTSWARM_DSH_BIN)) {
      log(`Installing ${DSH_PACKAGE}@${DSH_VERSION} into ${harnessDir()} (a few minutes) ...`);
      await installHarness();
    }
    step(`harness ${DSH_PACKAGE}@${DSH_VERSION}`, dshInstalled(), dshBin());
    if (!dshInstalled()) throw new Error('harness install did not produce the dsh executable');

    fs.mkdirSync(dshHome(), { recursive: true });
    writeProfileFiles();
    if (!teamBundleInstalled() || reinstall) {
      if (!(await commandExists('pnpm'))) throw new Error('pnpm is required to install the Agent Teams bundle into the profile (npm install -g pnpm)');
      log(`Installing ${TEAM_PROFILE_PACKAGE} into the swarm profile with pnpm ...`);
      const result = await installTeamBundle();
      if (!result.ok) throw new Error(`profile install failed: ${result.stderr.slice(-2000)}`);
    }
    step(`profile ${profileDir()}`, teamBundleInstalled());

    const profile = await verifyProfile();
    step('profile composes with sdk server + agent team rows', profile.ok, JSON.stringify(profile.rows));
    if (!profile.ok) throw new Error(`profile verification failed: ${profile.tail.slice(-2000)}`);

    const agents = installAgents();
    step('Codex subagents in ' + codexHome(), agents.every((a) => a.state !== 'missing'),
      agents.map((a) => `${a.name}: ${a.state}`).join(', '));

    const key = deepseekKeySource();
    step('DEEPSEEK_API_KEY', Boolean(key), key ? `from ${key}` : `add DEEPSEEK_API_KEY=... to ${keyFile()}`);
    return { ok: steps.every((s) => s.ok), steps, keyFile: keyFile(), dataDir: dataDir() };
  } catch (error) {
    step('setup', false, error.message.slice(0, 2000));
    return { ok: false, steps, keyFile: keyFile(), dataDir: dataDir() };
  }
}

/** Read-only health report. */
export async function runDoctor() {
  const checks = [];
  const check = (label, ok, detail = '') => checks.push({ label, ok, ...(detail ? { detail } : {}) });
  const major = Number(process.versions.node.split('.')[0]);
  check(`node ${process.versions.node}`, major >= 22, major >= 22 ? '' : 'needs 22+');
  check('pnpm on PATH', await commandExists('pnpm'), 'needed once, to install the Agent Teams bundle');
  check(`dsh executable`, dshInstalled(), dshInstalled() ? dshBin() : 'run swarm_setup');
  if (dshInstalled()) {
    const v = await runDsh(['--version'], { timeout: 60_000 });
    check(`dsh --version ${v.stdout.trim()}`, v.ok, v.ok ? '' : v.stderr.slice(-300));
  }
  check(`${TEAM_PROFILE_PACKAGE} in profile`, teamBundleInstalled(), teamBundleInstalled() ? profileDir() : 'run swarm_setup');
  const agents = agentsStatus();
  check('Codex subagents (designer, imager, writer)', agents.every((a) => a.state !== 'missing'),
    agents.length ? agents.map((a) => `${a.name}: ${a.state}`).join(', ') : 'no templates found; reinstall the plugin');

  const key = deepseekKeySource();
  check('DEEPSEEK_API_KEY', Boolean(key), key ? `from ${key}` : `add DEEPSEEK_API_KEY=... to ${keyFile()}`);
  if (dshInstalled() && teamBundleInstalled()) {
    const profile = await verifyProfile();
    check('profile composes with sdk server + agent team rows', profile.ok, JSON.stringify(profile.rows));
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    dataDir: dataDir(),
    keyFile: keyFile(),
    defaults: { model: DEFAULTS.model, visionModel: DEFAULTS.visionModel, provider: DEFAULTS.provider },
  };
}
