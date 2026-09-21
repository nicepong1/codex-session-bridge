$ErrorActionPreference='Stop'
$bridgeTestRoot=Join-Path ([IO.Path]::GetTempPath()) ('csb-recovery-test-'+[Guid]::NewGuid().ToString())
$bridgeOriginalLocal=$env:LOCALAPPDATA
$bridgeSource=Join-Path $bridgeTestRoot 'source'
New-Item -ItemType Directory -Path $bridgeSource -Force|Out-Null
$bridgeRepo=Split-Path -Parent $PSScriptRoot
Copy-Item -LiteralPath (Join-Path $bridgeRepo 'Install.ps1') -Destination (Join-Path $bridgeSource 'Install.ps1')
$bridgeEntries=@()
foreach($bridgeName in @('runtime/node.exe','bin/codex-gpu-guard.exe','package.json','src/desktop-hub.mjs','src/guarded-gpu-worker.mjs','src/install-files.ps1','src/install-context.ps1','node_modules/ws/package.json')){
 $bridgeFile=Join-Path $bridgeSource $bridgeName
 New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($bridgeFile)) -Force|Out-Null
 if($bridgeName -eq 'src/install-files.ps1'){Copy-Item -LiteralPath (Join-Path $bridgeRepo $bridgeName) -Destination $bridgeFile}
 # This synthetic package isolates copy recovery from the launch context.
 # The real context guard is tested separately and in native ZIP validation.
 elseif($bridgeName -eq 'src/install-context.ps1'){[IO.File]::WriteAllText($bridgeFile,'function Assert-BridgeInstallerContext {}')}
 else{[IO.File]::WriteAllText($bridgeFile,'inert fixture; not executable')}
 $bridgeEntries+=@{path=$bridgeName;sha256=(Get-FileHash -LiteralPath $bridgeFile).Hash.ToLowerInvariant()}
}
$bridgeManifest=Join-Path $bridgeSource 'release-files.json'
[IO.File]::WriteAllText($bridgeManifest,(@{version='0.19.5';files=$bridgeEntries}|ConvertTo-Json -Depth 4))
$bridgeHash=(Get-FileHash -LiteralPath $bridgeManifest).Hash.Substring(0,12).ToLowerInvariant()
function Assert-Review([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function Run-Installer {& (Join-Path $bridgeSource 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null}
# Unit fixture controls the process snapshot; the actual CIM query is exercised
# separately by installation validation outside the restricted test account.
function Get-CimInstance {param([string]$ClassName) $global:bridgeReviewProcesses}
try {
 $env:LOCALAPPDATA=Join-Path $bridgeTestRoot 'interrupted'
 $script:bridgeCopyCount=0
 function Copy-Item {
  param([string]$LiteralPath,[string]$Destination)
  $script:bridgeCopyCount++;if($script:bridgeCopyCount -eq 3){throw 'Injected disk copy failure'}
  Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination
 }
 $bridgeFailed=$false;try{Run-Installer}catch{$bridgeFailed=$_.Exception.Message -match 'Injected disk copy failure'}
 Remove-Item -LiteralPath Function:\Copy-Item
 Assert-Review $bridgeFailed 'Failure injection was not reached'
 $bridgeTarget=Join-Path $env:LOCALAPPDATA ('Programs\CodexSessionBridge\versions\0.19.5-'+$bridgeHash)
 Assert-Review (!(Test-Path -LiteralPath $bridgeTarget)) 'Partial copy became a final installation'
 Assert-Review (!(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\client.json'))) 'Failed installation changed pointer'
 Run-Installer
 Assert-Review (Test-Path -LiteralPath (Join-Path $bridgeTarget 'release-files.json')) 'Retry failed to finish installation'
 $bridgePointer=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\client.json'
 $bridgeBefore=[IO.File]::ReadAllText($bridgePointer);Run-Installer
 Assert-Review ([IO.File]::ReadAllText($bridgePointer) -eq $bridgeBefore) 'Reinstall changed the installed path'
 Assert-Review (@(Get-ChildItem -LiteralPath (Split-Path $bridgePointer) -Filter '*.backup-*').Count -eq 1) 'Pointer replacement did not preserve prior pointer'
 [IO.File]::AppendAllText((Join-Path $bridgeTarget 'package.json'),'tampered')
 $bridgeRejected=$false;try{Run-Installer}catch{$bridgeRejected=$_.Exception.Message -match 'Existing installation differs'}
 Assert-Review $bridgeRejected 'Tampered completed installation was overwritten'

 # Copy-Item can be replaced by a damaged filesystem/copy provider. A corrupt
 # completion manifest must never be promoted or registered as an installation.
 $env:LOCALAPPDATA=Join-Path $bridgeTestRoot 'manifest-corruption'
 function Copy-Item {
  param([string]$LiteralPath,[string]$Destination)
  Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination
  if([IO.Path]::GetFileName($LiteralPath) -eq 'release-files.json'){[IO.File]::WriteAllText($Destination,'truncated')}
 }
 $bridgeRejected=$false;try{Run-Installer}catch{$bridgeRejected=$_.Exception.Message -match 'Staged release manifest checksum failed'}
 Remove-Item -LiteralPath Function:\Copy-Item
 Assert-Review $bridgeRejected 'Damaged completion manifest was accepted'
 $bridgeTarget=Join-Path $env:LOCALAPPDATA ('Programs\CodexSessionBridge\versions\0.19.5-'+$bridgeHash)
 Assert-Review (!(Test-Path -LiteralPath $bridgeTarget)) 'Damaged manifest reached the final directory'
 Assert-Review (!(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\client.json'))) 'Damaged manifest changed the installed pointer'
 Assert-Review (@(Get-ChildItem -LiteralPath (Split-Path $bridgeTarget) -Directory -Force -Filter '.staging-*').Count -eq 1) 'Failed manifest copy was not preserved'
 Run-Installer

 foreach($bridgeTag in @('9000001A','9000601A','9000F01A')){
  Assert-Review (![BridgeInstallReparse]::IsLinkTag(0x400,[Convert]::ToUInt32($bridgeTag,16))) ('Cloud tag rejected: '+$bridgeTag)
 }
 foreach($bridgeTag in @('A0000003','A000000C','80000013','9000001B')){
  Assert-Review ([BridgeInstallReparse]::IsLinkTag(0x400,[Convert]::ToUInt32($bridgeTag,16))) ('Redirecting or unknown tag accepted: '+$bridgeTag)
 }
 Assert-Review (![BridgeInstallReparse]::IsLinkTag(0,[Convert]::ToUInt32('A0000003',16))) 'Non-reparse file rejected based on unused tag'

 foreach($bridgeCase in @('legacy','unknown','changed','active','pointed','linked')){
  $env:LOCALAPPDATA=Join-Path $bridgeTestRoot $bridgeCase
  $script:bridgeTarget=Join-Path $env:LOCALAPPDATA ('Programs\CodexSessionBridge\versions\0.19.5-'+$bridgeHash)
  New-Item -ItemType Directory -Path (Join-Path $bridgeTarget 'runtime') -Force|Out-Null
  Copy-Item -LiteralPath (Join-Path $bridgeSource 'runtime\node.exe') -Destination (Join-Path $bridgeTarget 'runtime\node.exe')
  $global:bridgeReviewProcesses=if($bridgeCase -eq 'active'){@([pscustomobject]@{ExecutablePath=(Join-Path $bridgeTarget 'runtime\node.exe');CommandLine='fixture'})}else{@()}
  if($bridgeCase -eq 'unknown'){[IO.File]::WriteAllText((Join-Path $bridgeTarget 'user-data.txt'),'preserve')}
  if($bridgeCase -eq 'changed'){[IO.File]::AppendAllText((Join-Path $bridgeTarget 'runtime\node.exe'),'changed')}
  if($bridgeCase -eq 'linked'){
   $bridgeLinkTarget=Join-Path $bridgeTestRoot 'link-target';New-Item -ItemType Directory -Path $bridgeLinkTarget|Out-Null
   Copy-Item -LiteralPath (Join-Path $bridgeSource 'runtime\node.exe') -Destination (Join-Path $bridgeLinkTarget 'node.exe')
   Remove-Item -LiteralPath (Join-Path $bridgeTarget 'runtime\node.exe')
   Remove-Item -LiteralPath (Join-Path $bridgeTarget 'runtime')
   New-Item -ItemType Junction -Path (Join-Path $bridgeTarget 'runtime') -Target $bridgeLinkTarget|Out-Null
  }
  if($bridgeCase -eq 'pointed'){
   New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'CodexSessionBridge') -Force|Out-Null
   [IO.File]::WriteAllText((Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\client.json'),(@{installPath=$bridgeTarget}|ConvertTo-Json))
  }
  if($bridgeCase -eq 'legacy'){
   Run-Installer
   $bridgeBackups=@(Get-ChildItem -LiteralPath (Split-Path $bridgeTarget) -Directory -Force -Filter '.incomplete-*')
   Assert-Review ($bridgeBackups.Count -eq 1) 'Old partial copy was not preserved'
   Assert-Review (Test-Path -LiteralPath (Join-Path $bridgeBackups[0].FullName 'runtime\node.exe')) 'Partial copy content was lost'
   Assert-Review (Test-Path -LiteralPath (Join-Path $bridgeTarget 'release-files.json')) 'Legacy recovery did not finish'
  }else{
   $bridgeRejected=$false;try{Run-Installer}catch{$bridgeRejected=$_.Exception.Message -match 'Existing installation differs'}
   Assert-Review $bridgeRejected ('Unsafe legacy recovery accepted: '+$bridgeCase)
   if($bridgeCase -eq 'changed'){
    try{Run-Installer}catch{Assert-Review ($_.Exception.Message -match 'runtime/node.exe') 'Changed-file diagnostic omitted the file name'}
   }
   Assert-Review (Test-Path -LiteralPath $bridgeTarget) ('Existing directory moved: '+$bridgeCase)
  }
 }
 Write-Output '{"interruptedRetry":true,"legacyRecovery":true,"tamperRejected":true,"unknownFilesPreserved":true,"activeVersionPreserved":true,"installedPointerProtected":true,"pointerBackup":true,"manifestCopyProtected":true,"reparseTagClassification":true}'
}finally{
 $env:LOCALAPPDATA=$bridgeOriginalLocal
 Remove-Variable -Name bridgeReviewProcesses -Scope Global -ErrorAction SilentlyContinue
 if(Test-Path -LiteralPath Function:\Copy-Item){Remove-Item -LiteralPath Function:\Copy-Item}
 $bridgeResolved=[IO.Path]::GetFullPath($bridgeTestRoot)
 $bridgeTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 if(!$bridgeResolved.StartsWith($bridgeTemp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($bridgeResolved) -notmatch '^csb-recovery-test-[a-f0-9-]{36}$'){throw 'Invalid recovery test cleanup target'}
 Remove-Item -LiteralPath $bridgeResolved -Recurse -Force
}
