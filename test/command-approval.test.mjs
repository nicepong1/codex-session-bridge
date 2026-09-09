import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {pendingCommand, commandApprovalFromFollower, verifyCommandApproval, CommandApprovalJournal, COMMAND_APPROVAL_METHOD} from '../src/command-approval.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {TaskHub} from '../src/task-hub.mjs';

function fixture() {
  const id=randomUUID(), owner=randomUUID(), turn=randomUUID();
  const state={id,sessionId:id,turns:[{turnId:turn,status:'inProgress'}],requests:[{id:76,method:'item/commandExecution/requestApproval',
    params:{threadId:id,turnId:turn,itemId:'exec-example',command:'Get-Content AGENTS.md',cwd:'C:\\project',availableDecisions:['accept','cancel']}}]};
  const policy=new NativeViewPolicy(id);policy.state=state;policy.owner=owner;policy.online=true;policy.followers.add('laptop');
  const message={method:COMMAND_APPROVAL_METHOD,version:1,sourceClientId:'laptop',params:{conversationId:id,requestId:76,decision:'accept'}};
  const approval=commandApprovalFromFollower(message,policy);
  const session={threadId:id,ownerClientId:owner,state,stale:false,receivedAt:Date.now()};
  return {id,policy,message,approval,session};
}

test('approval only accepts the connected follower and exact active command request',()=>{
  const {id,policy,message}=fixture(), before=structuredClone(policy.state);
  assert.equal(commandApprovalFromFollower(message,policy).requestId,76);
  assert.equal(pendingCommand(policy.state,id,76,'cancel').decision,'cancel');
  for(const change of [{version:2},{sourceClientId:'other'},{method:'thread-follower-file-approval-decision'},
    {params:{...message.params,conversationId:randomUUID()}},{params:{...message.params,requestId:'76'}},
    {params:{...message.params,decision:'acceptForSession'}},
    {params:{...message.params,decision:{acceptWithExecpolicyAmendment:{execpolicy_amendment:['Get-Content']}}}}])
    assert.throws(()=>commandApprovalFromFollower({...message,...change},policy));
  assert.deepEqual(policy.state,before);
  policy.state.requests[0].method='item/fileChange/requestApproval';assert.throws(()=>commandApprovalFromFollower(message,policy));
});

test('fresh GPU validation rejects changed owner, command, turn, missing request and stale snapshots',()=>{
  const {session,approval}=fixture();assert.equal(verifyCommandApproval(session,approval).decision,'accept');
  for(const change of [{ownerClientId:randomUUID()},{stale:true},{receivedAt:Date.now()-6000},
    {receivedAt:NaN},{receivedAt:Infinity},{receivedAt:undefined},{receivedAt:Date.now()+60000},
    {state:{...session.state,requests:[]}},{state:{...session.state,turns:[]}}])
    assert.throws(()=>verifyCommandApproval({...session,...change},approval));
  session.state.requests[0].params.command='different command';assert.throws(()=>verifyCommandApproval(session,approval),/변경/);
});

test('the user may select the exact proposed rule; altered rules and implicit upgrades are refused',async t=>{
  const {id,policy,message}=fixture(), params=policy.state.requests[0].params;
  const decision={acceptWithExecpolicyAmendment:{execpolicy_amendment:['Get-Content','-LiteralPath','WORKFLOW.md']}};
  params.proposedExecpolicyAmendment=decision.acceptWithExecpolicyAmendment.execpolicy_amendment;
  params.availableDecisions.push(decision,'acceptForSession');
  const approval=commandApprovalFromFollower({...message,params:{...message.params,decision}},policy);
  assert.deepEqual(approval.decision,decision);
  assert.equal(commandApprovalFromFollower(message,policy).decision,'accept');
  assert.equal(pendingCommand(policy.state,id,76,'acceptForSession').decision,'acceptForSession');
  assert.throws(()=>pendingCommand(policy.state,id,76,{acceptWithExecpolicyAmendment:{execpolicy_amendment:['Get-Content']}}));
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-approval-test-'));t.after(()=>fs.rmSync(folder,{recursive:true}));
  let calls=0;const send=async()=>{calls++;return{ok:true}},journal=new CommandApprovalJournal(folder);
  await journal.run(approval,send);await journal.run(structuredClone(approval),send);
  await new CommandApprovalJournal(folder).run(structuredClone(approval),send);assert.equal(calls,1);
});

test('approval journal deduplicates simultaneous clicks, survives restart, and rejects a changed decision',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-approval-test-'));t.after(()=>fs.rmSync(folder,{recursive:true}));
  const {approval}=fixture(), journal=new CommandApprovalJournal(folder);let calls=0;
  const send=async()=>{calls++;return{ok:true}};
  await Promise.all([journal.run(approval,send),journal.run(approval,send)]);
  await new CommandApprovalJournal(folder).run(approval,send);assert.equal(calls,1);
  await assert.rejects(journal.run({...approval,decision:'cancel'},send));assert.equal(calls,1);
});

test('an uncertain approval is never dispatched again, including after restart',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-approval-test-'));t.after(()=>fs.rmSync(folder,{recursive:true}));
  const {approval}=fixture();let calls=0;const send=async()=>{calls++;throw Error('connection lost')};
  const journal=new CommandApprovalJournal(folder);
  await assert.rejects(journal.run(approval,send));await assert.rejects(journal.run(approval,send));
  await assert.rejects(new CommandApprovalJournal(folder).run(approval,send),/불확실/);assert.equal(calls,1);
});

test('hub forwards only explicit clicks, deduplicates them, and has no offline queue',async t=>{
  const {id,policy,message}=fixture(), connection=new EventEmitter(), calls=[];
  connection.online=true;connection.close=()=>{};connection.request=async(method,params)=>{calls.push({method,params});return{ok:true}};
  const hub=new TaskHub({createConnection:()=>connection,allowCommandApprovals:true});t.after(()=>hub.close());
  hub.task(id).policy=policy;
  await Promise.all([hub.approveCommand(message),hub.approveCommand(message)]);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'commandApproval');assert.equal(calls[0].params.decision,'accept');
  connection.online=false;await assert.rejects(hub.approveCommand(message),/연결/);
  connection.online=true;hub.allowCommandApprovals=false;await assert.rejects(hub.approveCommand(message),/비활성화/);assert.equal(calls.length,1);
});
