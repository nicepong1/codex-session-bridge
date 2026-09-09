import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {JsonReport,BufferedJsonReport,createEndpointFile,endpointFilePath} from '../src/runtime-files.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'csb-runtime-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('concurrent diagnostic readers only observe complete JSON documents',async t=>{
 const root=fixture(t),file=path.join(root,'report.json'),report=new JsonReport(file);
 report.write({generation:0,text:'old'});
 const reader=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');let reads=0,invalid=0;const timer=setInterval(()=>{try{JSON.parse(fs.readFileSync(workerData,'utf8'));reads++}catch(e){if(e instanceof SyntaxError)invalid++}},0);parentPort.on('message',()=>{clearInterval(timer);parentPort.postMessage({reads,invalid})});parentPort.postMessage('ready')`,{eval:true,workerData:file});
 t.after(()=>reader.terminate());await once(reader,'message');
 for(let i=1;i<=100;i++){report.write({generation:i,text:'x'.repeat(i%2?100000:1)});await new Promise(resolve=>setImmediate(resolve));}
 reader.postMessage('stop');const [result]=await once(reader,'message');
 assert.ok(result.reads>0);assert.equal(result.invalid,0);
 // A Windows reader may briefly block replacement. After it releases the file,
 // the next heartbeat must publish the latest complete state.
 assert.equal(report.write({generation:100,text:'final'}),true);assert.equal(JSON.parse(fs.readFileSync(file)).generation,100);
 assert.deepEqual(fs.readdirSync(root),['report.json']);assert.throws(()=>new JsonReport(file),/EEXIST/);
});
test('sharing violations preserve the previous report and a later write recovers',t=>{
 const root=fixture(t),file=path.join(root,'report.json');let locked=true;
 const report=new JsonReport(file,{rename:(from,to)=>{if(locked)throw Object.assign(Error('reader holds file'),{code:'EBUSY'});fs.renameSync(from,to)}});
 assert.equal(report.write({generation:1}),false);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{});
 assert.deepEqual(fs.readdirSync(root),['report.json']);locked=false;
 assert.equal(report.write({generation:2}),true);assert.equal(JSON.parse(fs.readFileSync(file)).generation,2);
});
test('endpoint cleanup removes only the file this run created and is repeatable',t=>{
 const root=fixture(t),file=path.join(root,'endpoint.json'),remove=createEndpointFile(file,'ws://127.0.0.1/fixture');
 assert.throws(()=>createEndpointFile(file,'other'),/EEXIST/);remove();remove();assert.equal(fs.existsSync(file),false);
 const removeReplaced=createEndpointFile(file,'ws://127.0.0.1/fixture');fs.writeFileSync(file,'replacement');removeReplaced();
 assert.equal(fs.readFileSync(file,'utf8'),'replacement');
});
test('a reused PID does not collide with a leftover endpoint file',t=>{
 const root=fixture(t),old=path.join(root,'codex-gpu-guard-endpoint-1234.json');fs.writeFileSync(old,'old run');
 const first=endpointFilePath(root,1234),next=endpointFilePath(root,1234);assert.notEqual(first,next);
 const remove=createEndpointFile(first,'ws://127.0.0.1/new');remove();assert.equal(fs.readFileSync(old,'utf8'),'old run');
 assert.throws(()=>endpointFilePath(root,-1));
});
test('bursts of 1000 diagnostic updates coalesce and shutdown retries a locked final state',async()=>{
 let writes=0,last,locked=0;
 const report=new BufferedJsonReport('unused',{intervalMs:20,writer:{write(value){writes++;if(locked-->0)return false;last=value;return true}}});
 for(let i=0;i<1000;i++)report.write({generation:i});
 assert.equal(writes,0);await new Promise(resolve=>setTimeout(resolve,45));assert.equal(writes,1);assert.equal(last.generation,999);
 report.write({state:'online'},{immediate:true});assert.equal(last.state,'online');
 locked=2;assert.equal(await report.close({state:'stopped'}),true);assert.equal(last.state,'stopped');
 const count=writes;report.write({state:'late'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(writes,count);
});

test('removing the diagnostic directory cannot crash the timer or prevent shutdown',async t=>{
 const root=fixture(t),directory=path.join(root,'reports');fs.mkdirSync(directory);
 const errors=[],report=new BufferedJsonReport(path.join(directory,'run.json'),{intervalMs:10,onError:e=>errors.push(e.code)});
 report.write({state:'online'});fs.rmSync(directory,{recursive:true});
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.deepEqual(errors,['ENOENT']);assert.equal(report.timer,null);
 report.write({state:'later'},{immediate:true});assert.equal(await report.close({state:'stopped'}),false);
 assert.deepEqual(errors,['ENOENT']);
});
test('a full disk during final diagnostics returns failure without throwing',async()=>{
 const errors=[],report=new BufferedJsonReport('unused',{writer:{write(){throw Object.assign(Error('disk full'),{code:'ENOSPC'})}},onError:e=>errors.push(e.code)});
 assert.equal(await report.close({state:'stopped'}),false);assert.deepEqual(errors,['ENOSPC']);
});
