import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/framing.mjs';
import { applyPatches, SessionState, turnsOf } from '../src/state.mjs';
import { DesktopIpc } from '../src/ipc.mjs';

test('byte-by-byte fragmented Unicode and multiple frames are decoded once', () => {
  const messages = [{ text: '한글 😃', type: 'broadcast' }, { type: 'response', result: null }];
  const bytes = Buffer.concat(messages.map(encodeFrame));
  const decoded = [], decoder = new FrameDecoder();
  for (const byte of bytes) decoder.push(Buffer.from([byte]), message => decoded.push(message));
  assert.deepEqual(decoded, messages);
  const together = [];
  new FrameDecoder().push(bytes, message => together.push(message));
  assert.deepEqual(together, messages);
});

test('zero, oversize, and invalid JSON stop the decoder', () => {
  for (const length of [0, MAX_FRAME_BYTES + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(length);
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(header, () => {}), /Invalid frame/);
    assert.throws(() => decoder.push(encodeFrame({}), () => {}), /failed/);
  }
  assert.throws(() => new FrameDecoder().push(Buffer.from([1, 0, 0, 0, 123]), () => {}));
});

test('patching handles arrays and leaves previous state unchanged', () => {
  const original = { id: 'thread', items: ['a', 'c'], status: 'idle' };
  const next = applyPatches(original, [
    { op: 'add', path: ['items', 1], value: 'b' },
    { op: 'remove', path: ['items', 0] },
    { op: 'replace', path: ['status'], value: 'active' },
  ]);
  assert.deepEqual(next, { id: 'thread', items: ['b', 'c'], status: 'active' });
  assert.deepEqual(original.items, ['a', 'c']);
});

test('unsafe and malformed patches cannot modify prototypes or partially commit state', () => {
  const original = { ok: 1 };
  for (const path of [['__proto__', 'polluted'], ['constructor', 'prototype', 'polluted'], ['missing', 'key']]) {
    assert.throws(() => applyPatches(original, [{ op: 'add', path, value: true }]));
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => applyPatches(original, [
    { op: 'replace', path: ['ok'], value: 2 }, { op: 'replace', path: ['missing'], value: 3 },
  ]));
  assert.deepEqual(original, { ok: 1 });
});

const envelope = change => ({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner',
  params: { conversationId: 'thread', hostId: 'local', change } });

test('only the matching owner may update a session; gaps block further updates until snapshot', () => {
  const state = new SessionState('thread', 'owner');
  const snapshot = envelope({ type: 'snapshot', revision: 4, conversationState: { id: 'thread', turns: [] } });
  assert.equal(state.accept({ ...snapshot, sourceClientId: 'imposter' }), false);
  state.accept(snapshot);
  assert.throws(() => state.accept(envelope({ type: 'patches', baseRevision: 5, revision: 6, patches: [] })), /Revision gap/);
  assert.equal(state.stale, true);
  assert.throws(() => state.accept(envelope({ type: 'patches', baseRevision: 4, revision: 5, patches: [] })), /Snapshot required/);
  state.accept(envelope({ type: 'snapshot', revision: 7, conversationState: { id: 'thread', turns: [] } }));
  assert.equal(state.stale, false);
  assert.equal(state.accept(snapshot), false);
});

test('canonical history is read in island order rather than object insertion order', () => {
  const state = { turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ value: 'a' }, { value: 'b' }] }],
    entitiesByKey: { b: { turnId: 'second' }, a: { turnId: 'first' } },
  } } };
  assert.deepEqual(turnsOf(state).map(t => t.turnId), ['first', 'second']);
});

test('default IPC client rejects mutations before opening a pipe', () => {
  const client = new DesktopIpc();
  for (const method of ['turn/start', 'thread-follower-start-turn', 'thread-follower-steer-turn', 'thread-follower-command-approval-decision']) {
    assert.throws(() => client.request(method, {}), /Read-only/);
  }
  assert.throws(() => client.sendProbe({}), /Read-only/);
  assert.throws(() => client.startIdleProbe({}), /Read-only/);
});

test('probe writes reject untested builds and stale or changed turns', () => {
  const client = new DesktopIpc({ allowProbeWrite: true });
  const args = { nonce: 'a'.repeat(24), expectedTurnId: 'turn', appVersion: '26.901.5280.0',
    session: { state: {}, receivedAt: Date.now(), summary: () => ({ stale: true, activeTurnIds: ['turn'] }) } };
  assert.throws(() => client.sendProbe({ ...args, appVersion: '0.0' }), /Untested/);
  assert.throws(() => client.sendProbe(args), /Fresh/);
  assert.throws(() => client.sendProbe({ ...args, session: { ...args.session,
    summary: () => ({ stale: false, activeTurnIds: ['different'] }) } }), /Active turn/);
});

test('unknown protocol versions invalidate cached state and untested app builds reject idle writes', () => {
  const state = new SessionState('thread', 'owner');
  const snapshot = envelope({ type: 'snapshot', revision: 1, conversationState: { id: 'thread', turns: [] } });
  state.accept(snapshot);
  assert.throws(() => state.accept({ ...snapshot, version: 12 }), /Unsupported stream protocol/);
  assert.equal(state.stale, true);
  const client = new DesktopIpc({ allowProbeWrite: true });
  assert.throws(() => client.startIdleProbe({ appVersion: '99.0.0.0' }), /Untested desktop version/);
});
