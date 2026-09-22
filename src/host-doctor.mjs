import {installedDesktop,discoverCli} from './installed.mjs';
import {DesktopIpc} from './ipc.mjs';
const desktop=installedDesktop('host');
const report={bridgeVersion:'0.19.9',platform:process.platform,architecture:process.arch,appVersions:desktop.versions??[],appCompatible:desktop.testedBuild===true,cliCompatible:false,ipcReady:false};
try{const cli=discoverCli();report.cliVersion=cli.version;report.cliCompatible=true}catch{report.cliError='Compatible official CLI cache not found'}
const ipc=new DesktopIpc();
if(report.appCompatible){try{await ipc.connect();report.ipcReady=true}catch{report.ipcError='Original Codex desktop IPC is unavailable'}finally{ipc.close()}}
report.ready=report.appCompatible&&report.cliCompatible&&report.ipcReady;
console.log(JSON.stringify(report));process.exitCode=report.ready?0:2;
