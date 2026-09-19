// Swarm lifecycle: one dsh runtime per swarm, driven over the SDK protocol.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULTS, PROFILE_NAME, dshBin, dshEnv, findingsServerPath, swarmsDir, toPosix, workDir } from './config.mjs';
import { DshClient } from './dsh-client.mjs';
import { Findings } from './findings.mjs';
import { buildLeadPrompt, buildSteerPrompt, parseReport } from './prompt.mjs';
import { SwarmState } from './swarm-state.mjs';

const execFileAsync = promisify(execFile);

function newId() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(2);
  return `sw-${stamp}-${randomBytes(2).toString('hex')}`;
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/** Per-swarm patch layered over the profile: the findings ledger MCP server with literal paths. */
function swarmPatch({ findingsFile, swarmId }) {
  const q = (s) => JSON.stringify(s);
  return [
    '# Generated per swarm. Findings ledger MCP server for every team member.',
    '- insert:',
    '    - id: mcp-findings',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: findings',
    '        transport: stdio',
    `        command: ${q(toPosix(process.execPath))}`,
    `        args: [${q(toPosix(findingsServerPath()))}]`,
    '        env:',
    `          SWARM_FINDINGS_FILE: ${q(toPosix(findingsFile))}`,
    `          SWARM_ID: ${q(swarmId)}`,
    '        failOnStartupError: true',
    '',
  ].join('\n');
}

export class Swarm {
  constructor(spec, { launch } = {}) {
    this.id = spec.swarmId;
    this.spec = spec;
    this.dir = path.join(swarmsDir(), this.id);
    this.rootSessionId = `swarm-${this.id}`;
    this.state = new SwarmState(this.rootSessionId);
    this.findings = new Findings(path.join(this.dir, 'findings.jsonl'));
    this.phase = 'created';
    this.error = null;
    this.startedAt = null;
    this.endedAt = null;
    this.prompts = [];
    this.client = null;
    this.workspace = spec.workspace;
    this.branch = null;
    this.launch = launch ?? defaultLaunch;
    this.#log = null;
  }

  #log;

  #write(record) {
    this.#log?.write(JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.#log = fs.createWriteStream(path.join(this.dir, 'events.jsonl'), { flags: 'a' });
    this.startedAt = new Date().toISOString();
    this.phase = 'starting';
    try {
      if (this.spec.isolate) await this.#createWorktree();
      const patchFile = path.join(this.dir, 'swarm.patch.yml');
      fs.writeFileSync(patchFile, swarmPatch({ findingsFile: this.findings.file, swarmId: this.id }));
      fs.writeFileSync(path.join(this.dir, 'spec.json'), JSON.stringify({ ...this.spec, workspace: this.workspace, branch: this.branch }, null, 2));

      this.client = this.launch({ swarm: this, patchFile });
      this.client.on('notification', (n) => {
        this.#write({ kind: 'notification', ...n });
        this.state.apply(n);
      });
      this.client.on('stderr', (chunk) => this.#write({ kind: 'stderr', text: chunk }));
      this.client.on('exit', (exit) => {
        this.#write({ kind: 'exit', ...exit });
        if (this.phase !== 'stopped') {
          this.phase = this.phase === 'idle' ? 'stopped' : 'failed';
          this.error ??= `runtime exited (code ${exit.code}) ${this.client.stderrTail.slice(-1500)}`;
        }
        this.endedAt = new Date().toISOString();
        this.state.emit('change');
      });
      this.client.start();
      await this.client.initialize({
        cwd: this.workspace,
        provider: this.spec.provider,
        model: this.spec.model,
        reasoningEffort: this.spec.reasoningEffort,
        maxTokens: this.spec.maxTokens,
      });
      const prompt = buildLeadPrompt({ ...this.spec, workspace: this.workspace, isolated: Boolean(this.branch) });
      fs.writeFileSync(path.join(this.dir, 'lead-prompt.md'), prompt);
      await this.#prompt(prompt, 'objective');
      this.phase = 'running';
      this.state.on('change', () => this.#refreshPhase());
      return this;
    } catch (error) {
      this.phase = 'failed';
      this.error = `${error.message}${this.client?.stderrTail ? `\n--- dsh stderr ---\n${this.client.stderrTail.slice(-2000)}` : ''}`;
      this.endedAt = new Date().toISOString();
      await this.client?.close().catch(() => {});
      throw new Error(this.error);
    }
  }

  #refreshPhase() {
    if (this.phase === 'stopped' || this.phase === 'failed') return;
    if (this.state.rootStatus === 'idle') this.phase = 'idle';
    else if (this.state.rootStatus === 'running') this.phase = 'running';
  }

