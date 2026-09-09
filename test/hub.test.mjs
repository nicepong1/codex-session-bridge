import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {TaskHub} from '../src/task-hub.mjs';
import {hubReadRoute, GPU_THREAD} from '../src/guard-policy.mjs';
import {TESTED_APP_VERSION} from '../src/installed.mjs';
import {storedHistoryPreview} from '../src/stored-history-preview.mjs';
const second = '714adca2-1120-4134-83ad-82c84799ea63';
function snapshot(id, revision = 1, owner = 'owner-' + id) {
  return {type: 'snapshot', threadId: id, appVersion: TESTED_APP_VERSION, ownerClientId: owner, revision,
    state: {id, sessionId: id, title: id === GPU_THREAD ? '첫 작업' : '다른 작업', threadRuntimeStatus: {type: 'idle'}, turns: []}};
}
class FakeConnection extends EventEmitter {
  online = true; calls = []; closed = false;
  waitUntilReady() { return this.online ? Promise.resolve() : Promise.reject(new Error('offline')); }
  async request(method, params) {
    this.calls.push({method, params});
    if (!this.online) throw new Error('offline');
    if (method === 'watch' || method === 'activate') return snapshot(params.threadId);
    if (method === 'submitText') return {result: {turn: {id: 'turn-' + params.threadId}}};
    if (method === 'catalog') return {tasks: [{id: GPU_THREAD}, {id: second}], nextCursor: null};
    if (method === 'read' && params.method === 'thread/list') return {data: [{id: GPU_THREAD}, {id: second}], nextCursor: 'next'};
    if (method === 'read' && params.method === 'thread/read') return {thread: {id: params.params.threadId}};
    return {};
  }
  close() { this.closed = true; }
}
function setup(t) { const connection = new FakeConnection(), hub = new TaskHub({createConnection: () => connection}); t.after(() => hub.close()); return {hub, connection}; }
function following(id, value = true) { return {method: 'thread-stream-following-changed', version: 1, sourceClientId: 'notebook', params: {hostId: 'local', conversationId: id, following: value}}; }

test('desktop ordering loads one paged read-only catalog and prevents older hydration from changing the order', async t => {
  const connection = new FakeConnection(), history = new FakeConnection();
  const hub = new TaskHub({createConnection: () => connection, createHistoryConnection: () => history,
    prefetchHistory: true, refreshCatalog: true, canRefreshCatalog: () => false});
  t.after(() => hub.close());
  connection.request = async (method, params) => {
    connection.calls.push({method, params});
    if (method === 'catalog') return params.cursor ? {tasks:[{id:second,updatedAt:90}],nextCursor:null}
      : {tasks:[{id:GPU_THREAD,updatedAt:100}],nextCursor:'second'};
    if (method === 'read' && params.method === 'thread/list') return {data:[{id:GPU_THREAD,updatedAt:100,recencyAt:2}],nextCursor:null};
    if (method === 'read' && params.method === 'thread/read') return {thread:{id:GPU_THREAD,updatedAt:2,turns:[]}};
    throw new Error('Unexpected operation');
  };
  const [a,b] = await Promise.all([hub.read('thread/list',{}),hub.read('thread/list',{})]);
  assert.equal(connection.calls.filter(c=>c.method==='catalog').length,2);
  assert.equal(a.data[0].recencyAt,b.data[0].recencyAt);
  const single = await hub.read('thread/read',{threadId:GPU_THREAD,includeTurns:false});
  assert.equal(single.thread.recencyAt,a.data[0].recencyAt);
  assert.equal(single.thread.updatedAt,100);
  assert.equal(hub.tasks.size,0);
});

test('a disconnected ordering scan cannot publish its delayed catalog', async t => {
  const {hub,connection}=setup(t);let finish;
  connection.request=()=>new Promise(resolve=>{finish=resolve});
  const pending=hub.ensureDesktopOrder();
  connection.online=false;connection.emit('state',{status:'offline'});
  finish({tasks:[{id:GPU_THREAD,updatedAt:1}],nextCursor:null});
  await assert.rejects(pending,/connection changed/);
  assert.equal(hub.desktopOrder.ready,false);
});

