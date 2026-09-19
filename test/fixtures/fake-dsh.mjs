#!/usr/bin/env node
// A fake dsh SDK runtime speaking the documented protocol over stdio. Modes via
// FAKE_DSH_MODE: normal | exit-early | hang-shutdown | reject-initialize.
import readline from 'node:readline';

const mode = process.env.FAKE_DSH_MODE ?? 'normal';
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
let seq = 0;
const event = (sessionId, type, data) => notify('session.event', { sessionId, event: { type, seq: ++seq, time: Date.now(), data } });

if (mode === 'exit-early') {
  process.stderr.write('fake dsh: boot failure\n');
  process.exit(3);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptCount = 0;

function runTurn(sessionId, messageId, text) {
  event(sessionId, 'agent/inbox/spliced', { inserted: [{ id: messageId }] });
  notify('session.status', { sessionId, status: 'running' });
  const teammate = 'sess-worker-1';
  if (promptCount === 1) {
    event(sessionId, 'team/task', { version: 2, teamId: sessionId, task: { id: 'task-1', revision: 1, subject: 'Explore', description: 'look', status: 'pending', blockedBy: [], writeScopes: [] } });
    event(sessionId, 'team/member', { version: 2, teamId: sessionId, member: { id: teammate, name: 'worker', description: 'does work', provider: 'spawn', context: 'fresh', phase: 'provisioning' } });
    notify('subagent.started', { parentSessionId: sessionId, childSessionId: teammate });
    event(sessionId, 'team/member', { version: 2, teamId: sessionId, member: { id: teammate, name: 'worker', description: 'does work', provider: 'spawn', context: 'fresh', phase: 'active' } });
    event(sessionId, 'team/task', { version: 2, teamId: sessionId, task: { id: 'task-1', revision: 2, subject: 'Explore', description: 'look', status: 'in_progress', ownerId: teammate, blockedBy: [], writeScopes: [] } });
    event(sessionId, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'spawn_teammate', arguments: '{}' });
    event(teammate, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' });
    event(teammate, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', isError: true }] }, error: { name: 'FsError', code: 'ENOENT', reason: 'missing file' } });
    event(teammate, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'worker done' }] }, stream: [], usage: { inputTokens: 100, outputTokens: 20 } });
    event(sessionId, 'team/message/queued', { version: 2, teamId: sessionId, message: { id: 'm1', senderId: teammate, senderName: 'worker', targetId: sessionId, content: [{ type: 'text', text: 'finished task-1' }] } });
    event(sessionId, 'team/message/delivered', { version: 2, teamId: sessionId, messageId: 'm1', targetId: sessionId });
    event(sessionId, 'team/task', { version: 2, teamId: sessionId, task: { id: 'task-1', revision: 3, subject: 'Explore', description: 'look', status: 'completed', ownerId: teammate, blockedBy: [], writeScopes: [] } });
    notify('subagent.finished', { provider: 'spawn', agentId: teammate, parentSessionId: sessionId, childSessionId: teammate, status: 'ok', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'worker done' }] });
  }
  const reply = text.startsWith('[Astra steer]')
    ? 'Steer applied.\n## Summary\nSteered and done.\n## Changes\n- none\n## Verification\n- none\n## Unresolved\nNone\n## Handoff\nReview.'
    : '## Summary\nAll done.\n## Changes\n- hello.txt: created\n## Verification\n- ls: ok\n## Unresolved\nNone\n## Handoff\nNothing.';
  event(sessionId, 'assistant/message', { turn: promptCount, step: 3, message: { content: [{ type: 'text', text: reply }] }, stream: [], usage: { inputTokens: 500, outputTokens: 80 } });
  event(sessionId, 'turn/end', { turn: promptCount, reason: { kind: 'completed' } });
  notify('session.status', { sessionId, status: 'idle' });
}

lines.on('line', (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  const { id, method, params } = frame;
  if (method === 'initialize') {
    if (mode === 'reject-initialize') {
      out({ jsonrpc: '2.0', id, error: { code: -32603, message: `unknown model ${params.model}` } });
      return;
    }
    process.stderr.write(`fake dsh: initialized cwd=${params.cwd} model=${params.model}\n`);
    out({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } });
  } else if (method === 'session/prompt') {
    promptCount += 1;
    const messageId = `msg-${promptCount}`;
    out({ jsonrpc: '2.0', id, result: { messageId } });
    const text = params.contentBlocks.map((b) => b.text ?? '').join('');
    setTimeout(() => runTurn(params.sessionId, messageId, text), 20);
  } else if (method === 'shutdown') {
    if (mode === 'hang-shutdown') return; // never answer, never exit on EOF
    out({ jsonrpc: '2.0', id, result: {} });
    setTimeout(() => process.exit(0), 10);
  } else if (id !== undefined) {
    out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});
lines.on('close', () => {
  if (mode !== 'hang-shutdown') process.exit(0);
});
