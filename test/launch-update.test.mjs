import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updateAtLaunch,packageUpdateCommand,runPackageUpdate} from '../src/launch-update.mjs';
import {compatibility} from '../src/installed.mjs';
const hash='a'.repeat(64),pointer='b'.repeat(64),version='9.8.7';
const release={version,compatibility:{...compatibility,bridgeVersion:version},compatibilitySha256:hash,asset:{sha256:hash}};
const client={versions:[compatibility.clientAppVersions[0]]};
const host={release:'1.0.0',appVersions:[compatibility.hostAppVersions[0]],cliVersions:[compatibility.hostCliVersions[0]]};
const report={status:'compatible-update-available',canConnect:true,latest:release,client,host};
const prepared={manifestHash:hash,pointerHash:pointer,release:version,installPath:'C:\\fixture\\new'};
const base={profile:{},installationRoot:'C:\\fixture\\old',inspect:async()=>report};
test('a launch makes one metadata check; offline lookup failure keeps the verified current pair',async()=>{
 let calls=0,applied=0;
 const result=await updateAtLaunch({...base,inspect:async()=>{calls++;return {status:'ready',canConnect:true,lookupError:'offline'}},apply:()=>applied++});
 assert.equal(calls,1);assert.equal(applied,0);assert.equal(result.status,'lookup-unavailable');assert.equal(result.installationRoot,base.installationRoot);
});
test('stage both, recheck app versions, activate host then client, return the new installation',async()=>{
 const order=[],phases=[];
 const result=await updateAtLaunch({...base,inspect:async options=>{order.push(options.online===false?'recheck':'check');return report},
  record:r=>phases.push(r.phase),apply:async(mode,role)=>{order.push(mode+role);return prepared}});
 assert.deepEqual(order,['check','PrepareClient','PrepareHost','recheck','ActivateHost','ActivateClient']);
 assert.deepEqual(phases,['checked','preparing','activating','complete']);assert.equal(result.installationRoot,prepared.installPath);
});
test('missing hash, failed download or changed prepared package never activates either PC',async()=>{
 for(const failure of ['digest','prepare','mismatch']){
  const calls=[];
  const result=await updateAtLaunch({...base,inspect:async()=>failure==='digest'?{...report,latest:{...release,asset:null}}:report,
   apply:async(mode,role)=>{calls.push(mode);if(failure==='prepare')throw Error('offline');return {...prepared,manifestHash:role==='Host'?'c'.repeat(64):hash}}});
  assert.equal(result.status,'update-deferred');assert.ok(!calls.includes('Activate'));
 }
});
test('changed official app versions during staging abort activation',async()=>{
 const calls=[];let inspections=0;
 const result=await updateAtLaunch({...base,inspect:async()=>++inspections===1?report:{...report,client:{versions:['99.0.0.0']}},
  apply:async mode=>{calls.push(mode);return prepared}});
 assert.deepEqual(calls,['Prepare','Prepare']);assert.equal(result.status,'update-deferred');
});
test('unknown compatibility and unreachable host block without installing',async()=>{
 for(const status of ['compatibility-validation-required','host-unavailable','bridge-version-mismatch']){
  let calls=0;await assert.rejects(updateAtLaunch({...base,inspect:async()=>({status,canConnect:false}),apply:async()=>calls++}));assert.equal(calls,0);
 }
});
test('uncertain activation never opens an old mismatched pair or replays the action',async()=>{
 for(const failedRole of ['Host','Client']){
  const calls=[],phases=[];
  await assert.rejects(updateAtLaunch({...base,record:r=>phases.push(r.phase),apply:async(mode,role)=>{
   calls.push(mode+role);if(mode==='Activate'&&role===failedRole)throw Error('lost acknowledgement');return prepared;
  }}),/업데이트를 완료하지 못했습니다/);
  assert.equal(calls.filter(x=>x==='Activate'+failedRole).length,1);assert.equal(phases.at(-1),'activation-incomplete');
 }
});
test('unready current pair cannot fall back on a failed preparation',async()=>{
 await assert.rejects(updateAtLaunch({...base,inspect:async()=>({...report,canConnect:false}),apply:async()=>{throw Error('fail')}}));
});
test('a fixed remote installation path is never silently repointed by the updater',async()=>{
 let called=false;
 const options={...base,profile:{remoteInstallPath:'C:\\fixed'},apply:async()=>{called=true}};
 assert.equal((await updateAtLaunch(options)).status,'update-deferred');
 await assert.rejects(updateAtLaunch({...options,inspect:async()=>({...report,canConnect:false})}),/고정/);
 assert.equal(called,false);
});
test('package requests reject injected parameters and keep SSH host-key verification',async()=>{
 for(const bad of [{...release,version:'1.2.3;whoami'},{...release,asset:{sha256:'bad'}},{...release,compatibilitySha256:'*'}]){
  assert.throws(()=>packageUpdateCommand('Prepare','Host',bad));
 }
 assert.throws(()=>packageUpdateCommand('Activate','Client',release,{...prepared,pointerHash:'bad'}));
 const profile={version:1,id:'00000000-0000-4000-8000-000000000001',label:'fixture',hostname:'192.0.2.1',username:'tester',port:22};
 await runPackageUpdate('Prepare','Host',release,null,{profile,run:async(exe,args,opts)=>{
  assert.equal(exe,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('ForwardAgent=no'));
  assert.ok(args.at(-1).length<1000);assert.match(opts.input,/-Mode Prepare -Role Host/);
  return {stdout:'CSB_UPDATE:'+JSON.stringify(prepared)};
 }});
});
test('real PowerShell launcher gate and ZIP/package validation fixtures',{skip:process.platform!=='win32'},()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'csb-update-test-'));
 try{
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('launch-update-fixture.ps1',import.meta.url)),'-FixtureRoot',tmp],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8192});
  assert.match(output,/UPDATE_FIXTURES_OK/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
