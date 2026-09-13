import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {TaskHub} from '../src/task-hub.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {TESTED_APP_VERSION} from '../src/installed.mjs';

const id=randomUUID(), other=randomUUID(), owner=randomUUID();
function snapshot(threadId=id, revision=1181, options={}) {
  return {type:'snapshot',appVersion:TESTED_APP_VERSION,threadId,ownerClientId:owner,revision,
    state:{id:threadId,sessionId:threadId,resumeState:'resumed',threadRuntimeStatus:{type:'idle'},
      turns:[{turnId:'latest-stored-turn',status:'completed',items:[]}]},...options};
}
class Connection extends EventEmitter {
  online=true;calls=[];revision=1181;
  waitUntilReady(){return this.online?Promise.resolve():Promise.reject(Error('offline'));}
  async request(method,params){
    this.calls.push({method,params});
    if(!this.online)throw Error('offline');
    const result=snapshot(params.threadId,this.revision);
    if(['watch','activate'].includes(method)) {this.emit('message',result);return result;}
    return {};
  }
  close(){}
  lose(){this.online=false;this.emit('offline','network lost');}
  restore(){this.online=true;this.emit('state',{status:'online'});}
}
function setup(t,allowActivation=true){
  const connection=new Connection(),hub=new TaskHub({allowActivation,createConnection:()=>connection});
  t.after(()=>hub.close());return {hub,connection};
}

test('network recovery reopens only the viewed task and accepts the same owner fresh revision baseline',async t=>{
  const {hub,connection}=setup(t),selected=await hub.prepare(id),warm=await hub.prepare(other);
  selected.policy.followers.add('notebook');const viewRevision=selected.policy.revision;
  connection.calls=[];connection.lose();connection.revision=4;connection.restore();
  await Promise.all([selected.pending,warm.pending]);
  assert.deepEqual(connection.calls.map(c=>[c.method,c.params.threadId]),[['activate',id],['watch',other]]);
  assert.equal(selected.policy.online,true);assert.equal(selected.blocked,false);
  assert.equal(selected.policy.owner,owner);assert.equal(selected.policy.sourceRevision,4);
  assert.ok(selected.policy.revision>viewRevision);
  assert.equal(selected.policy.state.turns[0].turnId,'latest-stored-turn');
});

test('a lost task owner is reopened by maintenance while a read-only viewer cannot activate',async t=>{
  for(const allowActivation of [true,false]){
    const {hub,connection}=setup(t,allowActivation),task=await hub.prepare(id);
    task.policy.followers.add('notebook');connection.calls=[];
    connection.emit('message',{type:'task-offline',threadId:id});connection.revision=4;
    hub.maintain();await task.pending;
    assert.equal(connection.calls[0].method,allowActivation?'activate':'watch');
    assert.equal(task.policy.online,true);assert.equal(task.blocked,false);
  }
});

test('a lower broadcast cannot reset the baseline, and live observations still reject rollback',()=>{
  const policy=new NativeViewPolicy(id);policy.acceptSnapshot(snapshot());
  assert.throws(()=>policy.acceptSnapshot(snapshot(id,4),{freshObservation:true}),/backwards/);
  policy.disconnect();assert.throws(()=>policy.acceptSnapshot(snapshot(id,4)),/backwards/);
  const loading=snapshot(id,4);loading.state.resumeState='resuming';
  assert.throws(()=>policy.acceptSnapshot(loading,{freshObservation:true}),/backwards/);
  assert.throws(()=>policy.acceptSnapshot(snapshot(id,4,{ownerClientId:randomUUID()}),{freshObservation:true}),/owner/);
  policy.acceptSnapshot(snapshot(id,4),{freshObservation:true});assert.equal(policy.sourceRevision,4);
});

test('a disconnected watch response cannot restore input even after the transport returns',async t=>{
  const {hub,connection}=setup(t),task=await hub.prepare(id);task.policy.followers.add('notebook');
  connection.lose();connection.online=true;
  let resolve;connection.request=()=>new Promise(r=>{resolve=r});
  const pending=hub.prepare(id);await new Promise(r=>setImmediate(r));
  connection.lose();connection.restore();resolve(snapshot(id,4));
  await assert.rejects(pending,/connection changed/);
  assert.equal(task.policy.online,false);assert.equal(task.policy.sourceRevision,1181);
  assert.equal(task.blocked,false);
});

test('a watch response for another task cannot enable either task',async t=>{
  const {hub,connection}=setup(t),task=await hub.prepare(id);task.policy.followers.add('notebook');
  connection.lose();connection.online=true;connection.request=async()=>snapshot(other,4);
  await assert.rejects(hub.prepare(id),/task mismatch/);
  assert.equal(task.policy.online,false);assert.equal(task.policy.sourceRevision,1181);
  assert.equal(hub.tasks.has(other),false);
});

test('losing only the task observation invalidates its in-flight baseline response',async t=>{
  const {hub,connection}=setup(t),task=await hub.prepare(id);
  connection.emit('message',{type:'task-offline',threadId:id});
  let resolve;connection.request=()=>new Promise(r=>{resolve=r});
  const pending=hub.prepare(id);await new Promise(r=>setImmediate(r));
  connection.emit('message',{type:'task-offline',threadId:id});resolve(snapshot(id,4));
  await assert.rejects(pending,/connection changed/);
  assert.equal(task.policy.online,false);assert.equal(task.policy.sourceRevision,1181);
});

test('owner replacement remains blocked during recovery and cannot receive user input',async t=>{
  const {hub,connection}=setup(t),task=await hub.prepare(id);task.policy.followers.add('notebook');
  connection.lose();connection.online=true;
  connection.request=async()=>snapshot(id,4,{ownerClientId:randomUUID()});
  await assert.rejects(hub.prepare(id),/identity/);
  assert.equal(task.blocked,true);assert.equal(task.policy.owner,owner);
  await assert.rejects(hub.submit(id,randomUUID(),'must not send'),/unavailable/);
});
