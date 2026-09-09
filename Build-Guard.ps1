$ErrorActionPreference = 'Stop'
$bridgeCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$bridgeOutput = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $bridgeOutput -Force | Out-Null
& $bridgeCompiler /nologo /optimize+ /target:exe ("/out:" + (Join-Path $bridgeOutput 'codex-gpu-guard.exe')) (Join-Path $PSScriptRoot 'src\GuardTransport.cs')
if ($LASTEXITCODE -ne 0) { throw 'Guard transport compilation failed' }
& $bridgeCompiler /nologo /optimize+ /target:exe ("/out:" + (Join-Path $bridgeOutput 'codex-interactive-opener.exe')) (Join-Path $PSScriptRoot 'src\InteractiveOpener.cs')
if ($LASTEXITCODE -ne 0) { throw 'Opener test helper compilation failed' }
