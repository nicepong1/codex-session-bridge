import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {defaultModelWrite, modelSettings, modelTurnOverrides, settingsFromFollower, settingsFromTurn, GpuModelSettings, modelFollowerResult} from '../src/model-settings.mjs';
import {desktopHubRoute, hubReadRoute, GPU_THREAD} from '../src/guard-policy.mjs';
import {TaskHub} from '../src/task-hub.mjs';
const params = (model = 'example', effort = 'high') => ({edits: [
  {keyPath:'model',value:model,mergeStrategy:'upsert'}, {keyPath:'model_reasoning_effort',value:effort,mergeStrategy:'upsert'}],
  filePath:null,expectedVersion:null,reloadUserConfig:true});

test('default selector accepts exactly the model pair; general read routes still reject config mutation', () => {
  assert.equal(desktopHubRoute('config/batchWrite',params()).write,true);
  assert.throws(()=>hubReadRoute('config/batchWrite',params()));
  for (const bad of [ {...params(),filePath:'C:\\other.toml'}, {...params(),expectedVersion:'stale'},
    {...params(),edits:[...params().edits,{keyPath:'approval_policy',value:'never',mergeStrategy:'upsert'}]},
    {...params(),edits:params().edits.map(e=>({...e,keyPath:'permissions.'+e.keyPath}))},
    {...params(),edits:[params().edits[0],params().edits[0]]},
    {...params(),edits:params().edits.map((e,i)=>({...e,keyPath:(i?'profiles.other.':'profiles.work.')+e.keyPath}))}])
    assert.throws(()=>defaultModelWrite(bad));
  assert.equal(defaultModelWrite({...params(),edits:params().edits.map(e=>({...e,keyPath:'profiles.work.'+e.keyPath}))}).profile,'work');
});

test('GPU validates live model availability and effort before any default write', async () => {
  const calls=[];
  const model=new GpuModelSettings(async(method,p)=>{calls.push(method);
    if(method==='model/list')return{data:[{model:'example',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
    if(method==='config/read')return{config:{profiles:{work:{}}}};
    return{status:'ok',filePath:'C:\\config.toml',version:'v'};
  });
  await assert.rejects(model.write(params('missing')),/없는 모델/);
  await assert.rejects(model.write(params('example','ultra')),/추론 수준/);
  assert.equal(calls.includes('config/batchWrite'),false);
  assert.equal((await model.write(params())).status,'ok');
  assert.equal(calls.filter(x=>x==='config/batchWrite').length,1);
});

test('task selector strips only installed desktop mode and never changes permissions', () => {
  const message={method:'thread-follower-update-thread-settings',version:1,params:{conversationId:GPU_THREAD,
    threadSettings:{model:'example',effort:'high',multiAgentMode:'explicitRequestOnly'}}};
  assert.deepEqual(settingsFromFollower(message,GPU_THREAD),{settings:{model:'example',effort:'high'},condition:null});
  assert.deepEqual(settingsFromFollower({...message,version:2},GPU_THREAD),settingsFromFollower(message,GPU_THREAD));
  assert.throws(()=>settingsFromFollower({...message,version:3},GPU_THREAD));
  assert.throws(()=>settingsFromFollower(message,randomUUID()));
  assert.throws(()=>modelSettings({...message.params.threadSettings,approvalPolicy:'never'},{desktop:true}));
});

test('v2 selector preserves conditions and refuses active-turn permission changes on either version',()=>{
  const params={conversationId:GPU_THREAD,threadSettings:{model:'example',effort:'high'},condition:{ifEffortEquals:'medium',ifModelEquals:'example'}};
  const message={method:'thread-follower-update-thread-settings',version:2,params};
  assert.deepEqual(settingsFromFollower(message,GPU_THREAD).condition,params.condition);
  for(const version of [1,2]) assert.throws(()=>settingsFromFollower({...message,version,params:{...params,condition:null,activeTurnId:randomUUID()}},GPU_THREAD));
  for(const condition of [{},{ifEffortEquals:undefined},{ifEffortEquals:5},{ifEffortEquals:'medium',unsafe:true},{ifEffortEquals:'medium',ifModelEquals:5}])
    assert.throws(()=>settingsFromFollower({...message,params:{...params,condition}},GPU_THREAD));
  assert.throws(()=>settingsFromFollower({...message,version:1},GPU_THREAD));
  assert.deepEqual(modelFollowerResult(1,{applied:true}),{ok:true});
  assert.deepEqual(modelFollowerResult(2,{applied:false}),{applied:false});
  assert.throws(()=>modelFollowerResult(1,{applied:false}));
  assert.throws(()=>modelFollowerResult(2,{ok:true}));
});

test('turn override retains GPU mode/instructions while carrying selected model and effort', () => {
  const gpu={latestCollaborationMode:{mode:'default',settings:{model:'old',reasoning_effort:'medium',developer_instructions:'original'}}};
  const choice=settingsFromTurn({collaborationMode:{mode:'plan',settings:{model:'example',reasoning_effort:'high',developer_instructions:'untrusted'}}});
  const overrides=modelTurnOverrides(gpu,choice);
  assert.equal(overrides.collaborationMode.mode,'default');
  assert.equal(overrides.collaborationMode.settings.developer_instructions,'original');
  assert.equal(overrides.collaborationMode.settings.model,'example');
  assert.equal(overrides.effort,'high');assert.equal(gpu.latestCollaborationMode.settings.model,'old');
  assert.throws(()=>settingsFromTurn({model:'other',collaborationMode:{settings:{model:'example',reasoning_effort:'high'}}}));
  assert.deepEqual(modelTurnOverrides(gpu,{}),{});
});

test('hub mutation requires online owner, invalidates defaults and includes model in message deduplication',async t=>{
  const connection=new EventEmitter();connection.online=true;connection.close=()=>{};const calls=[];
  connection.request=async(method,p)=>{calls.push({method,p});return method==='modelSettings'?{applied:p.condition==null}:{ok:true}};
  const hub=new TaskHub({createConnection:()=>connection,allowModelSettings:true});t.after(()=>hub.close());
  await assert.rejects(hub.updateModel(GPU_THREAD,{model:'example',effort:'high'}),/unavailable/);
  const task=hub.task(GPU_THREAD);task.policy.online=true;
  await hub.updateModel(GPU_THREAD,{model:'example',effort:'high'});
  const id=randomUUID();await hub.submit(GPU_THREAD,id,'test',{model:'example',effort:'high'});
  await assert.rejects(hub.submit(GPU_THREAD,id,'test',{model:'other',effort:'high'}));
  assert.deepEqual(calls.at(-1).p.settings,{model:'example',effort:'high'});
  connection.online=false;
  await assert.rejects(hub.read('config/batchWrite',params()),/연결/);
  await assert.rejects(hub.updateModel(GPU_THREAD,{model:'example'}),/unavailable/);
  assert.equal(calls.length,2);
  connection.online=true;
  const events=[];hub.on('modelSettings',e=>events.push(e));
  const condition={ifEffortEquals:'medium',ifModelEquals:'example'};
  assert.deepEqual(await hub.updateModel(GPU_THREAD,{model:'example'},{condition}),{applied:false});
  assert.deepEqual(calls.at(-1).p.condition,condition);
  assert.equal(events.at(-1).outcome,'not-applied');
});
