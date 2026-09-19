// Minimal newline-delimited JSON-RPC client for a dsh SDK-profile runtime.
// Speaks exactly the documented SDK protocol: initialize, session/prompt, shutdown,
// plus the session.event / session.status / subagent.started / subagent.finished
// notifications. Written here because the published SDK client pins a different
// dsh version than the one we install.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class TransportClosedError extends Error {
  constructor(message, { exitCode = null, stderrTail = '' } = {}) {
    super(message);
    this.name = 'TransportClosedError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}
export class RequestTimeoutError extends Error {
  constructor(method, ms) {
    super(`${method} timed out after ${ms}ms`);
    this.name = 'RequestTimeoutError';
  }
}
export class JsonRpcResponseError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)}`);
    this.name = 'JsonRpcResponseError';
    this.code = error?.code;
    this.data = error?.data;
  }
}

const STDERR_TAIL_BYTES = 8192;

export class DshClient extends EventEmitter {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #exit = null;
  #stderrTail = '';
  #options;

  /**
   * @param {object} options
   * @param {string} options.command executable, normally process.execPath
   * @param {string[]} options.args argv: dsh bin, --profile, --patch ...
   * @param {string} options.cwd child working directory (the workspace)
   * @param {NodeJS.ProcessEnv} options.env
   * @param {number} [options.initializeTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   */
  constructor(options) {
    super();
    this.#options = { initializeTimeoutMs: 120_000, requestTimeoutMs: 30_000, ...options };
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  get stderrTail() {
    return this.#stderrTail;
  }

  get exited() {
    return this.#exit;
  }

  start() {
    if (this.#child) return;
    const { command, args, cwd, env } = this.#options;
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    child.on('error', (error) => {
      this.#exit ??= { code: null, signal: null };
      this.#failAll(new TransportClosedError(`dsh runtime failed to start: ${error.message}`));
      this.emit('exit', { code: null, signal: null, error });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      this.emit('stderr', chunk);
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#onLine(line));
    child.on('exit', (code, signal) => {
      this.#exit = { code, signal };
      this.#failAll(new TransportClosedError(`dsh runtime exited (code ${code}, signal ${signal})`, {
        exitCode: code,
        stderrTail: this.#stderrTail,
      }));
      this.emit('exit', { code, signal });
    });
  }

  #onLine(line) {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.emit('garbage', line);
      return;
    }
    if (frame === null || typeof frame !== 'object') return;
    if (frame.id !== undefined && frame.method === undefined) {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new JsonRpcResponseError(pending.method, frame.error));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method !== undefined && frame.id === undefined) {
      this.emit('notification', { method: frame.method, params: frame.params ?? {} });
      return;
    }
    if (frame.method !== undefined && frame.id !== undefined) {
      // Server-to-client requests are a dead capability upstream; answer method-not-found.
      this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unsupported' } });
    }
  }

  #write(frame) {
    if (!this.#child || this.#closed || this.#exit) {
      throw new TransportClosedError('dsh runtime is not running', {
        exitCode: this.#exit?.code ?? null,
        stderrTail: this.#stderrTail,
      });
    }
    this.#child.stdin.write(JSON.stringify(frame) + '\n');
  }

  request(method, params, timeoutMs = this.#options.requestTimeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #failAll(error) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  /** Process-wide handshake; the server validates the provider/model route here. */
  initialize({ cwd, provider, model, reasoningEffort, maxTokens }) {
    const params = { cwd, provider, model };
    if (reasoningEffort) params.reasoningEffort = reasoningEffort;
    if (maxTokens) params.maxTokens = maxTokens;
    return this.request('initialize', params, this.#options.initializeTimeoutMs);
  }

  /** Queue one user message; resolves with the durable messageId, never waits for the agent. */
  async prompt(sessionId, text) {
    const contentBlocks = typeof text === 'string' ? [{ type: 'text', text }] : text;
    const result = await this.request('session/prompt', { sessionId, contentBlocks });
    return result.messageId;
  }

  /** shutdown, then stdin EOF, SIGTERM, SIGKILL, ending only at actual exit. Idempotent. */
  async close({ shutdownTimeoutMs = 3000, graceMs = 3000 } = {}) {
    if (this.#closing) return this.#closing;
    this.#closing = this.#closeLadder({ shutdownTimeoutMs, graceMs });
    return this.#closing;
  }

  #closing = null;

  async #closeLadder({ shutdownTimeoutMs, graceMs }) {
    const child = this.#child;
    if (!child || this.#exit) {
      this.#closed = true;
      return this.#exit;
    }
    const exited = new Promise((resolve) => {
      if (this.#exit) resolve(this.#exit);
      else child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const wait = (ms) => Promise.race([exited, new Promise((r) => setTimeout(() => r(null), ms))]);
    // Send the protocol shutdown before refusing further writes.
    const shutdown = this.request('shutdown', undefined, shutdownTimeoutMs).catch(() => null);
    this.#closed = true;
    await Promise.race([shutdown, new Promise((r) => setTimeout(r, shutdownTimeoutMs))]);
    if (await wait(graceMs)) return this.#exit;
    try { child.stdin.end(); } catch { /* ignore */ }
    if (await wait(graceMs)) return this.#exit;
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    if (await wait(graceMs)) return this.#exit;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await exited;
    return this.#exit;
  }
}
