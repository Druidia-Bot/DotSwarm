#!/usr/bin/env node
// Replay a swarm's events.jsonl into the same compressed state the MCP server
// reports, from outside that process. Usage: node scripts/monitor.mjs [swarmId|latest] [--tail N] [--members]
import fs from 'node:fs';
import path from 'node:path';
import { swarmsDir } from '../src/config.mjs';
import { Findings } from '../src/findings.mjs';
import { parseReport } from '../src/prompt.mjs';
import { SwarmState } from '../src/swarm-state.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const tail = Number(args[args.indexOf('--tail') + 1]) || 0;
const wsFilter = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
let id = args.find((a, i) => !a.startsWith('--') && a !== String(tail) && args[i - 1] !== '--workspace') ?? 'latest';
if (id === 'latest') {
  const ids = fs.readdirSync(swarmsDir()).filter((d) => d.startsWith('sw-')).sort();
  id = ids.filter((d) => {
    if (!wsFilter) return true;
    try { return JSON.parse(fs.readFileSync(path.join(swarmsDir(), d, 'spec.json'), 'utf8')).workspace.toLowerCase().includes(wsFilter.toLowerCase()); } catch { return false; }
  }).at(-1);
}
const dir = path.join(swarmsDir(), id);
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const state = new SwarmState(`swarm-${id}`);
const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
let first = null; let last = null; let exit = null; const stderr = []; const prompts = [];
for (const line of lines) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  first ??= r.time; last = r.time;
  if (r.kind === 'notification') state.apply(r);
  else if (r.kind === 'exit') exit = r;
  else if (r.kind === 'stderr') stderr.push(r.text);
  else if (r.kind === 'prompt') prompts.push(r);
}
const findings = new Findings(path.join(dir, 'findings.jsonl')).readAll();
const lead = state.lastLeadText();
const ageSec = Math.round((Date.now() - Date.parse(last)) / 1000);
console.log(`swarm ${id}  workspace ${spec.workspace}  model ${spec.model}  maxAgents ${spec.maxAgents}`);
console.log(`events ${lines.length}  first ${first}  last ${last} (${ageSec}s ago)  prompts ${prompts.length}  exit ${exit ? JSON.stringify({ code: exit.code, signal: exit.signal }) : 'none (still running)'}`);
console.log(`root status ${state.rootStatus}  last root turn end ${state.lastRootTurnEnd}  tokens ${JSON.stringify(state.tokens())}`);
console.log('\nROSTER');
for (const r of state.roster()) console.log(`  ${r.name.padEnd(16)} ${String(r.status).padEnd(12)} ${r.phase ?? ''} tools=${r.toolCalls ?? state.sessions.get(state.rootSessionId).toolCalls} ${r.error ? 'ERROR ' + r.error : ''}`);
console.log('\nTASKS ' + JSON.stringify(state.taskCounts()));
for (const t of state.taskBoard()) console.log(`  ${t.id.padEnd(8)} ${t.status.padEnd(12)} ${(t.owner ?? '-').padEnd(14)} ${t.subject}${t.blockedBy.length ? '  blockedBy ' + t.blockedBy.join(',') : ''}`);
console.log(`\nMAIL queued ${state.mail.queued} delivered ${state.mail.delivered}`);
for (const m of state.mail.recent.slice(-8)) console.log(`  ${m.from} -> ${m.to}: ${m.preview.replace(/\s+/g, ' ').slice(0, 160)}`);
console.log(`\nFINDINGS ${findings.length}`);
for (const f of findings.slice(-8)) console.log(`  ${f.id} [${f.type}] (${f.scope}) ${f.author}: ${f.message.replace(/\s+/g, ' ').slice(0, 220)}`);
if (state.errors.length) {
  console.log('\nTOOL ERRORS');
  for (const e of state.errors) console.log(`  ${e.session}: ${e.code} ${e.reason ?? ''}`);
}
if (stderr.length) console.log('\nSTDERR TAIL\n' + stderr.join('').slice(-1500));
if (flag('--members')) {
  console.log('\nMEMBER ACTIVITY');
  for (const s of state.sessions.values()) {
    console.log(`  ${(s.name ?? s.id).padEnd(16)} turns=${s.turns} tools=${s.toolCalls} recent=${s.recentTools.join(',')}`);
    const msg = s.messages.at(-1);
    if (msg) console.log(`     last: ${msg.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}
console.log(`\nLEAD LAST MESSAGE${parseReport(lead) ? ' (final report format detected)' : ''}\n${lead.slice(-(tail || 1200))}`);
