import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectRoot} from './project-write-policy.mjs';

import {loadProfile} from './connection-config.mjs';
const execute = promisify(execFile);
export function decodeMappedDrives(text) {
  const parsed=JSON.parse(text.trim()||'[]');
  // Windows PowerShell 5.1 unwraps a one-row pipeline even when @() was used.
  const rows=Array.isArray(parsed)?parsed:parsed==null?[]:[parsed];
  if(rows.length>26||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)||
      typeof r.DeviceID!=='string'||typeof r.ProviderName!=='string')) throw new Error('네트워크 드라이브 정보를 확인하지 못했습니다');
  return rows;
}
export async function readGpuMappedDrives() {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | Select-Object DeviceID,ProviderName) | ConvertTo-Json -Compress";
  const result = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:8000,maxBuffer:128*1024});
  return decodeMappedDrives(result.stdout);
}

// Resolve the laptop drive -> authenticated GPU SMB share -> GPU local path.
// Never infer a drive letter or a same-named folder on another machine.
export class GpuPathMapper {
  constructor({readDrives=readGpuMappedDrives, readShares, now=Date.now, onResolved=()=>{}, hostname=loadProfile().hostname}) {
    Object.assign(this,{readDrives,readShares,now,onResolved,hostname});this.expires=0;this.pending=null;this.mappings=[];this.foreignDrives=new Set();
  }
  async refresh(fresh=false) {
    if (this.pending) return this.pending;
    if (!fresh && this.now()<this.expires) return;
    this.pending=(async()=>{
      const drives=await this.readDrives(), requests=[],foreignDrives=new Set();
      for(const row of drives) {
        if(!/^[a-z]:$/i.test(row.DeviceID??'')) continue;
        const match=/^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(row.ProviderName??'');
        if(!match || match[1].toLowerCase()!==this.hostname.toLowerCase()) {foreignDrives.add(row.DeviceID.toUpperCase());continue;}
        if(!match[2] || /[\x00-\x1f\\/:*?"<>|]/.test(match[2])) throw new Error('Invalid GPU share name');
        requests.push({drive:row.DeviceID.toUpperCase(),share:match[2],suffix:match[3]??''});
      }
      const shares=requests.length ? await this.readShares([...new Set(requests.map(r=>r.share))]) : [];
      if(!Array.isArray(shares) || shares.length>26) throw new Error('Invalid GPU share roots');
      const mappings=requests.map(row=>{
        const matches=shares.filter(s=>s.name?.toLowerCase()===row.share.toLowerCase());
        if(matches.length!==1) throw new Error('GPU 공유 폴더의 실제 경로를 확인하지 못했습니다: '+row.share);
        const root=projectRoot(matches[0].path);
        const target=projectRoot(path.win32.join(root,row.suffix));
        const relative=path.win32.relative(root,target);
        if(relative==='..'||relative.startsWith('..\\')||path.win32.isAbsolute(relative)) throw new Error('Invalid shared subfolder');
        return {...row,target};
      });
      this.mappings=mappings;this.foreignDrives=foreignDrives;this.expires=this.now()+10000;this.onResolved(mappings);
    })().catch(error=>{this.mappings=[];this.expires=0;throw error}).finally(()=>{this.pending=null});
    return this.pending;
  }
  resolve(value) {
    if(typeof value!=='string') return value;
    const match=/^([a-z]:)[\\/](.*)$/i.exec(value);
    if(!match) return value;
    if(this.foreignDrives.has(match[1].toUpperCase())) throw new Error('선택한 네트워크 드라이브는 GPU PC의 공유 폴더가 아닙니다');
    const mapping=this.mappings.find(m=>m.drive===match[1].toUpperCase());
    if(!mapping) return value;
    // Validate before normalization so traversal cannot escape the share.
    projectRoot(value);
    const resolved=projectRoot(path.win32.join(mapping.target,match[2]));
    const relative=path.win32.relative(mapping.target,resolved);
    if(relative==='..'||relative.startsWith('..\\')||path.win32.isAbsolute(relative)) throw new Error('Invalid mapped project path');
    return resolved;
  }
  async params(method,params,{fresh=false}={}) {
    if(method!=='project/create' && !(['thread/list','thread/start'].includes(method) && params?.cwd!=null)) return params;
    await this.refresh(fresh);
    if(method==='project/create') return {...params,roots:params.roots.map(r=>({...r,path:this.resolve(r.path)}))};
    return {...params,cwd:Array.isArray(params.cwd)?params.cwd.map(p=>this.resolve(p)):this.resolve(params.cwd)};
  }
  invalidate(){this.expires=0;}
}
