import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {pendingPermissionsApproval,permissionsApprovalFromFollower,verifyPermissionsApproval,PermissionsApprovalJournal,PERMISSIONS_APPROVAL_METHOD} from '../src/permissions-approval.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {TaskHub} from '../src/task-hub.mjs';

function fixture() {
  const id=randomUUID(),owner=randomUUID(),turn=randomUUID();
  const permissions={network:{enabled:true},fileSystem:{read:['C:\\example\\npm'],write:null,
    entries:[{path:{type:'path',path:'C:\\example\\npm'},access:'read'}]}};
  const state={id,sessionId:id,turns:[{turnId:turn,status:'inProgress'}],requests:[{id:76,method:'item/permissions/requestApproval',params:{
    threadId:id,turnId:turn,itemId:'exec-example',cwd:'C:\\project',environmentId:'local',startedAtMs:Date.now(),permissions,reason:'private reason'}}]};
  const policy=new NativeViewPolicy(id);Object.assign(policy,{state,owner,online:true});policy.followers.add('laptop');
  const response={permissions:structuredClone(permissions),scope:'turn'};
  const message={method:PERMISSIONS_APPROVAL_METHOD,version:1,sourceClientId:'laptop',params:{conversationId:id,requestId:76,response}};
  const approval=permissionsApprovalFromFollower(message,policy),session={threadId:id,ownerClientId:owner,state,stale:false,receivedAt:Date.now()};
  return {id,permissions,state,policy,message,approval,session};
}

test('permission buttons preserve exact requested groups and selected scope, including denial',()=>{
  const {id,state,permissions}=fixture(),before=structuredClone(state);
  for(const response of [{permissions,scope:'turn'},{permissions,scope:'session'},
    {permissions:{},scope:'turn'},{permissions:{network:permissions.network},scope:'turn'},
    {permissions:{fileSystem:permissions.fileSystem},scope:'turn',strictAutoReview:true},
    {permissions:{network:null,fileSystem:null}}])
    assert.deepEqual(pendingPermissionsApproval(state,id,76,response).response,response);
  assert.deepEqual(state,before);
});

test('permission grants reject widened paths, network, access, unknown fields and invalid scopes',()=>{
  const {id,state,permissions}=fixture();
  for(const response of [{permissions,scope:'always'},{permissions:null},{permissions:[]},
    {permissions,scope:null},{permissions,strictAutoReview:'no'},{permissions,unexpected:true},
    {permissions:{sandbox:'all'}},{permissions:{network:{enabled:true,domains:['example.com']}}},
    {permissions:{fileSystem:{read:['C:\\']}}},
    {permissions:{fileSystem:{...permissions.fileSystem,write:permissions.fileSystem.read}}},
    {permissions:{fileSystem:{...permissions.fileSystem,entries:[{path:{type:'path',path:'C:\\example\\npm'},access:'write'}]}}}])
    assert.throws(()=>pendingPermissionsApproval(state,id,76,response));
  state.requests[0].params.permissions={fileSystem:permissions.fileSystem};
  assert.throws(()=>pendingPermissionsApproval(state,id,76,{permissions:{network:{enabled:true}}}));
});

test('dropping nested deny entries cannot widen a permission group',()=>{
  const {id,state,permissions}=fixture();
  permissions.fileSystem.entries.push({path:{type:'path',path:'C:\\example\\npm\\private'},access:'deny'});
  const granted=structuredClone(permissions);granted.fileSystem.entries.pop();
  assert.throws(()=>pendingPermissionsApproval(state,id,76,{permissions:granted,scope:'turn'}));
});

test('only an authenticated follower of the same live pending permission request may respond',()=>{
  const {policy,message}=fixture();
  for(const change of [{version:2},{sourceClientId:'other'},{method:'thread-follower-command-approval-decision'},
    {params:{...message.params,conversationId:randomUUID()}},{params:{...message.params,requestId:'76'}}])
    assert.throws(()=>permissionsApprovalFromFollower({...message,...change},policy));
  for(const change of [{online:false},{preview:true},{state:{...policy.state,requests:[]}},
    {state:{...policy.state,requests:[policy.state.requests[0],policy.state.requests[0]]}},
    {state:{...policy.state,turns:[]}}])
    assert.throws(()=>permissionsApprovalFromFollower(message,Object.assign(Object.create(Object.getPrototypeOf(policy)),policy,change)));
});

test('GPU permission validation binds complete request, owner, turn and fresh state',()=>{
  const {session,approval}=fixture();assert.deepEqual(verifyPermissionsApproval(session,approval).response,approval.response);
  for(const change of [{ownerClientId:randomUUID()},{threadId:randomUUID()},{stale:true},
    {receivedAt:NaN},{receivedAt:Date.now()-6000},{receivedAt:Date.now()+5000}])
    assert.throws(()=>verifyPermissionsApproval({...session,...change},approval));
  session.state.requests[0].params.reason='changed request';
  assert.throws(()=>verifyPermissionsApproval(session,approval),/변경/);
});

test('permission journal deduplicates choices across restart without persisting requested paths or reasons',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-permissions-test-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  const {approval}=fixture();let calls=0;const send=async()=>{calls++;return{ok:true}};
  const journal=new PermissionsApprovalJournal(directory);
  await Promise.all([journal.run(approval,send),journal.run(structuredClone(approval),send)]);
  await new PermissionsApprovalJournal(directory).run(approval,send);assert.equal(calls,1);
  await assert.rejects(journal.run({...approval,response:{...approval.response,scope:'session'}},send));
  const saved=fs.readdirSync(directory).map(file=>fs.readFileSync(path.join(directory,file),'utf8')).join('');
  assert.doesNotMatch(saved,/private reason|npm|fileSystem|permissions|network/);
});

test('uncertain permission decisions are never sent again, including after restart',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-permissions-test-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  const {approval}=fixture();let calls=0;const send=async()=>{calls++;throw Error('connection lost')};
  const journal=new PermissionsApprovalJournal(directory);
  await assert.rejects(journal.run(approval,send));await assert.rejects(journal.run(approval,send));
  await assert.rejects(new PermissionsApprovalJournal(directory).run(approval,send),/불확실/);assert.equal(calls,1);
});

test('hub permission forwarding is explicit, gated, and never queued while offline',async t=>{
  const {id,policy,message}=fixture(),connection=new EventEmitter(),calls=[];
  connection.online=true;connection.close=()=>{};connection.request=async(method,params)=>{calls.push({method,params});return{ok:true}};
  const hub=new TaskHub({createConnection:()=>connection,allowPermissionsApprovals:true});t.after(()=>hub.close());hub.task(id).policy=policy;
  assert.equal(calls.length,0);await Promise.all([hub.approvePermissions(message),hub.approvePermissions(message)]);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'permissionsApproval');assert.deepEqual(calls[0].params.response,message.params.response);
  connection.online=false;await assert.rejects(hub.approvePermissions(message));
  connection.online=true;hub.allowPermissionsApprovals=false;await assert.rejects(hub.approvePermissions(message));
  assert.equal(calls.length,1);
});
