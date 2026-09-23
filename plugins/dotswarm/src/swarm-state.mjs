// Fold runtime notifications into a compact model of what the swarm believes and
// has done. Nothing here talks to a process; it is pure state for status and inspect.
import { EventEmitter } from 'node:events';

const KEEP_MESSAGES = 20;
const KEEP_TOOL_NAMES = 12;
const KEEP_ERRORS = 10;
const KEEP_MAIL = 30;
const TEXT_CAP = 4000;

const SIGNIFICANT = new Set([
  'team/member', 'team/task', 'team/message/queued', 'team/message/delivered',
  'assistant/message', 'turn/end',
]);

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

export class SwarmState extends EventEmitter {
  constructor(rootSessionId) {
    super();
    this.rootSessionId = rootSessionId;
    this.rootStatus = 'unknown';
    this.sessions = new Map();
    this.members = new Map(); // name -> member snapshot + sessionId
    this.tasks = new Map(); // task id -> snapshot
    this.mail = { queued: 0, delivered: 0, recent: [] };
    this.receipts = new Set();
    this.userMessageIds = new Set(); // prompts actually claimed by a Lead turn
    this.subagentsFinished = [];
    this.errors = [];
    this.eventCount = 0;
    this.lastEventAt = null;
    this.lastRootTurnEnd = null;
    this.#session(rootSessionId).name = 'lead';
    this.#session(rootSessionId).role = 'lead';
  }

  #session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, name: null, role: 'teammate', status: 'unknown',
        messages: [], toolCalls: 0, recentTools: [], tokens: { input: 0, output: 0, cacheRead: 0 }, turns: 0,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  nameFor(sessionId) {
    return this.sessions.get(sessionId)?.name ?? sessionId;
  }

  /** @param {{method: string, params: any}} notification */
  apply(notification) {
    const { method, params } = notification;
    let significant = false;
    if (method === 'session.status') {
      const s = this.#session(params.sessionId);
      s.status = params.status;
      if (params.sessionId === this.rootSessionId) this.rootStatus = params.status;
      significant = true;
    } else if (method === 'subagent.started') {
      this.#session(params.childSessionId);
    } else if (method === 'subagent.finished') {
      this.subagentsFinished.push({
        session: params.childSessionId,
        name: this.nameFor(params.childSessionId),
        status: params.status,
        stopReason: params.stopReason,
        text: textOf(params.lastAssistantMessage).slice(0, TEXT_CAP),
      });
      significant = true;
    } else if (method === 'session.event') {
      significant = this.#applyEvent(params.sessionId, params.event);
    }
    this.eventCount += 1;
    this.lastEventAt = new Date().toISOString();
    if (significant) this.emit('change');
  }

  #applyEvent(sessionId, event) {
    if (!event || typeof event.type !== 'string') return false;
    const s = this.#session(sessionId);
    const data = event.data ?? {};
    switch (event.type) {
      case 'team/member': {
        const m = data.member;
        if (!m) return false;
        this.members.set(m.name, { ...m, sessionId: m.id });
        const member = this.#session(m.id);
        member.name = m.name;
        member.role = 'teammate';
        return true;
      }
      case 'team/task': {
        if (!data.task) return false;
        this.tasks.set(data.task.id, data.task);
        return true;
      }
      case 'team/message/queued': {
        const m = data.message;
        this.mail.queued += 1;
        this.mail.recent.push({
          id: m?.id, from: m?.senderName ?? this.nameFor(m?.senderId), to: this.nameFor(m?.targetId),
          preview: textOf(m?.content).slice(0, 300),
        });
        if (this.mail.recent.length > KEEP_MAIL) this.mail.recent.shift();
        return true;
      }
      case 'team/message/delivered':
        this.mail.delivered += 1;
        return true;
      case 'agent/inbox/spliced':
        for (const inserted of data.inserted ?? []) if (inserted?.id) this.receipts.add(inserted.id);
        return false;
      case 'user/message':
        if (sessionId === this.rootSessionId && data.id) this.userMessageIds.add(data.id);
        return false;
      case 'assistant/message': {
        const text = textOf(data.message?.content);
        if (text) {
          s.messages.push({ time: event.time ?? null, turn: data.turn, text: text.slice(0, TEXT_CAP) });
          if (s.messages.length > KEEP_MESSAGES) s.messages.shift();
        }
        if (data.usage) {
          s.tokens.input += data.usage.inputTokens ?? 0;
          s.tokens.output += data.usage.outputTokens ?? 0;
          s.tokens.cacheRead += data.usage.cacheReadTokens ?? 0;
        }
        return sessionId === this.rootSessionId && Boolean(text);
      }
      case 'tool/call':
        s.toolCalls += 1;
        s.recentTools.push(data.name);
        if (s.recentTools.length > KEEP_TOOL_NAMES) s.recentTools.shift();
        return false;
      case 'tool/result':
        if (data.error) {
          this.errors.push({ session: s.name ?? sessionId, code: data.error.code, reason: data.error.reason ?? data.error.name });
          if (this.errors.length > KEEP_ERRORS) this.errors.shift();
          return true;
        }
        return false;
      case 'turn/end':
        s.turns += 1;
        if (sessionId === this.rootSessionId) this.lastRootTurnEnd = data.reason?.kind ?? null;
        return true;
      default:
        return SIGNIFICANT.has(event.type);
    }
  }

  lastLeadText() {
    const lead = this.sessions.get(this.rootSessionId);
    return lead?.messages.at(-1)?.text ?? '';
  }

  roster() {
    const rows = [{ name: 'lead', role: 'lead', status: this.rootStatus }];
    for (const [name, m] of this.members) {
      const s = this.sessions.get(m.sessionId);
      rows.push({
        name, role: 'teammate', phase: m.phase, status: s?.status ?? 'unknown',
        description: m.description, toolCalls: s?.toolCalls ?? 0, ...(m.error ? { error: m.error } : {}),
      });
    }
    return rows;
  }

  taskBoard() {
    const rows = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'deleted') continue;
      rows.push({
        id: t.id, subject: t.subject, status: t.status,
        owner: t.ownerId ? this.nameFor(t.ownerId) : null, blockedBy: t.blockedBy ?? [],
      });
    }
    return rows;
  }

  taskCounts() {
    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of this.tasks.values()) if (t.status in counts) counts[t.status] += 1;
    return counts;
  }

  tokens() {
    let input = 0; let output = 0; let cacheRead = 0;
    for (const s of this.sessions.values()) { input += s.tokens.input; output += s.tokens.output; cacheRead += s.tokens.cacheRead; }
    return { input, output, cacheRead };
  }

  tokensByMember() {
    const out = {};
    for (const s of this.sessions.values()) {
      if (s.tokens.input === 0 && s.tokens.output === 0) continue;
      out[s.name ?? s.id] = { ...s.tokens };
    }
    return out;
  }
}
