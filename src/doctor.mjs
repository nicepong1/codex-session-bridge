import {prepareRemoteProfile} from './remote-installation.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {loadProfile} from './connection-config.mjs';
import {sshArguments,remoteNodeCommand} from './ssh-command.mjs';
import {installedDesktop} from './installed.mjs';
const execute=promisify(execFile);
export async function diagnose(profile=loadProfile()){
  const local=installedDesktop('client');
  const report={profileId:profile.id,client:{appVersions:local.versions??[],compatible:local.testedBuild===true},host:null,ready:false};
  try{
    const prepared=await prepareRemoteProfile(profile);
    let stdout;
    try{({stdout}=await execute('ssh',sshArguments(prepared,remoteNodeCommand(prepared,'host-doctor.mjs')),{windowsHide:true,timeout:45000,maxBuffer:65536}))}
    catch(e){if(e.code===2&&e.stdout)stdout=e.stdout;else throw e}
    const remote=JSON.parse(stdout.trim());
    if(remote.bridgeVersion!=='0.19.5'||typeof remote.ready!=='boolean')throw Error('Invalid host diagnostic');
    report.host=remote;report.ready=report.client.compatible&&remote.ready;
  }catch(e){
    const text=String(e.stderr??'');
    report.connectionError=/Permission denied/i.test(text)?'SSH key authentication failed':/HOST IDENTIFICATION|Host key verification/i.test(text)?'SSH host key changed or is missing':/version mismatch/i.test(text)?'Install the same bridge release on both PCs':'Host unavailable: check Tailscale, SSH and host installation';
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const r=await diagnose();console.log(JSON.stringify(r,null,2));process.exitCode=r.ready?0:2}
  catch{console.error('No valid connection profile. Run Configure.cmd first.');process.exitCode=2}
}