test('automatic catalog reads discover new IDs without opening tasks and invalidate cached pages', async t => {
  const connection = new FakeConnection(), history = new FakeConnection(); let rows = [{id: GPU_THREAD, title: '첫 작업', updatedAt: 1}];
  history.request = async (method, params) => { history.calls.push({method, params}); assert.equal(method, 'catalog'); return {tasks: rows, nextCursor: null}; };
  const hub = new TaskHub({createConnection: () => connection, prefetchHistory: true, createHistoryConnection: () => history, refreshCatalog: true});
  t.after(() => hub.close());
  await hub.read('thread/list', {}); assert.equal(hub.taskListCache.entries.size, 1);
  await hub.catalogPoller.scan(); rows = [...rows, {id: second, title: '새 작업', updatedAt: 2}];
  const events = []; hub.on('catalogChanged', value => events.push(value));
  await hub.catalogPoller.scan();
  assert.equal(events.length, 1); assert.equal(events[0][0].id, second);
  assert.equal(hub.knownIds.has(second), true); assert.equal(hub.taskListCache.entries.size, 0);
  assert.equal(hub.tasks.size, 0); assert.equal(connection.calls.filter(c => ['watch', 'activate', 'submitText'].includes(c.method)).length, 0);
});

test('unused parked bodies are bounded while prior owner identity remains protected', async t => {
  const connection = new FakeConnection(), hub = new TaskHub({createConnection: () => connection, maxWarmTasks: 0, maxParkedHistories: 1});
  t.after(() => hub.close());
  await hub.prepare(GPU_THREAD); await hub.prepare(second); await new Promise(resolve => setImmediate(resolve));
  hub.tasks.get(GPU_THREAD).lastUsed = 1; hub.tasks.get(second).lastUsed = 2;
  hub.pruneWarmTasks();
  const old = hub.tasks.get(GPU_THREAD);
  assert.equal(old.policy.state, null); assert.equal(old.policy.owner, 'owner-' + GPU_THREAD);
  assert.ok(hub.tasks.get(second).policy.state);
  old.desired = true; connection.emit('message', snapshot(GPU_THREAD, 2, 'different-owner'));
  assert.equal(old.blocked, true); await assert.rejects(hub.submit(GPU_THREAD, randomUUID(), 'must not send'), /unavailable/);
});

test('hub read routes preserve pagination and archives while rejecting mutations and invalid IDs', () => {
  assert.equal(hubReadRoute('thread/read', {threadId: second}).params.threadId, second);
  const list = hubReadRoute('thread/list', {cursor: 'next', archived: true, limit: 75});
  assert.equal(list.params.cursor, 'next'); assert.equal(list.params.archived, true); assert.equal(list.params.limit, 75);
  for (const method of ['thread/resume', 'thread/start', 'turn/start', 'command/exec', 'fs/writeFile']) assert.throws(() => hubReadRoute(method, {threadId: second}));
  assert.throws(() => hubReadRoute('thread/read', {threadId: '../other'}));
  assert.throws(() => hubReadRoute('thread/list', {limit: 100000}));
});
test('listing all GPU tasks does not start or observe any task', async t => {
  const {hub, connection} = setup(t), result = await hub.read('thread/list', {});
  assert.equal(result.data.length, 2); assert.equal(result.nextCursor, 'next');
  assert.equal(hub.tasks.size, 0); assert.equal(connection.calls.length, 1);
  assert.equal(connection.calls[0].method, 'read');
});
test('two GPU tasks keep separate owners, streams and input destinations', async t => {
  const {hub, connection} = setup(t);
  const [a, b] = await Promise.all([hub.prepare(GPU_THREAD), hub.prepare(second)]);
  a.policy.followers.add('laptop-a'); b.policy.followers.add('laptop-b');
  connection.emit('message', snapshot(second, 2));
  assert.equal(a.policy.sourceRevision, 1); assert.equal(b.policy.sourceRevision, 2);
  await hub.submit(second, randomUUID(), '다른 작업에만 보내기');
  const writes = connection.calls.filter(c => c.method === 'submitText');
  assert.equal(writes.length, 1); assert.equal(writes[0].params.threadId, second);
  assert.deepEqual(a.policy.snapshot('hub').targetClientIds, ['laptop-a']);
  assert.deepEqual(b.policy.snapshot('hub').targetClientIds, ['laptop-b']);
});
test('sidebar metadata hydration does not attach to every listed GPU task', async t => {
  const {hub, connection} = setup(t);
  await hub.read('thread/read', {threadId: second, includeTurns: false});
  assert.equal(hub.knownIds.has(second), true);
  assert.equal(hub.tasks.size, 0);
  assert.equal(connection.calls.filter(c => c.method === 'watch').length, 0);
  assert.equal(await hub.discover({method: 'thread-owner-discovery', version: 1, params: {conversationId: second}}), true);
  assert.equal(connection.calls.filter(c => c.method === 'watch').length, 1);
});
test('owner change blocks only that GPU task and cannot redirect its input', async t => {
  const {hub, connection} = setup(t);
  await Promise.all([hub.prepare(GPU_THREAD), hub.prepare(second)]);
  connection.emit('message', snapshot(second, 2, 'replacement'));
  assert.equal(hub.tasks.get(second).blocked, true);
  assert.equal(hub.tasks.get(GPU_THREAD).policy.online, true);
  await assert.rejects(hub.submit(second, randomUUID(), 'blocked'), /unavailable/);
  assert.equal(connection.calls.filter(c => c.method === 'submitText').length, 0);
});
test('duplicate input cannot be reused across different GPU tasks', async t => {
  const {hub, connection} = setup(t); await Promise.all([hub.prepare(GPU_THREAD), hub.prepare(second)]);
  const id = randomUUID(); await hub.submit(GPU_THREAD, id, 'same text');
  await assert.rejects(hub.submit(second, id, 'same text'), /different content/);
  assert.equal(connection.calls.filter(c => c.method === 'submitText').length, 1);
});
test('transport loss disables every observed task without sending new turns', async t => {
  const {hub, connection} = setup(t); await Promise.all([hub.prepare(GPU_THREAD), hub.prepare(second)]);
  connection.online = false; connection.emit('offline', 'link lost');
  assert.equal(hub.tasks.get(GPU_THREAD).policy.online, false); assert.equal(hub.tasks.get(second).policy.online, false);
  await assert.rejects(hub.submit(GPU_THREAD, randomUUID(), 'do not queue'), /unavailable/);
  assert.equal(connection.calls.filter(c => c.method === 'submitText').length, 0);
});

