function Enter-GpuBridgeLauncherLock {
  param([Parameter(Mandatory=$true)][Threading.Mutex]$Mutex)
  try {return $Mutex.WaitOne(0)}
  catch [Threading.AbandonedMutexException] {return $true}
}

function Read-GpuBridgeReport {
  param([Parameter(Mandatory=$true)][string]$Path)
  for($bridgeReadAttempt=0;$bridgeReadAttempt -lt 3;$bridgeReadAttempt++){
    try {return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json}
    catch {if($bridgeReadAttempt -eq 2){throw};Start-Sleep -Milliseconds 25}
  }
}

function Test-GpuBridgeRunner {
  param($Report,$Runner,[string]$RelativeReport)
  if(!$Report -or !$Runner -or $Report.mode -ne 'hub' -or $Report.status -eq 'stopped' -or
    $Report.pid -ne $Runner.ProcessId -or $Runner.Name -ine 'node.exe' -or
    [string]::IsNullOrEmpty($Runner.CommandLine) -or
    !$Runner.CommandLine.Contains('src/desktop-hub.mjs')){return $false}
  $bridgeCommand=$Runner.CommandLine.Replace('\','/')
  $bridgeArgument=[regex]::Escape($RelativeReport.Replace('\','/'))
  if($bridgeCommand -notmatch ('(?:^|\s)--report\s+"?'+$bridgeArgument+'(?:"|\s|$)')){return $false}
  try {
    $bridgeStarted=if($Report.startedAt -is [DateTime]){$Report.startedAt.ToUniversalTime()}else{[DateTimeOffset]::Parse($Report.startedAt).UtcDateTime}
    $bridgeCreated=([DateTime]$Runner.CreationDate).ToUniversalTime()
    return [Math]::Abs(($bridgeStarted-$bridgeCreated).TotalSeconds) -lt 30
  } catch {return $false}
}

function Test-GpuBridgeApp {
  param($Report,$Runner,$App,[string]$RelativeReport)
  if(!(Test-GpuBridgeRunner $Report $Runner $RelativeReport) -or !$App -or
    $App.ProcessId -ne $Report.appPid -or $App.ParentProcessId -ne $Runner.ProcessId -or
    [string]::IsNullOrEmpty($App.CommandLine) -or [string]::IsNullOrEmpty($Report.profilePath)){return $false}
  if($App.ExecutablePath -notmatch '\\OpenAI\.Codex_[\d.]+_x64__2p2nqsd0c76g0\\app\\ChatGPT\.exe$'){return $false}
  $bridgeProfile=[IO.Path]::GetFullPath($Report.profilePath)
  $bridgeTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if(!$bridgeProfile.StartsWith($bridgeTemp,[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($bridgeProfile) -notmatch '^codex-gpu-guard-[A-Za-z0-9]+$'){return $false}
  return $App.CommandLine.Contains('--user-data-dir='+$bridgeProfile+'\user-data') -or
    $App.CommandLine.Contains('--user-data-dir="'+$bridgeProfile+'\user-data"')
}

function Get-GpuBridgeInstance {
  param([Parameter(Mandatory=$true)][string]$Root)
  $bridgeReports=Join-Path $Root 'reports'
  if(!(Test-Path -LiteralPath $bridgeReports)){return $null}
  $bridgeCandidates=@()
  $bridgeHint=Join-Path $bridgeReports 'desktop-launch-last.json'
  if(Test-Path -LiteralPath $bridgeHint){
    try {
      $bridgeLast=Get-Content -LiteralPath $bridgeHint -Raw -Encoding UTF8 | ConvertFrom-Json
      if($bridgeLast.report -match '^reports/hub-[A-Za-z0-9.-]+\.json$'){
        $bridgeCandidates+=Get-Item -LiteralPath (Join-Path $Root $bridgeLast.report) -ErrorAction SilentlyContinue
      }
    } catch {}
  }
  $bridgeCandidates+=Get-ChildItem -LiteralPath $bridgeReports -Filter 'hub-*.json' -File | Sort-Object LastWriteTimeUtc -Descending
  $bridgeSeen=@{}
  foreach($bridgeFile in $bridgeCandidates){
    if(!$bridgeFile -or $bridgeSeen.ContainsKey($bridgeFile.FullName) -or $bridgeFile.Length -gt 8MB){continue}
    $bridgeSeen[$bridgeFile.FullName]=$true
    try {
      $bridgeReport=Read-GpuBridgeReport -Path $bridgeFile.FullName
      if($bridgeReport.mode -ne 'hub' -or $bridgeReport.status -eq 'stopped' -or
        $bridgeReport.pid -le 0 -or !(Get-Process -Id $bridgeReport.pid -ErrorAction SilentlyContinue)){continue}
      $bridgeRelative='reports/'+$bridgeFile.Name
      $bridgeRunner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$bridgeReport.pid)
      if(!(Test-GpuBridgeRunner $bridgeReport $bridgeRunner $bridgeRelative)){continue}
      if(!$bridgeReport.appPid){
        return [pscustomobject]@{report=$bridgeRelative;pid=$bridgeReport.pid;appPid=$null;starting=$true}
      }
      $bridgeApp=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$bridgeReport.appPid)
      if(Test-GpuBridgeApp $bridgeReport $bridgeRunner $bridgeApp $bridgeRelative){
        return [pscustomobject]@{report=$bridgeRelative;pid=$bridgeReport.pid;appPid=$bridgeReport.appPid;starting=$false}
      }
    } catch {}
  }
  return $null
}

function Show-GpuBridgeWindow {
  param([Parameter(Mandatory=$true)][int]$AppProcessId)
  if(!('GpuBridgeWindow' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GpuBridgeWindow {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr window, bool invert);
}
'@
  }
  $bridgeWindowProcess=Get-Process -Id $AppProcessId -ErrorAction Stop
  $bridgeWindowProcess.Refresh()
  $bridgeHandle=$bridgeWindowProcess.MainWindowHandle
  if($bridgeHandle -eq [IntPtr]::Zero){return [pscustomobject]@{windowFound=$false;foreground=$false}}
  if([GpuBridgeWindow]::IsIconic($bridgeHandle)){[void][GpuBridgeWindow]::ShowWindowAsync($bridgeHandle,9)}
  [void][GpuBridgeWindow]::SetForegroundWindow($bridgeHandle)
  $bridgeFocused=[GpuBridgeWindow]::GetForegroundWindow() -eq $bridgeHandle
  if(!$bridgeFocused){[void][GpuBridgeWindow]::FlashWindow($bridgeHandle,$true)}
  return [pscustomobject]@{windowFound=$true;foreground=$bridgeFocused}
}

function Get-GpuBridgeEndpointPath {
  param([Parameter(Mandatory=$true)]$Report,[Parameter(Mandatory=$true)][int]$HubProcessId)
  $bridgeEndpoint=[IO.Path]::GetFullPath($Report.endpointFile)
  $bridgeName=[IO.Path]::GetFileName($bridgeEndpoint)
  $bridgeExpected=Join-Path ([IO.Path]::GetTempPath()) $bridgeName
  # Older live versions used PID only. New runs include a nonce for PID reuse.
  if($HubProcessId -le 0 -or $bridgeEndpoint -ne [IO.Path]::GetFullPath($bridgeExpected) -or
    $bridgeName -notmatch ('^codex-gpu-guard-endpoint-'+$HubProcessId+'(?:-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?\.json$')){throw 'Unexpected guard endpoint file'}
  return $bridgeEndpoint
}

function Restore-GpuBridgeWindow {
  param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)]$Instance,[string]$ThreadId,[string]$InstallationRoot=$Root)
  $bridgeReport=Read-GpuBridgeReport -Path (Join-Path $Root $Instance.report)
  $bridgeRunner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$Instance.pid)
  $bridgeApp=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$Instance.appPid)
  if(!(Test-GpuBridgeApp $bridgeReport $bridgeRunner $bridgeApp $Instance.report)){throw 'Isolated app changed before window restoration'}
  $bridgeEndpointPath=Get-GpuBridgeEndpointPath -Report $bridgeReport -HubProcessId $Instance.pid
  $bridgeEndpoint=Get-Content -LiteralPath $bridgeEndpointPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $bridgeUri=[Uri]$bridgeEndpoint.url
  if($bridgeUri.Scheme -ne 'ws' -or $bridgeUri.Host -ne '127.0.0.1' -or $bridgeUri.Port -ne $bridgeReport.port){throw 'Unexpected guard endpoint'}
  $bridgeThread=$bridgeReport.lastSelectedThreadId
  if($ThreadId){
    if($ThreadId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'){throw 'Invalid target GPU task'}
    $bridgeThread=$ThreadId
  }
  if($bridgeThread -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'){$bridgeThread=$bridgeReport.threadId}
  if($bridgeThread -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$'){throw 'Invalid restored task'}
  $bridgeUserData=Join-Path $bridgeReport.profilePath 'user-data'
  $bridgeStart=[Diagnostics.ProcessStartInfo]::new()
  $bridgeStart.FileName=$bridgeApp.ExecutablePath
  $bridgeStart.WorkingDirectory=$Root
  $bridgeStart.Arguments='"--user-data-dir='+$bridgeUserData+'" codex://threads/'+$bridgeThread
  $bridgeStart.UseShellExecute=$false
  $bridgeStart.CreateNoWindow=$true
  $bridgeStart.EnvironmentVariables['CODEX_HOME']=Join-Path $bridgeReport.profilePath 'codex-home'
  $bridgeStart.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH']=$bridgeUserData
  $bridgeStart.EnvironmentVariables['CODEX_CLI_PATH']=Join-Path $InstallationRoot 'bin\codex-gpu-guard.exe'
  $bridgeStart.EnvironmentVariables['CODEX_APP_SERVER_FORCE_CLI']='1'
  $bridgeStart.EnvironmentVariables['CODEX_GPU_GUARD_URL']=$bridgeEndpoint.url
  $bridgeStart.EnvironmentVariables.Remove('CODEX_APP_SERVER_WS_URL')
  # The official app handles this second instance in its existing profile, recreating its primary window.
  # The guarded environment is retained even during the brief second-instance process.
  $bridgeRestoreProcess=[Diagnostics.Process]::Start($bridgeStart)
  $bridgeRestoreProcess.Dispose()
}
