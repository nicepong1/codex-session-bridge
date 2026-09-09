$ErrorActionPreference='Stop'
Write-Output ('Windows user: '+[Security.Principal.WindowsIdentity]::GetCurrent().Name)
Write-Output ('Computer: '+$env:COMPUTERNAME)
$bridgeTailscale=Get-Command tailscale.exe -ErrorAction SilentlyContinue
if($bridgeTailscale){ & $bridgeTailscale.Source ip -4 }
$bridgeKeys=Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'ssh') -Filter 'ssh_host_*_key.pub' -ErrorAction SilentlyContinue
if(!$bridgeKeys){Write-Output 'Install/start Windows OpenSSH Server first. See docs/USER-GUIDE.md.'}
foreach($bridgeKey in $bridgeKeys){ & ssh-keygen.exe -lf $bridgeKey.FullName -E sha256 }
& (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'src\host-doctor.mjs')
