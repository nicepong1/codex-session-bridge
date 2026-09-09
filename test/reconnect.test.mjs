import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ReconnectingWorker} from '../src/reconnecting-worker.mjs';
import {SubmissionRegistry} from '../src/submission-registry.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {GPU_THREAD} from '../src/guard-policy.mjs';
import {TESTED_APP_VERSION} from '../src/installed.mjs';
import {RpcPeer} from '../src/json-rpc-peer.mjs';
const snapshot = (revision = 3) => ({type: 'snapshot', threadId: GPU_THREAD, appVersion: TESTED_APP_VERSION,
  ownerClientId: 'original-gpu-owner', revision, state: {id: GPU_THREAD, sessionId: GPU_THREAD, threadRuntimeStatus: {type: 'idle'}}});
class FakeWorker extends EventEmitter {
  sent = [];
  peer = new RpcPeer(message => this.sent.push(message));
  request(method, params) { return this.peer.request(method, params); }
  close() { this.peer.close(); }
}
function setup() {
  const children = [], policy = new NativeViewPolicy(GPU_THREAD);
  const worker = new ReconnectingWorker({threadId: GPU_THREAD, seconds: 60, delays: [5, 10],
    acceptSnapshot: message => policy.acceptSnapshot(message),
    createWorker: () => { const child = new FakeWorker(); children.push(child); return child; }});
  worker.on('offline', () => policy.disconnect());
  return {worker, children, policy};
}
async function until(predicate) { const end = Date.now() + 1000; while (!predicate() && Date.now() < end) await delay(2); assert.ok(predicate()); }

test('reconnect requires a fresh verified snapshot; old-generation messages cannot restore input', async () => {
  const {worker, children, policy} = setup();
  try {
    await until(() => children.length === 1);
    children[0].emit('message', snapshot());
    assert.equal(worker.online, true);
    children[0].emit('offline', 'connection lost');
    assert.equal(worker.online, false); assert.equal(policy.online, false);
    await assert.rejects(worker.request('submitText', {}), /not sent/);
    children[0].emit('message', snapshot(99));
    assert.equal(worker.online, false);
    await until(() => children.length === 2);
    children[1].emit('message', {type: 'heartbeat'});
    assert.equal(worker.online, false);
    children[1].emit('message', snapshot(4));
    assert.equal(worker.online, true); assert.equal(worker.recoveries, 1);
    assert.equal(policy.owner, 'original-gpu-owner');
    assert.equal(policy.sourceRevision, 4);
  } finally { worker.close(); }
});

test('loss rejects a dispatched write and does not replay it after recovery', async () => {
  const {worker, children} = setup();
  try {
    await until(() => children.length === 1);
    children[0].emit('message', snapshot());
    const pending = worker.request('submitText', {operationId: 'one'});
    const rejected = assert.rejects(pending, /do not automatically resend/);
    worker.disconnectForTest(); await rejected;
    await until(() => children.length === 2);
    children[1].emit('message', snapshot(4));
    assert.equal(children[0].sent.length, 1);
    assert.equal(children[1].sent.length, 0);
  } finally { worker.close(); }
});

test('changed owner after loss blocks recovery instead of silently attaching to another execution', async () => {
  const {worker, children} = setup();
  try {
    await until(() => children.length === 1); children[0].emit('message', snapshot());
    worker.disconnectForTest(); await until(() => children.length === 2);
    children[1].emit('message', {...snapshot(4), ownerClientId: 'replacement'});
    assert.equal(worker.blocked, true); assert.equal(worker.online, false);
    await assert.rejects(worker.request('read', {}), /unavailable/);
    await delay(30); assert.equal(children.length, 2);
  } finally { worker.close(); }
});

test('closing cancels scheduled reconnects and pending unsent reads', async () => {
  const {worker, children} = setup();
  await until(() => children.length === 1);
  const pending = worker.request('read', {});
  const rejected = assert.rejects(pending, /stopped/);
  children[0].emit('offline', 'closed'); worker.close(); await rejected;
  await delay(30); assert.equal(children.length, 1);
});

test('read startup waits for a verified snapshot and only dispatches once', async () => {
  const {worker, children} = setup();
  try {
    const pending = worker.request('read', {method: 'thread/read'});
    await until(() => children.length === 1); assert.equal(children[0].sent.length, 0);
    children[0].emit('message', snapshot());
    await until(() => children[0].sent.length === 1);
    children[0].peer.accept({id: children[0].sent[0].id, result: {thread: {id: GPU_THREAD}}});
    assert.equal((await pending).thread.id, GPU_THREAD);
  } finally { worker.close(); }
});

test('duplicate UI requests share one submission and unknown outcomes never retry', async () => {
  const registry = new SubmissionRegistry();
  const id = '514adca2-1120-4134-83ad-82c84799ea63';
  let count = 0, finish;
  const send = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const first = registry.run(id, 'one', send), duplicate = registry.run(id, 'one', send);
  await delay(0); assert.equal(count, 1); finish({turn: 'gpu-turn'});
  assert.deepEqual(await first, await duplicate);
  await assert.rejects(registry.run(id, 'changed', send), /different content/);
  const uncertainId = '514adca2-1120-4134-83ad-82c84799ea64';
  const fail = () => { count++; throw new Error('connection lost'); };
  await assert.rejects(registry.run(uncertainId, 'two', fail), /connection lost/);
  await assert.rejects(registry.run(uncertainId, 'two', fail), /connection lost/);
  assert.equal(count, 2);
  await assert.rejects(registry.run('', 'three', send), /stable/);
});

test('until-close mode renews bounded GPU workers and stops only when explicitly closed', async () => {
  const children = [], scopes = [];
  const worker = new ReconnectingWorker({threadId: GPU_THREAD, seconds: 0, readySignal: 'ready', delays: [5],
    createWorker: options => { scopes.push(options.seconds); const child = new FakeWorker(); children.push(child); return child; }});
  try {
    await until(() => children.length === 1); assert.equal(worker.deadline, Infinity); assert.equal(worker.lifetime, null);
    children[0].emit('message', {type: 'ready'}); worker.disconnectForTest();
    await until(() => children.length === 2); children[1].emit('message', {type: 'ready'});
    assert.equal(worker.online, true); assert.deepEqual(scopes, [3600, 3600]);
  } finally { worker.close(); }
  await delay(25); assert.equal(children.length, 2); assert.equal(worker.online, false);
});

test('heartbeats cannot keep a never-ready transport stuck forever', async () => {
  const children = [];
  const worker = new ReconnectingWorker({threadId: GPU_THREAD, seconds: 60, readySignal: 'ready', readyTimeoutMs: 20, delays: [5],
    createWorker: () => { const child = new FakeWorker(); children.push(child); return child; }});
  try {
    await until(() => children.length === 1); children[0].emit('message', {type: 'heartbeat'});
    await until(() => children.length >= 2); assert.equal(worker.online, false);
    children.at(-1).emit('message', {type: 'ready'}); await delay(35);
    assert.equal(worker.online, true); assert.equal(children.length, 2);
  } finally { worker.close(); }
});
