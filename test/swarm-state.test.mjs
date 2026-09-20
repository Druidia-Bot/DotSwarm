import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SwarmState } from '../src/swarm-state.mjs';

const root = 'swarm-root';
const ev = (sessionId, type, data) => ({ method: 'session.event', params: { sessionId, event: { type, seq: 1, data } } });

test('folds team events into roster, tasks, mail, tokens, and errors', () => {
  const s = new SwarmState(root);
  const changes = [];
  s.on('change', () => changes.push(1));
  s.apply({ method: 'session.status', params: { sessionId: root, status: 'running' } });
  s.apply(ev(root, 'team/member', { member: { id: 'w1', name: 'worker', description: 'd', phase: 'active' } }));
  s.apply(ev(root, 'team/task', { task: { id: 'task-1', revision: 2, subject: 'A', status: 'in_progress', ownerId: 'w1', blockedBy: [] } }));
  s.apply(ev(root, 'team/task', { task: { id: 'task-2', revision: 1, subject: 'B', status: 'deleted', blockedBy: [] } }));
  s.apply(ev('w1', 'tool/call', { name: 'read' }));
  s.apply(ev('w1', 'tool/result', { message: {}, error: { code: 'ENOENT', reason: 'gone' } }));
  s.apply(ev('w1', 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 10, outputTokens: 5 } }));
  s.apply(ev(root, 'team/message/queued', { message: { id: 'm', senderId: 'w1', senderName: 'worker', targetId: root, content: [{ type: 'text', text: 'done' }] } }));
  s.apply(ev(root, 'team/message/delivered', { messageId: 'm', targetId: root }));
  s.apply(ev(root, 'assistant/message', { message: { content: [{ type: 'text', text: 'lead says' }] }, usage: { inputTokens: 100, outputTokens: 50 } }));
  s.apply({ method: 'session.status', params: { sessionId: root, status: 'idle' } });

  assert.equal(s.rootStatus, 'idle');
  assert.deepEqual(s.roster().map((r) => r.name), ['lead', 'worker']);
  assert.deepEqual(s.taskBoard(), [{ id: 'task-1', subject: 'A', status: 'in_progress', owner: 'worker', blockedBy: [] }]);
  assert.deepEqual(s.taskCounts(), { pending: 0, in_progress: 1, completed: 0 });
  assert.equal(s.mail.queued, 1);
  assert.equal(s.mail.delivered, 1);
  assert.equal(s.mail.recent[0].from, 'worker');
  assert.equal(s.mail.recent[0].to, 'lead');
  assert.deepEqual(s.tokens(), { input: 110, output: 55 });
  assert.deepEqual(s.tokensByMember(), { lead: { input: 100, output: 50 }, worker: { input: 10, output: 5 } });
  assert.equal(s.errors[0].code, 'ENOENT');
  assert.equal(s.lastLeadText(), 'lead says');
  assert.equal(s.sessions.get('w1').toolCalls, 1);
  assert.ok(changes.length >= 6);
});

test('worker chatter is not a significant change but lead text is', () => {
  const s = new SwarmState(root);
  let changes = 0;
  s.on('change', () => { changes += 1; });
  s.apply(ev('w1', 'assistant/message', { message: { content: [{ type: 'text', text: 'thinking' }] } }));
  s.apply(ev('w1', 'tool/call', { name: 'bash' }));
  assert.equal(changes, 0);
  s.apply(ev(root, 'assistant/message', { message: { content: [{ type: 'text', text: 'report' }] } }));
  assert.equal(changes, 1);
});
