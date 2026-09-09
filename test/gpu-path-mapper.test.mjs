import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {GpuPathMapper,decodeMappedDrives} from '../src/gpu-path-mapper.mjs';
import {TaskHub} from '../src/task-hub.mjs';
const drive={DeviceID:'Z:',ProviderName:'\\\\192.0.2.10\\projects'};
const root={name:'projects',path:'C:\\Projects'};
test('Windows PowerShell single-row and array drive outputs are both decoded',()=>{
  assert.deepEqual(decodeMappedDrives(JSON.stringify(drive)),[drive]);
  assert.deepEqual(decodeMappedDrives(JSON.stringify([drive])),[drive]);
  assert.deepEqual(decodeMappedDrives(''),[]);
  assert.throws(()=>decodeMappedDrives('42'));
});
test('SMB drive translates both creation and multi-folder preflight to authenticated GPU paths',async()=>{
  const mapper=new GpuPathMapper({hostname:'192.0.2.10',readDrives:async()=>[drive],readShares:async names=>{assert.deepEqual(names,['projects']);return [root]}});
  const created=await mapper.params('project/create',{roots:[{path:'Z:\\document-demo'}]});
  assert.deepEqual(created.roots,[{path:'C:\\Projects\\document-demo'}]);
  const list=await mapper.params('thread/list',{cwd:['z:/document-demo','C:\\Other'],limit:100});
  assert.deepEqual(list.cwd,['C:\\Projects\\document-demo','C:\\Other']);
  assert.equal(list.limit,100);
});
test('unknown GPU shares, foreign SMB drives and traversal cannot register another path',async()=>{
  const mapper=new GpuPathMapper({hostname:'192.0.2.10',readDrives:async()=>[drive],readShares:async()=>[]});
  await assert.rejects(mapper.params('project/create',{roots:[{path:'Z:\\file'}]}),/실제 경로/);
  mapper.readShares=async()=>[root];
  await assert.rejects(mapper.params('project/create',{roots:[{path:'Z:\\..\\Windows'}]}));
  mapper.readDrives=async()=>[{...drive,ProviderName:'\\\\different-server\\projects'}];
  await assert.rejects(mapper.params('project/create',{roots:[{path:'Z:\\file'}]},{fresh:true}),/GPU PC의 공유 폴더가 아닙니다/);
});
test('write refresh observes remapped drive and read cache cannot hide a failed refresh',async()=>{
  let target='C:\\Projects',reads=0;
  const mapper=new GpuPathMapper({hostname:'192.0.2.10',readDrives:async()=>{reads++;return [drive]},readShares:async()=>[{...root,path:target}]});
  await mapper.params('thread/list',{cwd:'Z:\\file'});
  await mapper.params('thread/list',{cwd:'Z:\\file'});assert.equal(reads,1);
  target='D:\\Projects';const changed=await mapper.params('project/create',{roots:[{path:'Z:\\file'}]},{fresh:true});
  assert.equal(changed.roots[0].path,'D:\\Projects\\file');assert.equal(reads,2);
  mapper.readShares=async()=>{throw new Error('disconnected')};
  await assert.rejects(mapper.params('project/create',{roots:[{path:'Z:\\file'}]},{fresh:true}),/disconnected/);
  assert.equal(mapper.mappings.length,0);
});
test('task hub sends resolved roots to GPU and keys filtered list cache by resolved folder',async t=>{
  class Connection extends EventEmitter {online=true;calls=[];waitUntilReady(){return Promise.resolve()}close(){}
    async request(method,p){this.calls.push({method,p});return method==='projectWrite'?{project:{id:randomUUID()}}:{data:[],nextCursor:null}}
  }
  const connection=new Connection();
  const mapper=new GpuPathMapper({hostname:'192.0.2.10',readDrives:async()=>[drive],readShares:async()=>[root]});
  const hub=new TaskHub({createConnection:()=>connection,pathMapper:mapper,allowProjectCreation:true});t.after(()=>hub.close());
  await hub.read('thread/list',{cwd:['Z:\\document-demo'],useStateDbOnly:true});
  await hub.read('project/create',{name:'Document-Demo',roots:[{path:'Z:\\document-demo'}],metadata:{},idempotencyKey:randomUUID()});
  assert.deepEqual(connection.calls[0].p.params.cwd,['C:\\Projects\\document-demo']);
  assert.equal(connection.calls[1].method,'projectWrite');
  assert.equal(connection.calls[1].p.params.roots[0].path,'C:\\Projects\\document-demo');
});
