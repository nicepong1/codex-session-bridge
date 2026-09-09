import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

test('launcher immediately recovers an abandoned Windows mutex',{skip:process.platform!=='win32'},()=>{
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/launcher-lock-fixture.ps1')],{windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/launcher-lock-recovery-ok/);
});

test('window restoration accepts current/legacy endpoints and rejects other PIDs or paths',{skip:process.platform!=='win32'},()=>{
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/endpoint-path-fixture.ps1')],{windowsHide:true,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/endpoint-paths-ok/);
});

test('desktop launcher identifies its own live app and rejects stale or unrelated processes', {skip: process.platform !== 'win32'}, () => {
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('test/desktop-launcher-fixture.ps1')],
    {encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),[true,true,false,false,false,false,false]);
});