test('returning to an idle-released task reattaches without owner discovery or resending input', async t => {
  const {hub, connection} = setup(t), task = await hub.prepare(GPU_THREAD);
  hub.maintain(task.lastUsed + hub.warmRetentionMs + 1);
  assert.equal(task.parked, true); assert.equal(task.desired, false); assert.equal(task.policy.online, false);
  assert.equal(task.policy.state.threadRuntimeStatus.type, 'idle');
  assert.equal(hub.follow(following(GPU_THREAD)), true);
  await task.pending;
  assert.equal(task.policy.online, true); assert.equal(task.desired, true); assert.equal(task.parked, false);
  assert.equal(connection.calls.filter(c => c.method === 'watch').length, 2);
  assert.equal(connection.calls.filter(c => c.method === 'submitText').length, 0);
});

test('maintenance repairs a followed task whose observation desire was lost', async t => {
  const {hub} = setup(t), task = await hub.prepare(GPU_THREAD);
  hub.maintain(task.lastUsed + hub.warmRetentionMs + 1);
  task.policy.followers.add('notebook');
  hub.maintain(); await task.pending;
  assert.equal(task.policy.online, true); assert.equal(task.desired, true);
});

test('refollow waits for an in-flight idle release before creating a fresh observation', async t => {
  const {hub, connection} = setup(t), task = await hub.prepare(GPU_THREAD);
  const originalRequest = connection.request.bind(connection);
  let release;
  connection.request = (method, params) => method === 'unwatch' ? new Promise(resolve => { release = resolve; }) : originalRequest(method, params);
  hub.maintain(task.lastUsed + hub.warmRetentionMs + 1); hub.follow(following(GPU_THREAD));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(task.policy.online, false);
  assert.equal(connection.calls.filter(c => c.method === 'watch').length, 1);
  release({}); await task.pending;
  assert.equal(task.policy.online, true);
  assert.equal(connection.calls.filter(c => c.method === 'watch').length, 2);
});
test('only an explicit isolated-desktop open activates a known task; reads never resume a CLI',async t=>{
  const connection=new FakeConnection(),hub=new TaskHub({createConnection:()=>connection,allowActivation:true});t.after(()=>hub.close());
  await hub.read('thread/list',{});
  await assert.rejects(hub.read('thread/resume',{threadId:second,path:'C:\\untrusted',history:[{role:'user',text:'untrusted'}],config:{permissions:'all'}}),/GPU 공식 앱에서/);
  assert.equal(hub.tasks.get(second).policy.online,true);
  assert.equal(connection.calls.filter(c=>c.method==='activate').length,1);
  assert.deepEqual(connection.calls.find(c=>c.method==='activate').params,{threadId:second});
  assert.equal(connection.calls.some(c=>c.method==='read'&&c.params.method==='thread/resume'),false);
  await assert.rejects(hub.read('thread/resume',{threadId:randomUUID()}),/unknown/);
  assert.equal(connection.calls.filter(c=>c.method==='activate').length,1);
});

