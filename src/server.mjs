#!/usr/bin/env node
// The MCP server Astra (Codex) talks to. Six small tools; everything below them
// is the DeepSeek Harness Agent Teams runtime.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULTS, deepseekKeySource, dshInstalled } from './config.mjs';
import { SwarmManager } from './swarm.mjs';

const manager = new SwarmManager();

const TOOLS = [
  {
    name: 'swarm_start',
    description: 'Start a DeepSeek Flash agent team on a task you have already planned. Returns a swarm_id immediately; the team runs in the background. Give it your plan as 5 to 15 meaningful work units, not micro-steps: the team decomposes further itself. Provide the absolute workspace path.',
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
        isolate: { type: 'boolean', description: 'Run in a fresh git worktree on branch swarm/<id> so the main checkout stays untouched. Requires a git repository.' },
        model: { type: 'string', description: `Model for every team member (default ${DEFAULTS.model}).` },
        reasoning_effort: { type: 'string', enum: ['off', 'low', 'high', 'max'], description: 'DeepSeek reasoning effort for the team.' },
        max_tokens: { type: 'integer', minimum: 1024, description: 'Per-response output token cap for team members.' },
      },
    },
  },
  {
    name: 'swarm_status',
    description: 'Compact state of a swarm: phase, roster, task board counts, latest findings, token use, last Lead message. Pass wait_ms to block until something changes (up to 600000) instead of polling.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['swarm_id'],
      properties: {
        swarm_id: { type: 'string' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 600_000, description: 'Block for a change first. Use 60000 to 300000 while the team is working.' },
      },
    },
  },
  {
    name: 'swarm_steer',
    description: 'Send an instruction to the Team Lead: redirect, add a constraint, answer a question, or ask for a specific check. The Lead applies it and propagates to teammates.',
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
    description: 'The Lead\'s final report (Summary, Changes, Verification, Unresolved, Handoff), open warnings and failures, task counts, and git diff stat. Pass wait_ms to wait for the Lead to go idle first. Treat the report as claims to verify, not proof.',
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
    name: 'swarm_list',
    description: 'List swarms started by this server process.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

async function waitUntilIdle(swarm, waitMs) {
  const deadline = Date.now() + waitMs;
  while (swarm.phase !== 'idle' && swarm.alive && Date.now() < deadline) {
    await swarm.waitForChange(Math.min(15_000, deadline - Date.now()));
  }
}

async function call(name, args) {
  switch (name) {
    case 'swarm_start': {
      if (!dshInstalled()) throw new Error('DeepSeek Harness is not installed. From the DeepAstra directory run: npm run setup');
      if (!deepseekKeySource()) throw new Error('No DEEPSEEK_API_KEY found in the environment or in work/dsh-home/.env. Add it, then retry.');
      const swarm = await manager.start(args);
      return { swarmId: swarm.id, phase: swarm.phase, workspace: swarm.workspace, branch: swarm.branch, hint: 'Call swarm_status with wait_ms while the team works; swarm_result when phase is idle.' };
    }
    case 'swarm_status': {
      const swarm = manager.get(args.swarm_id);
      if (args.wait_ms) await swarm.waitForChange(args.wait_ms);
      return swarm.status();
    }
    case 'swarm_steer':
      return manager.get(args.swarm_id).steer(String(args.instruction ?? ''));
    case 'swarm_inspect':
      return manager.get(args.swarm_id).inspect(String(args.scope ?? ''), args.limit ?? 10);
    case 'swarm_result': {
      const swarm = manager.get(args.swarm_id);
      if (args.wait_ms) await waitUntilIdle(swarm, args.wait_ms);
      return swarm.result();
    }
    case 'swarm_stop':
      return manager.get(args.swarm_id).stop();
    case 'swarm_list':
      return manager.list();
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const server = new Server({ name: 'deepastra-swarm', version: '2.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await call(name, args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.shutdownAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
