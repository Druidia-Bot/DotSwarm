#!/usr/bin/env node
// setup | doctor | smoke --live | profile-dump
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULTS, ROOT, TEAM_PROFILE_PACKAGE, deepseekKeySource, dshBin, dshHome, dshInstalled, profileDir } from './config.mjs';
import { installTeamBundle, runDsh, teamBundleInstalled, verifyProfile, writeProfileFiles } from './profile.mjs';
import { SwarmManager } from './swarm.mjs';

const execFileAsync = promisify(execFile);
const [command = 'doctor', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));

function line(ok, label, detail = '') {
  console.log(`${ok === null ? '  ' : ok ? 'OK' : '!!'}  ${label}${detail ? `  ${detail}` : ''}`);
}

async function commandExists(name) {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function doctor() {
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 22, `node ${process.versions.node}`, major >= 22 ? '' : 'needs 22+');
  line(dshInstalled(), `dsh executable ${dshBin()}`, dshInstalled() ? '' : 'run: npm run setup');
  if (dshInstalled()) {
    const v = await runDsh(['--version'], { timeout: 60_000 });
    line(v.ok, `dsh --version ${v.stdout.trim()}`, v.ok ? '' : v.stderr.slice(-300));
  }
  line(await commandExists('pnpm'), 'pnpm on PATH', '(dsh plugin install needs it)');
  line(fs.existsSync(path.join(profileDir(), 'package.json')), `profile ${profileDir()}`);
  line(teamBundleInstalled(), `${TEAM_PROFILE_PACKAGE} installed in profile`, teamBundleInstalled() ? '' : 'run: npm run setup');
  const key = deepseekKeySource();
  line(Boolean(key), 'DEEPSEEK_API_KEY', key ? `from ${key}` : `set it in the environment or in ${path.join(dshHome(), '.env')}`);
  if (dshInstalled() && teamBundleInstalled()) {
    const profile = await verifyProfile();
    line(profile.ok, 'profile composes with sdk server + agent team rows', JSON.stringify(profile.rows));
    if (!profile.ok) console.log(profile.tail);
  }
  line(null, `work dir ${path.dirname(dshHome())}`);
  line(null, `default model ${DEFAULTS.model} via ${DEFAULTS.provider}`);
}

async function setup() {
  if (!dshInstalled() && !process.env.DEEPASTRA_DSH_BIN) {
    console.log('Installing pinned DeepSeek Harness into harness/node_modules ...');
    await execFileAsync('npm', ['ci', '--prefix', path.join(ROOT, 'harness'), '--ignore-scripts'], {
      cwd: ROOT, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024,
    });
  }
  fs.mkdirSync(dshHome(), { recursive: true });
  writeProfileFiles();
  if (!teamBundleInstalled() || flags.has('--reinstall')) {
    console.log(`Installing ${TEAM_PROFILE_PACKAGE} into the swarm profile with pnpm ...`);
    const result = await installTeamBundle();
    if (!result.ok) {
      console.error(result.stderr.slice(-3000));
      throw new Error('profile install failed');
    }
  }
  const profile = await verifyProfile();
  line(profile.ok, 'profile composes with sdk server + agent team rows', JSON.stringify(profile.rows));
  if (!profile.ok) {
    console.log(profile.tail);
    throw new Error('profile verification failed');
  }
  if (!deepseekKeySource()) {
    console.log(`\nAdd your key before starting a swarm: create ${path.join(dshHome(), '.env')} containing\nDEEPSEEK_API_KEY=...`);
  }
  console.log('\nSetup complete. Register the Codex plugin with scripts/install-codex-plugin.ps1');
}

async function smoke() {
  if (!flags.has('--live')) {
    console.log('smoke needs --live (it spends DeepSeek tokens). It starts a 1-teammate swarm in a temp directory.');
    return;
  }
  const workspace = positional[0] ? path.resolve(positional[0]) : fs.mkdtempSync(path.join(os.tmpdir(), 'deepastra-smoke-'));
  if (!positional[0]) fs.writeFileSync(path.join(workspace, 'README.md'), '# smoke\n');
  console.log(`workspace: ${workspace}`);
  const manager = new SwarmManager();
  const swarm = await manager.start({
    objective: 'Create a file hello.txt containing the single line "hello from the swarm" and verify it exists with a shell command.',
    acceptance_criteria: ['hello.txt exists in the workspace with exactly that line'],
    workspace,
    max_agents: 1,
  });
  console.log(`started ${swarm.id}`);
  const deadline = Date.now() + 10 * 60_000;
  while (swarm.phase !== 'idle' && swarm.alive && Date.now() < deadline) {
    await swarm.waitForChange(20_000);
    const s = swarm.status();
    console.log(`[${s.elapsedSeconds}s] ${s.phase} roster=${s.roster.length} tasks=${JSON.stringify(s.tasks.counts)} tokens=${JSON.stringify(s.tokens)}`);
  }
  console.log(JSON.stringify(await swarm.result(), null, 2));
  await swarm.stop();
}

try {
  if (command === 'doctor') await doctor();
  else if (command === 'setup') await setup();
  else if (command === 'smoke') await smoke();
  else if (command === 'profile-dump') {
    const r = await runDsh(['--profile', 'swarm', '--dump-config'], { timeout: 120_000 });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
  } else {
    console.log('usage: node src/cli.mjs <setup|doctor|smoke --live [workspace]|profile-dump>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
