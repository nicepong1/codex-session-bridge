# Called only after the release manifest and all source files have been verified.
function Assert-BridgeManagedDirectory([string]$Path,[string]$Base) {
  $bridgeChecked=[IO.Path]::GetFullPath($Path).TrimEnd('\')
  $bridgeParent=[IO.Path]::GetFullPath($Base).TrimEnd('\')
  if([IO.Path]::GetDirectoryName($bridgeChecked) -ne $bridgeParent){throw 'Installation target is outside the version directory'}
  foreach($bridgePart in @($bridgeParent,$bridgeChecked)){
    if((Test-Path -LiteralPath $bridgePart) -and [BridgeInstallReparse]::IsLinked($bridgePart)){throw 'Linked installation directory is not supported'}
  }
  return $bridgeChecked
}

function Test-BridgeInstalledFiles([string]$Directory,$Files,[switch]$AllowMissing) {
  $bridgeQueue=[Collections.Generic.Queue[string]]::new();$bridgeQueue.Enqueue($Directory)
  while($bridgeQueue.Count){
    foreach($bridgeItem in Get-ChildItem -LiteralPath $bridgeQueue.Dequeue() -Force){
      if([BridgeInstallReparse]::IsLinked($bridgeItem.FullName)){return $false}
      if($bridgeItem.PSIsContainer){$bridgeQueue.Enqueue($bridgeItem.FullName)}
    }
  }
  foreach($bridgeEntry in $Files){
    $bridgeFile=Join-Path $Directory $bridgeEntry.path
    if(!(Test-Path -LiteralPath $bridgeFile)){if($AllowMissing){continue};return $false}
    if(!(Test-Path -LiteralPath $bridgeFile -PathType Leaf) -or
       [BridgeInstallReparse]::IsLinked($bridgeFile) -or
       (Get-FileHash -LiteralPath $bridgeFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bridgeEntry.sha256){return $false}
  }
  return $true
}

function Move-BridgeIncompleteInstall([string]$Directory,[string]$Base,$Files,[string]$DataDirectory) {
  $bridgeChecked=Assert-BridgeManagedDirectory $Directory $Base
  # A completion manifest, installed pointer, unknown/changed file, link, or a
  # running process makes this an existing installation, not a recoverable copy.
  if(Test-Path -LiteralPath (Join-Path $bridgeChecked 'release-files.json')){throw 'Existing installation differs. Preserve it and use a new release.'}
  foreach($bridgeName in @('client.json','host.json')){
    $bridgePointer=Join-Path $DataDirectory $bridgeName
    if(Test-Path -LiteralPath $bridgePointer){
      $bridgeExisting=Get-Content -LiteralPath $bridgePointer -Raw|ConvertFrom-Json
      if([IO.Path]::GetFullPath($bridgeExisting.installPath).TrimEnd('\') -eq $bridgeChecked){throw 'Existing installation differs. Installed pointer must not be replaced by recovery.'}
    }
  }
  $bridgeAllowed=@{};foreach($bridgeEntry in $Files){$bridgeAllowed[$bridgeEntry.path]=$true}
  # Walk one level at a time so a junction is rejected before descending into it.
  $bridgeQueue=[Collections.Generic.Queue[string]]::new();$bridgeQueue.Enqueue($bridgeChecked)
  while($bridgeQueue.Count){
    foreach($bridgeItem in Get-ChildItem -LiteralPath $bridgeQueue.Dequeue() -Force){
      if([BridgeInstallReparse]::IsLinked($bridgeItem.FullName)){throw 'Existing installation differs. Linked paths cannot be recovered.'}
      if($bridgeItem.PSIsContainer){$bridgeQueue.Enqueue($bridgeItem.FullName)}
      elseif(!$bridgeAllowed.ContainsKey($bridgeItem.FullName.Substring($bridgeChecked.Length+1).Replace('\','/'))){throw 'Existing installation differs. Unknown files were preserved.'}
    }
  }
  if(!(Test-BridgeInstalledFiles $bridgeChecked $Files -AllowMissing)){
    $bridgeChanged=@($Files|Where-Object {
      $bridgeCandidate=Join-Path $bridgeChecked $_.path
      (Test-Path -LiteralPath $bridgeCandidate -PathType Leaf) -and (Get-FileHash -LiteralPath $bridgeCandidate).Hash.ToLowerInvariant() -ne $_.sha256
    }|Select-Object -First 1)
    throw ('Existing installation differs. Changed or truncated file was preserved: '+($bridgeChanged.path -join ', ')+'. See the manual recovery section in docs/TROUBLESHOOTING.md.')
  }
  $bridgeRunning=@(Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($bridgeChecked+'\',[StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf($bridgeChecked,[StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  if($bridgeRunning.Count){throw 'Existing installation differs. Close processes using this directory before recovery.'}
  $bridgeBackup=Assert-BridgeManagedDirectory (Join-Path $Base ('.incomplete-'+[IO.Path]::GetFileName($bridgeChecked)+'-'+[Guid]::NewGuid().ToString())) $Base
  [IO.Directory]::Move($bridgeChecked,$bridgeBackup)
  Write-Host ('Preserved incomplete installation: '+$bridgeBackup)
}

function Install-BridgeFiles([string]$Source,[string]$Destination,$Files,[string]$DataDirectory) {
  $bridgeSourceManifest=Join-Path $Source 'release-files.json'
  $bridgeSourceManifestHash=(Get-FileHash -LiteralPath $bridgeSourceManifest -Algorithm SHA256).Hash
  $bridgeBase=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))
  New-Item -ItemType Directory -Path $bridgeBase -Force|Out-Null
  $bridgeTarget=Assert-BridgeManagedDirectory $Destination $bridgeBase
  if(Test-Path -LiteralPath $bridgeTarget){
    if(Test-BridgeInstalledFiles $bridgeTarget $Files){
      $bridgeManifest=Join-Path $bridgeTarget 'release-files.json'
      if((Test-Path -LiteralPath $bridgeManifest -PathType Leaf) -and
         (Get-FileHash -LiteralPath $bridgeManifest).Hash -eq $bridgeSourceManifestHash){return}
    }
    Move-BridgeIncompleteInstall $bridgeTarget $bridgeBase $Files $DataDirectory
  }
  $bridgeStage=Assert-BridgeManagedDirectory (Join-Path $bridgeBase ('.staging-'+[IO.Path]::GetFileName($bridgeTarget)+'-'+[Guid]::NewGuid().ToString())) $bridgeBase
  New-Item -ItemType Directory -Path $bridgeStage|Out-Null
  try {
    foreach($bridgeEntry in $Files){
      $bridgeFile=Join-Path $bridgeStage $bridgeEntry.path
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($bridgeFile)) -Force|Out-Null
      Copy-Item -LiteralPath (Join-Path $Source $bridgeEntry.path) -Destination $bridgeFile
    }
    if(!(Test-BridgeInstalledFiles $bridgeStage $Files)){throw 'Staged installation checksum failed'}
    $bridgeStagedManifest=Join-Path $bridgeStage 'release-files.json'
    Copy-Item -LiteralPath $bridgeSourceManifest -Destination $bridgeStagedManifest
    if((Get-FileHash -LiteralPath $bridgeStagedManifest -Algorithm SHA256).Hash -ne $bridgeSourceManifestHash){throw 'Staged release manifest checksum failed'}
    [void](Assert-BridgeManagedDirectory $bridgeStage $bridgeBase)
    [void](Assert-BridgeManagedDirectory $bridgeTarget $bridgeBase)
    [IO.Directory]::Move($bridgeStage,$bridgeTarget)
  } catch {
    # A failed staging directory is never treated as an installed version.
    # Preserve it for diagnosis; the next run uses a new staging directory.
    Write-Warning ('Incomplete staging files preserved: '+$bridgeStage)
    throw
  }
}

function Save-BridgeInstallPointer([string]$File,[string]$InstallPath) {
  $bridgeTemp=$File+'.tmp-'+[Guid]::NewGuid().ToString()
  $bridgePointer=@{version=1;release='0.18.3';installPath=$InstallPath}|ConvertTo-Json
  try {
    [IO.File]::WriteAllText($bridgeTemp,$bridgePointer,[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $File){[IO.File]::Replace($bridgeTemp,$File,($File+'.backup-'+[Guid]::NewGuid().ToString()))}
    else{[IO.File]::Move($bridgeTemp,$File)}
  }finally{if(Test-Path -LiteralPath $bridgeTemp){Remove-Item -LiteralPath $bridgeTemp}}
}
