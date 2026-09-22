import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {checkUpdates,updateDecision} from './update-status.mjs';
import {loadProfile,dataRoot} from './connection-config.mjs';
import {sshArguments} from './ssh-command.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const script=fs.readFileSync(new URL('update-package.ps1',import.meta.url),'utf8');
const digest=/^[a-f0-9]{64}$/;
export function packageUpdateCommand(mode,role,release,prepared){
 if(!['Prepare','Activate'].includes(mode)||!['Client','Host'].includes(role)||!/^\d+\.\d+\.\d+$/.test(release?.version??'')||
    !digest.test(release.compatibilitySha256??'')||!digest.test(release.asset?.sha256??''))throw Error('Unverified update package');
 const args=['-Mode',mode,'-Role',role,'-Version',release.version,'-ArchiveHash',release.asset.sha256,'-CompatibilityHash',release.compatibilitySha256];
 if(mode==='Activate'){
  if(!digest.test(prepared?.manifestHash??'')||!digest.test(prepared?.pointerHash??''))throw Error('Invalid prepared installation');
  args.push('-ManifestHash',prepared.manifestHash,'-ExpectedPointerHash',prepared.pointerHash);
 }
 // Every interpolated value is an enum, numeric version or SHA256. SSH keeps saved host trust.
 return '& {\n'+script+'\n} '+args.join(' ');
}
function executeInput(exe,args,{input,timeout,maxBuffer}){
 return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',size=0,done=false;
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error)}else resolve({stdout})};
  const timer=setTimeout(()=>finish(Error('Package operation timed out')),timeout);
  child.on('error',()=>finish(Error('Package process unavailable')));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBuffer)finish(Error('Package output exceeded limit'));else stdout+=chunk.toString('utf8')});
  child.stderr.on('data',chunk=>{size+=chunk.length;if(size>maxBuffer)finish(Error('Package output exceeded limit'))});
  child.stdin.on('error',()=>finish(Error('Package input channel closed')));
  child.on('close',code=>finish(code===0?null:Error('Package operation failed')));
  child.stdin.end(input);
 });
}
export async function runPackageUpdate(mode,role,release,prepared,{profile,run=executeInput}={}){
 const input=packageUpdateCommand(mode,role,release,prepared);
 // Keep the Windows SSH command line small; transfer this fixed helper over stdin.
 const encoded=Buffer.from("& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",'utf16le').toString('base64');
 const exe=role==='Host'?'ssh':'powershell.exe';
 const args=role==='Host'?sshArguments(profile,'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+encoded):
  ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded];
 const {stdout}=await run(exe,args,{input,timeout:180000,maxBuffer:65536});
 const result=stdout.split(/\r?\n/).find(line=>line.startsWith('CSB_UPDATE:'));
 if(!result)throw Error('Missing update result');
 const value=JSON.parse(result.slice(11));
 if(value.release!==release.version||typeof value.installPath!=='string')throw Error('Unexpected installed version');
 if(mode==='Prepare'&&(!digest.test(value.manifestHash??'')||!digest.test(value.pointerHash??'')))throw Error('Invalid preparation result');
 return value;
}
export async function updateAtLaunch({inspect=checkUpdates,apply=runPackageUpdate,profile=loadProfile(),installationRoot=root,record=()=>{}}={}){
 const report=await inspect({profile});
 record({...report,phase:'checked'});
 if(report.status!=='compatible-update-available'){
  if(!report.canConnect)throw Error(report.status==='host-unavailable'?
   'GPU에 연결할 수 없습니다. GPU 전원·Codex 로그인·Tailscale 연결을 확인한 후 다시 열어 주세요.':
   '현재 Codex와 호환되는 브리지가 아직 준비되지 않았습니다. 기존 작업은 보존됩니다. Check-Updates.cmd에서 확인해 주세요.');
  return {installationRoot,status:report.lookupError?'lookup-unavailable':'ready'};
 }
 const release=report.latest;let activating=false;
 if(profile.remoteInstallPath){
  record({...report,phase:'fixed-host-path'});
  if(report.canConnect)return {installationRoot,status:'update-deferred'};
  throw Error('연결 설정에 호스트 설치 폴더가 고정되어 있습니다. 양쪽 설치와 해당 경로를 수동으로 맞춘 후 다시 열어 주세요.');
 }
 try{
  if(!release?.asset)throw Error('Published asset digest unavailable');
  record({...report,phase:'preparing'});
  // Stage and verify both before changing either pointer. Never stop the official app or its tasks.
  const client=await apply('Prepare','Client',release,null,{profile});
  const host=await apply('Prepare','Host',release,null,{profile});
  if(client.manifestHash!==host.manifestHash)throw Error('Prepared packages differ');
  const fresh=await inspect({profile,online:false});
  if(!fresh.host||!updateDecision({currentVersion:release.version,currentMatrix:release.compatibility,
   local:fresh.client,host:{...fresh.host,release:release.version}}).canConnect)throw Error('Codex versions changed during update');
  activating=true;record({...report,phase:'activating'});
  await apply('Activate','Host',release,host,{profile});
  const installed=await apply('Activate','Client',release,client,{profile});
  record({...report,phase:'complete',installedVersion:release.version});
  return {installationRoot:installed.installPath,status:'updated',version:release.version};
 }catch{
  record({...report,phase:activating?'activation-incomplete':'preparation-failed'});
  if(!activating&&report.canConnect)return {installationRoot,status:'update-deferred'};
  // If an activation response was lost, do not assume success or revert a newer install.
  // Next launch stages the same verified version again and converges the two pointers.
  throw Error('브리지 업데이트를 완료하지 못했습니다. 창을 다시 열면 양쪽 설치 상태를 다시 확인합니다. 기존 작업과 입력은 보존됩니다.');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const resultAt=process.argv.indexOf('--result'),resultPath=resultAt>=0?process.argv[resultAt+1]:null;
 const directory=path.join(dataRoot(),'updates');fs.mkdirSync(directory,{recursive:true});
 const write=(file,value)=>{const tmp=file+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file)};
 try{
  if(!resultPath)throw Error('Missing launch result path');
  const result=await updateAtLaunch({record:value=>write(path.join(directory,'launch-status.json'),{...value,at:new Date().toISOString()})});
  write(resultPath,{ok:true,...result});
 }catch(error){if(resultPath)write(resultPath,{ok:false,message:error.message});process.exitCode=2}
}
