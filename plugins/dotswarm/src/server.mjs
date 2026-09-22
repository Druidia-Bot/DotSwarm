#!/usr/bin/env node
// The MCP server the coordinator (the model running the Codex session) talks to.
// A small set of tools; everything below them is the DeepSeek Harness Agent Teams runtime.
import { DEFAULTS, VERSION, deepseekKeySource, dshInstalled, keyFile } from './config.mjs';
import { serveStdio } from './mcp.mjs';
import { runDoctor, runSetup } from './setup.mjs';
import { installAgents } from './agents.mjs';
import { SwarmManager } from './swarm.mjs';

const manager = new SwarmManager();

const TOOLS = [
  {
    name: 'swarm_start',
    description: 'Start a DeepSeek Flash agent team. Use mode brief to have the team read for you, build for mundane work a spec fully determines, and verify to check finished work without reading it yourself. Returns a swarm_id immediately; the team runs in the background. Give it your plan as 5 to 15 meaningful work units, not micro-steps: the team decomposes further itself. Provide the absolute workspace path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'workspace'],
      properties: {
        objective: { type: 'string', description: 'What must be true when the swarm is done. One to three paragraphs.' },
        plan: { type: 'string', description: 'Your work breakdown and approach. Numbered work units with dependencies and the files each is expected to touch.' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Concrete, checkable criteria, including the exact test or verification commands.' },
        context: { type: 'string', description: 'Context packet: relevant repo facts, constraints, decisions already made, things not to touch. Not the conversation.' },
        workspace: { type: 'string', description: 'Absolute path of the checkout the team works in.' },
        max_agents: { type: 'integer', minimum: 1, maximum: DEFAULTS.maxAgentsCap, description: `Teammate cap (default ${DEFAULTS.maxAgents}). Small tasks need 1 or 2.` },
        roles: { type: 'array', items: { type: 'string' }, description: 'Optional role hints such as "explorer: ..." or "tester: ...".' },
        isolate: { type: 'boolean', description: 'Run in a fresh git worktree on branch swarm/<id> so the main checkout stays untouched. Default: true whenever the workspace is a git repository. Pass false to work directly in the checkout.' },
        permission_mode: { type: 'string', enum: DEFAULTS.permissionModes, description: `Runtime sandbox for the team (default ${DEFAULTS.permissionMode}). workspace-write confines writes to the workspace but on Windows it also blocks spawning native toolchain binaries such as esbuild and workerd, so npm install, vitest, Astro, and wrangler fail. Use danger-full-access for real build work and rely on the objective's boundaries; use read-only for exploration-only swarms.` },
        design: { type: 'boolean', description: `Set true whenever the work includes anything a person will look at. Switches the team to the image-capable ${DEFAULTS.visionModel} and requires screenshot-driven iteration on every screen (render with Playwright at mobile and desktop sizes, view with read_image, critique, improve, at least two rounds).` },
        mode: { type: 'string', enum: DEFAULTS.modes, description: 'build (default): implement work you specified. brief: read the sources named in objective and context and write one condensed brief (result.brief.path) you read instead of the sources; nothing in the workspace changes. verify: run every acceptance command and standard check, fix mechanical defects in place, and escalate only judgment problems as open questions. refactor: resolve an audit list you supply. Brief and verify work in the checkout; build and refactor use a worktree in a git repo.' },
        brief_words: { type: 'integer', minimum: 1000, maximum: DEFAULTS.briefWordsCap, description: `Word budget for a brief swarm's brief (default ${DEFAULTS.briefWords}).` },
        model: { type: 'string', description: `Model for every team member (default ${DEFAULTS.model}; design swarms default to ${DEFAULTS.visionModel}).` },
        reasoning_effort: { type: 'string', enum: ['off', 'low', 'high', 'max'], description: 'DeepSeek reasoning effort for the team.' },
        max_tokens: { type: 'integer', minimum: 1024, description: 'Per-response output token cap for team members.' },
      },
    },
  },
  {
    name: 'swarm_status',
    description: 'Compact state of a swarm: phase, roster, task counts, open questions for you, new findings since the id you pass, filtered tool errors, cost, last Lead message. Pass wait_ms to block (up to 600000) until the swarm needs you: the Lead posts a plan, a question, a failure, three or more warnings or tool errors, or the run goes idle, stops, or fails. Routine progress is held and summarized in findings.newByType; the result names the reason in wake. Pass since_finding with the latestId from your previous call so you only read new ledger entries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id'],
      properties: {
        swarm_id: { type: 'string' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 600_000, description: 'Block until the swarm needs you or this deadline passes. Use 300000 to 600000 while the team is working.' },
        since_finding: { type: 'string', description: 'The latestId from your previous status call; only newer findings are returned and considered for waking.' },
        wake_on: { type: 'string', enum: ['attention', 'any'], description: 'attention (default) wakes only when you need to act; any wakes on every runtime change.' },
      },
    },
  },
  {
    name: 'swarm_task_add',
    description: 'Hand the Lead a new task for the shared board instead of doing the work yourself. Use this for root configs, docs, fixes you noticed, or anything you would otherwise edit while the swarm runs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id', 'subject', 'description'],
      properties: {
        swarm_id: { type: 'string' },
        subject: { type: 'string', description: 'Concise task title.' },
        description: { type: 'string', description: 'Complete details, acceptance criteria, and the verification command.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths the task may modify.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing board task ids that must complete first.' },
      },
    },
  },
  {
    name: 'swarm_steer',
    description: 'Send an instruction to the Team Lead: redirect, add a constraint, answer a question, or ask for a specific check. Delivered as the Lead\'s next turn and immediately as a findings-ledger entry of type steer that the Lead checks each cycle. swarm_status reports steers sent versus read.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id', 'instruction'],
      properties: { swarm_id: { type: 'string' }, instruction: { type: 'string' } },
    },
  },
  {
    name: 'swarm_inspect',
    description: 'Drill into one part of a swarm when status is not enough. Scopes: tasks, findings, roster, mail, errors, lead, member:<name>, events, prompts. Costs context; prefer swarm_status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id', 'scope'],
      properties: {
        swarm_id: { type: 'string' },
        scope: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'swarm_result',
    description: 'The Lead\'s final report (Summary, Changes, Verification, Unresolved, Handoff), warnings and failures nobody answered (ledger.open), open questions, readFirst (changed files where defects are costly: gates, scripts, build config, schema, forms, auth), task counts, cost, and git diff stat. Also writes handoff.md, a one-page brief the next stage starts from in a fresh session. For a brief swarm, brief.text carries the finished brief inline; for a design or verify swarm, screenshots lists the final screenshots. At an approval gate, ownerQuestions holds every question for the owner, numbered and complete: show them to the user as one numbered list. Pass wait_ms to wait for the Lead to go idle first. Treat the report as claims to verify, not proof.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id'],
      properties: {
        swarm_id: { type: 'string' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 600_000 },
      },
    },
  },
  {
    name: 'swarm_stop',
    description: 'Stop a swarm and shut its runtime down. Work already written to the workspace stays.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id'],
      properties: { swarm_id: { type: 'string' } },
    },
  },
  {
    name: 'swarm_resume',
    description: 'Continue a swarm whose server process is gone (phase detached) or that already finished. Starts a fresh team on the same workspace or worktree, seeded with the previous task board, the complete findings ledger, and the previous Lead\'s last report. The old teammates cannot be reattached. Returns the new swarm_id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id'],
      properties: {
        swarm_id: { type: 'string', description: 'The detached or finished swarm to continue.' },
        instruction: { type: 'string', description: 'What to focus on now: remaining work, what to re-verify, what changed. For mode refactor, the complete numbered audit list.' },
        max_agents: { type: 'integer', minimum: 1, maximum: DEFAULTS.maxAgentsCap },
        mode: { type: 'string', enum: DEFAULTS.modes, description: 'Override the mode for the continuation; use refactor to act on your audit.' },
        design: { type: 'boolean', description: 'Override the design flag for the continuation.' },
      },
    },
  },
  {
    name: 'swarm_list',
    description: 'List swarms known to this server, including detached ones left by earlier server processes (resumable with swarm_resume).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'swarm_doctor',
    description: 'Check that DotSwarm can run: Node, pnpm, the pinned DeepSeek Harness, the swarm profile, and the DeepSeek API key. Returns the data directory and the key file path to tell the user about.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'swarm_setup',
    description: 'One-time setup: installs the pinned DeepSeek Harness and the Agent Teams bundle into the DotSwarm data directory and verifies the profile. Takes a few minutes and needs npm and pnpm on PATH. Safe to rerun. The DeepSeek API key is not handled here; the result names the file the user must put it in.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { reinstall: { type: 'boolean', description: 'Reinstall even when already present.' } },
    },
  },
];

