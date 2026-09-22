param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
$bridgeTestRoot=Join-Path ([IO.Path]::GetTempPath()) ('csb-update-install-test-'+[Guid]::NewGuid().ToString())
$bridgeOriginalLocal=$env:LOCALAPPDATA
$bridgeSourceArchive=$Archive
. (Join-Path $Stage 'src\update-package.ps1')
# Supply the built ZIP without network; use the actual extraction, verification, staging and activation code.
function Get-BridgeUpdateArchive([string]$Release,[string]$Target,[string]$Hash){
 Copy-Item -LiteralPath $bridgeSourceArchive -Destination $Target
 if((Get-FileHash -LiteralPath $Target).Hash.ToLowerInvariant() -ne $Hash){throw 'Fixture archive changed'}
}
function Assert-Rejected([scriptblock]$Operation){$rejected=$false;try{& $Operation|Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Expected activation rejection'}}
try{
 $env:LOCALAPPDATA=$bridgeTestRoot
 $Version=(Get-Content -LiteralPath (Join-Path $Stage 'package.json') -Raw|ConvertFrom-Json).version
 $ArchiveHash=(Get-FileHash -LiteralPath $Archive).Hash.ToLowerInvariant()
 $CompatibilityHash=(Get-FileHash -LiteralPath (Join-Path $Stage 'compatibility.json')).Hash.ToLowerInvariant()
 $data=Join-Path $bridgeTestRoot 'CodexSessionBridge';[IO.Directory]::CreateDirectory($data)|Out-Null
 foreach($name in @('client','host')){[IO.File]::WriteAllText((Join-Path $data ($name+'.json')),(@{version=1;release='0.0.1';installPath='C:\fixture\previous'}|ConvertTo-Json))}
 $hostPointer=Join-Path $data 'host.json';$clientPointer=Join-Path $data 'client.json'
 $hostBefore=(Get-FileHash -LiteralPath $hostPointer).Hash;$clientBefore=(Get-FileHash -LiteralPath $clientPointer).Hash
 $Mode='Prepare';$Role='Host';$prepared=Invoke-BridgePackageUpdate
 if((Get-FileHash -LiteralPath $hostPointer).Hash -ne $hostBefore){throw 'Staging activated the host early'}
 $ManifestHash=$prepared.manifestHash;$ExpectedPointerHash='0'*64;$Mode='Activate'
 Assert-Rejected {Invoke-BridgePackageUpdate}
 if((Get-FileHash -LiteralPath $hostPointer).Hash -ne $hostBefore){throw 'Rejected activation changed the pointer'}
 $ExpectedPointerHash=$prepared.pointerHash;$first=Invoke-BridgePackageUpdate;$second=Invoke-BridgePackageUpdate
 if($first.installPath -ne $second.installPath){throw 'Activation is not idempotent'}
 if((Get-FileHash -LiteralPath $clientPointer).Hash -ne $clientBefore){throw 'Host activation changed the client'}
 $readme=Join-Path $prepared.installPath 'README.md';$saved=[IO.File]::ReadAllBytes($readme)
 [IO.File]::AppendAllText($readme,'tampered');Assert-Rejected {Invoke-BridgePackageUpdate};[IO.File]::WriteAllBytes($readme,$saved)
 $Mode='Prepare';$Role='Client';$preparedClient=Invoke-BridgePackageUpdate
 $Mode='Activate';$ManifestHash=$preparedClient.manifestHash;$ExpectedPointerHash=$preparedClient.pointerHash
 $client=Invoke-BridgePackageUpdate
 if($client.installPath -ne $first.installPath){throw 'The pair did not converge'}
 Write-Output '{"stagePreservedPointers":true,"compareAndSwap":true,"idempotentActivation":true,"tamperRejected":true,"bothRoles":true}'
}finally{
 $env:LOCALAPPDATA=$bridgeOriginalLocal
 $target=[IO.Path]::GetFullPath($bridgeTestRoot);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
 if([IO.Path]::GetDirectoryName($target) -ne $parent -or [IO.Path]::GetFileName($target) -notmatch '^csb-update-install-test-[a-f0-9-]{36}$'){throw 'Invalid test cleanup path'}
 if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}
}
