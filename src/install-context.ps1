# Package identity is not sufficient: child processes can report NO_PACKAGE
# while writes still go to LocalCache. Measure fresh files at both destinations.
function Initialize-BridgeInstallerContext {
 if(!('BridgeInstallerContext' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.IO;
using Microsoft.Win32.SafeHandles;
public static class BridgeInstallerContext {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
 public static string Probe(string directory) {
  directory=Path.GetFullPath(directory);
  bool created=!Directory.Exists(directory);
  Directory.CreateDirectory(directory);
  string file=Path.Combine(directory,".bridge-location-"+Guid.NewGuid().ToString("N")+".tmp");
  bool opened=false;
  try {
   using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None)) {
    opened=true;
    var physical=new StringBuilder(32768);
    uint length=GetFinalPathNameByHandle(stream.SafeFileHandle,physical,(uint)physical.Capacity,0);
    if(length==0 || length>=physical.Capacity) throw new IOException("Cannot verify installation file location");
    string actual=physical.ToString();
    string expected=file.StartsWith(@"\\?\")?file:@"\\?\"+file;
    return String.Equals(expected,actual,StringComparison.OrdinalIgnoreCase)?null:actual;
   }
  } finally {
   if(opened) File.Delete(file);
   if(created) { try { Directory.Delete(directory,false); } catch(IOException) {} }
  }
 }
}
'@
 }
}
function Assert-BridgeInstallerContext {
 param([string[]]$Directories=@((Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge'),(Join-Path $env:LOCALAPPDATA 'CodexSessionBridge')))
 Initialize-BridgeInstallerContext
 foreach($bridgeDirectory in $Directories){
  if([BridgeInstallerContext]::Probe($bridgeDirectory)){
   throw 'Windows redirected the installation location. Open the extracted release folder in File Explorer and run Install.cmd there. Only a temporary location check was performed; no installation was registered.'
  }
 }
}
