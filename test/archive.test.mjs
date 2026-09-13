import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter, once} from 'node:events';
import WebSocket from 'ws';
import {desktopHubRoute, hubReadRoute, readRoute} from '../src/guard-policy.mjs';
import {GpuArchiveWriter} from '../src/gpu-archive-writer.mjs';
import {TaskHub} from '../src/task-hub.mjs';
import {startGuardServer} from '../src/guard-server.mjs';
const id='b0759e24-5db2-4735-abf0-12e16ad4fba5', other='18e097c9-26ae-4336-8fbc-e25450f3ed54';

test('archive and restore are exact desktop writes, never general read permissions',()=>{
  for(const method of ['thread/archive','thread/unarchive']){
    assert.deepEqual(desktopHubRoute(method,{threadId:id}),{write:true,method,params:{threadId:id}});
    for(const params of [{threadId:'invalid'}, {threadId:id,cwd:'C:\\work'}, {threadId:id,delete:true}, [id], null])
      assert.throws(()=>desktopHubRoute(method,params));
    for(const route of [readRoute,hubReadRoute])assert.throws(()=>route(method,{threadId:id}),/denied/);
  }
  assert.throws(()=>desktopHubRoute('thread/delete',{threadId:id}),/denied/);
});

function writer(t,request){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-archive-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new GpuArchiveWriter({request,journalDirectory:dir});}
test('archive writes one validated target, coalesces duplicate IDs and rejects changed reuse',async t=>{
  const calls=[],gpu=writer(t,async(method,params)=>{calls.push({method,params});return method==='thread/read'?{thread:{id}}:{};});
  const operation={operationId:randomUUID(),method:'thread/archive',params:{threadId:id}};
  assert.deepEqual(await Promise.all([gpu.handle(operation),gpu.handle(operation)]),[{},{}]);
  assert.deepEqual(calls.map(c=>c.method),['thread/read','thread/archive']);
  assert.deepEqual(calls[1].params,{threadId:id});
  await assert.rejects(gpu.handle({...operation,params:{threadId:other}}),/reused/);
});
test('lost archive acknowledgement is not replayed in memory or after a worker restart',async t=>{
  let writes=0;const request=async method=>{if(method==='thread/read')return {thread:{id}};writes++;throw Error('connection lost');};
  const gpu=writer(t,request),operation={operationId:randomUUID(),method:'thread/archive',params:{threadId:id}};
  await assert.rejects(gpu.handle(operation),/connection lost/);await assert.rejects(gpu.handle(operation),/connection lost/);
  const restarted=new GpuArchiveWriter({request,journalDirectory:gpu.journalDirectory});
  await assert.rejects(restarted.handle(operation),/replay refused/);assert.equal(writes,1);
});
test('restore requires the returned identity and journals no conversation content',async t=>{
  const gpu=writer(t,async method=>({thread:{id:method==='thread/read'?id:other,turns:[{text:'private body'}]}}));
  await assert.rejects(gpu.handle({operationId:randomUUID(),method:'thread/unarchive',params:{threadId:id}}),/verified/);
  const texts=fs.readdirSync(gpu.journalDirectory).map(f=>fs.readFileSync(path.join(gpu.journalDirectory,f),'utf8'));
  assert.equal(texts.some(s=>s.includes('private body')),false);
});
test('read identity mismatch and invalid operation IDs never reach a write',async t=>{
  const calls=[],gpu=writer(t,async method=>{calls.push(method);return {thread:{id:other}};});
  await assert.rejects(gpu.handle({operationId:'../invalid',method:'thread/archive',params:{threadId:id}}));
  assert.deepEqual(calls,[]);
  await assert.rejects(gpu.handle({operationId:randomUUID(),method:'thread/archive',params:{threadId:id}}),/target mismatch/);
  assert.deepEqual(calls,['thread/read']);
});

