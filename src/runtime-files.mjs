import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Diagnostics may lag briefly behind a sharing violation, but readers must
// never observe half of one JSON document and half of another.
export class JsonReport {
  constructor(file,{rename=fs.renameSync}={}) {
    this.file=file;this.rename=rename;
    fs.writeFileSync(file,'{}',{flag:'wx',mode:0o600});
  }
  write(value) {
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try {
      fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
      this.rename(temporary,this.file);return true;
    } catch(error) {
      if (['EBUSY','EACCES','EPERM'].includes(error.code)) return false;
      throw error;
    } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
}

export class BufferedJsonReport {
  constructor(file,{intervalMs=200,writer=new JsonReport(file),onError=error=>console.error(`Diagnostic report disabled: ${error.code||error.name}`)}={}) {
    Object.assign(this,{writer,intervalMs,onError});this.timer=null;this.latest=null;this.closed=false;this.failed=false;
  }
  write(value,{immediate=false}={}) {
    if(this.closed||this.failed)return;
    this.latest=value;
    if(immediate){clearTimeout(this.timer);this.timer=null;this.flush();}
    else if(!this.timer)this.schedule();
  }
  schedule(){this.timer=setTimeout(()=>{this.timer=null;this.flush()},this.intervalMs);this.timer.unref?.();}
  tryWrite(value){
    if(this.failed)return false;
    try{return this.writer.write(value)}catch(error){
      // A diagnostic directory or disk failure must not terminate a live task.
      this.failed=true;clearTimeout(this.timer);this.timer=null;
      this.onError(error);return false;
    }
  }
  flush(){if(this.latest && !this.tryWrite(this.latest) && !this.failed && !this.closed && !this.timer)this.schedule();}
  async close(value=this.latest){
    this.closed=true;clearTimeout(this.timer);this.timer=null;
    for(let attempt=0;attempt<5;attempt++){
      if(!value||this.tryWrite(value))return true;
      if(this.failed)return false;
      if(attempt<4)await delay(25);
    }
    return false;
  }
}

export function endpointFilePath(directory,pid=process.pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid endpoint process ID');
  // A crash may leave files behind. PID reuse must not reuse their filenames.
  return path.join(directory,`codex-gpu-guard-endpoint-${pid}-${randomUUID()}.json`);
}

export function createEndpointFile(file,url) {
  const contents=JSON.stringify({url});
  fs.writeFileSync(file,contents,{flag:'wx',mode:0o600});
  return () => {
    try {
      // Do not remove a replacement created by another process.
      if(fs.lstatSync(file).isFile()&&fs.readFileSync(file,'utf8')===contents)fs.unlinkSync(file);
    } catch(error) {if(error.code!=='ENOENT')throw error;}
  };
}
