import {createHash} from 'node:crypto';
import {UUID} from './guard-policy.mjs';
import {turnsOf} from './state.mjs';
import {CommandApprovalJournal,sameApprovalDecision} from './command-approval.mjs';
import {popupCapability} from './popup-catalog.mjs';

export const FILE_APPROVAL_METHOD='thread-follower-file-approval-decision';
export const USER_INPUT_METHOD='thread-follower-submit-user-input';
export const MCP_REPLY_METHOD='thread-follower-submit-mcp-server-elicitation-response';
export const POPUP_REPLY_METHODS=Object.freeze([FILE_APPROVAL_METHOD,USER_INPUT_METHOD,MCP_REPLY_METHOD]);
export function usesLegacyComputerReply(message,state) {
  if(message?.method!==MCP_REPLY_METHOD)return false;
  const matches=(state?.requests??[]).filter(r=>r.id===message.params?.requestId);
  const meta=matches.length===1?matches[0].params?._meta:null;
  return meta?.codex_approval_kind==='mcp_tool_call'&&meta.connector_id==='computer-use'&&meta.tool_name==null;
}
const object=v=>v!=null&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const validId=v=>(Number.isSafeInteger(v)&&v>=0)||(typeof v==='string'&&v.length>0&&v.length<=200);
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const fail=()=>{throw Error('이 요청의 응답 형식을 지원하지 않거나 GPU가 제공한 범위를 벗어났습니다');};

function boundedJson(value,depth=0) {
  if(depth>16)fail();
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='string'){if(value.length>65536)fail();return;}
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return;}
  if(Array.isArray(value)){if(value.length>256)fail();for(const item of value)boundedJson(item,depth+1);return;}
  if(!object(value)||Object.keys(value).length>256)fail();
  for(const [key,item] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))fail();boundedJson(item,depth+1);}
}

function userAnswers(params,response) {
  if(!only(response,['answers'])||!object(response.answers)||!Array.isArray(params.questions)||params.questions.length>100)fail();
  const ids=params.questions.map(q=>q.id);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)fail();
  // The native UI permits free text even beside suggestions. Preserve partial
  // answers and an empty answer map (dismissal); never pick a default option.
  for(const [id,answer] of Object.entries(response.answers)) {
    if(!ids.includes(id)||!only(answer,['answers'])||!Array.isArray(answer.answers)||answer.answers.length>100||
       answer.answers.some(v=>typeof v!=='string'||v.length>16000))fail();
  }
}

// Standard MCP form schemas are small object forms with primitive fields and
// enum arrays. Also accept nested object forms with explicitly named fields.
// No remote $ref loading, expression execution, or schema coercion is performed.
function formValue(schema,value,depth=0) {
  if(depth>12||!object(schema)||schema.$ref!=null)fail();
  const known=['$schema','type','title','description','default','enum','enumNames','const','oneOf','anyOf','properties','required',
    'additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','minimum','maximum','format',
    'x-openai-input','x-openai-preview'];
  if(Object.keys(schema).some(key=>!known.includes(key)))fail();
  if(schema['x-openai-input']?.type==='file')throw Error('GPU 파일 선택이 필요한 폼입니다. GPU 공식 앱에서 응답해 주세요');
  if(schema.enum!=null&&(!Array.isArray(schema.enum)||!schema.enum.some(v=>sameApprovalDecision(v,value))))fail();
  if(Object.hasOwn(schema,'const')&&!sameApprovalDecision(schema.const,value))fail();
  if(schema.oneOf||schema.anyOf){
    const variants=schema.oneOf??schema.anyOf;if(!Array.isArray(variants)||!variants.length||variants.length>100)fail();
    let matches=0;for(const variant of variants){try{formValue(variant,value,depth+1);matches++;}catch{}}
    if(schema.oneOf?matches!==1:matches===0)fail();
  }
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if(value===null){if(!types.includes('null'))fail();return;}
  if(types.includes('object')){
    if(!object(value)||!object(schema.properties))fail();
    const required=schema.required??[];if(!Array.isArray(required)||required.some(k=>!Object.hasOwn(value,k)))fail();
    for(const [key,item] of Object.entries(value)){if(!Object.hasOwn(schema.properties,key))fail();formValue(schema.properties[key],item,depth+1);}
  }else if(types.includes('array')){
    if(!Array.isArray(value)||!schema.items||value.length<(schema.minItems??0)||value.length>(schema.maxItems??256))fail();
    if(schema.uniqueItems&&new Set(value.map(hash)).size!==value.length)fail();
    for(const item of value)formValue(schema.items,item,depth+1);
  }else if(types.includes('string')){
    if(typeof value!=='string'||[...value].length<(schema.minLength??0)||[...value].length>(schema.maxLength??65536))fail();
    // Unknown validation keywords must not silently approve a different schema.
    if(schema.pattern!=null)fail();
    if(schema.format!=null){
      if(schema.format==='email'){if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))fail();}
      else if(schema.format==='uri'){try{new URL(value);}catch{fail();}}
      else if(schema.format==='date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail();}
      else if(schema.format==='date-time'){if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)||!Number.isFinite(Date.parse(value)))fail();}
      else fail();
    }
  }else if(types.includes('number')||types.includes('integer')){
    if(typeof value!=='number'||!Number.isFinite(value)||(types.includes('integer')&&!Number.isInteger(value))||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))fail();
  }else if(types.includes('boolean')){if(typeof value!=='boolean')fail();}
  else if(!Object.hasOwn(schema,'const')&&!schema.enum&&!schema.oneOf&&!schema.anyOf)fail();
}

