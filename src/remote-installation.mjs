import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadProfile,validateProfile} from './connection-config.mjs';
import {sshArguments} from './ssh-command.mjs';
const execute=promisify(execFile),resolved=new Map();
export function resolvedProfile(profile=loadProfile()){
 const p=resolved.get(profile.id)??profile;
 if(!p.remoteInstallPath)throw Error('Remote installation has not been resolved. Open the bridge through its launcher.');
 return p;
}
export async function prepareRemoteProfile(profile=loadProfile()){
 if(profile.remoteInstallPath){resolved.set(profile.id,profile);return profile}
 const ps="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$h=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\\host.json') -Raw|ConvertFrom-Json;if($h.version -ne 1 -or $h.release -ne '0.18.1'){throw 'Install the same bridge release on the host'};@{installPath=$h.installPath}|ConvertTo-Json -Compress";
 const command='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(ps,'utf16le').toString('base64');
 const {stdout}=await execute('ssh',sshArguments(profile,command),{windowsHide:true,timeout:20000,maxBuffer:16384});
 const value=JSON.parse(stdout.trim()),p=validateProfile({...profile,remoteInstallPath:value.installPath});
 if(!p.remoteInstallPath)throw Error('Host installation is missing');resolved.set(p.id,p);return p;
}
