$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\desktop-launcher.ps1')
$stamp=[DateTime]::UtcNow
$profile=Join-Path ([IO.Path]::GetTempPath()) 'codex-gpu-guard-ABC123'
$report=[pscustomobject]@{mode='hub';status='guard-ready';pid=101;appPid=102;startedAt=$stamp;profilePath=$profile}
$runner=[pscustomobject]@{ProcessId=101;Name='node.exe';CreationDate=$stamp;CommandLine='node src/desktop-hub.mjs --report reports/hub-test.json --launch'}
$app=[pscustomobject]@{ProcessId=102;ParentProcessId=101;ExecutablePath='C:\Program Files\WindowsApps\OpenAI.Codex_26.901.6511.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe';CommandLine='ChatGPT.exe --user-data-dir='+$profile+'\user-data'}
$results=@()
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$report.status='reconnecting'
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$app.ParentProcessId=999
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$app.ParentProcessId=101
$runner.CreationDate=$stamp.AddMinutes(1)
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$runner.CreationDate=$stamp
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-other.json'
$report.status='stopped'
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$report.status='guard-ready'
$app.CommandLine='ChatGPT.exe --user-data-dir=C:\Users\ordinary-app'
$results+=Test-GpuBridgeApp $report $runner $app 'reports/hub-test.json'
$results | ConvertTo-Json -Compress
