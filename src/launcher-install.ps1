function Resolve-BridgeLauncherInstallation([string]$Fallback,[string]$Data,[string]$Base=(Join-Path $env:LOCALAPPDATA 'Programs\CodexSessionBridge\versions')) {
 $pointer=Join-Path $Data 'client.json'
 if(!(Test-Path -LiteralPath $pointer -PathType Leaf)){return $Fallback}
 $client=Get-Content -LiteralPath $pointer -Raw -Encoding UTF8|ConvertFrom-Json
 $root=[IO.Path]::GetFullPath($client.installPath).TrimEnd('\')
 if($client.version -ne 1 -or $client.release -notmatch '^\d+\.\d+\.\d+$' -or
    [IO.Path]::GetDirectoryName($root) -ne [IO.Path]::GetFullPath($Base).TrimEnd('\') -or
    [IO.Path]::GetFileName($root) -notmatch ('^'+[regex]::Escape($client.release)+'-[a-f0-9]{12}$') -or
    !(Test-Path -LiteralPath (Join-Path $root 'Open-Bridge.ps1') -PathType Leaf)){throw 'Invalid bridge installation pointer. Reinstall the Client package.'}
 return $root
}
