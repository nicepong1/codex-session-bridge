import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateProfile,saveProfile,loadProfile,selectProfile,profilePaths,verifyHostKeys} from '../src/connection-config.mjs';
import {sshArguments,remoteNodeCommand} from '../src/ssh-command.mjs';
import {desktopFromPaths,discoverCli,hostModelSettingsVersion} from '../src/installed.mjs';
const profile=()=>({version:1,id:randomUUID(),label:'Work PC',hostname:'192.0.2.10',username:'example-user',port:22,identityFile:'',remoteInstallPath:''});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'csb-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
test('profiles and last-task/report paths are isolated per destination and user root',t=>{
 const root=fixture(t),otherRoot=fixture(t),a=profile(),b=profile();
 saveProfile(a,'key-a',root);saveProfile(b,'key-b',root);selectProfile(a.id,root);
 assert.equal(loadProfile(undefined,root).id,a.id);assert.notEqual(profilePaths(a.id,root).lastTask,profilePaths(b.id,root).lastTask);
 selectProfile(b.id,root);assert.equal(loadProfile(undefined,root).id,b.id);assert.throws(()=>loadProfile(b.id,otherRoot));
 assert.throws(()=>saveProfile({...a,hostname:'192.0.2.20'},'new-key',root),/EEXIST/);
});
test('malformed profiles cannot escape their directory or inject SSH options',()=>{
 for(const overrides of [{id:'../escape'},{hostname:'-oProxyCommand=calc'},{username:'name" & calc'},{port:0},{port:65536},{password:'secret'},{remoteInstallPath:'C:\\x\\..\\y'},{identityFile:'\\\\server\\key'},{label:'../bad'}])assert.throws(()=>validateProfile({...profile(),...overrides}));
 assert.throws(()=>profilePaths('../escape'));
});
function hostKey(){const type=Buffer.from('ssh-ed25519'),key=Buffer.alloc(4+type.length+4+32);key.writeUInt32BE(type.length);type.copy(key,4);key.writeUInt32BE(32,4+type.length);key.fill(7,8+type.length);return {base64:key.toString('base64'),fingerprint:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}}
test('host enrollment requires a matching separately obtained SHA256 fingerprint and address',()=>{
 const k=hostKey(),line=`192.0.2.10 ssh-ed25519 ${k.base64}`;
 assert.equal(verifyHostKeys(line,k.fingerprint,'192.0.2.10',22),line+'\n');
 assert.throws(()=>verifyHostKeys(line,'SHA256:'+'A'.repeat(43),'192.0.2.10',22));
 assert.throws(()=>verifyHostKeys(line,k.fingerprint,'192.0.2.11',22));
 assert.throws(()=>verifyHostKeys(line,k.fingerprint,'192.0.2.10',2222));
 assert.ok(verifyHostKeys(line.replace('192.0.2.10','[192.0.2.10]:2222'),k.fingerprint,'192.0.2.10',2222));
});
test('SSH is noninteractive with strict per-profile host trust and no agent forwarding',()=>{
 const p=profile(),args=sshArguments(p,'remote-command',{root:'C:\\Users\\test user\\Data'});
 assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('ForwardAgent=no'));assert.ok(args.includes('GlobalKnownHostsFile=NUL'));
 assert.ok(args.some(v=>v.includes(p.id+'/known_hosts')));assert.deepEqual(args.slice(-5),['22','-l','example-user','192.0.2.10','remote-command']);
});
test('remote configuration is encoded as data and remote entry points are restricted',()=>{
 const p={...profile(),remoteInstallPath:"C:\\Users\\O'Brien $x `quote\\Bridge"};
 const command=remoteNodeCommand(p,'host-doctor.mjs');assert.ok(command.startsWith('cmd.exe /d /v:off /s /c ""'));assert.ok(command.includes(p.remoteInstallPath+'\\runtime\\node.exe"'));
 const encoded=command.match(/base64,([A-Za-z0-9+/=]+)/)[1];assert.ok(Buffer.from(encoded,'base64').toString().includes(JSON.stringify(p.remoteInstallPath)));
 assert.throws(()=>remoteNodeCommand({...p,remoteInstallPath:'C:\\%TEMP%\\Bridge'},'host-doctor.mjs'));
 assert.throws(()=>remoteNodeCommand(p,'anything.mjs'));assert.throws(()=>remoteNodeCommand(p,'host-doctor.mjs',[';bad']));
});
const app=v=>`C:\\Program Files\\WindowsApps\\OpenAI.Codex_${v}_x64__package\\app\\ChatGPT.exe`;
test('compatibility blocks unknown, ambiguous and wrong-role builds',()=>{
 assert.equal(desktopFromPaths(app('26.901.6511.0'),'client').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.901.6511.0'),'host').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.908.9136.0'),'client').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.908.4834.0'),'host').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.915.4065.0'),'host').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.917.6896.0'),'client').testedBuild,true);
 assert.equal(desktopFromPaths(app('26.917.6896.0'),'host').testedBuild,false);
 assert.equal(desktopFromPaths(app('26.908.9136.0'),'host').testedBuild,false);
 assert.equal(desktopFromPaths(app('99.1.1.0'),'client').testedBuild,false);
 assert.equal(desktopFromPaths([app('26.901.6511.0'),app('26.901.5280.0')]).testedBuild,false);
 assert.equal(desktopFromPaths([]).testedBuild,false);
});
test('CLI cache discovery uses the supported executable regardless of cache directory name',t=>{
 const root=fixture(t);for(const name of ['new-cache','different-cache']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'codex.exe'),'fixture')}
 const found=discoverCli({root,execute:file=>file.includes('different-cache')?'codex-cli 0.153.4':'codex-cli 99.0.0'});
 assert.match(found.executable,/different-cache/);assert.throws(()=>discoverCli({root,execute:()=> 'codex-cli 99.0.0'}));
 assert.equal(discoverCli({root,execute:()=> 'codex-cli 0.154.0-alpha.6.2'}).version,'codex-cli 0.154.0-alpha.6.2');
 assert.equal(discoverCli({root,execute:()=> 'codex-cli 0.155.0-alpha.9.2'}).version,'codex-cli 0.155.0-alpha.9.2');
 assert.equal(hostModelSettingsVersion('26.903.8094.0'),1);
 assert.equal(hostModelSettingsVersion('26.915.4065.0'),2);
 assert.throws(()=>hostModelSettingsVersion('99.1.1.0'));
});