test('a late desktop resume error is followed by bounded snapshots of the selected task only', async t => {
  const connection = new FakeConnection(), hub = new TaskHub({createConnection: () => connection, allowActivation: true});
  t.after(() => hub.close()); await hub.read('thread/list', {});
  await assert.rejects(hub.read('thread/resume', {threadId: second}), /GPU 공식 앱에서/);
  hub.follow(following(second)); await hub.tasks.get(second).pending;
  const task = hub.tasks.get(second), sourceRevision = task.policy.sourceRevision;
  const afterResumeError = [], revisionBefore = task.policy.revision;
  hub.on('snapshot', task => afterResumeError.push(task.policy.snapshot('hub')));
  hub.maintain(task.viewRefreshAt);
  assert.equal(afterResumeError.length, 1);
  assert.deepEqual(afterResumeError[0].targetClientIds, ['notebook']);
  assert.equal(afterResumeError[0].params.conversationId, second);
  assert.equal(afterResumeError[0].params.change.conversationState.resumeState, 'resumed');
  assert.ok(afterResumeError[0].params.change.revision > revisionBefore);
  assert.equal(task.policy.sourceRevision, sourceRevision);
  hub.maintain(task.viewRefreshAt - 1); assert.equal(afterResumeError.length, 1);
  hub.maintain(task.viewRefreshUntil); assert.equal(afterResumeError.length, 1);
  hub.follow(following(second, false)); hub.maintain(task.viewRefreshAt);
  assert.equal(afterResumeError.length, 1);
  assert.equal(connection.calls.some(c => c.method === 'submitText'), false);
});

test('delayed view recovery stops when the GPU connection is lost', async t => {
  const {hub, connection} = setup(t), task = await hub.prepare(second);
  hub.follow(following(second)); await task.pending;
  connection.online = false; connection.emit('offline', 'lost');
  const revision = task.policy.revision; hub.maintain(task.viewRefreshAt);
  assert.equal(task.policy.revision, revision);
  assert.equal(task.policy.online, false);
});

test('post-resume snapshots arrive before the maintenance tick and stop after disconnect', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {hub, connection} = setup(t), task = await hub.prepare(second);
  hub.follow(following(second)); await task.pending;
  const revisions = []; hub.on('snapshot', task => revisions.push(task.policy.revision));
  t.mock.timers.tick(349); assert.equal(revisions.length, 0);
  t.mock.timers.tick(1); assert.equal(revisions.length, 1);
  connection.online = false;
  t.mock.timers.tick(550); assert.equal(revisions.length, 1);
  assert.equal(connection.calls.some(call => call.method === 'submitText'), false);
});

test('hub rejects metadata while offline, clears it on reconnect and never caches execution', async t => {
  const {hub, connection} = setup(t);
  await hub.read('model/list', {}); await hub.read('model/list', {});
  assert.equal(connection.calls.length, 1);
  connection.online = false; connection.emit('offline', 'lost');
  await assert.rejects(hub.read('model/list', {}), /offline/);
  connection.online = true; connection.emit('state', {status: 'online'});
  await hub.read('model/list', {});
  assert.equal(connection.calls.length, 2);
  await assert.rejects(hub.read('turn/start', {}), /denied/);
  await hub.read('account/read', {}); await hub.read('account/read', {});
  assert.equal(connection.calls.length, 4);
});

test('returning after the old one-minute deadline reuses the live verified state without another GPU request', async t => {
  const {hub, connection} = setup(t), task = await hub.prepare(GPU_THREAD);
  const state = task.policy.state, owner = task.policy.owner;
  hub.maintain(task.lastUsed + 61000);
  assert.equal(task.policy.online, true); assert.equal(task.parked, false);
  await hub.prepare(GPU_THREAD);
  assert.equal(task.policy.state, state); assert.equal(task.policy.owner, owner);
  assert.deepEqual(connection.calls.map(c => c.method), ['watch']);
  hub.maintain(task.lastUsed + hub.warmRetentionMs + 1);
  assert.equal(task.parked, true); assert.equal(task.policy.online, false);
});

