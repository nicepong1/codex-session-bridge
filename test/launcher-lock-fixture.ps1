$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\src\desktop-launcher.ps1')
Add-Type -TypeDefinition @'
using System.Threading;
public static class BridgeAbandonedLockFixture {
  public static void Abandon(Mutex mutex) {
    Thread owner=new Thread(()=>{mutex.WaitOne();});
    owner.Start(); owner.Join(); // Deliberately exit the owning OS thread.
  }
}
'@
$bridgeMutex=[Threading.Mutex]::new($false,('Global\CodexSessionBridgeLockTest-'+[Guid]::NewGuid().ToString()))
try {
 [BridgeAbandonedLockFixture]::Abandon($bridgeMutex)
 $bridgeAbandoned=$false
 try{[void]$bridgeMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$bridgeAbandoned=$true}
 if(!$bridgeAbandoned){throw 'Fixture did not create an abandoned Windows mutex'}
 $bridgeMutex.ReleaseMutex()
 [BridgeAbandonedLockFixture]::Abandon($bridgeMutex)
 if(!(Enter-GpuBridgeLauncherLock -Mutex $bridgeMutex)){throw 'Launcher rejected abandoned lock ownership'}
 $bridgeMutex.ReleaseMutex()
 if(!(Enter-GpuBridgeLauncherLock -Mutex $bridgeMutex)){throw 'Normal launcher acquisition failed'}
 $bridgeMutex.ReleaseMutex()
 Write-Output 'launcher-lock-recovery-ok'
}finally{$bridgeMutex.Dispose()}
