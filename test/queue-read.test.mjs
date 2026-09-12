import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {readRoute,hubReadRoute,desktopHubRoute} from '../src/guard-policy.mjs';
import {startGuardServer} from '../src/guard-server.mjs';
import {TaskHub} from '../src/task-hub.mjs';

test('queue pagination is scoped to a valid GPU thread and forwards only bounded query fields',()=>{
  const id=randomUUID(),params={threadId:id,cursor:'opaque-token',limit:30};
  assert.deepEqual(readRoute('thread/queue/list',params,id),{method:'thread/queue/list',params});
  assert.deepEqual(desktopHubRoute('thread/queue/list',{threadId:id}),{method:'thread/queue/list',params:{threadId:id,cursor:null,limit:100}});
  assert.throws(()=>readRoute('thread/queue/list',params,randomUUID()));
  for(const p of [{threadId:'bad'},null,{...params,limit:0},{...params,limit:201},{...params,limit:1.5},
    {...params,cursor:123},{...params,cursor:'x'.repeat(4097)},{...params,input:[]}])
    assert.throws(()=>hubReadRoute('thread/queue/list',p));
  for(const method of ['thread/queue/add','thread/queue/delete','thread/queue/update','thread/queue/reorder','thread/queue/start'])
    assert.throws(()=>desktopHubRoute(method,params));
});

test('queue reads remain fresh and never fall back to an empty queue on failure',async t=>{
  const connection=new EventEmitter();connection.online=true;connection.close=()=>{};connection.waitUntilReady=async()=>{};
  let version=0,failed=false;
  connection.request=async(method,{method:rpc,params})=>{assert.equal(method,'read');assert.equal(rpc,'thread/queue/list');if(failed)throw Error('GPU unavailable');return{data:[{id:++version}],nextCursor:params.cursor};};
  const hub=new TaskHub({createConnection:()=>connection});t.after(()=>hub.close());const id=randomUUID();
  assert.equal((await hub.read('thread/queue/list',{threadId:id})).data[0].id,1);
  assert.equal((await hub.read('thread/queue/list',{threadId:id})).data[0].id,2);
  failed=true;await assert.rejects(hub.read('thread/queue/list',{threadId:id}),/unavailable/);
});

test('desktop WebSocket queue query traverses the guard while queue execution stays blocked',async()=>{
  const id=randomUUID(),calls=[];
  const server=await startGuardServer({route:desktopHubRoute,read:async(method,params)=>{calls.push({method,params});return{data:[],nextCursor:null}}});
  const ws=new WebSocket(server.url);
  try{
    await once(ws,'open');let next=0;
    async function call(method){const reply=once(ws,'message');ws.send(JSON.stringify({id:++next,method,params:{threadId:id}}));return JSON.parse((await reply)[0]);}
    await call('initialize');calls.length=0;
    assert.deepEqual((await call('thread/queue/list')).result,{data:[],nextCursor:null});
    assert.match((await call('thread/queue/start')).error.message,/denied/);
    assert.equal(calls.length,1);assert.equal(calls[0].params.threadId,id);
  }finally{ws.terminate();await server.close();}
});