test('six most recent inactive tasks survive while older observations are released, never the visible task', async t => {
  const {hub, connection} = setup(t), visible = await hub.prepare(GPU_THREAD);
  hub.follow(following(GPU_THREAD)); visible.lastUsed = 1;
  const inactive = [];
  for (let i = 0; i < 8; i++) {
    const task = await hub.prepare(randomUUID());
    task.lastUsed = Date.now() - 1000 + i; inactive.push(task);
  }
  assert.equal(visible.policy.online, true);
  assert.equal(inactive.filter(t => t.policy.online).length, 6);
  assert.ok(inactive.slice(0, 2).every(t => t.parked));
  assert.ok(connection.calls.filter(c => c.method === 'unwatch').every(c => c.params.threadId !== GPU_THREAD));
  hub.maintain(Date.now() + hub.warmRetentionMs + 1);
  assert.equal(visible.policy.online, true); assert.ok(inactive.every(t => t.parked));
});

test('leaving a long-visible task starts a fresh retention period, but an invalid unfollow cannot prolong it', async t => {
  const {hub} = setup(t), task = await hub.prepare(GPU_THREAD);
  hub.follow(following(GPU_THREAD)); task.lastUsed = 1;
  hub.follow({...following(GPU_THREAD, false), params: {hostId: 'other', conversationId: GPU_THREAD, following: false}});
  assert.equal(task.lastUsed, 1); assert.equal(task.policy.followers.size, 1);
  hub.follow(following(GPU_THREAD, false));
  assert.ok(Date.now() - task.lastUsed < 1000);
  hub.maintain(task.lastUsed + 61000); assert.equal(task.policy.online, true);
});

test('expired inactive tasks are not restored after reconnect and retained tasks still need a fresh owner check', async t => {
  const {hub, connection} = setup(t);
  const expired = await hub.prepare(GPU_THREAD), recent = await hub.prepare(second);
  connection.online = false; connection.emit('offline', 'lost');
  expired.lastUsed = Date.now() - hub.warmRetentionMs - 1;
  await assert.rejects(hub.submit(second, randomUUID(), 'never send cached input'), /unavailable/);
  connection.online = true; connection.emit('state', {status: 'online'});
  await recent.pending;
  assert.equal(expired.desired, false); assert.equal(expired.parked, true);
  assert.equal(connection.calls.filter(c => c.method === 'watch' && c.params.threadId === GPU_THREAD).length, 1);
  assert.equal(connection.calls.filter(c => c.method === 'watch' && c.params.threadId === second).length, 2);
  assert.equal(recent.policy.online, true);
  assert.equal(connection.calls.some(c => c.method === 'submitText'), false);
});

test('background recovery does not reset recent-use age and a departing client starts retention once', async t => {
  const {hub, connection} = setup(t), task = await hub.prepare(GPU_THREAD);
  const lastUsed = Date.now() - 100000; task.lastUsed = lastUsed;
  connection.online = false; connection.emit('offline', 'lost');
  connection.online = true; connection.emit('state', {status: 'online'}); await task.pending;
  assert.equal(task.lastUsed, lastUsed);
  hub.follow(following(GPU_THREAD)); task.lastUsed = 1;
  hub.removeFollower('someone-else'); assert.equal(task.lastUsed, 1);
  hub.removeFollower('notebook'); assert.ok(Date.now() - task.lastUsed < 1000);
  assert.equal(task.policy.online, true);
});

test('selecting a known catalog task activates on the first following signal before any resume request', async t => {
  const connection = new FakeConnection(), hub = new TaskHub({createConnection: () => connection, allowActivation: true});
  t.after(() => hub.close()); await hub.read('thread/list', {});
  assert.equal(hub.tasks.size, 0);
  const published = []; hub.on('snapshot', task => published.push(task.policy.snapshot('bridge')));
  assert.equal(hub.follow(following(second)), true);
  await hub.tasks.get(second).pending;
  assert.deepEqual(connection.calls.filter(c => c.method === 'activate'), [{method: 'activate', params: {threadId: second}}]);
  assert.deepEqual(published[0].targetClientIds, ['notebook']);
  assert.equal(published[0].params.change.conversationState.sessionId, second);
  assert.equal(connection.calls.some(c => c.method === 'submitText'), false);
});

