import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDropAckProxy } from '../diagnostics/drop-ack-proxy.mjs';
import { observeSession } from '../diagnostics/observe-session.mjs';
import { FrameDecoder, encodeFrame } from '../src/framing.mjs';
import { TEST_CHAT_TEXT } from '../src/ipc.mjs';

async function mockHost(t) {
  const connections = new Set();
  let number = 0, revision = 5, writeCount = 0;
  const state = { id: 'thread', sessionId: 'thread', threadRuntimeStatus: { type: 'idle' },
    turns: [{ turnId: 'old', status: 'completed', params: { input: [{ type: 'text', text: TEST_CHAT_TEXT }] } }] };
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cb-mock-${randomUUID()}` : join(tmpdir(), `cb-mock-${randomUUID()}.sock`);
  const sendSnapshot = connection => connection.socket.writable && connection.socket.write(encodeFrame({
    type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
    targetClientIds: [connection.id], params: { conversationId: 'thread', hostId: 'local',
      change: { type: 'snapshot', revision, conversationState: state } },
  }));
  const server = net.createServer(socket => {
    const c = { socket, id: `reader-${++number}`, following: false };
    connections.add(c); socket.on('close', () => connections.delete(c));
    const decoder = new FrameDecoder();
    socket.on('data', chunk => decoder.push(chunk, message => {
      const respond = result => socket.write(encodeFrame({ type: 'response', requestId: message.requestId,
        method: message.method, resultType: 'success', handledByClientId: 'owner', result }));
      if (message.method === 'initialize') respond({ clientId: c.id });
      if (message.method === 'thread-owner-discovery') respond({ supportsUntrustedAppInput: true });
      if (message.method === 'thread-stream-following-changed') {
        c.following = message.params.following;
        if (c.following) sendSnapshot(c);
      }
      if (message.method === 'thread-follower-start-turn') {
        writeCount++;
        state.turns.push({ turnId: 'accepted', status: 'completed', params: { input: message.params.turnStart.request.input }, items: [] });
        revision++;
        for (const reader of connections) if (reader.following) sendSnapshot(reader);
        respond({ result: { turn: { id: 'accepted' } } });
      }
    }));
  });
  server.listen(endpoint); await once(server, 'listening');
  t.after(async () => {
    for (const c of connections) c.socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { endpoint, state, get writeCount() { return writeCount; },
    drop() { for (const c of connections) c.socket.destroy(); }, resetRevision() { revision = 0; } };
}

test('lost success reply rejects the sender; another client recovers one committed turn without resending', async t => {
  const host = await mockHost(t);
  const continuous = await observeSession('thread', { path: host.endpoint });
  const proxy = await createDropAckProxy({ upstreamPath: host.endpoint });
  const sender = await observeSession('thread', { path: proxy.path, allowProbeWrite: true });
  let recovered;
  t.after(async () => { continuous.close(); sender.close(); recovered?.close(); await proxy.close(); });
  const args = { session: sender.state, expectedLastTurnId: 'old', appVersion: '26.901.5280.0', nonce: 'a'.repeat(24) };
  await assert.rejects(sender.client.startIdleProbe(args), /closed/);
  assert.throws(() => sender.client.startIdleProbe(args), /already attempted/);
  assert.equal(proxy.stats.replyDropped, true);
  assert.equal(proxy.stats.acceptedTurnId, 'accepted');
  assert.equal(proxy.stats.ownerMatched, true);
  assert.equal(sender.state.stale, true);
  recovered = await observeSession('thread', { path: host.endpoint });
  assert.notEqual(continuous.client.clientId, recovered.client.clientId);
  assert.equal(recovered.state.stale, false);
  assert.deepEqual(recovered.state.state.turns.map(turn => turn.turnId), ['old', 'accepted']);
  assert.equal(continuous.state.state.turns.at(-1).turnId, 'accepted');
  assert.equal(host.writeCount, 1);
});

test('connection loss invalidates old state; a new connection accepts a fresh lower-revision snapshot', async t => {
  const host = await mockHost(t);
  const old = await observeSession('thread', { path: host.endpoint });
  let fresh;
  t.after(() => { old.close(); fresh?.close(); });
  const disconnected = once(old.client, 'disconnected');
  host.drop(); await disconnected;
  assert.equal(old.state.stale, true);
  assert.ok(old.error);
  host.resetRevision();
  fresh = await observeSession('thread', { path: host.endpoint });
  assert.equal(fresh.state.revision, 0);
  assert.equal(fresh.state.stale, false);
  assert.equal(fresh.state.state.sessionId, 'thread');
  assert.equal(host.writeCount, 0);
});
