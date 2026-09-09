param([ValidateSet('Client','Host','Both')][string]$Role,[switch]$NoConfigure,[switch]$NoShortcut)
$ErrorActionPreference='Stop'
if(![Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required.'}
if(!$Role){
  Write-Host 'Codex Session Bridge: 1 = Client (laptop), 2 = Host (work PC), 3 = Both'
  $bridgeChoice=Read-Host 'Choose 1, 2 or 3'
  $Role=switch($bridgeChoice){'1'{'Client'} '2'{'Host'} '3'{'Both'} default{throw 'Invalid role'}}
}
$bridgeManifestPath=Join-Path $PSScriptRoot 'release-files.json'
if(!(Test-Path -LiteralPath $bridgeManifestPath)){throw 'Use the release ZIP from GitHub, or run scripts/Build-Release.ps1 first.'}
$bridgeManifest=Get-Content -LiteralPath $bridgeManifestPath -Raw|ConvertFrom-Json
if($bridgeManifest.version -ne '0.18.0' -or !$bridgeManifest.files){throw 'Invalid release manifest'}
$bridgeFiles=@($bridgeManifest.files)
$bridgeSeen=@{}
foreach($bridgeFile in $bridgeFiles){
  if($bridgeFile.path -notmatch '^[A-Za-z0-9_.@/-]+$' -or $bridgeFile.path.StartsWith('/') -or @($bridgeFile.path.Split('/')) -contains '..' -or $bridgeSeen.ContainsKey($bridgeFile.path)){throw 'Invalid release file path'}
  $bridgeSeen[$bridgeFile.path]=$true
  $bridgeSource=Join-Path $PSScriptRoot $bridgeFile.path
  if(!(Test-Path -LiteralPath $bridgeSource -PathType Leaf) -or (Get-Item -LiteralPath $bridgeSource).Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Missing or linked release file: '+$bridgeFile.path)}
  if((Get-FileHash -LiteralPath $bridgeSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bridgeFile.sha256){throw ('Release checksum failed: '+$bridgeFile.path)}
}
foreach($bridgeRequired in @('runtime/node.exe','bin/codex-gpu-guard.exe','package.json','src/desktop-hub.mjs','src/guarded-gpu-worker.mjs','node_modules/ws/package.json')){if(!$bridgeSeen.ContainsKey($bridgeRequired)){throw ('Incomplete release: '+$bridgeRequired)}}
$bridgeHash=(Get-FileHash -LiteralPath $bridgeManifestPath -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$bridgeInstallBase=Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge'
$bridgeInstall=Join-Path $bridgeInstallBase ('versions\0.18.0-'+$bridgeHash)
if(Test-Path -LiteralPath $bridgeInstall){
  foreach($bridgeFile in $bridgeFiles){$bridgeExisting=Join-Path $bridgeInstall $bridgeFile.path;if(!(Test-Path -LiteralPath $bridgeExisting) -or (Get-FileHash -LiteralPath $bridgeExisting -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bridgeFile.sha256){throw 'Existing installation differs. Preserve it and use a new release; do not overwrite a running installation.'}}
}else{
  New-Item -ItemType Directory -Path $bridgeInstall -Force|Out-Null
  foreach($bridgeFile in $bridgeFiles){
    $bridgeDestination=Join-Path $bridgeInstall $bridgeFile.path
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($bridgeDestination)) -Force|Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $bridgeFile.path) -Destination $bridgeDestination
  }
  Copy-Item -LiteralPath $bridgeManifestPath -Destination (Join-Path $bridgeInstall 'release-files.json')
}
$bridgeData=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge'
New-Item -ItemType Directory -Path $bridgeData -Force|Out-Null
function Save-BridgeInstallPointer([string]$Name){
  $bridgeFile=Join-Path $bridgeData $Name
  if(Test-Path -LiteralPath $bridgeFile){Copy-Item -LiteralPath $bridgeFile -Destination ($bridgeFile+'.backup-'+[Guid]::NewGuid().ToString())}
  $bridgePointer=@{version=1;release='0.18.0';installPath=$bridgeInstall}|ConvertTo-Json
  [IO.File]::WriteAllText($bridgeFile,$bridgePointer,[Text.UTF8Encoding]::new($false))
}
if($Role -eq 'Host' -or $Role -eq 'Both'){
  Save-BridgeInstallPointer 'host.json'
  Write-Host 'Host installed. Keep the official Codex app signed in. OpenSSH Server and Tailscale must already be configured.'
  & (Join-Path $bridgeInstall 'Show-HostInfo.ps1')
}
if($Role -eq 'Client' -or $Role -eq 'Both'){
  Save-BridgeInstallPointer 'client.json'
  if(!$NoShortcut){
  $bridgeShell=New-Object -ComObject WScript.Shell
  $bridgeShortcutPath=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Codex Session Bridge.lnk'
  if(Test-Path -LiteralPath $bridgeShortcutPath){
    $bridgeExistingShortcut=$bridgeShell.CreateShortcut($bridgeShortcutPath)
    if($bridgeExistingShortcut.Description -ne 'Codex Session Bridge client'){throw 'A different shortcut already uses this name.'}
  }
  $bridgeShortcut=$bridgeShell.CreateShortcut($bridgeShortcutPath)
  $bridgeShortcut.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $bridgeShortcut.Arguments='-NoLogo -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $bridgeInstall 'Open-Bridge.ps1')+'"'
  $bridgeShortcut.WorkingDirectory=$bridgeInstall
  $bridgeShortcut.IconLocation=(Join-Path $bridgeInstall 'assets\gpu-codex.ico')+',0'
  $bridgeShortcut.Description='Codex Session Bridge client';$bridgeShortcut.Save()
  }
  Write-Host ('Installed: '+$bridgeInstall)
  if(!$NoConfigure){& (Join-Path $bridgeInstall 'runtime\node.exe') (Join-Path $bridgeInstall 'src\setup.mjs')}
}
Write-Host 'Installation complete. Existing Codex tasks and account settings were preserved.'
