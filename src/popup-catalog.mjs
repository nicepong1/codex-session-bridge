import {turnsOf} from './state.mjs';

const supported=(kind)=>({kind,status:'supported'});
const hostOnly=(kind,reason)=>({kind,status:'host-required',reason});

function unsupportedSchema(schema,depth=0) {
  if(depth>12||!schema||typeof schema!=='object')return true;
  if(schema.$ref!=null||schema.pattern!=null||schema['x-openai-input']?.type==='file'||schema.type==='openai/imagePicker')return true;
  const known=new Set(['$schema','type','title','description','default','enum','enumNames','const','oneOf','anyOf','properties','required',
    'additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','minimum','maximum','format','x-openai-input','x-openai-preview']);
  if(Object.keys(schema).some(k=>!known.has(k)))return true;
  return Object.values(schema.properties??{}).some(s=>unsupportedSchema(s,depth+1))||
    (schema.items!=null&&unsupportedSchema(schema.items,depth+1))||
    [...schema.oneOf??[],...schema.anyOf??[]].some(s=>unsupportedSchema(s,depth+1));
}

// No request text, credential, file path, or form value is returned. This is
// capability reporting, never an approval decision or a replacement request.
function classify(request) {
  const p=request?.params??{};
  switch(request?.method){
    case 'item/commandExecution/requestApproval':return supported('명령 실행·네트워크 정책');
    case 'item/fileChange/requestApproval':return supported('파일 변경 승인');
    case 'item/permissions/requestApproval':return supported('추가 권한');
    case 'item/tool/requestUserInput':return supported('질문 답변');
    case 'item/plan/requestImplementation':return {kind:'계획 실행',status:'partial',reason:'원본 계획 실행과 피드백은 전달됩니다. 편집한 계획 실행·계획 닫기는 GPU 공식 앱에서 처리해 주세요.'};
    case 'item/tool/requestOptionPicker':return hostOnly('옵션 선택','현재 공식 앱에는 이 선택기의 원격 응답 경로가 없습니다.');
    case 'item/tool/requestSetupCodexContextPicker':return hostOnly('초기 환경 선택','현재 공식 앱에서는 자동 해제되는 요청입니다. 계속 남아 있으면 GPU 공식 앱에서 확인해 주세요.');
    case 'item/tool/call':
      if([null,undefined,'codex_app'].includes(p.namespace)&&p.tool==='request_onboarding_input')return supported('초기 설정 질문');
      return hostOnly('도구 설정·선택','이 도구 화면의 응답은 GPU 공식 앱에서 처리해야 합니다.');
    case 'mcpServer/elicitation/request':
      if(p._meta?.codex_approval_kind==='browser_auth')return hostOnly('브라우저 인증','인증 입력과 완료 확인이 GPU 브라우저에 연결되어 있습니다.');
      if(p._meta?.codex_approval_kind==='tool_suggestion')return hostOnly('플러그인 설치 제안','GPU의 플러그인 설치 결과 확인이 필요합니다.');
      if(p.mode==='url')return p.serverName==='codex_apps'?hostOnly('계정 연결','GPU 계정의 인증 완료 확인이 필요합니다.'):supported('URL 확인');
      if(!['form','openai/form','openaiForm'].includes(p.mode))return hostOnly('인증·확인','현재 연결에서 지원하지 않는 확인 방식입니다.');
      if(unsupportedSchema(p.requestedSchema))return hostOnly('확장 입력 폼','GPU 파일 선택 또는 아직 지원하지 않는 폼 규칙이 있습니다.');
      return supported('앱·사이트 승인 또는 입력 폼');
    default:return hostOnly('새 요청 유형','현재 연결에서 검증되지 않은 요청입니다.');
  }
}

export function popupCapability(request) {
  try{return classify(request);}catch{return hostOnly('확인할 수 없는 요청','요청 형식이 달라 GPU 공식 앱에서 확인해야 합니다.');}
}

export function popupCapabilities(state) {
  return (state?.requests??[]).slice(0,100).map(popupCapability);
}

export function popupNoticeState(state) {
  const notices=popupCapabilities(state).filter(c=>c.status!=='supported');
  if(!notices.length)return state;
  const copy=structuredClone(state),turn=turnsOf(copy).at(-1);
  if(!turn||!Array.isArray(turn.items))return state;
  const lines=[...new Set(notices.map(c=>`${c.kind}: ${c.reason}`))];
  turn.items.push({type:'agentMessage',id:'session-bridge-popup-guidance',phase:'commentary',
    text:'**Session Bridge 연결 안내 — 이 창에만 표시**\n\n'+lines.join('\n\n')+
      '\n\nGPU PC의 공식 Codex에서 같은 작업을 열어 응답해 주세요. 원래 요청과 작업은 유지되며, 연결 프로그램이 대신 허용하지 않습니다.'});
  return copy;
}
