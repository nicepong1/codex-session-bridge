import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
export const PROFILE_ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const dataRoot=()=>process.env.CSB_DATA_HOME || path.join(process.env.LOCALAPPDATA||os.homedir(),'CodexSessionBridge');
export function validateProfile(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!PROFILE_ID.test(value.id??''))throw Error('Invalid connection profile');
  if(Object.keys(value).some(k=>!['version','id','label','hostname','username','port','identityFile','remoteInstallPath'].includes(k)))throw Error('Unknown connection setting');
  if(typeof value.label!=='string'||!value.label.trim()||value.label.length>60||/[\x00-\x1f<>:"/\\|?*]/.test(value.label))throw Error('Invalid connection name');
  if(typeof value.hostname!=='string'||!(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value.hostname)))throw Error('Use an IPv4 address or DNS hostname');
  if(typeof value.username!=='string'||!(/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]{0,127}$/.test(value.username)))throw Error('Invalid SSH username');
  if(!Number.isInteger(value.port)||value.port<1||value.port>65535)throw Error('Invalid SSH port');
  for(const key of ['identityFile','remoteInstallPath']){
    const p=value[key];if(p!=null&&p!==''&&(typeof p!=='string'||p.length>1024||!path.win32.isAbsolute(p)||/[\x00-\x1f"<>|]/.test(p)||p.startsWith('\\\\')||p.split(/[\\/]/).includes('..')))throw Error('Use an absolute local Windows path: '+key);
  }
  return Object.freeze({...value,hostname:value.hostname.toLowerCase(),identityFile:value.identityFile||'',remoteInstallPath:value.remoteInstallPath||''});
}
export function profilePaths(id,root=dataRoot()){
  if(!PROFILE_ID.test(id??''))throw Error('Invalid profile ID');
  const directory=path.join(root,'clients',id);
  return {directory,config:path.join(directory,'connection.json'),knownHosts:path.join(directory,'known_hosts'),reports:path.join(directory,'reports'),lastTask:path.join(directory,'last-task.json')};
}
export function loadProfile(id=process.env.CSB_PROFILE_ID,root=dataRoot()){
  if(!id){const selected=JSON.parse(fs.readFileSync(path.join(root,'selected.json'),'utf8'));id=selected.id;}
  const file=profilePaths(id,root).config;
  if(fs.statSync(file).size>8192)throw Error('Connection profile is too large');
  const result=validateProfile(JSON.parse(fs.readFileSync(file,'utf8')));
  if(result.id!==id)throw Error('Connection profile identity mismatch');
  return result;
}
export function saveProfile(profile,knownHosts,root=dataRoot()){
  const p=validateProfile(profile),paths=profilePaths(p.id,root);
  if(typeof knownHosts!=='string'||!knownHosts.trim()||knownHosts.length>16384)throw Error('Verified SSH host key required');
  fs.mkdirSync(paths.directory,{recursive:true});fs.mkdirSync(paths.reports,{recursive:true});
  fs.writeFileSync(paths.config,JSON.stringify(p,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(paths.knownHosts,knownHosts,{flag:'wx',mode:0o600});return p;
}
export function selectProfile(id,root=dataRoot()){
  loadProfile(id,root);fs.mkdirSync(root,{recursive:true});const file=path.join(root,'selected.json'),tmp=file+'.'+randomUUID();
  fs.writeFileSync(tmp,JSON.stringify({version:1,id})+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);
}
export function listProfiles(root=dataRoot()){
  const dir=path.join(root,'clients');if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(id=>PROFILE_ID.test(id)).flatMap(id=>{try{return [loadProfile(id,root)]}catch{return []}});
}
export function verifyHostKeys(scan,expected,hostname,port){
  if(!/^SHA256:[a-zA-Z0-9+/]{43}$/.test(expected??''))throw Error('Enter the SHA256 host fingerprint shown on the host PC');
  const token=port===22?hostname:`[${hostname}]:${port}`;
  const accepted=String(scan).split(/\r?\n/).flatMap(line=>{
    if(!line||line.startsWith('#'))return [];
    const [host,type,key,...rest]=line.trim().split(/\s+/);
    if(host!==token||rest.length||!['ssh-ed25519','ecdsa-sha2-nistp256','ssh-rsa'].includes(type)||!key||!/^[a-zA-Z0-9+/]+={0,2}$/.test(key))return [];
    const bytes=Buffer.from(key,'base64');if(bytes.length<16||bytes.length>8192)return [];
    const size=bytes.readUInt32BE(0);if(size>64||bytes.subarray(4,4+size).toString()!==type)return [];
    const fingerprint='SHA256:'+createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'');
    return fingerprint===expected?[`${host} ${type} ${key}`]:[];
  });
  if(!accepted.length)throw Error('SSH host fingerprint does not match. Check the host PC; no key was trusted.');
  return [...new Set(accepted)].join('\n')+'\n';
}
