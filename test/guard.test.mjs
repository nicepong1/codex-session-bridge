import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {startGuardServer} from '../src/guard-server.mjs';
import {readRoute, GPU_THREAD, reportStatus, textFromFollower} from '../src/guard-policy.mjs';
import {RpcPeer} from '../src/json-rpc-peer.mjs';
import {DesktopIpc} from '../src/ipc.mjs';

test('guard never routes resume, execution, permissions or unknown methods to a CLI', () => {
  for (const method of ['thread/resume', 'thread/start', 'thread/fork', 'turn/start', 'turn/steer', 'command/exec', 'fs/writeFile', 'account/login/start', 'config/value/write', 'unknown']) {
    assert.throws(() => readRoute(method, {threadId: GPU_THREAD}), /gpu-guard-denied/);
  }
  assert.throws(() => readRoute('thread/read', {threadId: 'another-thread'}));
  assert.equal(readRoute('thread/list', {limit: 100}).params.threadId, GPU_THREAD);
  assert.deepEqual(readRoute('thread/list', {cursor: 'another'}).local.data, []);
  assert.deepEqual(readRoute('thread/list', {archived: true}).local.data, []);
});
test('text forwarding scopes the task and excludes local attachments', () => {
  const r = {method: 'thread-follower-start-turn', version: 2, params: {conversationId: GPU_THREAD,
    turnStart: {request: {threadId: GPU_THREAD, input: [{type: 'text', text: 'GPU에서 실행'}]}, context: {attachments: []}}}};
  assert.equal(textFromFollower(r), 'GPU에서 실행');
  assert.throws(() => textFromFollower({...r, version: 1}));
  r.params.turnStart.context.attachments.push({path: 'C:\\notebook-file'});
  assert.throws(() => textFromFollower(r), /Attachments/);
  assert.throws(() => new DesktopIpc().startTextTurn({}), /disabled/);
});

test('selecting another GPU task changes the read scope without opening execution routes', () => {
  const selected = '714adca2-1120-4134-83ad-82c84799ea63';
  assert.equal(readRoute('thread/read', {threadId: selected}, selected).params.threadId, selected);
  assert.equal(readRoute('thread/list', {}, selected).params.threadId, selected);
  assert.throws(() => readRoute('thread/read', {threadId: GPU_THREAD}, selected));
  for (const method of ['turn/start', 'thread/resume', 'thread/fork', 'command/exec']) assert.throws(() => readRoute(method, {threadId: selected}, selected));
});
test('old or stale status reports cannot assert a live connection', () => {
  assert.equal(reportStatus({status: 'ready-read-only'}), 'unverified-legacy-report');
  const now = Date.now(); const report = {pid: 123, status: 'guard-ready', heartbeatAt: new Date(now).toISOString()};
  assert.equal(reportStatus(report, {now, alive: true}), 'guard-ready');
  assert.equal(reportStatus(report, {now: now + 16000, alive: true}), 'offline');
  assert.equal(reportStatus(report, {now, alive: false}), 'offline');
});
test('RPC channel loss rejects pending input without resending it', async () => {
  const sent = [];
  const peer = new RpcPeer(message => sent.push(message));
  const pending = peer.request('submitText', {text: 'one request'});
  peer.close();
  await assert.rejects(pending, /do not automatically resend/);
  await assert.rejects(peer.request('submitText', {}), /closed/);
  assert.equal(sent.length, 1);
});
test('WebSocket guard refuses execution before and after upstream failure', async () => {
  const reads = []; let upstream = true;
  const server = await startGuardServer({read: async (method, params) => { reads.push(method); if (!upstream) throw new Error('GPU disconnected'); return method === 'initialize' ? {userAgent: 'guard-test'} : {thread: {id: params.threadId}}; }});
  const ws = new WebSocket(server.url);
  try {
    await once(ws, 'open');
    let id = 0;
    async function call(method, params = {}) { const response = once(ws, 'message'); ws.send(JSON.stringify({id: ++id, method, params})); return JSON.parse((await response)[0]); }
    assert.equal((await call('initialize')).result.userAgent, 'guard-test');
    ws.send(JSON.stringify({method: 'initialized'}));
    assert.equal((await call('thread/read', {threadId: GPU_THREAD})).result.thread.id, GPU_THREAD);
    for (const method of ['thread/resume', 'turn/start', 'command/exec']) assert.match((await call(method, {threadId: GPU_THREAD})).error.message, /denied/);
    upstream = false;
    assert.match((await call('thread/read', {threadId: GPU_THREAD})).error.message, /disconnected/);
    assert.match((await call('turn/start', {threadId: GPU_THREAD})).error.message, /denied/);
    assert.deepEqual(reads, ['initialize', 'thread/read', 'thread/read']);
  } finally { ws.terminate(); await server.close(); }
});
test('WebSocket guard rejects browser Origins and incorrect capabilities', async () => {
  const server = await startGuardServer({read: async () => assert.fail('must not reach upstream')});
  try {
    for (const [url, options] of [[server.url, {origin: 'https://example.com'}], [server.url + 'wrong', {}]]) {
      const ws = new WebSocket(url, options);
      ws.on('error', () => {});
      const [response] = await new Promise(resolve => ws.once('unexpected-response', (_request, response) => { response.resume(); resolve([response]); }));
      assert.equal(response.statusCode, 403); ws.terminate();
    }
  } finally { await server.close(); }
});

