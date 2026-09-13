import {validateProfile,profilePaths} from './connection-config.mjs';
export function sshArguments(profile,command,{root,interactive=false}={}){
  const p=validateProfile(profile);
  return ['-F','NUL','-T','-o','BatchMode='+(interactive?'no':'yes'),'-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile="'+profilePaths(p.id,root).knownHosts.replaceAll('\\','/')+'"','-o','GlobalKnownHostsFile=NUL',
    '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',
    ...(p.identityFile?['-o','IdentitiesOnly=yes','-i',p.identityFile]:[]),'-p',String(p.port),'-l',p.username,p.hostname,command];
}
export function remoteNodeCommand(profile,entry,args=[]){
  const p=validateProfile(profile);
  if(!['guarded-gpu-worker.mjs','host-doctor.mjs'].includes(entry)||!Array.isArray(args)||args.some(a=>typeof a!=='string'||!/^[a-zA-Z0-9.-]+$/.test(a)))throw Error('Invalid remote entry point');
  const boot=`import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';let root=${JSON.stringify(p.remoteInstallPath)};if(!root){const h=JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA,'CodexSessionBridge','host.json'),'utf8'));if(h.version!==1||typeof h.installPath!=='string')throw Error('Host installation missing');root=h.installPath;}process.chdir(root);if(JSON.parse(fs.readFileSync('package.json','utf8')).version!=='0.19.1')throw Error('Bridge version mismatch; install the same release on both PCs');process.argv=['node',${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(pathToFileURL(path.resolve('src',${JSON.stringify(entry)})).href);`;
  if(!p.remoteInstallPath||p.remoteInstallPath.includes('%'))throw Error('Resolve a host install path without percent signs before connecting');
  // A direct native process preserves SSH stdin/stdout; PowerShell pipelines can consume stdin.
  const node=p.remoteInstallPath.replaceAll('/', '\\')+'\\runtime\\node.exe';
  return 'cmd.exe /d /v:off /s /c ""'+node+'" --input-type=module -e "import(\'data:text/javascript;base64,'+Buffer.from(boot).toString('base64')+'\')""';

}
