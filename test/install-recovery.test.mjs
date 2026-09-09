import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
test('interrupted installation retries, legacy copies recover, and existing installations stay protected',{skip:process.platform!=='win32'},()=>{
 // PowerShell 7's inherited module search path hides Windows PowerShell modules.
 const env={...process.env};delete env.PSModulePath;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/install-recovery-fixture.ps1')],{windowsHide:true,encoding:'utf8',timeout:45000,env});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/"interruptedRetry":true/);assert.match(result.stdout,/"activeVersionPreserved":true/);
});
