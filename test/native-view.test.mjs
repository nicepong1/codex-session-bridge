import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeViewPolicy } from '../src/native-view-policy.mjs';
import { TESTED_APP_VERSION } from '../src/installed.mjs';
import { encodeSshFrame, SshFrameDecoder } from '../src/ssh-framing.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const snapshot = () => ({type: 'snapshot', appVersion: TESTED_APP_VERSION, threadId: id,
  ownerClientId: 'gpu-owner', revision: 3, state: {id, sessionId: id, rolloutPath: 'gpu-private-path', resumeState: 'resumed'}});
const request = method => ({requestId: 'r', method, version: 1, params: {hostId: 'local', conversationId: id}});
test('native view preserves conversation identity but removes the local-resume path', () => {
  const p = new NativeViewPolicy(id); const original = snapshot(); p.acceptSnapshot(original);
  assert.equal(p.state.id, id); assert.equal(p.state.sessionId, id); assert.equal(p.state.rolloutPath, '');
  assert.equal(original.state.rolloutPath, 'gpu-private-path');
  assert.equal(p.snapshot('bridge'), null);
});
test('native view cannot handle another task or host and never accepts execution', () => {
  const p = new NativeViewPolicy(id); p.acceptSnapshot(snapshot());
  assert.equal(p.canHandle({...request('thread-owner-discovery'), params: {conversationId: 'other'}}), false);
  assert.equal(p.canHandle({...request('thread-owner-discovery'), hostId: 'remote-host'}), false);
  for (const method of ['thread-follower-start-turn', 'thread-follower-steer-turn', 'thread-follower-file-approval-decision']) {
    assert.equal(p.handleRequest(request(method), 'bridge').error, 'native-view-read-only');
  }
  assert.equal(p.handleRequest(request('thread-owner-discovery'), 'bridge').result.supportsUntrustedAppInput, false);
});
test('upstream disconnect remains a reachable rejection, preventing missing-owner fallback', () => {
  const p = new NativeViewPolicy(id); p.acceptSnapshot(snapshot()); p.disconnect();
  assert.equal(p.canHandle(request('thread-follower-start-turn')), true);
  const reply = p.handleRequest(request('thread-follower-start-turn'), 'bridge');
  assert.equal(reply.error, 'native-view-gpu-offline'); assert.doesNotMatch(reply.error, /no-client-found/);
});
test('native view rejects owner, version, session and revision changes', () => {
  const p = new NativeViewPolicy(id); p.acceptSnapshot(snapshot());
  for (const patch of [{ownerClientId: 'replacement'}, {appVersion: 'unknown'}, {revision: 2}, {state: {id, sessionId: 'other'}}]) {
    assert.throws(() => p.acceptSnapshot({...snapshot(), ...patch}));
  }
});
test('snapshots only go to clients following the selected conversation', () => {
  const p = new NativeViewPolicy(id); p.acceptSnapshot(snapshot());
  const follow = {type: 'broadcast', sourceClientId: 'desktop', method: 'thread-stream-following-changed', version: 1,
    params: {hostId: 'local', conversationId: id, following: true}};
  assert.equal(p.follow({...follow, params: {...follow.params, conversationId: 'other'}}), false);
  assert.equal(p.follow(follow), true);
  assert.deepEqual(p.snapshot('bridge').targetClientIds, ['desktop']);
  p.follow({...follow, params: {...follow.params, following: false}});
  assert.equal(p.snapshot('bridge'), null);
});
test('SSH carrier preserves Korean through CRLF and arbitrary chunk boundaries', () => {
  const input = {type: 'snapshot', text: 'GPU의 원래 대화 😀\n다음 줄'};
  const wire = Buffer.from((encodeSshFrame(input) + encodeSshFrame({type: 'heartbeat'})).replaceAll('\n', '\r\n'), 'ascii');
  const decoder = new SshFrameDecoder(); const output = [];
  for (const byte of wire) decoder.push(Buffer.from([byte]), message => output.push(message));
  assert.deepEqual(output, [input, {type: 'heartbeat'}]);
});
test('SSH carrier fails closed on shell output or truncated frames', () => {
  for (const wire of ['unexpected output\n', Buffer.from([4, 0, 0, 0, 0]).toString('base64') + '\n']) {
    const decoder = new SshFrameDecoder();
    assert.throws(() => decoder.push(Buffer.from(wire), () => assert.fail('must not decode')));
    assert.throws(() => decoder.push(Buffer.from(encodeSshFrame({})), () => assert.fail('failed decoder')));
  }
});
test('an explicit local view alias preserves the GPU session identity and original content', () => {
  const viewId = '00000000-0000-4000-8000-000000000013';
  const p = new NativeViewPolicy(id, viewId);
  const original = snapshot(); original.state.turns = [{turnId: 'gpu-turn', text: 'GPU 본문'}];
  p.acceptSnapshot(original);
  assert.equal(p.state.id, viewId); assert.equal(p.state.sessionId, id);
  assert.deepEqual(p.state.turns, original.state.turns); assert.equal(original.state.id, id);
  assert.equal(p.canHandle(request('thread-owner-discovery')), false);
  assert.equal(p.canHandle({...request('thread-owner-discovery'), params: {conversationId: viewId, hostId: 'local'}}), true);
  assert.equal(p.snapshot('bridge', ['desktop']).params.conversationId, viewId);
});
