import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {loadProfile,dataRoot} from './connection-config.mjs';
import {sshArguments} from './ssh-command.mjs';
import {installedDesktop,compatibility,BRIDGE_VERSION} from './installed.mjs';

const execute=promisify(execFile);
export const RELEASE_REPOSITORY='nicepong1/codex-session-bridge';
export const RELEASES_URL=`https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
const VERSION=/^\d+\.\d+\.\d+$/;
const APP_VERSION=/^\d+\.\d+\.\d+\.\d+$/;
export function newerVersion(candidate,current){
 if(!VERSION.test(candidate??'')||!VERSION.test(current??''))return false;
 const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
 for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;
}
export function validateReleaseCompatibility(value,version){
 if(!value||value.schemaVersion!==1||value.bridgeVersion!==version||!VERSION.test(version??'')||
    value.platform!=='win32'||value.architecture!=='x64'||value.unknownVersionPolicy!=='block')throw Error('Invalid release compatibility metadata');
 for(const key of ['clientAppVersions','hostAppVersions'])
  if(!Array.isArray(value[key])||!value[key].length||value[key].length>200||!value[key].every(x=>typeof x==='string'&&APP_VERSION.test(x)))throw Error('Invalid application versions');
 if(!Array.isArray(value.hostCliVersions)||!value.hostCliVersions.length||value.hostCliVersions.length>200||!value.hostCliVersions.every(v=>typeof v==='string'&&/^codex-cli [\d.a-z+-]{1,80}$/i.test(v)))throw Error('Invalid CLI versions');
 return value;
}
function supports(matrix,local,host){
 return local?.versions?.length===1&&matrix.clientAppVersions.includes(local.versions[0])&&
  host?.appVersions?.length===1&&matrix.hostAppVersions.includes(host.appVersions[0])&&
  Array.isArray(host.cliVersions)&&host.cliVersions.some(v=>matrix.hostCliVersions.includes(v));
}
export function updateDecision({currentVersion,local,host,currentMatrix=compatibility,latest}){
 if(!host)return {status:'host-unavailable',canConnect:false,action:'check-host-connection'};
 const ready=host.release===currentVersion&&supports(currentMatrix,local,host);
 if(latest&&newerVersion(latest.version,currentVersion)&&supports(latest.compatibility,local,host))
  return {status:'compatible-update-available',canConnect:ready,action:'prepare-both-pcs',targetVersion:latest.version,releaseUrl:latest.url};
 if(ready)return {status:'ready',canConnect:true,action:'none'};
 const mismatch=host.release!==currentVersion;
 return {status:mismatch?'bridge-version-mismatch':'compatibility-validation-required',canConnect:false,
  action:mismatch?'align-both-pcs':'validate-new-app',releaseUrl:RELEASES_URL};
}
async function json(url,{fetcher=fetch,limit=128*1024}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetcher(url,{signal:controller.signal,redirect:'error',headers:{Accept:'application/vnd.github+json','User-Agent':'codex-session-bridge-update-check'}});
  if(!response.ok)throw Error('Release lookup HTTP '+response.status);
  if(Number(response.headers.get('content-length'))>limit)throw Error('Release metadata too large');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Release metadata too large');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }finally{clearTimeout(timer)}
}
export async function latestPublishedRelease({fetcher=fetch}={}){
 const value=await json(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,{fetcher});
 if(value.draft||value.prerelease||!/^v\d+\.\d+\.\d+$/.test(value.tag_name??''))throw Error('Invalid published release');
 const version=value.tag_name.slice(1),url=`https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
 if(value.html_url!==url)throw Error('Unexpected release origin');
 // Metadata only. Never execute scripts or install assets returned by this query.
 const matrix=await json(`https://raw.githubusercontent.com/${RELEASE_REPOSITORY}/v${version}/compatibility.json`,{fetcher});
 return {version,url,compatibility:validateReleaseCompatibility(matrix,version)};
}
export async function readHostVersions(profile,{run=execute}={}){
 const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$h=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\\host.json') -Raw|ConvertFrom-Json;$v=@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue|ForEach-Object{try{if($_.Path -match 'OpenAI\\.Codex_([\\d.]+)_'){$Matches[1]}}catch{}}|Select-Object -Unique);$installed=@(Get-AppxPackage -Name OpenAI.Codex|ForEach-Object{$_.Version.ToString()});$c=@(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\bin') -Directory|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 8|ForEach-Object{$p=Join-Path $_.FullName 'codex.exe';if(Test-Path -LiteralPath $p){(& $p --version)}});@{release=$h.release;appVersions=$v;installedAppVersions=$installed;cliVersions=$c}|ConvertTo-Json -Compress";
 const command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(script,'utf16le').toString('base64');
 const {stdout}=await run('ssh',sshArguments(profile,command),{windowsHide:true,timeout:30000,maxBuffer:16384});
 const host=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
 if(!VERSION.test(host.release??'')||!Array.isArray(host.appVersions)||!host.appVersions.every(v=>APP_VERSION.test(v))||
    !Array.isArray(host.cliVersions)||host.cliVersions.some(v=>typeof v!=='string'||v.length>100))throw Error('Invalid host version inventory');
 return host;
}
export async function checkUpdates({profile=loadProfile(),online=true}={}){
 const report={checkedAt:new Date().toISOString(),bridgeVersion:BRIDGE_VERSION,client:{versions:installedDesktop('client').versions??[]},host:null,latest:null,lookupError:null};
 const [host,latest]=await Promise.allSettled([readHostVersions(profile),online?latestPublishedRelease():Promise.resolve(null)]);
 if(host.status==='fulfilled')report.host=host.value;else report.hostError='GPU version query unavailable; check Tailscale and SSH';
 if(latest.status==='fulfilled')report.latest=latest.value;else report.lookupError='Release lookup unavailable; installed compatibility checks still apply';
 return {...report,...updateDecision({currentVersion:BRIDGE_VERSION,local:report.client,host:report.host,latest:report.latest})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const report=await checkUpdates({online:!process.argv.includes('--offline')});
  const directory=path.join(dataRoot(),'updates');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'status.json'),tmp=file+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,file);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.canConnect?0:2;
 }catch{console.error('Update check unavailable. Verify the saved connection with Configure.cmd.');process.exitCode=2}
}
