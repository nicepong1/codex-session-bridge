import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../src/install-context.ps1',import.meta.url));
function run(body){
 const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'; . '${source.replaceAll("'","''")}'
$root=Join-Path ([IO.Path]::GetTempPath()) ('csb-context-test-'+[Guid]::NewGuid().ToString());[IO.Directory]::CreateDirectory($root)|Out-Null
try{${body}}finally{
 $resolved=[IO.Path]::GetFullPath($root);$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\')+'\\'
 if(!$resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^csb-context-test-[a-f0-9-]{36}$'){throw 'Invalid cleanup target'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}`;
 return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,PSModulePath:''}}));
}
test('location check measures actual writes and removes its temporary file', {skip:process.platform!=='win32'},()=>{
 const r=run(`Initialize-BridgeInstallerContext
$redirected=[BridgeInstallerContext]::Probe($root)
try{Assert-BridgeInstallerContext -Directories @($root);$accepted=$true}catch{$accepted=$false}
@{redirected=[bool]$redirected;accepted=$accepted;remaining=@(Get-ChildItem -LiteralPath $root -Force).Count}|ConvertTo-Json -Compress`);
 assert.equal(r.accepted,!r.redirected);assert.equal(r.remaining,0);
});
test('a redirected destination is refused without modifying files already there', {skip:process.platform!=='win32'},()=>{
 const r=run(`$target=Join-Path $root 'target';[IO.Directory]::CreateDirectory($target)|Out-Null
$marker=Join-Path $target 'preserve.txt';[IO.File]::WriteAllText($marker,'keep')
$link=Join-Path $root 'link';New-Item -ItemType Junction -Path $link -Target $target|Out-Null
try{try{Assert-BridgeInstallerContext -Directories @($link);$rejected=$false}catch{$rejected=$_.Exception.Message -match 'File Explorer'}
@{rejected=$rejected;preserved=([IO.File]::ReadAllText($marker) -eq 'keep');files=@(Get-ChildItem -LiteralPath $target -Force).Count}|ConvertTo-Json -Compress
}finally{[IO.Directory]::Delete($link)}`);
 assert.equal(r.rejected,true);assert.equal(r.preserved,true);assert.equal(r.files,1);
});
