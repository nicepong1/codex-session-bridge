param([ValidateSet('Client','Host','Both')][string]$Role,[switch]$NoConfigure,[switch]$NoShortcut)
$ErrorActionPreference='Stop'
if(![Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required.'}
# OneDrive placeholders are reparse points but do not redirect the file name.
# Inspect the native tag: allow only normal files and Microsoft's cloud tags;
# junctions, symbolic links and unknown reparse handlers remain rejected.
if(!('BridgeInstallReparse' -as [type])){
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BridgeInstallReparse {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct FindData {
    public uint attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint sizeHigh, sizeLow, tag, reserved;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] public string alternate;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr FindFirstFileW(string path, out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  public static bool IsLinkTag(uint attributes, uint tag) {
    return (attributes & 0x400u)!=0 && (tag & 0xffff0fffu)!=0x9000001au;
  }
  public static bool IsLinked(string path) {
    FindData data; IntPtr handle=FindFirstFileW(path, out data);
    if(handle==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { return IsLinkTag(data.attributes, data.tag); }
    finally { FindClose(handle); }
  }
}
'@
}
if(!$Role){
  Write-Host 'Codex Session Bridge: 1 = Client (laptop), 2 = Host (work PC), 3 = Both'
  $bridgeChoice=Read-Host 'Choose 1, 2 or 3'
  $Role=switch($bridgeChoice){'1'{'Client'} '2'{'Host'} '3'{'Both'} default{throw 'Invalid role'}}
}
$bridgeManifestPath=Join-Path $PSScriptRoot 'release-files.json'
if(!(Test-Path -LiteralPath $bridgeManifestPath)){throw 'Use the release ZIP from GitHub, or run scripts/Build-Release.ps1 first.'}
$bridgeManifest=Get-Content -LiteralPath $bridgeManifestPath -Raw|ConvertFrom-Json
if($bridgeManifest.version -ne '0.19.3' -or !$bridgeManifest.files){throw 'Invalid release manifest'}
$bridgeFiles=@($bridgeManifest.files)
$bridgeSeen=@{}
foreach($bridgeFile in $bridgeFiles){
  if($bridgeFile.path -notmatch '^[A-Za-z0-9_.@/-]+$' -or $bridgeFile.path.StartsWith('/') -or @($bridgeFile.path.Split('/')) -contains '..' -or $bridgeSeen.ContainsKey($bridgeFile.path)){throw 'Invalid release file path'}
  $bridgeSeen[$bridgeFile.path]=$true
  $bridgeSource=Join-Path $PSScriptRoot $bridgeFile.path
  if(!(Test-Path -LiteralPath $bridgeSource -PathType Leaf) -or [BridgeInstallReparse]::IsLinked($bridgeSource)){throw ('Missing or linked release file: '+$bridgeFile.path)}
  if((Get-FileHash -LiteralPath $bridgeSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bridgeFile.sha256){throw ('Release checksum failed: '+$bridgeFile.path)}
}
foreach($bridgeRequired in @('runtime/node.exe','bin/codex-gpu-guard.exe','package.json','src/desktop-hub.mjs','src/guarded-gpu-worker.mjs','src/install-files.ps1','src/install-context.ps1','node_modules/ws/package.json')){if(!$bridgeSeen.ContainsKey($bridgeRequired)){throw ('Incomplete release: '+$bridgeRequired)}}
. (Join-Path $PSScriptRoot 'src\install-context.ps1')
Assert-BridgeInstallerContext
. (Join-Path $PSScriptRoot 'src\install-files.ps1')
$bridgeInstallerLock=[Threading.Mutex]::new($false,('Global\CodexSessionBridgeInstaller-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$bridgeOwnsInstallerLock=$false
try {
try{$bridgeOwnsInstallerLock=$bridgeInstallerLock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$bridgeOwnsInstallerLock=$true}
if(!$bridgeOwnsInstallerLock){throw 'Another installer is running for this Windows user.'}
$bridgeHash=(Get-FileHash -LiteralPath $bridgeManifestPath -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
$bridgeInstallBase=Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge'
$bridgeInstall=Join-Path $bridgeInstallBase ('versions\0.19.3-'+$bridgeHash)
$bridgeData=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge'
Install-BridgeFiles -Source $PSScriptRoot -Destination $bridgeInstall -Files $bridgeFiles -DataDirectory $bridgeData
New-Item -ItemType Directory -Path $bridgeData -Force|Out-Null
if($Role -eq 'Host' -or $Role -eq 'Both'){
  Save-BridgeInstallPointer (Join-Path $bridgeData 'host.json') $bridgeInstall
  Write-Host 'Host installed. Keep the official Codex app signed in. OpenSSH Server and Tailscale must already be configured.'
  & (Join-Path $bridgeInstall 'Show-HostInfo.ps1')
}
if($Role -eq 'Client' -or $Role -eq 'Both'){
  Save-BridgeInstallPointer (Join-Path $bridgeData 'client.json') $bridgeInstall
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
}finally{if($bridgeOwnsInstallerLock){$bridgeInstallerLock.ReleaseMutex()};$bridgeInstallerLock.Dispose()}