function setupHint(reason) {
  return `${reason} Call swarm_setup to install the runtime, then ask the user to put DEEPSEEK_API_KEY=... in ${keyFile()}. swarm_doctor reports the state.`;
}

async function waitUntilIdle(swarm, waitMs) {
  const deadline = Date.now() + waitMs;
  while (swarm.phase !== 'idle' && swarm.alive && Date.now() < deadline) {
    await swarm.waitForChange(Math.min(15_000, deadline - Date.now()));
  }
}

async function call(name, args) {
  switch (name) {
    case 'swarm_start': {
      if (!dshInstalled()) throw new Error(setupHint('DeepSeek Harness is not installed.'));
      if (!deepseekKeySource()) throw new Error(`No DEEPSEEK_API_KEY found in the environment or in ${keyFile()}. Ask the user to add it, then retry.`);
      const swarm = await manager.start(args);
      return {
        swarmId: swarm.id, phase: swarm.phase, workspace: swarm.workspace, branch: swarm.branch, mode: swarm.spec.mode, design: swarm.spec.design, model: swarm.spec.model,
        ...(swarm.spec.mode === 'brief' ? { brief: swarm.briefPath } : {}),
        hint: swarm.spec.mode === 'brief'
          ? 'Your next call is swarm_result with wait_ms 600000; it returns the finished brief inline. Until then do not read the sources, skill references, or planning files the brief covers, and do not start writing work that depends on them; reading them now pays for the same material twice. If it returns before the brief is done, call it again.'
          : 'Call swarm_status with wait_ms of 300000 to 600000; it returns when the team needs you or finishes. Then swarm_result.',
      };
    }
    case 'swarm_status': {
      const swarm = manager.get(args.swarm_id);
      if (!args.wait_ms) return swarm.status({ sinceFinding: args.since_finding });
      if (args.wake_on === 'any') {
        const changed = await swarm.waitForChange(args.wait_ms);
        return { wake: changed ? 'change' : 'timeout', ...swarm.status({ sinceFinding: args.since_finding }) };
      }
      const wake = await swarm.waitForAttention(args.wait_ms, { sinceFinding: args.since_finding });
      return { wake, ...swarm.status({ sinceFinding: args.since_finding }) };
    }
    case 'swarm_steer':
      return manager.get(args.swarm_id).steer(String(args.instruction ?? ''));
    case 'swarm_task_add':
      return manager.get(args.swarm_id).addTask({
        subject: args.subject, description: args.description, writeScopes: args.write_scopes ?? [], blockedBy: args.blocked_by ?? [],
      });
    case 'swarm_inspect':
      return manager.get(args.swarm_id).inspect(String(args.scope ?? ''), args.limit ?? 10);
    case 'swarm_result': {
      const swarm = manager.get(args.swarm_id);
      if (args.wait_ms) await waitUntilIdle(swarm, args.wait_ms);
      return swarm.result();
    }
    case 'swarm_stop':
      return manager.get(args.swarm_id).stop();
    case 'swarm_resume': {
      if (!dshInstalled()) throw new Error(setupHint('DeepSeek Harness is not installed.'));
      const swarm = await manager.resume(args.swarm_id, { instruction: args.instruction, maxAgents: args.max_agents, mode: args.mode, design: args.design });
      return { swarmId: swarm.id, resumedFrom: args.swarm_id, phase: swarm.phase, workspace: swarm.workspace, branch: swarm.branch };
    }
    case 'swarm_list':
      return manager.list();
    case 'swarm_doctor':
      return runDoctor();
    case 'swarm_setup':
      return runSetup({ reinstall: Boolean(args.reinstall) });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.shutdownAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The subagents are plain Codex agents: no key, no network, no harness. Install them on start so
// every install has them, whether or not the DeepSeek side is ever set up. A file whose managed-by
// marker the user removed is theirs and is left alone.
try {
  installAgents();
} catch { /* a read-only or unusual Codex home must not stop the server */ }

serveStdio({
  name: 'dotswarm',
  version: VERSION,
  tools: TOOLS,
  call,
  onClose: shutdown,
  instructions: 'DotSwarm runs DeepSeek Flash agent teams so your tokens go to judgment, not reading or routine work. Use mode brief to have the team read sources and return one brief, build for work a spec and a command fully determine, and verify to check finished work and fix mechanical defects. Write what users read or see and make the decisions yourself. Do not read what the swarm wrote: read the brief, openQuestions, ownerQuestions, and ledger.open. The team cannot generate raster images: hand the image specification to the dotswarm-imager subagent. Taste work goes to dotswarm-designer, prose that has to persuade to dotswarm-writer; all three are installed for you and need no DeepSeek key. Wait with swarm_status wait_ms 300000 to 600000; never poll. If a tool says setup is needed, call swarm_setup, then swarm_doctor.',
});