  async #prompt(text, kind) {
    const messageId = await this.client.prompt(this.rootSessionId, text);
    this.prompts.push({ kind, messageId, time: new Date().toISOString(), text: text.slice(0, 500) });
    this.#write({ kind: 'prompt', promptKind: kind, messageId });
    return messageId;
  }

  async #createWorktree() {
    if (!(await isGitRepo(this.spec.workspace))) throw new Error('isolate requires the workspace to be a git repository');
    const worktree = path.join(workDir(), 'worktrees', this.id);
    this.branch = `swarm/${this.id}`;
    await git(this.spec.workspace, ['worktree', 'add', '-b', this.branch, worktree, 'HEAD']);
    this.workspace = worktree;
  }

  get alive() {
    return this.client !== null && !this.client.exited && (this.phase === 'running' || this.phase === 'idle' || this.phase === 'starting');
  }

  async steer(instruction) {
    if (!this.alive) throw new Error(`swarm ${this.id} is ${this.phase}; it cannot be steered`);
    const messageId = await this.#prompt(buildSteerPrompt(instruction), 'steer');
    this.phase = 'running';
    return { messageId };
  }

  /** Resolve on the next significant change, or after timeoutMs. Returns whether a change happened. */
  waitForChange(timeoutMs) {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (changed) => { clearTimeout(timer); this.state.off('change', onChange); resolve(changed); };
      const onChange = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.state.once('change', onChange);
    });
  }

  async stop() {
    if (this.phase === 'stopped' || this.phase === 'failed') return { phase: this.phase };
    this.phase = 'stopped';
    this.endedAt = new Date().toISOString();
    const exit = await this.client?.close();
    this.#log?.end();
    return { phase: this.phase, exit };
  }

  elapsedSeconds() {
    const end = this.endedAt ? Date.parse(this.endedAt) : Date.now();
    return Math.round((end - Date.parse(this.startedAt ?? new Date().toISOString())) / 1000);
  }

  status() {
    const s = this.state;
    const findings = this.findings.readAll();
    const lead = s.lastLeadText();
    return {
      swarmId: this.id,
      phase: this.phase,
      ...(this.error ? { error: this.error.slice(0, 1500) } : {}),
      elapsedSeconds: this.elapsedSeconds(),
      workspace: this.workspace,
      ...(this.branch ? { branch: this.branch } : {}),
      roster: s.roster(),
      tasks: { counts: s.taskCounts(), board: s.taskBoard() },
      mail: { queued: s.mail.queued, delivered: s.mail.delivered },
      findings: { count: findings.length, latest: findings.slice(-5).map((f) => `${f.id} [${f.type}] ${f.scope}: ${f.message.slice(0, 200)}`) },
      toolErrors: s.errors.slice(-3),
      tokens: s.tokens(),
      lastLeadMessage: lead.slice(-800),
      lastEventAt: s.lastEventAt,
      reportReady: this.phase === 'idle' && parseReport(lead) !== null,
    };
  }

  inspect(scope, limit = 10) {
    const s = this.state;
    const cap = Math.max(1, Math.min(limit, 50));
    if (scope === 'tasks') {
      return [...s.tasks.values()].filter((t) => t.status !== 'deleted').map((t) => ({
        ...t, owner: t.ownerId ? s.nameFor(t.ownerId) : null,
      }));
    }
    if (scope === 'findings') return this.findings.list({ limit: cap });
    if (scope === 'roster') return s.roster();
    if (scope === 'mail') return s.mail.recent.slice(-cap);
    if (scope === 'errors') return s.errors.slice(-cap);
    if (scope === 'lead') return this.#sessionView(this.rootSessionId, cap);
    if (scope.startsWith('member:')) {
      const name = scope.slice('member:'.length);
      const member = s.members.get(name);
      if (!member) throw new Error(`unknown member ${name}; known: ${[...s.members.keys()].join(', ') || 'none'}`);
      return this.#sessionView(member.sessionId, cap);
    }
    if (scope === 'events') return this.#tailEvents(cap);
    if (scope === 'prompts') return this.prompts.slice(-cap);
    throw new Error('scope must be tasks, findings, roster, mail, errors, lead, member:<name>, events, or prompts');
  }

  #sessionView(sessionId, limit) {
    const s = this.state.sessions.get(sessionId);
    if (!s) return null;
    return {
      name: s.name, status: s.status, turns: s.turns, toolCalls: s.toolCalls, recentTools: s.recentTools,
      tokens: s.tokens, messages: s.messages.slice(-limit),
    };
  }

  #tailEvents(limit) {
    try {
      const lines = fs.readFileSync(path.join(this.dir, 'events.jsonl'), 'utf8').trim().split('\n');
      return lines.slice(-limit).map((line) => {
        try {
          const r = JSON.parse(line);
          if (r.kind === 'notification' && r.method === 'session.event') {
            return { time: r.time, session: this.state.nameFor(r.params.sessionId), type: r.params.event?.type };
          }
          return { time: r.time, kind: r.kind, method: r.method, text: r.text?.slice(0, 200) };
        } catch {
          return { raw: line.slice(0, 200) };
        }
      });
    } catch {
      return [];
    }
  }

  async result() {
    const lead = this.state.lastLeadText();
    const report = parseReport(lead);
    const out = {
      swarmId: this.id,
      phase: this.phase,
      ...(this.error ? { error: this.error.slice(0, 1500) } : {}),
      complete: this.phase === 'idle' && report !== null,
      workspace: this.workspace,
      ...(this.branch ? { branch: this.branch } : {}),
      report: report ?? { raw: lead.slice(-6000) },
      findings: this.findings.readAll().filter((f) => f.type === 'warning' || f.type === 'failure' || f.type === 'question'),
      tasks: this.state.taskCounts(),
      tokens: this.state.tokens(),
      elapsedSeconds: this.elapsedSeconds(),
    };
    if (await isGitRepo(this.workspace)) {
      try {
        out.git = {
          changedFiles: (await git(this.workspace, ['status', '--porcelain'])).split('\n').filter(Boolean).length,
          diffStat: (await git(this.workspace, ['diff', '--stat'])).slice(-3000),
        };
      } catch (error) {
        out.git = { error: error.message };
      }
    }
    return out;
  }
}

