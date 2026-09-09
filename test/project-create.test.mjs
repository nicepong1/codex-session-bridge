import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter, once} from 'node:events';
import WebSocket from 'ws';
import {projectWriteRoute} from '../src/project-write-policy.mjs';
import {GpuProjectWriter} from '../src/gpu-project-writer.mjs';
import {hubReadRoute, desktopHubRoute} from '../src/guard-policy.mjs';
import {TaskHub} from '../src/task-hub.mjs';
import {startGuardServer} from '../src/guard-server.mjs';

const params = () => ({name: 'DocumentDemo', roots: [{path: 'C:\\Projects\\document-demo'}], metadata: {}, idempotencyKey: randomUUID()});
function setup(t, request, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('bridge-project-test-'));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const options = {request, journalDirectory: directory, stat: async () => ({isDirectory: () => true}), userHome: 'C:\\Users\\USER', ...overrides};
  return {writer: new GpuProjectWriter(options), options};
}
test('official multi-root preflight survives both guards, without expanding into all tasks', () => {
  for (const cwd of [[], ['C:\\a'], ['C:\\a', 'D:\\자료']]) {
    const normalized = desktopHubRoute('thread/list', {cwd, useStateDbOnly: true, limit: 100, projectId: null}).params;
    assert.deepEqual(hubReadRoute('thread/list', normalized).params.cwd, cwd);
    assert.equal(normalized.useStateDbOnly, true);
    assert.equal(normalized.projectId, null);
  }
  for (const cwd of [[{}], [''], Array(101).fill('C:\\a'), ['bad\0path']]) assert.throws(() => hubReadRoute('thread/list', {cwd}));
  assert.throws(() => hubReadRoute('project/create', params()), /denied/);
  assert.equal(desktopHubRoute('project/create', params()).write, true);
});
test('create validates paths, method and appearance without granting arbitrary writes', () => {
  for (const root of ['../x', 'C:relative', 'C:\\a\\..\\b', '\\\\server\\share', 'C:\\file:stream', 'C:\\bad\0path', 'C:\\name.'])
    assert.throws(() => projectWriteRoute('project/create', {...params(), roots: [{path: root}]}));
  for (const change of [{idempotencyKey: '../x'}, {roots: []}, {name: ' '}, {metadata: {shell: 'cmd'}}, {command: 'cmd'}])
    assert.throws(() => projectWriteRoute('project/create', {...params(), ...change}));
  for (const method of ['project/delete','project/import','project/update','thread/start','turn/start','command/exec'])
    assert.throws(() => desktopHubRoute(method, params()), /denied/);
});
test('missing GPU directories and notebook user folders never reach the create API', async t => {
  let sent = 0;
  const {writer} = setup(t, async () => sent++, {stat: async () => { throw new Error('ENOENT'); }});
  await assert.rejects(writer.handle('project/create', params()), /GPU PC에서 소스 폴더/);
  await assert.rejects(writer.handle('project/create', {...params(), roots: [{path:'C:\\Users\\laptop\\Documents'}]}), /노트북 사용자 폴더/);
  assert.equal(sent, 0);
});
test('double-click requests merge, persist on restart, and reject changed key reuse', async t => {
  let sent = 0, finish; const serverId = randomUUID(), keys = [];
  const request = async (method, p) => {
    assert.equal(method, 'project/create'); sent++; keys.push(p.idempotencyKey);
    if (sent === 1) await new Promise(resolve => { finish = resolve; });
    return {project: {id: serverId, name: p.name, roots: p.roots}};
  };
  const {writer, options} = setup(t, request); const original = params();
  const a = writer.handle('project/create', original), b = writer.handle('project/create', {...original, idempotencyKey: randomUUID()});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 1); finish();
  assert.equal((await a).project.id, (await b).project.id);
  const restarted = new GpuProjectWriter(options);
  assert.equal((await restarted.handle('project/create', {...original, idempotencyKey: randomUUID()})).project.id, serverId);
  assert.equal(keys[0], keys[1]);
  await assert.rejects(restarted.handle('project/create', {...original, name: 'Changed'}), /기록이 일치/);
});
test('uncertain create is not automatically resent; explicit retry uses the same durable key', async t => {
  const keys = []; let fail = true;
  const {writer} = setup(t, async (_m,p) => {
    keys.push(p.idempotencyKey); if (fail) throw new Error('connection lost');
    return {project: {id: randomUUID(), name:p.name, roots:p.roots}};
  });
  const p = params(); await assert.rejects(writer.handle('project/create', p), /connection lost/);
  assert.equal(keys.length, 1); fail = false;
  await writer.handle('project/create', {...p,idempotencyKey:randomUUID()}); assert.equal(keys[0], keys[1]);
});
test('project move is limited to bridge-created IDs and rejects invalid targets', async t => {
  const id = randomUUID(), calls = [];
  const {writer, options} = setup(t, async (method,p) => { calls.push(method); return method==='project/create' ? {project:{id,name:p.name,roots:p.roots}} : {}; });
  await assert.rejects(writer.handle('project/move', {projectId:id}), /이 연결에서 생성/);
  await writer.handle('project/create', params());
  await new GpuProjectWriter(options).handle('project/move', {projectId:id,beforeProjectId:null});
  assert.deepEqual(calls, ['project/create','project/move']);
  assert.throws(() => projectWriteRoute('project/move', {projectId:id,beforeProjectId:id}));
});
test('live desktop facade forwards only project writes, invalidates caches and refuses offline writes', async t => {
  class Connection extends EventEmitter {
    online = true; calls = [];
    async waitUntilReady() {}
    async request(method,p) { this.calls.push({method,p}); return {project:{id:randomUUID(),name:p.params.name,roots:p.params.roots}}; }
    close() {}
  }
  const connection = new Connection();
  const hub = new TaskHub({createConnection:()=>connection,allowProjectCreation:true}); t.after(()=>hub.close());
  const server = await startGuardServer({route:desktopHubRoute,read:async (m,p)=>m==='initialize'?{}:hub.read(m,p)});
  const ws = new WebSocket(server.url); t.after(async()=>{ws.terminate();await server.close()}); await once(ws,'open');
  let id = 0;
  const call = async (method,p) => {const next=once(ws,'message');ws.send(JSON.stringify({id:++id,method,params:p}));return JSON.parse((await next)[0]);};
  await call('initialize',{});
  hub.metadataCache.entries.set('stale',{});hub.taskListCache.entries.set('stale',{});
  assert.ok((await call('project/create',params())).result.project.id);
  assert.equal(connection.calls[0].method,'projectWrite');assert.equal(hub.metadataCache.entries.size,0);assert.equal(hub.taskListCache.entries.size,0);
  connection.online=false;assert.match((await call('project/create',params())).error.message,/연결이 끊겨/);
  assert.match((await call('thread/start',{})).error.message,/denied/);
  assert.equal(connection.calls.length,1);
});
