import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RpcPeer} from './json-rpc-peer.mjs';
import {newTaskParams} from './new-task-policy.mjs';
import {BRIDGE_VERSION} from './installed.mjs';
const UUID=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const normalize=p=>path.win32.normalize(p).replace(/[\\/]+$/,'').toLowerCase();

function writeOnce(file,value) {
  const fd=fs.openSync(file,'wx');
  try{fs.writeSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

// A dedicated process owns the empty task only for metadata creation. Merely
// unsubscribing does NOT release its writer: wait for process exit before the
// desktop opens it. No turn/start or arbitrary method is available here.
export async function createEmptyGpuTask(cliPath, params) {
  const child=spawn(cliPath,['app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const rpc=new RpcPeer(m=>child.stdin.write(JSON.stringify(m)+'\n'));
  let buffer='',exited=false;
  const exit=new Promise(resolve=>child.once('close',()=>{exited=true;rpc.close();resolve();}));
  child.on('error',()=>rpc.close());child.stdin.on('error',()=>rpc.close());child.stderr.on('data',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{
    buffer+=s;
    if(buffer.length>4*1024*1024){rpc.close();child.kill();return;}
    let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.trim())try{rpc.accept(JSON.parse(line));}catch{rpc.close();child.kill();}}
  });
  try{
    await rpc.request('initialize',{clientInfo:{name:'codex_session_bridge_new_task',version:BRIDGE_VERSION},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const result=await rpc.request('thread/start',params,30000);
    if(!UUID.test(result?.thread?.id??'') || result.thread.ephemeral || normalize(result.thread.cwd)!==normalize(params.cwd)) throw Error('Unexpected GPU creation result');
    // The official API keeps new tasks unmaterialized until a first message or
    // explicit title. A title materializes an empty history without execution.
    await rpc.request('thread/name/set',{threadId:result.thread.id,name:'새 채팅'});
    // Flush the initial rollout before releasing the process.
    await rpc.request('thread/read',{threadId:result.thread.id,includeTurns:true});
    await rpc.request('thread/unsubscribe',{threadId:result.thread.id});
    return result;
  }finally{
    child.stdin.end();
    const killTimer=setTimeout(()=>{if(!exited)child.kill();},1500);
    const deadline=setTimeout(()=>{if(!exited){rpc.close();child.kill();}},8000);
    try{await exit;}finally{clearTimeout(killTimer);clearTimeout(deadline);rpc.close();}
  }
}

export class GpuNewTasks {
  constructor({request,create,journalDirectory,stat=fs.promises.stat}){Object.assign(this,{request,create,journalDirectory,stat});this.pending=new Map();}
  marker(id){if(!UUID.test(id??''))throw Error('Invalid created task');return path.join(this.journalDirectory,'created-'+id+'.json');}
  isCreated(id){return UUID.test(id??'')&&fs.existsSync(this.marker(id));}
  handle({operationId,params}){
    if(!UUID.test(operationId??''))return Promise.reject(Error('Stable creation ID required'));
    const accepted=newTaskParams(params),fingerprint=createHash('sha256').update(JSON.stringify(accepted)).digest('hex');
    const old=this.pending.get(operationId);if(old)return old.fingerprint===fingerprint?old.promise:Promise.reject(Error('Creation ID reused with different data'));
    const promise=this.createTask(operationId,accepted,fingerprint);this.pending.set(operationId,{fingerprint,promise});return promise;
  }
  async createTask(operationId,params,fingerprint){
    fs.mkdirSync(this.journalDirectory,{recursive:true});
    const requestFile=path.join(this.journalDirectory,'request-'+operationId+'.json'),resultFile=path.join(this.journalDirectory,'result-'+operationId+'.json');
    if(fs.existsSync(requestFile)){
      if(JSON.parse(fs.readFileSync(requestFile,'utf8')).fingerprint!==fingerprint)throw Error('Creation ID reused with different data');
      if(fs.existsSync(resultFile))return JSON.parse(fs.readFileSync(resultFile,'utf8'));
      throw Error('Earlier GPU task creation is unconfirmed; automatic replay refused');
    }
    const folder=await this.stat(params.cwd);if(!folder.isDirectory())throw Error('GPU source folder is not a directory');
    const projects=[];let cursor=null;
    for(let page=0;page<10;page++){
      const response=await this.request('project/list',{limit:100,cursor});projects.push(...response.data??[]);
      if(!response.nextCursor)break;if(response.nextCursor===cursor)throw Error('Invalid GPU project cursor');cursor=response.nextCursor;
    }
    const matches=projects.filter(p=>(!params.projectId||params.projectId===p.id)&&p.roots?.some(r=>normalize(r.path)===normalize(params.cwd)));
    if(matches.length!==1)throw Error('GPU에 등록된 프로젝트의 원본 폴더를 선택해 주세요. 새 작업 복사본은 만들지 않습니다.');
    params={...params,cwd:matches[0].roots.find(r=>normalize(r.path)===normalize(params.cwd)).path,projectId:matches[0].id};
    // Crash/connection loss after this point must never create another task.
    writeOnce(requestFile,{operationId,fingerprint,attemptedAt:new Date().toISOString()});
    const result=await this.create(params);
    writeOnce(this.marker(result.thread.id),{threadId:result.thread.id,operationId,cwd:params.cwd,projectId:params.projectId});
    writeOnce(resultFile,result);return result;
  }
  claimFirst(id,operationId){
    if(!this.isCreated(id)||!UUID.test(operationId??''))throw Error('Not a bridge-created GPU task');
    writeOnce(path.join(this.journalDirectory,'first-'+id+'.json'),{threadId:id,operationId,attemptedAt:new Date().toISOString()});
  }
}
