// Swarm lifecycle: one dsh runtime per swarm, driven over the SDK protocol.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { BENIGN_TOOL_ERRORS, DEFAULTS, PROFILE_NAME, dshBin, dshEnv, findingsServerPath, swarmsDir, toPosix, tokenPrices, workDir } from './config.mjs';
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

function isGitRepoSync(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Replay a swarm's events.jsonl into a SwarmState, for detached swarms and resume packets. */
function foldEventLog(dir, rootSessionId) {
  const state = new SwarmState(rootSessionId);
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch { return state; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === 'notification') state.apply(r);
    } catch { /* torn line */ }
  }
  return state;
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

  /** Durable summary so a later server process can list, inspect, and resume this swarm. */
  persist() {
    if (this.detached) return;
    const state = {
      id: this.id, phase: this.phase, workspace: this.workspace, branch: this.branch, rootSessionId: this.rootSessionId,
      startedAt: this.startedAt, endedAt: this.endedAt, prompts: this.prompts, resumedFrom: this.spec.resume?.fromSwarmId ?? null,
      error: this.error, savedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(state, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * Rebuild a swarm from disk after the server process that owned it is gone.
   * It is read-only: status, inspect, and result work from the event log; steer and stop do not.
   */
  static fromDisk(id) {
    const dir = path.join(swarmsDir(), id);
    const spec = readJson(path.join(dir, 'spec.json'));
    if (!spec) throw new Error(`no spec.json for swarm ${id}`);
    const saved = readJson(path.join(dir, 'state.json'), {});
    const swarm = new Swarm({ ...spec, swarmId: id });
    swarm.detached = true;
    swarm.workspace = saved.workspace ?? spec.workspace;
    swarm.branch = saved.branch ?? spec.branch ?? null;
    swarm.startedAt = saved.startedAt ?? null;
    swarm.endedAt = saved.endedAt ?? saved.savedAt ?? null;
    swarm.prompts = saved.prompts ?? [];
    swarm.error = saved.error ?? null;
    swarm.state = foldEventLog(dir, swarm.rootSessionId);
    // A swarm whose owner died mid-run is detached; a clean end keeps its final phase.
    swarm.phase = saved.phase === 'stopped' || saved.phase === 'failed' ? saved.phase : 'detached';
    return swarm;
  }

  /** What a successor Lead needs to know from this swarm. */
  resumePacket(instruction) {
    const lead = this.state.lastLeadText();
    return {
      fromSwarmId: this.id,
      tasks: this.state.taskBoard(),
      lastLeadMessage: lead.slice(-3000),
      findingsCount: this.findings.readAll().length,
      ...(instruction ? { instruction } : {}),
    };
  }

  async start() {
    if (this.detached) throw new Error(`swarm ${this.id} is detached; use swarm_resume`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.#log = fs.createWriteStream(path.join(this.dir, 'events.jsonl'), { flags: 'a' });
    this.startedAt = new Date().toISOString();
    this.phase = 'starting';
    try {
      if (this.spec.resume?.findingsFile && fs.existsSync(this.spec.resume.findingsFile)) {
        // Continue the previous ledger; ids keep counting up.
        fs.copyFileSync(this.spec.resume.findingsFile, this.findings.file);
      }
      if (this.spec.isolate) await this.#createWorktree();
      this.persist();
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
        this.persist();
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
      const screensDir = path.join(this.dir, 'screens');
      if (this.spec.design) fs.mkdirSync(screensDir, { recursive: true });
      const prompt = buildLeadPrompt({ ...this.spec, workspace: this.workspace, isolated: Boolean(this.branch), screensDir: toPosix(screensDir) });
      fs.writeFileSync(path.join(this.dir, 'lead-prompt.md'), prompt);
      await this.#prompt(prompt, 'objective');
      this.phase = 'running';
      this.persist();
      this.state.on('change', () => this.#refreshPhase());
      return this;
    } catch (error) {
      this.phase = 'failed';
      this.error = `${error.message}${this.client?.stderrTail ? `\n--- dsh stderr ---\n${this.client.stderrTail.slice(-2000)}` : ''}`;
      this.endedAt = new Date().toISOString();
      this.persist();
      await this.client?.close().catch(() => {});
      throw new Error(this.error);
    }
  }

  #refreshPhase() {
    if (this.phase === 'stopped' || this.phase === 'failed') return;
    const before = this.phase;
    if (this.state.rootStatus === 'idle') this.phase = 'idle';
    else if (this.state.rootStatus === 'running') this.phase = 'running';
    if (this.phase !== before) this.persist();
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
    return !this.detached && this.client !== null && !this.client.exited && (this.phase === 'running' || this.phase === 'idle' || this.phase === 'starting');
  }

  async steer(instruction) {
    if (this.detached) throw new Error(`swarm ${this.id} is detached (its server process is gone); use swarm_resume to continue it`);
    if (!this.alive) throw new Error(`swarm ${this.id} is ${this.phase}; it cannot be steered`);
    const text = String(instruction ?? '').trim();
    if (!text) throw new Error('instruction is required');
    // The SDK protocol has no mid-turn steer: a prompt is claimed at the next turn. The
    // ledger entry reaches a Lead that is still mid-turn, because it reads findings each cycle.
    const finding = this.findings.append({ author: 'coordinator', type: 'steer', scope: 'coordinator', message: text });
    const messageId = await this.#prompt(buildSteerPrompt(text, finding.id), 'steer');
    this.phase = 'running';
    return { messageId, findingId: finding.id, note: 'Queued as the next Lead turn and recorded in the findings ledger as type steer, which the Lead checks each cycle.' };
  }

  /** Hand the Lead a new board task instead of the coordinator doing the work itself. */
  async addTask({ subject, description, writeScopes = [], blockedBy = [] }) {
    const title = String(subject ?? '').trim();
    const body = String(description ?? '').trim();
    if (!title || !body) throw new Error('subject and description are required');
    const lines = [
      'TASK REQUEST from the coordinator. Create this task on the shared board with team_task_create, assign or announce an owner, and complete it under the usual verification rules.',
      `Subject: ${title}`,
      `Description: ${body}`,
      ...(writeScopes.length ? [`Write scopes: ${writeScopes.join(', ')}`] : []),
      ...(blockedBy.length ? [`Blocked by: ${blockedBy.join(', ')}`] : []),
    ];
    const result = await this.steer(lines.join('\n'));
    return { ...result, note: 'Task request queued as a steer and recorded in the ledger; the Lead creates the board task.' };
  }

  /** Open items the Lead raised for the coordinator: questions, and anything scoped to coordinator. */
  openQuestions(limit = 10) {
    return this.findings.readAll()
      .filter((f) => f.type === 'question' || (f.scope === 'coordinator' && f.type !== 'steer'))
      .slice(-limit)
      .map((f) => ({ id: f.id, author: f.author, message: f.message.slice(0, 500) }));
  }

  cost() {
    const tokens = this.state.tokens();
    const prices = tokenPrices();
    return {
      swarmTokens: tokens,
      byMember: this.state.tokensByMember(),
      ...(prices ? { estimatedUsd: Number(((tokens.input * prices.input + tokens.output * prices.output) / 1_000_000).toFixed(4)) } : {}),
      note: 'DeepSeek tokens only. The coordinator spends separately; keep the coordinator to planning, steering, and review.',
    };
  }

  steerDelivery() {
    const steers = this.prompts.filter((p) => p.kind === 'steer');
    return { sent: steers.length, read: steers.filter((p) => this.state.userMessageIds.has(p.messageId)).length };
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
    if (this.detached) {
      this.phase = 'stopped';
      return { phase: this.phase, note: 'detached swarm marked stopped; its runtime was already gone' };
    }
    if (this.phase === 'stopped' || this.phase === 'failed') return { phase: this.phase };
    this.phase = 'stopped';
    this.endedAt = new Date().toISOString();
    this.persist();
    const exit = await this.client?.close();
    this.#log?.end();
    return { phase: this.phase, exit };
  }

  elapsedSeconds() {
    const end = this.endedAt ? Date.parse(this.endedAt) : Date.now();
    return Math.round((end - Date.parse(this.startedAt ?? new Date().toISOString())) / 1000);
  }

  status({ sinceFinding } = {}) {
    const s = this.state;
    const findings = this.findings.readAll();
    const lead = s.lastLeadText();
    const newFindings = sinceFinding
      ? this.findings.list({ since: sinceFinding, limit: 20 }).filter((f) => f.type !== 'steer')
      : findings.slice(-5);
    return {
      swarmId: this.id,
      phase: this.phase,
      ...(this.detached ? { detached: 'The server that ran this swarm is gone. Status is replayed from its log; use swarm_resume to continue the work.' } : {}),
      ...(this.spec.resume ? { resumedFrom: this.spec.resume.fromSwarmId } : {}),
      mode: this.spec.mode ?? 'build',
      ...(this.spec.design ? { design: true, model: this.spec.model, screens: toPosix(path.join(this.dir, 'screens')) } : {}),
      ...(this.error ? { error: this.error.slice(0, 1500) } : {}),
      elapsedSeconds: this.elapsedSeconds(),
      workspace: this.workspace,
      ...(this.branch ? { branch: this.branch } : {}),
      roster: s.roster(),
      tasks: { counts: s.taskCounts(), board: s.taskBoard() },
      mail: { queued: s.mail.queued, delivered: s.mail.delivered },
      steers: this.steerDelivery(),
      permissionMode: this.spec.permissionMode,
      findings: {
        count: findings.length,
        latestId: findings.at(-1)?.id ?? null,
        [sinceFinding ? 'new' : 'latest']: newFindings.map((f) => `${f.id} [${f.type}] ${f.scope}: ${f.message.slice(0, 200)}`),
      },
      openQuestions: this.openQuestions(),
      toolErrors: s.errors.filter((e) => !BENIGN_TOOL_ERRORS.has(e.code)).slice(-3),
      cost: this.cost(),
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
      openQuestions: this.openQuestions(),
      tasks: this.state.taskCounts(),
      cost: this.cost(),
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
    env: dshEnv({ SWARM_ID: swarm.id, DSH_PERMISSION_MODE: swarm.spec.permissionMode }),
    initializeTimeoutMs: DEFAULTS.initializeTimeoutMs,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
  });
}

export class SwarmManager {
  constructor({ launch } = {}) {
    this.swarms = new Map();
    this.launch = launch;
    this.loadDetached();
  }

  /** Register swarms left on disk by earlier server processes. */
  loadDetached() {
    let ids = [];
    try { ids = fs.readdirSync(swarmsDir()).filter((d) => d.startsWith('sw-')); } catch { return; }
    for (const id of ids) {
      if (this.swarms.has(id)) continue;
      try {
        this.swarms.set(id, Swarm.fromDisk(id));
      } catch { /* incomplete directory */ }
    }
  }

  normalizeSpec(input) {
    const objective = String(input.objective ?? '').trim();
    if (!objective) throw new Error('objective is required');
    const workspace = path.resolve(input.workspace || process.env.DEEPASTRA_WORKSPACE || process.cwd());
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`workspace does not exist: ${workspace}`);
    const maxAgents = Math.max(1, Math.min(Number(input.max_agents ?? DEFAULTS.maxAgents) || DEFAULTS.maxAgents, DEFAULTS.maxAgentsCap));
    // Isolation is the default wherever it is possible: a git repo gets its own worktree.
    const isolate = input.isolate === undefined ? isGitRepoSync(workspace) : Boolean(input.isolate);
    const design = Boolean(input.design);
    const mode = DEFAULTS.modes.includes(input.mode) ? input.mode : 'build';
    // A design swarm must see its screenshots; the default model is text-only.
    const model = input.model ? String(input.model) : (design ? DEFAULTS.visionModel : DEFAULTS.model);
    return {
      swarmId: newId(),
      design,
      mode,
      objective,
      plan: input.plan ? String(input.plan) : undefined,
      acceptanceCriteria: Array.isArray(input.acceptance_criteria) ? input.acceptance_criteria.map(String) : undefined,
      context: input.context ? String(input.context) : undefined,
      roles: Array.isArray(input.roles) ? input.roles.map(String) : undefined,
      maxAgents,
      workspace,
      isolate,
      permissionMode: DEFAULTS.permissionModes.includes(input.permission_mode) ? input.permission_mode : DEFAULTS.permissionMode,
      provider: input.provider ? String(input.provider) : DEFAULTS.provider,
      model,
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

  /**
   * Continue an interrupted or finished swarm in a fresh runtime. The old team and
   * board cannot be reattached (the SDK server only creates sessions), so the new
   * Lead starts from the old board, the full ledger, and the old Lead's last message,
   * on the same workspace or worktree.
   */
  async resume(id, { instruction, maxAgents, mode, design } = {}) {
    const previous = this.get(id);
    if (previous.alive) throw new Error(`swarm ${id} is still running; steer it instead of resuming`);
    const nextDesign = design === undefined ? Boolean(previous.spec.design) : Boolean(design);
    const spec = {
      ...previous.spec,
      swarmId: newId(),
      // The previous worktree (or plain workspace) already holds the work; never create another.
      workspace: previous.workspace,
      isolate: false,
      maxAgents: maxAgents ? Math.max(1, Math.min(Number(maxAgents), DEFAULTS.maxAgentsCap)) : previous.spec.maxAgents,
      mode: DEFAULTS.modes.includes(mode) ? mode : (previous.spec.mode ?? 'build'),
      design: nextDesign,
      model: nextDesign && previous.spec.model === DEFAULTS.model ? DEFAULTS.visionModel : previous.spec.model,
      resume: { ...previous.resumePacket(instruction), findingsFile: previous.findings.file },
    };
    const swarm = new Swarm(spec, { launch: this.launch });
    swarm.branch = previous.branch;
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
    return [...this.swarms.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({
        swarmId: s.id, phase: s.phase, workspace: s.workspace, ...(s.branch ? { branch: s.branch } : {}),
        elapsedSeconds: s.elapsedSeconds(), objective: s.spec.objective.slice(0, 120),
        ...(s.spec.resume ? { resumedFrom: s.spec.resume.fromSwarmId } : {}),
      }));
  }

  async shutdownAll() {
    await Promise.all([...this.swarms.values()].map((s) => s.stop().catch(() => {})));
  }
}
