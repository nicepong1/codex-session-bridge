import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActivation} from '../src/task-activation.mjs';
import {interactiveOpenScript} from '../src/interactive-task-open.mjs';
import {GPU_THREAD, desktopHubRoute, hubReadRoute} from '../src/guard-policy.mjs';
const other='00000000-0000-4000-8000-000000000016';
function fake(overrides={}) {
  const openCalls=[], live=new Set();
  const activation=new TaskActivation({readThread:async id=>({thread:{id}}), observe:async id=>{
    if(!live.has(id)) throw new Error('no-client-found'); return {id,owner:'official-gpu-owner'};
  },openTask:async id=>{openCalls.push(id); live.add(id);},...overrides});
  return {activation,openCalls,live};
}
test('opening an already loaded GPU task leaves its existing owner untouched', async()=>{
  const {activation,openCalls,live}=fake();live.add(GPU_THREAD);
  assert.equal((await activation.activate(GPU_THREAD)).owner,'official-gpu-owner'); assert.equal(openCalls.length,0);
});
test('concurrent opens of one stored task navigate once without creating a turn', async()=>{
  const {activation,openCalls}=fake();
  const [a,b]=await Promise.all([activation.activate(GPU_THREAD),activation.activate(GPU_THREAD)]);
  assert.equal(a,b);assert.deepEqual(openCalls,[GPU_THREAD]);
});
test('missing, mismatched and temporary tasks cannot activate the desktop', async()=>{
  for(const thread of [null,{id:other},{id:GPU_THREAD,ephemeral:true}]) {
    const {activation,openCalls}=fake({readThread:async()=>({thread})});
    await assert.rejects(activation.activate(GPU_THREAD),/existing stored/);assert.equal(openCalls.length,0);
  }
});
test('a transport or owner error is not treated as permission to reopen a task', async()=>{
  const {activation,openCalls}=fake({observe:async()=>{throw new Error('owner identity invalid');}});
  await assert.rejects(activation.activate(GPU_THREAD),/identity invalid/);assert.equal(openCalls.length,0);
});
test('desktop openings are serialized and a stopped connection cannot open queued tasks', async()=>{
  let release,closed=false;const calls=[];
  const {activation,live}=fake({isClosed:()=>closed,openTask:async id=>{
    calls.push(id);await new Promise(resolve=>{release=resolve;});live.add(id);
  }});
  const first=activation.activate(GPU_THREAD), next=activation.activate(other);
  const results=Promise.allSettled([first,next]);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[GPU_THREAD]);
  closed=true;release();const settled=await results;
  assert.equal(settled[0].status,'rejected');assert.equal(settled[1].status,'rejected');assert.deepEqual(calls,[GPU_THREAD]);
});
test('failed navigation is not automatically repeated on an immediate retry',async()=>{
  let opens=0;const {activation}=fake({openTask:async()=>{opens++;throw new Error('activation failed');}});
  await assert.rejects(activation.activate(GPU_THREAD),/activation failed/);
  await assert.rejects(activation.activate(GPU_THREAD),/recently failed/);assert.equal(opens,1);
});
test('desktop task opening cannot forward arbitrary paths, history, commands or settings to execution',()=>{
  assert.equal(desktopHubRoute('thread/resume',{threadId:GPU_THREAD,cwd:'C:\\notebook',config:{x:1}}).threadId,GPU_THREAD);
  assert.throws(()=>hubReadRoute('thread/resume',{threadId:GPU_THREAD}));
  for(const field of ['path','history']) assert.deepEqual(desktopHubRoute('thread/resume',{threadId:GPU_THREAD,[field]:'injected'}),{activation:true,threadId:GPU_THREAD});
  for(const method of ['thread/start','turn/start','command/exec','config/batchWrite']) assert.throws(()=>desktopHubRoute(method,{}));
  assert.throws(()=>interactiveOpenScript("'; Start-Process malicious; '"));
});
