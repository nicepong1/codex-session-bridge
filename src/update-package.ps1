param(
 [ValidateSet('Prepare','Activate')][string]$Mode,
 [ValidateSet('Client','Host')][string]$Role,
 [string]$Version,[string]$ArchiveHash,[string]$CompatibilityHash,
 [string]$ManifestHash,[string]$ExpectedPointerHash
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

function Assert-BridgeUpdatePath([string]$Name){
 if($Name -notmatch '^[A-Za-z0-9_@./-]+$' -or $Name.StartsWith('/') -or $Name.EndsWith('/')){throw 'Invalid package path'}
 foreach($part in $Name.Split('/')){
  if(!$part -or $part -in @('.','..') -or $part.EndsWith('.') -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw 'Unsafe package path'}
 }
}
function Expand-BridgeUpdate([string]$Archive,[string]$Destination){
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 Add-Type -AssemblyName System.IO.Compression
 if(Test-Path -LiteralPath $Destination){throw 'Extraction directory already exists'}
 $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
 try{
  $seen=@{};$total=[long]0;$files=@();$count=0
  foreach($entry in $zip.Entries){
   if(++$count -gt 5000){throw 'Too many package entries'}
   # Windows Compress-Archive writes backslashes; normalize before validating and detecting duplicates.
   $normalized=$entry.FullName.Replace('\','/')
   $name=$normalized.TrimEnd('/')
   Assert-BridgeUpdatePath $name
   if($name -ne 'codex-session-bridge' -and !$name.StartsWith('codex-session-bridge/',[StringComparison]::Ordinal)){throw 'Unexpected archive root'}
   if($seen.ContainsKey($name)){throw 'Duplicate package path'};$seen[$name]=$true
   $kind=($entry.ExternalAttributes -shr 16) -band 0xf000
   if($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000){throw 'Linked or special package entry'}
   if(($entry.ExternalAttributes -band 0x400) -ne 0){throw 'Reparse package entry'}
   if($entry.Length -gt 128MB){throw 'Package file too large'}
   $total+=$entry.Length;if($total -gt 512MB){throw 'Expanded package too large'}
   if(!$normalized.EndsWith('/')){$files+=,@{entry=$entry;name=$name}}
  }
  [IO.Directory]::CreateDirectory($Destination)|Out-Null
  foreach($file in $files){
   $target=Join-Path $Destination $file.name
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
   [IO.Compression.ZipFileExtensions]::ExtractToFile($file.entry,$target,$false)
  }
 }finally{$zip.Dispose()}
}
function Test-BridgeUpdatePackage([string]$Root,[string]$Release,[string]$MatrixHash){
 $manifestPath=Join-Path $Root 'release-files.json'
 if((Get-Item -LiteralPath $manifestPath).Length -gt 1MB){throw 'Release manifest too large'}
 $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
 if($manifest.version -ne $Release -or !$manifest.files -or @($manifest.files).Count -gt 5000){throw 'Invalid release manifest'}
 $seen=@{'release-files.json'=$true}
 foreach($file in $manifest.files){
  Assert-BridgeUpdatePath $file.path
  if($seen.ContainsKey($file.path) -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid release manifest entry'}
  $seen[$file.path]=$true
  $target=Join-Path $Root $file.path
  if(!(Test-Path -LiteralPath $target -PathType Leaf) -or (Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Release file checksum failed'}
 }
 foreach($file in (Get-ChildItem -LiteralPath $Root -Recurse -File)){
  if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Linked release file'}
  if(!$seen.ContainsKey($file.FullName.Substring($Root.Length+1).Replace('\','/'))){throw 'Unlisted release file'}
 }
 foreach($required in @('Install.ps1','Open-Bridge.ps1','runtime/node.exe','src/launch-update.mjs','src/install-context.ps1','src/install-files.ps1','compatibility.json','package.json')){
  if(!$seen.ContainsKey($required)){throw 'Incomplete update package'}
 }
 if((Get-FileHash -LiteralPath (Join-Path $Root 'compatibility.json')).Hash.ToLowerInvariant() -ne $MatrixHash){throw 'Compatibility metadata changed'}
 if((Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw|ConvertFrom-Json).version -ne $Release){throw 'Package version mismatch'}
 return (Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant()
}
function Get-BridgeUpdateArchive([string]$Release,[string]$Target,[string]$Hash){
 Add-Type -AssemblyName System.Net.Http
 $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
 $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(90)
 $cts=[Threading.CancellationTokenSource]::new();$cts.CancelAfter(90000)
 try{
  $url=[Uri]('https://github.com/nicepong1/codex-session-bridge/releases/download/v'+$Release+'/codex-session-bridge-'+$Release+'-windows-x64.zip')
  for($redirect=0;$redirect -le 3;$redirect++){
   if($url.Scheme -ne 'https' -or $url.Port -ne 443 -or $url.UserInfo -or $url.DnsSafeHost -notin @('github.com','release-assets.githubusercontent.com')){throw 'Unexpected download origin'}
   $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,$url)
   $request.Headers.UserAgent.ParseAdd('codex-session-bridge-updater')
   $response=$client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cts.Token).GetAwaiter().GetResult()
   try{
    if([int]$response.StatusCode -in @(301,302,303,307,308)){
     if(!$response.Headers.Location){throw 'Missing download redirect'}
     $url=[Uri]::new($url,$response.Headers.Location);continue
    }
    $response.EnsureSuccessStatusCode()|Out-Null
    if($response.Content.Headers.ContentLength -gt 128MB){throw 'Download too large'}
    $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output=[IO.File]::Open($Target,[IO.FileMode]::CreateNew)
    try{
     $buffer=New-Object byte[] 65536;$total=[long]0
     while(($n=$stream.ReadAsync($buffer,0,$buffer.Length,$cts.Token).GetAwaiter().GetResult()) -gt 0){
      $total+=$n;if($total -gt 128MB){throw 'Download too large'};$output.Write($buffer,0,$n)
     }
    }finally{$output.Dispose();$stream.Dispose()}
    if((Get-FileHash -LiteralPath $Target).Hash.ToLowerInvariant() -ne $Hash){throw 'Published ZIP checksum mismatch'}
    return
   }finally{$response.Dispose();$request.Dispose()}
  }
  throw 'Too many download redirects'
 }finally{$cts.Dispose();$client.Dispose();$handler.Dispose()}
}
function Invoke-BridgePackageUpdate {
 if($Version -cnotmatch '^\d+\.\d+\.\d+$' -or $CompatibilityHash -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid update request'}
 $data=Join-Path $env:LOCALAPPDATA 'CodexSessionBridge'
 $pointer=Join-Path $data ($Role.ToLowerInvariant()+'.json')
 $base=Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge\versions'
 if(!(Test-Path -LiteralPath $pointer -PathType Leaf)){throw 'Installation pointer missing'}
 if($Mode -eq 'Prepare'){
  if($ArchiveHash -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid archive digest'}
  $before=(Get-FileHash -LiteralPath $pointer).Hash.ToLowerInvariant()
  $old=Get-Content -LiteralPath $pointer -Raw -Encoding UTF8|ConvertFrom-Json
  if($old.release -notmatch '^\d+\.\d+\.\d+$' -or [version]$old.release -gt [version]$Version){throw 'Refusing downgrade'}
  $temp=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('csb-update-'+[Guid]::NewGuid().ToString())))
  [IO.Directory]::CreateDirectory($temp)|Out-Null
  try{
   $archive=Join-Path $temp 'release.zip';$expanded=Join-Path $temp 'expanded'
   Get-BridgeUpdateArchive $Version $archive $ArchiveHash
   Expand-BridgeUpdate $archive $expanded
   $root=Join-Path $expanded 'codex-session-bridge'
   $digest=Test-BridgeUpdatePackage $root $Version $CompatibilityHash
   & (Join-Path $root 'Install.ps1') -Role $Role -NoConfigure -NoShortcut -StageOnly|Out-Null
   $install=Join-Path $base ($Version+'-'+$digest.Substring(0,12))
   if((Test-BridgeUpdatePackage $install $Version $CompatibilityHash) -ne $digest){throw 'Installed package differs'}
   if((Get-FileHash -LiteralPath $pointer).Hash.ToLowerInvariant() -ne $before){throw 'Installation changed during preparation; retry launch'}
   return @{manifestHash=$digest;pointerHash=$before;release=$Version;installPath=$install}
  }finally{
   # Only remove this invocation's validated, uniquely named temporary directory.
   $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
   if([IO.Path]::GetDirectoryName($temp) -eq $parent -and [IO.Path]::GetFileName($temp) -match '^csb-update-[a-f0-9-]{36}$'){
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
   }
  }
 }
 if($ManifestHash -cnotmatch '^[a-f0-9]{64}$' -or $ExpectedPointerHash -cnotmatch '^[a-f0-9]{64}$'){throw 'Invalid activation digest'}
 $install=Join-Path $base ($Version+'-'+$ManifestHash.Substring(0,12))
 $lock=[Threading.Mutex]::new($false,('Global\CodexSessionBridgeInstaller-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value));$owns=$false
 try{
  try{$owns=$lock.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owns=$true}
  if(!$owns){throw 'Another installer is running'}
  if((Test-BridgeUpdatePackage $install $Version $CompatibilityHash) -ne $ManifestHash){throw 'Staged package checksum changed'}
  . (Join-Path $install 'src\install-context.ps1');Assert-BridgeInstallerContext
  $current=Get-Content -LiteralPath $pointer -Raw -Encoding UTF8|ConvertFrom-Json
  if($current.release -eq $Version -and $current.installPath -eq $install){return @{release=$Version;installPath=$install}}
  if((Get-FileHash -LiteralPath $pointer).Hash.ToLowerInvariant() -ne $ExpectedPointerHash){throw 'Installation changed before activation; retry launch'}
  . (Join-Path $install 'src\install-files.ps1')
  Save-BridgeInstallPointer $pointer $install
  return @{release=$Version;installPath=$install}
 }finally{if($owns){$lock.ReleaseMutex()};$lock.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){
 try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Write-Output ('CSB_UPDATE:'+((Invoke-BridgePackageUpdate)|ConvertTo-Json -Compress))}
 catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}
}
