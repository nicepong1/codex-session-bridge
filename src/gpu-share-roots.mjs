import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectRoot} from './project-write-policy.mjs';
const execute=promisify(execFile);
export async function readGpuShareRoots(names) {
  if(!Array.isArray(names)||!names.length||names.length>26||names.some(n=>typeof n!=='string'||!n||n.length>80||/[\x00-\x1f\\/:*?"<>|]/.test(n)))
    throw new Error('Invalid GPU share query');
  // Do not interpolate request data into PowerShell. Filter the typed result.
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Share | Where-Object { $_.Type -eq 0 } | Select-Object Name,Path) | ConvertTo-Json -Compress";
  const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:8000,maxBuffer:128*1024});
  const parsed=JSON.parse(result.stdout.trim()||'[]');
  const shares=Array.isArray(parsed)?parsed:parsed==null?[]:[parsed];
  if(shares.length>1000||shares.some(s=>!s||typeof s.Name!=='string'||typeof s.Path!=='string')) throw new Error('Invalid GPU shares');
  return shares.filter(s=>names.some(n=>n.toLowerCase()===s.Name?.toLowerCase())).map(s=>({name:s.Name,path:projectRoot(s.Path)}));
}
