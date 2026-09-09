param([string]$ProfileId)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'src\desktop-launcher.ps1')
$bridgeData=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge'
if($env:CSB_DATA_HOME){$bridgeData=$env:CSB_DATA_HOME}
$bridgeLock=$null
try {
  if(!$ProfileId){
    $bridgeSelected=Join-Path $bridgeData 'selected.json'
    if(!(Test-Path -LiteralPath $bridgeSelected)){
      Start-Process -FilePath (Join-Path $PSScriptRoot 'Configure.cmd')
      return
    }
    $ProfileId=(Get-Content -LiteralPath $bridgeSelected -Raw|ConvertFrom-Json).id
  }
  if($ProfileId -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'Invalid connection profile. Run Configure.cmd.'}
  $env:CSB_PROFILE_ID=$ProfileId
  $bridgeState=Join-Path $bridgeData ('clients\'+$ProfileId)
  $bridgeLock=[Threading.Mutex]::new($false,('Global\CodexSessionBridgeLauncher-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
  if(!(Enter-GpuBridgeLauncherLock -Mutex $bridgeLock)){return}
  $bridgeInstance=Get-GpuBridgeInstance -Root $bridgeState
  if($bridgeInstance){
    if($bridgeInstance.starting){return}
    $bridgeWindow=Show-GpuBridgeWindow -AppProcessId $bridgeInstance.appPid
    if(!$bridgeWindow.windowFound){Restore-GpuBridgeWindow -Root $bridgeState -InstallationRoot $PSScriptRoot -Instance $bridgeInstance}
    return
  }
  New-Item -ItemType Directory -Path (Join-Path $bridgeState 'reports') -Force|Out-Null
  $bridgeReport='reports/hub-'+[Guid]::NewGuid().ToString()+'.json'
  $bridgeNode=Join-Path $PSScriptRoot 'runtime\node.exe'
  $bridgeEntry=(Join-Path $PSScriptRoot 'src\desktop-hub.mjs').Replace('\','/')
  $bridgeLog=Join-Path $bridgeState 'reports\launch-error.txt'
  $bridgeProcess=Start-Process -FilePath $bridgeNode -ArgumentList @(('"'+$bridgeEntry+'"'),'--report',$bridgeReport,'--seconds','0','--launch','--enable-text-input') -WorkingDirectory $bridgeState -WindowStyle Hidden -PassThru -RedirectStandardError $bridgeLog
  $bridgeDeadline=[DateTime]::UtcNow.AddSeconds(55)
  while([DateTime]::UtcNow -lt $bridgeDeadline){
    if($bridgeProcess.HasExited){throw 'Connection stopped. Run Diagnose.cmd. Another remote window may already be open, or the Codex build is unsupported.'}
    $bridgeStatusPath=Join-Path $bridgeState $bridgeReport
    if(Test-Path -LiteralPath $bridgeStatusPath){
      try{$bridgeStatus=Read-GpuBridgeReport -Path $bridgeStatusPath}catch{$bridgeStatus=$null}
      if($bridgeStatus.status -eq 'guard-ready') {return}
      if($bridgeStatus.status -eq 'blocked'){throw 'Connection identity changed. Close the remote window and diagnose before reconnecting.'}
    }
    Start-Sleep -Milliseconds 300
  }
  [void][Windows.Forms.MessageBox]::Show('Connection is still starting. Check Tailscale and the host Codex app. Run Diagnose.cmd for details.','Codex Session Bridge')
}catch{
  [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Codex Session Bridge',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Warning)
}finally{if($bridgeLock){try{$bridgeLock.ReleaseMutex()}catch{};$bridgeLock.Dispose()}}