function mcpResponse(params,response) {
  if(!only(response,['action','content','_meta'])||!['accept','decline','cancel'].includes(response.action)||
     !['form','openai/form','openaiForm','url'].includes(params.mode)||typeof params.serverName!=='string'||!params.serverName)fail();
  if(response._meta!=null){
    if(!only(response._meta,['persist']))fail();
    const persist=response._meta.persist;
    if(persist!=null&&(response.action!=='accept'||!['session','always'].includes(persist)||![params._meta?.persist].flat().includes(persist)))fail();
    // Execution-bound tool confirmations may never be turned into saved access.
    const tool=params._meta?.tool_params;
    if(persist!=null&&object(tool)&&(Object.hasOwn(tool,'plan_token')||Object.hasOwn(tool,'confirmation_summary')))fail();
  }
  if(response.action!=='accept'){if(response.content!=null)fail();return;}
  const capability=popupCapability({method:'mcpServer/elicitation/request',params});
  if(capability.status==='host-required')throw Error(capability.reason+' GPU 공식 앱에서 응답해 주세요');
  if(params.mode==='url'){
    if(typeof params.elicitationId!=='string'||!params.elicitationId||typeof params.url!=='string'||
       (response.content!=null&&(!object(response.content)||Object.keys(response.content).length)))fail();
    let url;try{url=new URL(params.url);}catch{fail();}if(!['https:','http:'].includes(url.protocol))fail();
    return;
  }
  formValue(params.requestedSchema,response.content);
}

export function pendingPopupReply(state,threadId,requestId,method,response) {
  if(!UUID.test(threadId??'')||state?.id!==threadId||state.sessionId!==threadId||!validId(requestId)||!POPUP_REPLY_METHODS.includes(method))fail();
  boundedJson(response);if(Buffer.byteLength(JSON.stringify(response))>256*1024)fail();
  const matches=(state.requests??[]).filter(r=>r.id===requestId),request=matches.length===1?matches[0]:null,params=request?.params;
  if(!params||params.threadId!==threadId)fail();
  const turns=turnsOf(state),turn=params.turnId==null?null:turns.find(t=>t.turnId===params.turnId);
  if(params.turnId!=null&&(!UUID.test(params.turnId)||!turn))fail();
  let boundItem=null;
  if(method===FILE_APPROVAL_METHOD){
    if(request.method!=='item/fileChange/requestApproval'||turn?.status!=='inProgress'||typeof params.itemId!=='string'||!params.itemId||
       !['accept','acceptForSession','decline','cancel'].includes(response))fail();
    const items=(turn.items??[]).filter(item=>item.id===params.itemId&&item.type==='fileChange');
    if(items.length!==1||!Array.isArray(items[0].changes))fail();boundItem=items[0];
  }else if(method===USER_INPUT_METHOD){
    if(!turn||!(turn.status==='inProgress'||(params.isBlocking===false&&turn.status==='completed')))fail();
    if(request.method==='item/tool/requestUserInput')userAnswers(params,response);
    else if(request.method==='item/tool/call'&&[null,undefined,'codex_app'].includes(params.namespace)&&params.tool==='request_onboarding_input')userAnswers(params.arguments,response);
    else fail();
  }else{
    if(usesLegacyComputerReply({method,params:{requestId}},state))throw Error('기존 앱 승인 경로로 응답해야 합니다');
    if(request.method!=='mcpServer/elicitation/request'||(turn&&turn.status!=='inProgress'))fail();
    mcpResponse(params,response);
  }
  return {threadId,requestId,turnId:params.turnId??null,itemId:params.itemId??'mcp:'+String(requestId),method,
    requestHash:hash({request,boundItem}),response:structuredClone(response)};
}

export function popupReplyFromFollower(message,policy) {
  if(message?.version!==1||!policy?.online||policy.preview||!policy.followers.has(message.sourceClientId)||!policy.matches(message)||message.params?.conversationId!==policy.threadId)
    throw Error('연결된 GPU 작업 창에서 응답해 주세요');
  const response=message.method===FILE_APPROVAL_METHOD?message.params.decision:message.params.response;
  return {...pendingPopupReply(policy.state,policy.threadId,message.params.requestId,message.method,response),ownerClientId:policy.owner};
}

export function verifyPopupReply(session,expected) {
  if(!expected||!UUID.test(expected.ownerClientId??'')||session?.ownerClientId!==expected.ownerClientId||session.threadId!==expected.threadId||session.stale||
     !Number.isFinite(session.receivedAt)||Date.now()-session.receivedAt>5000||session.receivedAt>Date.now()+1000)throw Error('GPU 질문의 연결이 바뀌었습니다');
  const current=pendingPopupReply(session.state,expected.threadId,expected.requestId,expected.method,expected.response);
  if(current.turnId!==expected.turnId||current.itemId!==expected.itemId||current.requestHash!==expected.requestHash)throw Error('GPU 질문이 변경되어 응답을 전달하지 않았습니다');
  return current;
}

export class PopupReplyJournal extends CommandApprovalJournal {
  run({response,...reply},send){return super.run({...reply,decision:hash(response)},send);}
}
