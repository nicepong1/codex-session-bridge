import net from 'node:net';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export function singletonPipeForSid(sid) {
  if (typeof sid !== 'string' || sid.length > 184 || !/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Invalid Windows user SID');
  return '\\\\.\\pipe\\codex-session-bridge-gpu-guard-' + createHash('sha256').update(sid).digest('hex');
}

export function currentWindowsSid() {
  if (process.platform !== 'win32') throw new Error('Windows user identity required');
  const windowsRoot=process.env.SystemRoot||process.env.WINDIR;
  if(!windowsRoot)throw new Error('Windows system directory is unavailable');
  const shell=path.join(windowsRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const sid=execFileSync(shell,['-NoProfile','-NonInteractive','-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{windowsHide:true,timeout:8000,encoding:'utf8',maxBuffer:4096}).trim();
  singletonPipeForSid(sid);return sid;
}

export async function acquireUserSingleton(sid=currentWindowsSid()) {
  const server=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',error=>reject(new Error('Another connection is running for this Windows user, or its lock is unavailable',{cause:error})));
    // Default Windows pipe ACL: do not enable readableAll or writableAll.
    server.listen(singletonPipeForSid(sid),resolve);
  });
  return server;
}
