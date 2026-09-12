import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {EventEmitter} from 'node:events';
import {pendingPopupReply,popupReplyFromFollower,verifyPopupReply,PopupReplyJournal,FILE_APPROVAL_METHOD,USER_INPUT_METHOD,MCP_REPLY_METHOD,usesLegacyComputerReply} from '../src/popup-replies.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';import {TaskHub} from '../src/task-hub.mjs';

function fixture(kind='file') {
  const id=randomUUID(),turnId=randomUUID(),owner=randomUUID(),requestId=42;
  let method,requestMethod,response,extra={};
  if(kind==='file'){method=FILE_APPROVAL_METHOD;requestMethod='item/fileChange/requestApproval';response='accept';}
  else if(kind==='question'){method=USER_INPUT_METHOD;requestMethod='item/tool/requestUserInput';extra={isBlocking:true,questions:[{id:'choice',question:'Choose',header:'Choice',options:[{label:'A',description:'First'}]},{id:'secret',question:'Value',header:'Value',isSecret:true}]};response={answers:{choice:{answers:['Free text']},secret:{answers:['private-user-input']}}};}
  else {method=MCP_REPLY_METHOD;requestMethod='mcpServer/elicitation/request';extra={serverName:'example',mode:'form',requestedSchema:{type:'object',properties:{enabled:{type:'boolean'}}},_meta:{persist:['session']}};response={action:'accept',content:{enabled:true},_meta:{persist:'session'}};}
  const request={id:requestId,method:requestMethod,params:{threadId:id,turnId,itemId:'item',startedAtMs:Date.now(),...extra}};
  const item={id:'item',type:'fileChange',changes:[{path:'C:\\example.txt',kind:{type:'update'},diff:'+new'}]};
  const state={id,sessionId:id,turns:[{turnId,status:'inProgress',items:[item]}],requests:[request]};
  const policy=new NativeViewPolicy(id);Object.assign(policy,{state,owner,online:true});policy.followers.add('laptop');
  const message={method,version:1,sourceClientId:'laptop',params:{conversationId:id,requestId,[kind==='file'?'decision':'response']:response}};
  const reply=popupReplyFromFollower(message,policy),session={threadId:id,ownerClientId:owner,state,stale:false,receivedAt:Date.now()};
  return {id,turnId,request,state,policy,message,response,reply,session};
}

test('all file decision meanings survive and approval binds the proposed file changes',()=>{
  const f=fixture();
  for(const decision of ['accept','acceptForSession','decline','cancel'])assert.equal(pendingPopupReply(f.state,f.id,42,FILE_APPROVAL_METHOD,decision).response,decision);
  for(const decision of ['always',{accept:true}])assert.throws(()=>pendingPopupReply(f.state,f.id,42,FILE_APPROVAL_METHOD,decision));
  f.state.turns[0].items[0].changes[0].diff='+different';assert.throws(()=>verifyPopupReply(f.session,f.reply),/변경/);
});

test('user answers preserve free text, partial input, secrets and dismissal without choosing defaults',()=>{
  const f=fixture('question');
  for(const response of [f.response,{answers:{}},{answers:{choice:{answers:[]}}},{answers:{choice:{answers:['A','additional text']}}}])
    assert.deepEqual(pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,response).response,response);
  for(const response of [{answers:{other:{answers:['x']}}},{answers:{choice:{answers:[true]}}},{answers:{choice:{answers:['x'],extra:1}}},{answers:{},extra:true}])
    assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,response));
  f.request.params.questions.push(f.request.params.questions[0]);assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
});

test('nonblocking pending questions may receive a response after their turn completes; canceled turns may not',()=>{
  const f=fixture('question');f.state.turns[0].status='completed';
  assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
  f.request.params.isBlocking=false;assert.doesNotThrow(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
  f.state.turns[0].status='interrupted';assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
});

test('onboarding answers route through the original supported dynamic tool only',()=>{
  const f=fixture('question');f.request.method='item/tool/call';f.request.params.tool='request_onboarding_input';f.request.params.namespace='codex_app';
  f.request.params.arguments={questions:f.request.params.questions};
  assert.doesNotThrow(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
  f.request.params.tool='execute';assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,f.response));
});

test('MCP forms validate field names, required fields, primitive types and enum arrays',()=>{
  const f=fixture('mcp');f.request.params.requestedSchema={type:'object',required:['name'],properties:{name:{type:'string',minLength:2},
    count:{type:'integer',minimum:1,maximum:4},tags:{type:'array',items:{enum:['a','b'],type:'string'},uniqueItems:true},
    choice:{type:'string',oneOf:[{const:'x',title:'X'},{const:'y',title:'Y'}]}}};
  const send=content=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{action:'accept',content});
  assert.doesNotThrow(()=>send({name:'ok',count:2,tags:['a','b'],choice:'x'}));
  for(const content of [{name:'a'},{count:2},{name:'ok',unknown:'value'},{name:'ok',count:1.5},{name:'ok',count:5},
    {name:'ok',tags:['a','a']},{name:'ok',tags:['c']},{name:'ok',choice:'z'}])assert.throws(()=>send(content));
  f.request.params.requestedSchema.properties.name.$ref='https://example.com/schema';assert.throws(()=>send({name:'ok'}));
});

test('MCP choice cannot widen persistence or turn an execution-bound action into remembered access',()=>{
  const f=fixture('mcp');
  assert.throws(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{...f.response,_meta:{persist:'always'}}));
  assert.throws(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{action:'decline',content:null,_meta:{persist:'session'}}));
  f.request.params._meta.tool_params={plan_token:'private-token',confirmation_summary:'private-details'};
  assert.throws(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,f.response));
  assert.doesNotThrow(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{action:'decline',content:null}));
});

