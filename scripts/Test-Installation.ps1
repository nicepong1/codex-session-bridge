param([Parameter(Mandatory=$true)][string]$Stage)
$ErrorActionPreference='Stop'
$bridgeTestRoot=Join-Path ([IO.Path]::GetTempPath()) ('csb-install-test-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $bridgeTestRoot|Out-Null
$bridgeOriginalLocal=$env:LOCALAPPDATA
try{
 $env:LOCALAPPDATA=$bridgeTestRoot
 & (Join-Path $Stage 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null
 $bridgePointer=Join-Path $bridgeTestRoot 'CodexSessionBridge\client.json'
 $bridgeInstalled=(Get-Content -LiteralPath $bridgePointer -Raw|ConvertFrom-Json).installPath
 if(!([IO.Path]::GetFullPath($bridgeInstalled)).StartsWith([IO.Path]::GetFullPath($bridgeTestRoot)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Installer escaped the test user directory'}
 $bridgeMarker=Join-Path $bridgeTestRoot 'CodexSessionBridge\preserve-test.txt'
 [IO.File]::WriteAllText($bridgeMarker,'preserve')
 & (Join-Path $Stage 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null
 if((Get-Content -LiteralPath $bridgeMarker -Raw) -ne 'preserve'){throw 'Reinstall overwrote user data'}
 $bridgeReadme=Join-Path $bridgeInstalled 'README.md'
 $bridgeOriginal=[IO.File]::ReadAllBytes($bridgeReadme)
 [IO.File]::AppendAllText($bridgeReadme,'checksum-test')
 $bridgeRejected=$false
 try{& (Join-Path $Stage 'Install.ps1') -Role Client -NoConfigure -NoShortcut|Out-Null}catch{$bridgeRejected=$_.Exception.Message -match 'Existing installation differs'}
 if(!$bridgeRejected){throw 'Reinstall did not reject altered files'}
 [IO.File]::WriteAllBytes($bridgeReadme,$bridgeOriginal)
 & (Join-Path $bridgeInstalled 'Uninstall.ps1') -KeepShortcut|Out-Null
 if(Test-Path -LiteralPath $bridgeInstalled){throw 'Version removal failed'}
 if(!(Test-Path -LiteralPath $bridgeMarker)){throw 'Uninstall removed user data'}
 Write-Output '{"install":true,"reinstall":true,"checksumRejection":true,"uninstall":true,"userDataPreserved":true}'
}finally{
 $env:LOCALAPPDATA=$bridgeOriginalLocal
 $bridgeResolved=[IO.Path]::GetFullPath($bridgeTestRoot)
 $bridgeTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 if(!$bridgeResolved.StartsWith($bridgeTemp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($bridgeResolved) -notmatch '^csb-install-test-[a-f0-9-]{36}$'){throw 'Invalid test cleanup target'}
 Remove-Item -LiteralPath $bridgeResolved -Recurse -Force
}
