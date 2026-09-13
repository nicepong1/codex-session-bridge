param([switch]$KeepShortcut)
$ErrorActionPreference='Stop'
$bridgeBase=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge\versions')).TrimEnd('\')+'\'
$bridgeTarget=[IO.Path]::GetFullPath($PSScriptRoot)
if(!$bridgeTarget.StartsWith($bridgeBase,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($bridgeTarget) -notmatch '^0\.19\.1-[a-f0-9]{12}$'){throw 'Run Uninstall.ps1 from the installed version directory.'}
$bridgeRunning=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($bridgeTarget+'\',[StringComparison]::OrdinalIgnoreCase)})
if($bridgeRunning.Count){throw 'Close the bridge connection and setup windows before uninstalling.'}
$bridgeData=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge'
foreach($bridgeName in @('host.json','client.json')){
 $bridgePointer=Join-Path $bridgeData $bridgeName
 if(Test-Path -LiteralPath $bridgePointer){$bridgeP=Get-Content -LiteralPath $bridgePointer -Raw|ConvertFrom-Json;if($bridgeP.installPath -eq $bridgeTarget){Remove-Item -LiteralPath $bridgePointer}}
}
if(!$KeepShortcut){
 $bridgeLink=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Codex Session Bridge.lnk'
 if(Test-Path -LiteralPath $bridgeLink){$bridgeShortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($bridgeLink);if($bridgeShortcut.Description -eq 'Codex Session Bridge client' -and $bridgeShortcut.Arguments.Contains($bridgeTarget)){Remove-Item -LiteralPath $bridgeLink}}
}
# The absolute version path is checked above; never remove user data, SSH keys, Codex or projects.
Remove-Item -LiteralPath $bridgeTarget -Recurse -Force
Write-Host 'Removed this version. Connection settings and journals were retained in LocalAppData\CodexSessionBridge.'
