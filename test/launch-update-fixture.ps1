param([string]$FixtureRoot)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'src\update-package.ps1')
. (Join-Path $repo 'src\launcher-install.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
function Reject([scriptblock]$Operation){$failed=$false;try{& $Operation}catch{$failed=$true};if(!$failed){throw 'Expected rejection'}}
foreach($name in @('../outside','C:/file','root//file','root/CON.txt','root/name.','root\bad','root/./bad')){Reject {Assert-BridgeUpdatePath $name}}
function MakeZip([string[]]$Names){
 $archive=Join-Path $FixtureRoot ([Guid]::NewGuid().ToString()+'.zip')
 $zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
 try{foreach($name in $Names){$entry=$zip.CreateEntry($name);$writer=[IO.StreamWriter]::new($entry.Open());$writer.Write('fixture');$writer.Dispose()}}finally{$zip.Dispose()}
 return $archive
}
foreach($names in @(@('codex-session-bridge/../../escape'),@('codex-session-bridge\..\..\escape'),@('other/root'),@('codex-session-bridge/a','codex-session-bridge\A'),@('codex-session-bridge/AUX.txt'))){
 $zip=MakeZip $names;Reject {Expand-BridgeUpdate $zip (Join-Path $FixtureRoot ([Guid]::NewGuid().ToString()))}
}
$zip=MakeZip @('codex-session-bridge\readme.txt');$good=Join-Path $FixtureRoot 'good'
Expand-BridgeUpdate $zip $good
if((Get-Content -LiteralPath (Join-Path $good 'codex-session-bridge/readme.txt')) -ne 'fixture'){throw 'Valid extraction failed'}
$package=Join-Path $FixtureRoot 'package';New-Item -ItemType Directory -Path $package|Out-Null
$entries=@()
foreach($name in @('Install.ps1','Open-Bridge.ps1','runtime/node.exe','src/launch-update.mjs','src/install-context.ps1','src/install-files.ps1','compatibility.json','package.json')){
 $file=Join-Path $package $name;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
 [IO.File]::WriteAllText($file,(@{version='9.8.7'}|ConvertTo-Json))
 $entries+=@{path=$name;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
}
[IO.File]::WriteAllText((Join-Path $package 'release-files.json'),(@{version='9.8.7';files=$entries}|ConvertTo-Json -Depth 5))
$matrixHash=(Get-FileHash -LiteralPath (Join-Path $package 'compatibility.json')).Hash.ToLowerInvariant()
[void](Test-BridgeUpdatePackage $package '9.8.7' $matrixHash)
[IO.File]::WriteAllText((Join-Path $package 'unlisted.ps1'),'bad');Reject {Test-BridgeUpdatePackage $package '9.8.7' $matrixHash}
Remove-Item -LiteralPath (Join-Path $package 'unlisted.ps1')
[IO.File]::WriteAllText((Join-Path $package 'runtime/node.exe'),'changed');Reject {Test-BridgeUpdatePackage $package '9.8.7' $matrixHash}
# Execute the actual launcher with mocked OS/window and updater boundaries.
# An existing or starting window must return before invoking Node; a new window calls once.
$launcher=Get-Content -LiteralPath (Join-Path $repo 'Open-Bridge.ps1') -Raw
$launcher=$launcher.Replace("Add-Type -AssemblyName System.Windows.Forms",'')
$launcher=$launcher.Replace(". (Join-Path `$PSScriptRoot 'src\desktop-launcher.ps1')",'')
$launcher=$launcher.Replace(". (Join-Path `$PSScriptRoot 'src\launcher-install.ps1')",'')
$launcher=$launcher.Replace(". (Join-Path `$bridgeRoot 'src\desktop-launcher.ps1')",'')
$launcher=$launcher.Replace("[Threading.Mutex]::new(`$false,('Global\CodexSessionBridgeLauncher-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))",'$null')
$launcher=$launcher.Replace("& (Join-Path `$bridgeRoot 'runtime\node.exe') (Join-Path `$bridgeRoot 'src\launch-update.mjs')",'Invoke-FixtureUpdater')
$launcher=$launcher.Replace('$PSScriptRoot','$script:fixtureLauncherRoot')
$launcher=[regex]::Replace($launcher,'\[void\]\[Windows.Forms.MessageBox\]::Show\(\$_\.Exception\.Message[^\r\n]+','throw')
$script:fixtureLauncherRoot=$repo
function Resolve-BridgeLauncherInstallation {return $script:fixtureLauncherRoot}
function Enter-GpuBridgeLauncherLock {return $true}
function Get-GpuBridgeInstance {return $script:instance}
function Show-GpuBridgeWindow {return @{windowFound=$true}}
function Invoke-FixtureUpdater {param([string]$x,[string]$y);$script:checks++;[IO.File]::WriteAllText($y,(@{ok=$true;installationRoot=$script:fixtureLauncherRoot}|ConvertTo-Json))}
function Start-Process {return @{HasExited=$false}}
function Test-Path {param([string]$LiteralPath);return $true}
function Read-GpuBridgeReport {return @{status='guard-ready'}}
$env:CSB_DATA_HOME=$FixtureRoot;$script:checks=0
foreach($state in @(@{starting=$true},@{starting=$false;appPid=123},$null)){
 $script:instance=$state
 & ([ScriptBlock]::Create($launcher)) -ProfileId '00000000-0000-4000-8000-000000000001'
}
if($script:checks -ne 1){throw 'Launch update was not called exactly once for the new window'}
Write-Output 'UPDATE_FIXTURES_OK'
