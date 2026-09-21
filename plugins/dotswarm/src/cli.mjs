#!/usr/bin/env node
// setup | doctor | smoke --live [workspace] | profile-dump
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_NAME } from './config.mjs';
import { runDsh } from './profile.mjs';
import { runDoctor, runSetup } from './setup.mjs';
import { SwarmManager } from './swarm.mjs';

const [command = 'doctor', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));

function print(rows) {
  for (const r of rows) console.log(`${r.ok ? 'OK' : '!!'}  ${r.label}${r.detail ? `  ${r.detail}` : ''}`);
}

async function smoke() {
  if (!flags.has('--live')) {
    console.log('smoke needs --live (it spends DeepSeek tokens). It starts a 1-teammate swarm in a temp directory.');
    return;
  }
  const workspace = positional[0] ? path.resolve(positional[0]) : fs.mkdtempSync(path.join(os.tmpdir(), 'dotswarm-smoke-'));
  if (!positional[0]) fs.writeFileSync(path.join(workspace, 'README.md'), '# smoke\n');
  console.log(`workspace: ${workspace}`);
  const manager = new SwarmManager();
  const swarm = await manager.start({
    objective: 'Create a file hello.txt containing the single line "hello from the swarm" and verify it exists with a shell command.',
    acceptance_criteria: ['hello.txt exists in the workspace with exactly that line'],
    workspace,
    max_agents: 1,
    isolate: false,
  });
  console.log(`started ${swarm.id}`);
  const deadline = Date.now() + 10 * 60_000;
  while (swarm.phase !== 'idle' && swarm.alive && Date.now() < deadline) {
    await swarm.waitForChange(20_000);
    const s = swarm.status();
    console.log(`[${s.elapsedSeconds}s] ${s.phase} roster=${s.roster.length} tasks=${JSON.stringify(s.tasks.counts)} tokens=${JSON.stringify(s.cost.swarmTokens)}`);
  }
  console.log(JSON.stringify(await swarm.result(), null, 2));
  await swarm.stop();
}

try {
  if (command === 'doctor') {
    const report = await runDoctor();
    print(report.checks);
    console.log(`    data dir ${report.dataDir}`);
    console.log(`    key file ${report.keyFile}`);
    process.exitCode = report.ok ? 0 : 1;
  } else if (command === 'setup') {
    const report = await runSetup({ reinstall: flags.has('--reinstall'), log: (line) => console.log(line) });
    if (!report.ok) process.exitCode = 1;
    else console.log('\nSetup complete.');
  } else if (command === 'smoke') {
    await smoke();
  } else if (command === 'profile-dump') {
    const r = await runDsh(['--profile', PROFILE_NAME, '--dump-config'], { timeout: 120_000 });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
  } else {
    console.log('usage: node src/cli.mjs <setup [--reinstall]|doctor|smoke --live [workspace]|profile-dump>');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