test('MCP without a correlated turn retains request identity without borrowing another active turn',()=>{
  const f=fixture('mcp');f.request.params.turnId=null;f.state.turns=[];
  const reply=pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,f.response);assert.equal(reply.turnId,null);
  f.request.params.turnId=randomUUID();assert.throws(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,f.response));
});

test('native URL Continue uses an empty object, while authentication completion is host-bound',()=>{
  const f=fixture('mcp');Object.assign(f.request.params,{mode:'url',url:'https://example.com/confirm',elicitationId:'url-id'});
  const reply=response=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,response);
  assert.doesNotThrow(()=>reply({action:'accept',content:{},_meta:null}));
  assert.doesNotThrow(()=>reply({action:'decline',content:null}));
  assert.throws(()=>reply({action:'accept',content:{token:'unrelated'}}));
  f.request.params.serverName='codex_apps';assert.throws(()=>reply({action:'accept',content:{}}),/GPU/);
  assert.doesNotThrow(()=>reply({action:'cancel',content:null}));
});

test('extended scalar forms retain choices; local file and browser credential flows require the GPU UI',()=>{
  const f=fixture('mcp'),send=content=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{action:'accept',content});
  f.request.params.mode='openaiForm';f.request.params.requestedSchema={type:'object',required:['choice'],properties:{choice:{type:'string',
    oneOf:[{const:'a',title:'A','x-openai-preview':{text:'preview'}},{const:'b',title:'B'}]}}};
  assert.doesNotThrow(()=>send({choice:'a'}));assert.throws(()=>send({choice:'c'}));
  f.request.params.requestedSchema.properties.choice['x-openai-input']={type:'file'};assert.throws(()=>send({choice:'a'}),/GPU/);
  f.request.params.mode='form';f.request.params.requestedSchema={type:'object',properties:{}};
  for(const kind of ['browser_auth','tool_suggestion']){f.request.params._meta={codex_approval_kind:kind};assert.throws(()=>send({}),/GPU/);}
});

test('malformed and oversized answer structures are rejected without persisting content',()=>{
  const f=fixture('question');
  for(const answers of [JSON.parse('{"__proto__":{"answers":["value"]}}'),{choice:{answers:['x'.repeat(16001)]}},
    {choice:{answers:['x'],constructor:{}}}])assert.throws(()=>pendingPopupReply(f.state,f.id,42,USER_INPUT_METHOD,{answers}));
});

test('legacy app approval cannot bypass its existing journal through the new MCP adapter',()=>{
  const f=fixture('mcp');f.request.params._meta={codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_params:{app:'Example'}};
  assert.equal(usesLegacyComputerReply(f.message,f.state),true);
  assert.throws(()=>pendingPopupReply(f.state,f.id,42,MCP_REPLY_METHOD,{action:'accept',content:{}}),/기존/);
});

test('popup replies are tied to follower, request ID type, owner and fresh state',()=>{
  for(const kind of ['file','question','mcp']){
    const f=fixture(kind);assert.doesNotThrow(()=>verifyPopupReply(f.session,f.reply));
    for(const change of [{ownerClientId:randomUUID()},{receivedAt:NaN},{receivedAt:Date.now()-6000},{receivedAt:Date.now()+5000},{stale:true}])
      assert.throws(()=>verifyPopupReply({...f.session,...change},f.reply));
    for(const change of [{version:2},{sourceClientId:'unknown'},{params:{...f.message.params,requestId:'42'}}])
      assert.throws(()=>popupReplyFromFollower({...f.message,...change},f.policy));
    f.state.requests=[];assert.throws(()=>verifyPopupReply(f.session,f.reply));
  }
});

test('reply journal survives restart and never stores question answers or form fields',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-popup-test-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  const {reply}=fixture('question'),journal=new PopupReplyJournal(directory);let calls=0;const send=async()=>{calls++;return{ok:true}};
  await Promise.all([journal.run(reply,send),journal.run(structuredClone(reply),send)]);await new PopupReplyJournal(directory).run(reply,send);
  assert.equal(calls,1);assert.doesNotMatch(fs.readdirSync(directory).map(name=>fs.readFileSync(path.join(directory,name),'utf8')).join(''),/private-user-input|Free text|answers|questions/);
  await assert.rejects(journal.run({...reply,response:{answers:{}}},send));assert.equal(calls,1);
});

test('lost popup acknowledgement is not replayed after restart',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-popup-test-'));t.after(()=>fs.rmSync(directory,{recursive:true}));
  const {reply}=fixture('mcp');let calls=0;const send=async()=>{calls++;throw Error('lost')};
  await assert.rejects(new PopupReplyJournal(directory).run(reply,send));await assert.rejects(new PopupReplyJournal(directory).run(reply,send),/불확실/);assert.equal(calls,1);
});

test('hub gates the common popup path and deduplicates simultaneous replies',async t=>{
  const f=fixture('question'),connection=new EventEmitter();connection.online=true;connection.close=()=>{};const calls=[];
  connection.request=async(method,params)=>{calls.push({method,params});return{ok:true}};
  const hub=new TaskHub({createConnection:()=>connection,allowPopupReplies:true});t.after(()=>hub.close());hub.task(f.id).policy=f.policy;
  await Promise.all([hub.replyPopup(f.message),hub.replyPopup(f.message)]);assert.equal(calls.length,1);assert.equal(calls[0].method,'popupReply');assert.deepEqual(calls[0].params.response,f.response);
  connection.online=false;await assert.rejects(hub.replyPopup(f.message));assert.equal(calls.length,1);
});