test('catalog notifications wait for initialization, replay to a reconnecting UI and cannot convey execution', async () => {
  const server = await startGuardServer({read: async () => ({userAgent: 'test'})});
  const sockets = [];
  try {
    assert.throws(() => server.notifyTaskNames([{id: '../bad', title: 'bad'}]), /Invalid/);
    server.notifyTaskNames([{id: GPU_THREAD, title: '새 GPU 작업'}]);
    for (let index = 0; index < 2; index++) {
      const ws = new WebSocket(server.url); sockets.push(ws); await once(ws, 'open');
      const messages = []; ws.on('message', bytes => messages.push(JSON.parse(bytes)));
      ws.send(JSON.stringify({id: 1, method: 'initialize'}));
      const deadline = Date.now() + 1000;
      while(messages.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(messages[0].id, 1);
      assert.deepEqual(messages[1], {method: 'thread/name/updated', params: {threadId: GPU_THREAD, threadName: '새 GPU 작업'}});
      // No initialized notification, matching the installed desktop handshake.
      const updated = once(ws, 'message'); const sent = server.notifyTaskNames([{id: GPU_THREAD, title: '이름 갱신'}]);
      assert.ok(sent.delivered >= 1); assert.equal(JSON.parse((await updated)[0]).params.threadName, '이름 갱신');
      ws.terminate();
      server.notifyTaskNames([{id: GPU_THREAD, title: '새 GPU 작업'}]);
    }
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); }
});

test('catalog replay history is bounded', async () => {
  const server = await startGuardServer({read: async () => ({})});
  try {
    const rows = Array.from({length: 1005}, (_, i) => ({id: `714adca2-1120-4134-83ad-${i.toString(16).padStart(12, '0')}`, title: 'task'}));
    const result = server.notifyTaskNames(rows); assert.equal(result.retained, 1000); assert.equal(result.delivered, 0);
  } finally { await server.close(); }
});

test('a native picker response cannot be misrouted or disconnect the app-server channel',async t=>{
  const replies=[],reads=[],events=[];
  const server=await startGuardServer({read:async(method)=>{reads.push(method);return{}},
    onUnsupportedReply:event=>replies.push(event),onRequest:event=>events.push(event)});
  const ws=new WebSocket(server.url);t.after(async()=>{ws.terminate();await server.close()});await once(ws,'open');
  let response=once(ws,'message');ws.send(JSON.stringify({id:1,method:'initialize'}));await response;
  ws.send(JSON.stringify({id:42,result:{answers:'private-credential'}}));
  response=once(ws,'message');ws.send(JSON.stringify({id:2,method:'model/list',params:{}}));
  assert.equal(JSON.parse((await response)[0]).id,2);assert.equal(ws.readyState,WebSocket.OPEN);
  assert.deepEqual(replies,[{requestId:42}]);assert.deepEqual(reads,['initialize','model/list']);
  assert.doesNotMatch(JSON.stringify(events),/private-credential|answers/);
});
