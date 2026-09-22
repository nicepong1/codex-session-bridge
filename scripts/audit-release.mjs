import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const stageAt=process.argv.indexOf('--stage'),staged=stageAt>=0;
const root=staged?path.resolve(process.argv[stageAt+1]):fileURLToPath(new URL('..',import.meta.url));
const roots=new Set(['src','diagnostics','docs','test','assets','scripts','.github']);
const top=new Set(['.gitignore','package.json','package-lock.json','README.md','LICENSE','THIRD-PARTY-NOTICES.md','compatibility.json','Install.cmd','Install.ps1','Open-Bridge.ps1','Configure.cmd','Diagnose.cmd','Check-Updates.cmd','Show-HostInfo.cmd','Show-HostInfo.ps1','Uninstall.ps1','Build-Guard.ps1','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','release-files.json']);
const allowedDiagnostics=new Set(['observe-session.mjs','drop-ack-proxy.mjs','fake-desktop.mjs']);
const errors=[];let count=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/'),first=relative.split('/')[0];
 if(!staged&&['.git','node_modules','dist','bin','runtime'].includes(first))continue;
 if(entry.isSymbolicLink()){errors.push('Linked file: '+relative);continue}
 if(entry.isDirectory()){
  if(!roots.has(first)&&!(staged&&['bin','runtime','node_modules'].includes(first))){errors.push('Unexpected directory: '+relative);continue}
  if(/(?:^|\/)(?:reports|checkpoints|\.research|codex-home|user-data|\.ssh)(?:\/|$)/.test(relative)){errors.push('Private directory: '+relative);continue}
  walk(file);continue;
 }
 if(!relative.includes('/')&&!top.has(relative))errors.push('Unexpected root file: '+relative);
 if(first==='diagnostics'&&!allowedDiagnostics.has(entry.name))errors.push('Unapproved diagnostic: '+relative);
 if(staged&&first==='node_modules'&&!relative.startsWith('node_modules/ws/'))errors.push('Unexpected dependency: '+relative);
 if(staged&&first==='runtime'&&!['runtime/node.exe','runtime/NODE-LICENSE.txt'].includes(relative))errors.push('Unexpected runtime: '+relative);
 if(staged&&first==='bin'&&relative!=='bin/codex-gpu-guard.exe')errors.push('Unexpected binary: '+relative);
 if(/(?:\.mjs|\.js|\.md|\.ps1|\.json|\.yml|\.cs|\.cmd)$/.test(relative)&&!relative.startsWith('node_modules/')){
  const text=fs.readFileSync(file,'utf8');
  const secrets=[/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/,/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}/,/\bsk-[A-Za-z0-9_-]{32,}/];
  if(secrets.some(rx=>rx.test(text)))errors.push('Possible secret: '+relative);
  // Historical account/device strings and real task IDs must never enter the public source.
  if(relative!=='scripts/audit-release.mjs'&&/01a0[0-9a-f]{4}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text))errors.push('Historical task identifier: '+relative);
 }
 count++;
}}
walk(root);
if(errors.length){console.error(errors.join('\n'));process.exitCode=2}else console.log(JSON.stringify({audit:'passed',files:count,scope:staged?'distribution':'source'}));
