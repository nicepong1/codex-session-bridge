param([Parameter(Mandatory=$true)][string]$Stage)
$ErrorActionPreference='Stop'
$bridgeReviewRoot=Join-Path ([IO.Path]::GetTempPath()) ('csb-fable-live-'+[Guid]::NewGuid().ToString())
$bridgeOriginalLocal=$env:LOCALAPPDATA;$bridgeProbeProcess=$null
New-Item -ItemType Directory -Path $bridgeReviewRoot|Out-Null
try{
 $env:LOCALAPPDATA=$bridgeReviewRoot
 $bridgeHash=(Get-FileHash -LiteralPath (Join-Path $Stage 'release-files.json')).Hash.Substring(0,12).ToLowerInvariant()
 $bridgeTarget=Join-Path $bridgeReviewRoot ('Programs\CodexSessionBridge\versions\0.18.3-'+$bridgeHash)
 $bridgeRuntime=Join-Path $bridgeTarget 'runtime';New-Item -ItemType Directory -Path $bridgeRuntime -Force|Out-Null
 $bridgeNode=Join-Path $bridgeRuntime 'node.exe'
 Copy-Item -LiteralPath (Join-Path $Stage 'runtime\node.exe') -Destination $bridgeNode
 $bridgeProbeProcess=Start-Process -FilePath $bridgeNode -ArgumentList @('-e','"setInterval(()=>{},1000)"') -WindowStyle Hidden -PassThru
 Start-Sleep -Milliseconds 150
 if($bridgeProbeProcess.HasExited){throw 'Probe process exited before CIM test'}
 $bridgeRejected=$false
 try{& (Join-Path $Stage 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null}catch{$bridgeRejected=$_.Exception.Message -match 'Close processes using this directory'}
 if(!$bridgeRejected){throw 'Actual running process was not protected'}
 if((Get-Process -Id $bridgeProbeProcess.Id).Path -ne $bridgeNode){throw 'Probe identity changed'}
 Stop-Process -Id $bridgeProbeProcess.Id;$bridgeProbeProcess.WaitForExit();$bridgeProbeProcess=$null
 & (Join-Path $Stage 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null
 $bridgeBackups=@(Get-ChildItem -LiteralPath (Split-Path $bridgeTarget) -Directory -Force -Filter '.incomplete-*')
 if($bridgeBackups.Count -ne 1 -or !(Test-Path -LiteralPath (Join-Path $bridgeTarget 'release-files.json'))){throw 'Actual idle partial copy did not recover'}
 $bridgeResult=@{actualCimRunningRejected=$true;actualCimIdleRecovered=$true;partialCopyPreserved=$true}
 $bridgeResult|ConvertTo-Json -Compress
}finally{
 if($bridgeProbeProcess -and !$bridgeProbeProcess.HasExited){
  if((Get-Process -Id $bridgeProbeProcess.Id).Path -eq $bridgeNode){Stop-Process -Id $bridgeProbeProcess.Id;$bridgeProbeProcess.WaitForExit()}
 }
 $env:LOCALAPPDATA=$bridgeOriginalLocal
 $bridgeResolved=[IO.Path]::GetFullPath($bridgeReviewRoot)
 $bridgeTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 if(!$bridgeResolved.StartsWith($bridgeTemp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($bridgeResolved) -notmatch '^csb-fable-live-[a-f0-9-]{36}$'){throw 'Invalid live fixture cleanup target'}
 Remove-Item -LiteralPath $bridgeResolved -Recurse -Force
}
