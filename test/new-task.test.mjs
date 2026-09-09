import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import{EventEmitter}from'node:events';
import {newTaskParams,firstTaskTurn} from '../src/new-task-policy.mjs';
import {GpuNewTasks} from '../src/gpu-new-task.mjs';
import {TaskHub} from '../src/task-hub.mjs';
import {hubReadRoute} from '../src/guard-policy.mjs';
const cwd='C:\\Projects\\example';
test('new task keeps explicit safety selections but excludes laptop setup and execution',()=>{
 const p=newTaskParams({cwd,model:'example',sandbox:'read-only',approvalPolicy:'on-request',runtimeWorkspaceRoots:['C:\\other'],config:{'mcp_servers.local.command':'bad'},developerInstructions:'local',dynamicTools:[{name:'local'}]});
 assert.equal(p.sandbox,'read-only');assert.equal(p.historyMode,'legacy');assert.equal(p.approvalPolicy,'on-request');
 for(const k of ['config','developerInstructions','dynamicTools','runtimeWorkspaceRoots'])assert.equal(k in p,false);
 for(const bad of [{cwd:'..'},{cwd,ephemeral:true},{cwd,threadSource:'subagent'},{cwd,sandbox:'danger-full-access',permissions:':read-only'}])assert.throws(()=>newTaskParams(bad));
 for(const method of ['thread/start','turn/start'])assert.throws(()=>hubReadRoute(method,{cwd}));
});
test('first input requires stable identity and plain text; excludes attachments and mode changes',()=>{
 const p={threadId:randomUUID(),clientUserMessageId:randomUUID(),input:[{type:'text',text:'hello'}],model:'example',effort:'high'};
 assert.equal(firstTaskTurn(p).text,'hello');
 for(const bad of [{...p,clientUserMessageId:null},{...p,input:[...p.input,{type:'image',url:'x'}]},{...p,toolOutput:{}},{...p,collaborationMode:{mode:'plan',settings:{model:'example',reasoning_effort:'high'}}}])assert.throws(()=>firstTaskTurn(bad));
});
test('GPU creation deduplicates concurrent and restarted requests without merging distinct new chats',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-create-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const projectId=randomUUID();let count=0;
 const options={journalDirectory:directory,stat:async()=>({isDirectory:()=>true}),request:async()=>({data:[{id:projectId,roots:[{path:cwd}]}]}),create:async p=>{count++;return{thread:{id:randomUUID(),cwd:p.cwd,projectId:p.projectId}}}};
 const first=new GpuNewTasks(options),operationId=randomUUID(),params={cwd};
 const [a,b]=await Promise.all([first.handle({operationId,params}),first.handle({operationId,params})]);assert.equal(a.thread.id,b.thread.id);assert.equal(count,1);
 const restarted=new GpuNewTasks(options);assert.equal((await restarted.handle({operationId,params})).thread.id,a.thread.id);assert.equal(count,1);
 await assert.rejects(restarted.handle({operationId,params:{cwd,model:'other'}}));
 const c=await restarted.handle({operationId:randomUUID(),params});assert.notEqual(c.thread.id,a.thread.id);assert.equal(count,2);
 first.claimFirst(a.thread.id,randomUUID());assert.throws(()=>restarted.claimFirst(a.thread.id,randomUUID()));assert.throws(()=>first.claimFirst(randomUUID(),randomUUID()));
});
test('GPU creation validates project root and refuses replay after uncertain creation',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-create-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let calls=0;
 const options={journalDirectory:directory,stat:async()=>({isDirectory:()=>true}),request:async()=>({data:[{id:randomUUID(),roots:[{path:cwd}]}]}),create:async()=>{calls++;throw Error('connection lost')}};
 await assert.rejects(new GpuNewTasks(options).handle({operationId:randomUUID(),params:{cwd:'C:\\laptop-only'}}),/원본 폴더/);assert.equal(calls,0);
 const request={operationId:randomUUID(),params:{cwd}};await assert.rejects(new GpuNewTasks(options).handle(request),/connection lost/);
 await assert.rejects(new GpuNewTasks(options).handle(request),/replay refused/);assert.equal(calls,1);
});
test('read-only hub and unknown task cannot use new first-turn gateway',async t=>{
 const connection=new EventEmitter();connection.online=true;connection.close=()=>{};connection.request=()=>assert.fail('must not send');
 const hub=new TaskHub({createConnection:()=>connection});t.after(()=>hub.close());
 await assert.rejects(hub.read('thread/start',{cwd},{requestKey:'a'}),/unavailable/);
 await assert.rejects(hub.read('turn/start',{threadId:randomUUID()}),/first input/);
});
