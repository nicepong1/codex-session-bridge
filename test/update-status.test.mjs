import test from 'node:test';import assert from 'node:assert/strict';
import {compatibility} from '../src/installed.mjs';
import {newerVersion,updateDecision,validateReleaseCompatibility,latestPublishedRelease,readHostVersions} from '../src/update-status.mjs';
const old='1.2.3',next='1.2.4',matrix={...compatibility,bridgeVersion:next,clientAppVersions:['2.3.4.5'],hostAppVersions:['1.2.3.4'],hostCliVersions:['codex-cli 0.153.4']};
const local={versions:['2.3.4.5']},host={release:old,appVersions:['1.2.3.4'],cliVersions:['codex-cli 0.153.4']};
const latest={version:next,url:'https://github.com/nicepong1/codex-session-bridge/releases/tag/v1.2.4',compatibility:matrix};
const base={currentVersion:old,local,host,currentMatrix:matrix};
test('update choice handles numeric versions and refuses invalid, prerelease and downgrade targets',()=>{
 assert.equal(newerVersion('1.10.0','1.9.9'),true);for(const v of ['1.2.3','1.2.2','1.2.4-beta','../../../x'])assert.equal(newerVersion(v,old),false);
});
test('only a release compatible with both PCs and the real host CLI can be prepared',()=>{
 assert.equal(updateDecision({...base,latest}).status,'compatible-update-available');
 assert.equal(updateDecision({...base,latest,host:{...host,cliVersions:['codex-cli 99.0.0']}}).status,'compatibility-validation-required');
 assert.equal(updateDecision({...base,latest,local:{versions:['99.0.0.0']}}).status,'compatibility-validation-required');
 assert.equal(updateDecision({...base,latest,local:{versions:['2.3.4.5','3.4.5.6']}}).canConnect,false);
 assert.equal(updateDecision({...base,latest,host:null}).status,'host-unavailable');
});
test('a failed remote release lookup never disables a previously compatible pair or masks a mismatch',()=>{
 assert.equal(updateDecision(base).status,'ready');
 assert.equal(updateDecision({...base,host:{...host,release:'1.2.2'}}).status,'bridge-version-mismatch');
 assert.equal(updateDecision({...base,local:{versions:['99.0.0.0']}}).canConnect,false);
});
test('release metadata rejects invalid platform, role lists and mismatched release tags',()=>{
 assert.equal(validateReleaseCompatibility(matrix,next),matrix);
 for(const value of [{...matrix,bridgeVersion:old},{...matrix,platform:'linux'},{...matrix,unknownVersionPolicy:'allow'},{...matrix,clientAppVersions:['*']},{...matrix,hostCliVersions:[]}])assert.throws(()=>validateReleaseCompatibility(value,next));
});
function mockFetch(release,manifest=matrix){const calls=[];return {calls,fetcher:async(url)=>{calls.push(url);return new Response(JSON.stringify(calls.length===1?release:manifest),{status:200})}}}
test('latest lookup is confined to the fixed release repository and validates tag metadata',async()=>{
 const release={draft:false,prerelease:false,tag_name:'v'+next,html_url:latest.url},mock=mockFetch(release);
 assert.equal((await latestPublishedRelease(mock)).version,next);assert.equal(mock.calls.length,2);
 assert.equal(mock.calls[1],'https://raw.githubusercontent.com/nicepong1/codex-session-bridge/v1.2.4/compatibility.json');
 for(const change of [{draft:true},{prerelease:true},{tag_name:'../../malicious'},{html_url:'https://attacker.invalid'}]){
  const bad=mockFetch({...release,...change});await assert.rejects(latestPublishedRelease(bad));assert.equal(bad.calls.length,1);
 }
});
test('release lookup is bounded and treats network errors as unknown, not up to date',async()=>{
 await assert.rejects(latestPublishedRelease({fetcher:async()=>new Response('x'.repeat(140000))}),/too large/);
 await assert.rejects(latestPublishedRelease({fetcher:async()=>new Response('',{status:503})}),/HTTP 503/);
});
test('host query remains read-only and uses the saved SSH trust',async()=>{
 const profile={version:1,id:'00000000-0000-4000-8000-000000000001',label:'fixture',hostname:'192.0.2.1',username:'tester',port:22};
 const result=await readHostVersions(profile,{run:async(exe,args)=>{
  assert.equal(exe,'ssh');assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('ForwardAgent=no'));
  const script=Buffer.from(args.at(-1).split(' ').at(-1),'base64').toString('utf16le');
  assert.match(script,/Get-AppxPackage/);assert.doesNotMatch(script,/Stop-Process|Install.ps1|thread\/resume|Set-Content/);
  return {stdout:JSON.stringify(host)};
 }});assert.deepEqual(result,host);
});
