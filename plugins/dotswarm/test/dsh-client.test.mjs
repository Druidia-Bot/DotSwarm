import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DshClient, JsonRpcResponseError, TransportClosedError } from '../src/dsh-client.mjs';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.mjs');
const make = (mode = 'normal') => new DshClient({
  command: process.execPath, args: [fake], cwd: process.cwd(),
  env: { ...process.env, FAKE_DSH_MODE: mode }, initializeTimeoutMs: 10_000, requestTimeoutMs: 5000,
});

test('initialize, prompt, receive notifications, shutdown cleanly', async () => {
  const client = make();
  const notifications = [];
  client.on('notification', (n) => notifications.push(n));
  client.start();
  const init = await client.initialize({ cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(init.serverInfo.name, 'deepseek-harness-sdk-runtime');
  const messageId = await client.prompt('s1', 'hello');
  assert.equal(messageId, 'msg-1');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(notifications.some((n) => n.method === 'session.status' && n.params.status === 'idle'));
  assert.ok(notifications.some((n) => n.method === 'session.event' && n.params.event.type === 'agent/inbox/spliced'));
  const exit = await client.close();
  assert.equal(exit.code, 0);
  assert.match(client.stderrTail, /initialized cwd=/);
});

test('a rejected initialize surfaces as JsonRpcResponseError', async () => {
  const client = make('reject-initialize');
  client.start();
  await assert.rejects(
    client.initialize({ cwd: process.cwd(), provider: 'x', model: 'nope' }),
    (e) => e instanceof JsonRpcResponseError && /unknown model nope/.test(e.message),
  );
  await client.close();
});

test('an early runtime exit fails pending requests with the stderr tail', async () => {
  const client = make('exit-early');
  client.start();
  await assert.rejects(
    client.initialize({ cwd: process.cwd(), provider: 'x', model: 'y' }),
    (e) => e instanceof TransportClosedError && e.exitCode === 3 && /boot failure/.test(e.stderrTail),
  );
  await client.close();
});

test('close escalates to kill when shutdown hangs', async () => {
  const client = make('hang-shutdown');
  client.start();
  await client.initialize({ cwd: process.cwd(), provider: 'x', model: 'y' });
  const started = Date.now();
  const exit = await client.close({ shutdownTimeoutMs: 200, graceMs: 200 });
  // The fake never answers shutdown; the ladder must still end at a real exit quickly.
  assert.ok(exit, 'exit recorded');
  assert.ok(Date.now() - started < 5000);
  assert.equal(client.exited, exit);
});
