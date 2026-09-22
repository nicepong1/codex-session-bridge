param([string]$NodeArchive,[string]$NodeSha256='6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba')
$ErrorActionPreference='Stop'
$bridgeRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $bridgeRoot
$bridgeVersion=(Get-Content package.json -Raw|ConvertFrom-Json).version
$bridgeBuild=Join-Path $bridgeRoot ('dist\build-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $bridgeBuild -Force|Out-Null
if(!$NodeArchive){
 $NodeArchive=Join-Path $bridgeBuild 'node-v24.20.0-win-x64.zip'
 Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip' -OutFile $NodeArchive -UseBasicParsing
}
if((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256){throw 'Official Node.js archive checksum mismatch'}
$bridgeNodeExtract=Join-Path $bridgeBuild 'node'
Expand-Archive -LiteralPath $NodeArchive -DestinationPath $bridgeNodeExtract
$bridgeNodeRoot=Join-Path $bridgeNodeExtract 'node-v24.20.0-win-x64'
$bridgeNode=Join-Path $bridgeNodeRoot 'node.exe'
& $bridgeNode (Join-Path $bridgeNodeRoot 'node_modules\npm\bin\npm-cli.js') ci --ignore-scripts --no-audit --no-fund --cache (Join-Path $bridgeBuild 'npm-cache')
if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'}
& (Join-Path $bridgeRoot 'Build-Guard.ps1')
& $bridgeNode --test 'test/*.test.mjs'
if($LASTEXITCODE -ne 0){throw 'Tests failed'}
& (Join-Path $bridgeRoot 'Build-Guard.ps1')
$bridgeStage=Join-Path $bridgeBuild 'codex-session-bridge'
New-Item -ItemType Directory -Path $bridgeStage -Force|Out-Null
foreach($bridgeDirectory in @('src','diagnostics','docs','assets')){Copy-Item -LiteralPath (Join-Path $bridgeRoot $bridgeDirectory) -Destination (Join-Path $bridgeStage $bridgeDirectory) -Recurse}
New-Item -ItemType Directory -Path (Join-Path $bridgeStage 'bin') -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $bridgeRoot 'bin\codex-gpu-guard.exe') -Destination (Join-Path $bridgeStage 'bin\codex-gpu-guard.exe')
foreach($bridgeFile in @('Install.cmd','Install.ps1','Open-Bridge.ps1','Configure.cmd','Diagnose.cmd','Check-Updates.cmd','Show-HostInfo.cmd','Show-HostInfo.ps1','Uninstall.ps1','README.md','LICENSE','THIRD-PARTY-NOTICES.md','package.json','package-lock.json','compatibility.json')){Copy-Item -LiteralPath (Join-Path $bridgeRoot $bridgeFile) -Destination (Join-Path $bridgeStage $bridgeFile)}
New-Item -ItemType Directory -Path (Join-Path $bridgeStage 'runtime'),(Join-Path $bridgeStage 'node_modules') -Force|Out-Null
Copy-Item -LiteralPath $bridgeNode -Destination (Join-Path $bridgeStage 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $bridgeNodeRoot 'LICENSE') -Destination (Join-Path $bridgeStage 'runtime\NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $bridgeRoot 'node_modules\ws') -Destination (Join-Path $bridgeStage 'node_modules\ws') -Recurse
& $bridgeNode scripts/audit-release.mjs --stage $bridgeStage
if($LASTEXITCODE -ne 0){throw 'Distribution audit failed'}
$bridgeEntries=@(Get-ChildItem -LiteralPath $bridgeStage -File -Recurse|Sort-Object FullName|ForEach-Object{@{path=$_.FullName.Substring($bridgeStage.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
[IO.File]::WriteAllText((Join-Path $bridgeStage 'release-files.json'),(@{version=$bridgeVersion;nodeVersion='24.20.0';files=$bridgeEntries}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$bridgeZip=Join-Path $bridgeRoot ('dist\codex-session-bridge-'+$bridgeVersion+'-windows-x64.zip')
if(Test-Path -LiteralPath $bridgeZip){throw 'Release ZIP exists. Preserve the old artifact or build a new version.'}
Compress-Archive -LiteralPath $bridgeStage -DestinationPath $bridgeZip -CompressionLevel Optimal
$bridgeDigest=(Get-FileHash -LiteralPath $bridgeZip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($bridgeZip+'.sha256'),($bridgeDigest+'  '+[IO.Path]::GetFileName($bridgeZip)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
Write-Output ('Release ZIP: '+$bridgeZip)
Write-Output ('SHA256: '+$bridgeDigest)