function setup(t){const connection=new EventEmitter();connection.online=true;connection.calls=[];
  connection.waitUntilReady=async()=>{};connection.close=()=>{};
  connection.request=async(method,params)=>{connection.calls.push({method,params});if(method==='archiveWrite')return params.method==='thread/archive'?{}:{thread:{id,turns:[]}};return {data:[{id,name:'fixture'}],nextCursor:null};};
  const hub=new TaskHub({createConnection:()=>connection,allowArchiving:true,allowActivation:true});t.after(()=>hub.close());return {hub,connection};}
test('acknowledged archive invalidates cached lists, stops followers and restores without a turn',async t=>{
  const {hub,connection}=setup(t),notifications=[];hub.on('archiveChanged',e=>notifications.push(e));
  await hub.read('thread/list',{limit:20});assert.ok(hub.taskListCache.entries.size);
  const task=hub.task(id);task.desired=true;task.policy.online=true;task.policy.followers.add('viewer');
  const context={requestKey:'socket:archive'};
  await Promise.all([hub.read('thread/archive',{threadId:id},context),hub.read('thread/archive',{threadId:id},context)]);
  assert.equal(connection.calls.filter(c=>c.method==='archiveWrite').length,1);
  assert.equal(hub.taskListCache.entries.size,0);assert.equal(task.desired,false);assert.equal(task.policy.followers.size,0);
  hub.maintain();await assert.rejects(hub.prepare(id,{activate:true}),/보관/);
  await hub.read('thread/unarchive',{threadId:id},{requestKey:'socket:restore'});
  assert.equal(hub.archivedIds.has(id),false);assert.equal(hub.knownIds.has(id),true);
  assert.deepEqual(notifications,[{threadId:id,archived:true},{threadId:id,archived:false}]);
  assert.equal(connection.calls.some(c=>['activate','turn/start','submitText'].includes(c.method)),false);
});
test('offline, read-only and failed archive requests cannot hide a conversation or be retried',async t=>{
  const {hub,connection}=setup(t);let events=0;hub.on('archiveChanged',()=>events++);
  connection.online=false;await assert.rejects(hub.read('thread/archive',{threadId:id},{requestKey:'offline'}));
  connection.online=true;hub.allowArchiving=false;await assert.rejects(hub.read('thread/archive',{threadId:id},{requestKey:'readonly'}));
  assert.equal(connection.calls.length,0);hub.allowArchiving=true;
  let calls=0;connection.request=async()=>{calls++;throw Error('uncertain');};
  const context={requestKey:'failed'};
  await assert.rejects(hub.read('thread/archive',{threadId:id},context));await assert.rejects(hub.read('thread/archive',{threadId:id},context));
  await assert.rejects(hub.read('thread/archive',{threadId:other},context),/reused/);
  assert.equal(calls,1);assert.equal(events,0);assert.equal(hub.archivedIds.has(id),false);
});
test('a fresh active catalog observes restoration from another device',async t=>{
  const {hub}=setup(t);
  await hub.read('thread/archive',{threadId:id},{requestKey:'archive'});
  assert.equal(hub.archivedIds.has(id),true);
  hub.acceptCatalog({data:[{id}]},{archived:true});assert.equal(hub.archivedIds.has(id),true);
  hub.acceptCatalog({data:[{id}]},{archived:false});assert.equal(hub.archivedIds.has(id),false);
});
test('archive notifications reach initialized desktop clients without restoring a cached name',async t=>{
  const server=await startGuardServer({route:desktopHubRoute,read:async()=>({})});t.after(()=>server.close());
  const ws=new WebSocket(server.url);t.after(()=>ws.terminate());await once(ws,'open');
  const messages=[];ws.on('message',data=>messages.push(JSON.parse(data)));
  ws.send(JSON.stringify({id:1,method:'initialize',params:{}}));await once(ws,'message');
  server.notifyTaskNames([{id,title:'fixture'}]);server.notifyArchiveState(id,true);server.notifyArchiveState(id,false);
  await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(messages.filter(m=>m.method?.match(/^thread\/(un)?archived$/)),[
    {method:'thread/archived',params:{threadId:id}},{method:'thread/unarchived',params:{threadId:id}}]);
  assert.throws(()=>server.notifyArchiveState('invalid',true));
});
