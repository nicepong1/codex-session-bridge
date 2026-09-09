$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\src\desktop-launcher.ps1')
$bridgeTemp=[IO.Path]::GetTempPath()
foreach($bridgeName in @('codex-gpu-guard-endpoint-1234.json','codex-gpu-guard-endpoint-1234-12345678-1234-1234-1234-123456789abc.json')){
 $bridgeValue=Join-Path $bridgeTemp $bridgeName
 if((Get-GpuBridgeEndpointPath -Report @{endpointFile=$bridgeValue} -HubProcessId 1234) -ne [IO.Path]::GetFullPath($bridgeValue)){throw 'Valid endpoint path rejected'}
}
foreach($bridgeBad in @((Join-Path $bridgeTemp 'codex-gpu-guard-endpoint-9999.json'),(Join-Path $bridgeTemp 'elsewhere\codex-gpu-guard-endpoint-1234.json'),(Join-Path $bridgeTemp 'codex-gpu-guard-endpoint-1234-bad.json'))){
 $bridgeRejected=$false;try{Get-GpuBridgeEndpointPath -Report @{endpointFile=$bridgeBad} -HubProcessId 1234|Out-Null}catch{$bridgeRejected=$true}
 if(!$bridgeRejected){throw 'Invalid endpoint path accepted'}
}
Write-Output 'endpoint-paths-ok'
