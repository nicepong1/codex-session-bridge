import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const compatibility=JSON.parse(fs.readFileSync(new URL('../compatibility.json',import.meta.url),'utf8'));
export const TESTED_APP_VERSION = compatibility.hostAppVersions[0];
export function desktopFromPaths(paths,role='client'){
  if(!['client','host'].includes(role))throw Error('Invalid computer role');
  const list=[...new Set((Array.isArray(paths)?paths:paths?[paths]:[]).filter(p=>typeof p==='string'&&/OpenAI\.Codex_[\d.]+_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$/i.test(p)))];
  const versions=[...new Set(list.map(p=>p.match(/OpenAI\.Codex_([\d.]+)_/i)[1]))];
  return {found:list.length>0,paths:list,executable:list.length===1?list[0]:null,versions,
    testedBuild:list.length===1&&compatibility[role+'AppVersions'].includes(versions[0])};
}

export function installedDesktop(role='client') {
  if (process.platform !== 'win32' || process.arch !== 'x64') return { found: false, testedBuild:false, error: 'Windows x64 only' };
  // Fixed read-only query. No user input or credentials are interpolated.
  const script = "$ErrorActionPreference='Stop'; @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ -match 'OpenAI\\.Codex_' } | Select-Object -Unique) | ConvertTo-Json -Compress";
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, encoding: 'utf8', maxBuffer: 64 * 1024 });
    const paths = output.trim() ? JSON.parse(output) : [];
    const running=desktopFromPaths(paths,role);
    if(running.found||role==='host')return running;
    const discover="$ErrorActionPreference='Stop';@(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object {Join-Path $_.InstallLocation 'app\\ChatGPT.exe'} | Where-Object {Test-Path -LiteralPath $_})|ConvertTo-Json -Compress";
    const packages=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',discover],{windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:65536});
    return desktopFromPaths(JSON.parse(packages.trim()||'[]'),role);
  } catch { return { found: false, error: 'Desktop package could not be identified in this process context' }; }
}
export function discoverCli({root=path.join(process.env.LOCALAPPDATA||'','OpenAI','Codex','bin'),execute=execFileSync}={}){
  const candidates=fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(root,e.name,'codex.exe')).filter(p=>fs.existsSync(p)):[];
  candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  for(const executable of candidates){try{const version=execute(executable,['--version'],{windowsHide:true,timeout:8000,encoding:'utf8',maxBuffer:4096}).trim();if(compatibility.hostCliVersions.includes(version))return {executable,version}}catch{}}
  throw Error('Compatible official Codex CLI cache not found. Open the host Codex app and check docs/COMPATIBILITY.md.');
}

export const supportedHostVersion=version=>compatibility.hostAppVersions.includes(version);
