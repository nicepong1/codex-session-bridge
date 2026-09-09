import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {pendingComputerApproval,computerApprovalFromFollower,verifyComputerApproval,ComputerApprovalJournal,COMPUTER_APPROVAL_METHOD} from '../src/computer-approval.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {TaskHub} from '../src/task-hub.mjs';

function fixture() {
  const id=randomUUID(),owner=randomUUID(),turn=randomUUID();
  const state={id,sessionId:id,turns:[{turnId:turn,status:'inProgress'}],requests:[{id:79,method:'mcpServer/elicitation/request',params:{
    threadId:id,turnId:turn,serverName:'node_repl',mode:'form',message:'private app request',
    requestedSchema:{type:'object',properties:{},additionalProperties:false},
    _meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',persist:['session','always'],tool_params:{app:'private app identifier'}}}}]};
  const policy=new NativeViewPolicy(id);Object.assign(policy,{state,owner,online:true});policy.followers.add('laptop');
  const response={action:'accept',content:{},_meta:{persist:'session'}};
  const message={method:COMPUTER_APPROVAL_METHOD,version:1,sourceClientId:'laptop',params:{conversationId:id,requestId:79,response}};
  const approval=computerApprovalFromFollower(message,policy),session={threadId:id,ownerClientId:owner,state,stale:false,receivedAt:Date.now()};
  return {id,state,policy,message,approval,session};
}

test('app access carries each actual button choice without changing its scope',()=>{
  const {id,state}=fixture(),before=structuredClone(state);
  for (const response of [{action:'accept',content:{},_meta:{persist:'session'}},
    {action:'accept',content:{},_meta:{persist:'always'}},{action:'accept',content:{},_meta:null},
    {action:'decline',content:null,_meta:null},{action:'cancel',content:null,_meta:null}])
    assert.deepEqual(pendingComputerApproval(state,id,79,response).response,response);
  assert.deepEqual(state,before);
  state.requests[0].params._meta.persist=['session'];
  assert.throws(()=>pendingComputerApproval(state,id,79,{action:'accept',content:{},_meta:{persist:'always'}}));
});

test('only the same connected follower and active app request may approve',()=>{
  const {policy,message}=fixture();
  for (const change of [{version:2},{sourceClientId:'other'},{method:'thread-follower-submit-user-input'},
    {params:{...message.params,conversationId:randomUUID()}},{params:{...message.params,requestId:'79'}}])
    assert.throws(()=>computerApprovalFromFollower({...message,...change},policy));
  for(const change of [{preview:true},{online:false},{state:{...policy.state,turns:[]}},
    {state:{...policy.state,requests:[policy.state.requests[0],policy.state.requests[0]]}}])
    assert.throws(()=>computerApprovalFromFollower(message,Object.assign(Object.create(Object.getPrototypeOf(policy)),policy,change)));
});

test('connector authentication, generic forms, unrelated tool calls and response payloads are rejected',()=>{
  const {id,state,approval}=fixture(),p=state.requests[0].params;
  for (const params of [{...p,mode:'url'},{...p,serverName:'codex_apps'},
    {...p,_meta:{...p._meta,codex_approval_kind:'browser_auth'}},
    {...p,_meta:{...p._meta,connector_id:'different-connector'}},
    {...p,_meta:{...p._meta,tool_name:'execute'}},
    {...p,_meta:{...p._meta,tool_params:{app:'example',command:'run'}}},
    {...p,requestedSchema:{type:'object',properties:{password:{type:'string'}}}},
    {...p,requestedSchema:{type:'object',properties:{},additionalProperties:true}}])
    assert.throws(()=>pendingComputerApproval({...state,requests:[{...state.requests[0],params}]},id,79,approval.response));
  for(const response of [{action:'accept',content:{password:'never forwarded'}},
    {action:'accept',content:{},_meta:{persist:'always',other:'never forwarded'}},
    {action:'accept',content:{},_meta:{persist:'all'}},
    {action:'decline',content:null,_meta:{persist:'always'}},
    {action:'accept',content:{},extra:true},{action:'accept',content:[]},
    {action:'approve',content:{}},{action:'decline',content:{}}])
    assert.throws(()=>pendingComputerApproval(state,id,79,response));
});

test('GPU verification binds owner, turn, complete request hash and a fresh snapshot',()=>{
  const {session,approval}=fixture();assert.deepEqual(verifyComputerApproval(session,approval).response,approval.response);
  for(const changes of [{ownerClientId:randomUUID()},{threadId:randomUUID()},{stale:true},{receivedAt:NaN},
    {receivedAt:Date.now()-6000},{state:{...session.state,requests:[]}},
    {state:{...session.state,turns:[{turnId:approval.turnId,status:'completed'}]}}])
    assert.throws(()=>verifyComputerApproval({...session,...changes},approval));
  session.state.requests[0].params._meta.tool_params.app='a different app';
  assert.throws(()=>verifyComputerApproval(session,approval),/변경/);
});

test('durable app choice deduplicates across restarts and never saves app/request content',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-computer-test-'));t.after(()=>fs.rmSync(folder,{recursive:true}));
  const {approval}=fixture();let calls=0;
  const journal=new ComputerApprovalJournal(folder),send=async()=>{calls++;return{ok:true}};
  await Promise.all([journal.run(approval,send),journal.run(structuredClone(approval),send)]);
  await new ComputerApprovalJournal(folder).run(approval,send);assert.equal(calls,1);
  await assert.rejects(journal.run({...approval,response:{action:'accept',content:{},_meta:{persist:'always'}}},send));
  const saved=fs.readdirSync(folder).map(file=>fs.readFileSync(path.join(folder,file),'utf8')).join('');
  assert.doesNotMatch(saved,/private app|tool_params|requestedSchema|message/);
});

test('uncertain app approval cannot be replayed even after a restart',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-computer-test-'));t.after(()=>fs.rmSync(folder,{recursive:true}));
  const {approval}=fixture();let calls=0;const send=async()=>{calls++;throw Error('lost acknowledgment')};
  const journal=new ComputerApprovalJournal(folder);
  await assert.rejects(journal.run(approval,send));await assert.rejects(journal.run(approval,send));
  await assert.rejects(new ComputerApprovalJournal(folder).run(approval,send),/불확실/);assert.equal(calls,1);
});

test('hub app approvals are explicit, separate from shell permission and never queued offline',async t=>{
  const {id,policy,message}=fixture(),connection=new EventEmitter(),calls=[];
  connection.online=true;connection.close=()=>{};connection.request=async(method,params)=>{calls.push({method,params});return{ok:true}};
  const hub=new TaskHub({createConnection:()=>connection,allowComputerApprovals:true});t.after(()=>hub.close());hub.task(id).policy=policy;
  assert.equal(calls.length,0);
  await Promise.all([hub.approveComputer(message),hub.approveComputer(message)]);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'computerApproval');
  assert.deepEqual(calls[0].params.response,message.params.response);
  await assert.rejects(hub.approveCommand(message));
  connection.online=false;await assert.rejects(hub.approveComputer(message));
  connection.online=true;hub.allowComputerApprovals=false;await assert.rejects(hub.approveComputer(message));
  assert.equal(calls.length,1);
});