test('unknown or malformed following signals cannot allocate or open a task', async t => {
  const {hub, connection} = setup(t); await hub.read('thread/list', {});
  for (const message of [following(randomUUID()), following(second, false), {...following(second), version: 2},
    {...following(second), sourceClientId: ''}, {...following(second), hostId: 'foreign'},
    {...following(second), params: {...following(second).params, hostId: 'foreign'}},
    {...following(second), method: 'another-broadcast'}, null]) assert.equal(hub.follow(message), false);
  assert.equal(hub.tasks.size, 0); assert.equal(connection.calls.length, 1);
});

test('early following and late resume share one activation; a retained selection needs no request', async t => {
  const connection = new FakeConnection(), hub = new TaskHub({createConnection: () => connection, allowActivation: true});
  t.after(() => hub.close()); hub.knownIds.add(second);
  let resolve; const original = connection.request.bind(connection);
  connection.request = (method, params) => method === 'activate' ? new Promise(r => {
    connection.calls.push({method, params}); resolve = r;
  }) : original(method, params);
  hub.follow(following(second));
  const resumed = assert.rejects(hub.read('thread/resume', {threadId: second}), /GPU 공식 앱에서/);
  await new Promise(r => setImmediate(r));
  assert.equal(connection.calls.length, 1); resolve(snapshot(second)); await resumed;
  hub.follow(following(second, false)); hub.follow(following(second));
  assert.equal(hub.tasks.get(second).policy.online, true); assert.equal(connection.calls.length, 1);
});

test('read-only selection observes but cannot activate, and offline lists never use saved data', async t => {
  const {hub, connection} = setup(t); await hub.read('thread/list', {});
  hub.follow(following(second)); await hub.tasks.get(second).pending;
  assert.equal(connection.calls.at(-1).method, 'watch');
  await hub.read('thread/list', {cursor: null, archived: false, limit: 50});
  assert.equal(connection.calls.filter(c => c.method === 'read').length, 1);
  connection.online = false; connection.emit('offline', 'lost');
  await assert.rejects(hub.read('thread/list', {}), /offline/);
  connection.online = true; connection.emit('state', {status: 'online'});
  await hub.read('thread/list', {});
  assert.equal(connection.calls.filter(c => c.method === 'read').length, 2);
});

test('prefetched body is published before slow activation while input stays blocked, then live state wins', async t => {
  const connection = new FakeConnection(), historyConnection = new FakeConnection();
  historyConnection.request = async (method, params) => {
    assert.equal(method, 'history');
    return storedHistoryPreview({id: params.threadId, sessionId: params.threadId, turns: [{id: 'stored', status: 'completed',
      items: [{type: 'agentMessage', text: '저장된 답변'}]}]}, params.threadId);
  };
  const hub = new TaskHub({createConnection: () => connection, allowActivation: true, prefetchHistory: true, createHistoryConnection: () => historyConnection});
  t.after(() => hub.close()); await hub.read('thread/list', {}); await hub.history.pump(); await hub.history.pump();
  assert.equal(hub.tasks.size, 0); assert.equal(connection.calls.some(c => c.method === 'activate'), false);
  let finish; const original = connection.request.bind(connection);
  connection.request = (method, params) => method === 'activate' ? new Promise(resolve => { finish = () => resolve(snapshot(params.threadId)); }) : original(method, params);
  const sent = []; hub.on('snapshot', task => sent.push({preview: task.policy.preview, online: task.policy.online, id: task.id}));
  hub.follow(following(second));
  assert.deepEqual(sent, [{preview: true, online: false, id: second}]);
  assert.equal(hub.tasks.get(second).policy.owner, null);
  await assert.rejects(hub.submit(second, randomUUID(), 'cannot send yet'), /unavailable/);
  await new Promise(resolve => setImmediate(resolve)); finish(); await hub.tasks.get(second).pending;
  assert.deepEqual(sent.at(-1), {preview: false, online: true, id: second});
  assert.equal(hub.tasks.get(second).policy.owner, 'owner-' + second);
  assert.equal(connection.calls.some(c => c.method === 'submitText'), false);
});