/** Spawn a real dsh runtime for a swarm. */
export function defaultLaunch({ swarm, patchFile }) {
  const bin = dshBin();
  if (!fs.existsSync(bin)) throw new Error(`dsh is not installed at ${bin}; run: npm run setup`);
  return new DshClient({
    command: process.execPath,
    args: [bin, '--profile', PROFILE_NAME, '--patch', patchFile],
    cwd: swarm.workspace,
    env: dshEnv({ SWARM_ID: swarm.id }),
    initializeTimeoutMs: DEFAULTS.initializeTimeoutMs,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
  });
}

export class SwarmManager {
  constructor({ launch } = {}) {
    this.swarms = new Map();
    this.launch = launch;
  }

  normalizeSpec(input) {
    const objective = String(input.objective ?? '').trim();
    if (!objective) throw new Error('objective is required');
    const workspace = path.resolve(input.workspace || process.env.DEEPASTRA_WORKSPACE || process.cwd());
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`workspace does not exist: ${workspace}`);
    const maxAgents = Math.max(1, Math.min(Number(input.max_agents ?? DEFAULTS.maxAgents) || DEFAULTS.maxAgents, DEFAULTS.maxAgentsCap));
    return {
      swarmId: newId(),
      objective,
      plan: input.plan ? String(input.plan) : undefined,
      acceptanceCriteria: Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria.map(String) : undefined,
      context: input.context ? String(input.context) : undefined,
      roles: Array.isArray(input.roles) ? input.roles.map(String) : undefined,
      maxAgents,
      workspace,
      isolate: Boolean(input.isolate),
      provider: input.provider ? String(input.provider) : DEFAULTS.provider,
      model: input.model ? String(input.model) : DEFAULTS.model,
      reasoningEffort: input.reasoning_effort ? String(input.reasoning_effort) : undefined,
      maxTokens: input.max_tokens ? Number(input.max_tokens) : undefined,
    };
  }

  async start(input) {
    const spec = this.normalizeSpec(input);
    const swarm = new Swarm(spec, { launch: this.launch });
    this.swarms.set(swarm.id, swarm);
    await swarm.start();
    return swarm;
  }

  get(id) {
    const swarm = this.swarms.get(id);
    if (!swarm) throw new Error(`unknown swarm ${id}; known: ${[...this.swarms.keys()].join(', ') || 'none'}`);
    return swarm;
  }

  list() {
    return [...this.swarms.values()].map((s) => ({
      swarmId: s.id, phase: s.phase, workspace: s.workspace, elapsedSeconds: s.elapsedSeconds(),
      objective: s.spec.objective.slice(0, 120),
    }));
  }

  async shutdownAll() {
    await Promise.all([...this.swarms.values()].map((s) => s.stop().catch(() => {})));
  }
}
