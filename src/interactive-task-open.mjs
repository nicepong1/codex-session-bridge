import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {UUID} from './guard-policy.mjs';
const execute = promisify(execFile);

export function interactiveOpenScript(id) {
  if (!UUID.test(id ?? '')) throw new Error('Invalid existing GPU task ID');
  const action = "$ErrorActionPreference='Stop'; Start-Process -FilePath 'codex://threads/" + id + "'";
  return interactiveActionScript(action);
}

export function interactiveHelperScript(pipeToken, parentPid, seconds, sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(pipeToken ?? '') || !Number.isSafeInteger(parentPid) || parentPid < 1 ||
      !Number.isInteger(seconds) || seconds < 10 || seconds > 3600 || !/^[a-f0-9]{64}$/.test(sourceHash ?? '')) throw new Error('Invalid helper lifetime or endpoint');
  // Resolve only our fixed executable; no external command/path is accepted.
  return interactiveActionScript('', {sourceHash, pipeToken, parentPid, seconds});
}

function interactiveActionScript(action, helper) {
  const encoded = Buffer.from(action, 'utf16le').toString('base64');
  return `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$bridgeTaskName='CodexSessionBridge-Open-'+[Guid]::NewGuid().ToString()
$bridgeUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$bridgeService=New-Object -ComObject 'Schedule.Service'
$bridgeService.Connect()
$bridgeFolder=$bridgeService.GetFolder('\\')
$bridgeDefinition=$bridgeService.NewTask(0)
$bridgeDefinition.Principal.UserId=$bridgeUser
$bridgeDefinition.Principal.LogonType=3
$bridgeDefinition.Principal.RunLevel=0
$bridgeDefinition.Settings.Enabled=$true
$bridgeDefinition.Settings.Hidden=$true
$bridgeDefinition.Settings.AllowDemandStart=$true
$bridgeDefinition.Settings.ExecutionTimeLimit='PT${helper?.seconds ?? 30}S'
$bridgeDefinition.Settings.DisallowStartIfOnBatteries=$false
$bridgeDefinition.Settings.StopIfGoingOnBatteries=$false
$bridgeAction=$bridgeDefinition.Actions.Create(0)
$bridgeAction.Path=${helper ? `Join-Path $env:LOCALAPPDATA 'CodexSessionBridge\\bin\\opener-${helper.sourceHash}.exe'` : "Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'"}
$bridgeAction.Arguments='${helper ? `${helper.pipeToken} ${helper.parentPid} ${helper.seconds}` : `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`}'
$bridgeRegistered=$false
try {
 $bridgeTask=$bridgeFolder.RegisterTaskDefinition($bridgeTaskName,$bridgeDefinition,2,$bridgeUser,$null,3,$null)
 $bridgeRegistered=$true
 $bridgeStarted=[DateTime]::UtcNow.AddSeconds(-2)
 $bridgeTask.Run($null) | Out-Null
 $bridgeDeadline=[DateTime]::UtcNow.AddSeconds(15)
 do {
  Start-Sleep -Milliseconds 100
  ${helper ? "if ($bridgeTask.LastRunTime.ToUniversalTime() -ge $bridgeStarted -and $bridgeTask.State -eq 4) { return }" : ''}
  if ($bridgeTask.LastRunTime.ToUniversalTime() -ge $bridgeStarted -and $bridgeTask.State -eq 3) {
   if ($bridgeTask.LastTaskResult -ne 0) { throw ('Interactive GPU task opening failed: code '+$bridgeTask.LastTaskResult) }
   return
  }
 } while ([DateTime]::UtcNow -lt $bridgeDeadline)
 throw 'Interactive GPU task opening timed out'
} finally {
 if ($bridgeRegistered) { $bridgeFolder.DeleteTask($bridgeTaskName,0) }
}
`;
}

export async function openInInteractiveDesktop(id) {
  return runInteractiveScript(interactiveOpenScript(id));
}

export async function runInteractiveScript(script) {
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024});
  } catch (error) {
    const result = /opening failed: code (\d+)/.exec(String(error.stderr ?? ''));
    throw new Error('GPU official app opening failed' + (result ? ' (code ' + result[1] + ')' : '; check the signed-in desktop session'));
  }
}
