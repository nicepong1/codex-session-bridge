import {createHash} from 'node:crypto';
import {turnsOf} from './state.mjs';
import {modelTurnOverrides} from './model-settings.mjs';

export const PLAN_PREFIX='PLEASE IMPLEMENT THIS PLAN:\n';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw Error('GPU 계획이 바뀌었거나 지원하지 않는 계획 실행입니다. GPU에서 계획을 다시 확인해 주세요');};

function pendingPlan(state,text) {
  const requests=(state?.requests??[]).filter(r=>r.method==='item/plan/requestImplementation');
  if(requests.length!==1)fail();
  const request=requests[0], p=request.params, turns=turnsOf(state);
  if(p?.threadId!==state.id||state.sessionId!==state.id||typeof p.planContent!=='string'||!p.planContent||
     request.id!==`implement-plan:${p.turnId}`||turns.at(-1)?.turnId!==p.turnId||turns.at(-1)?.status!=='completed'||
     turns.some(t=>t.status==='inProgress')||state.threadRuntimeStatus?.type!=='idle'||text!==PLAN_PREFIX+p.planContent)fail();
  return {requestId:request.id,turnId:p.turnId,requestHash:digest(request)};
}

// The native button submits a new text turn. Bind the mode change to the exact
// pending plan, instead of trusting arbitrary client collaboration instructions.
export function planFollowupFromFollower(message,policy,text) {
  const mode=message.params?.turnStart?.request?.collaborationMode?.mode;
  const current=policy.state?.latestThreadSettings?.collaborationMode?.mode??policy.state?.latestCollaborationMode?.mode;
  if(mode!=='default'||current!=='plan')return null;
  if(!policy.online||policy.preview||!policy.matches(message)||!policy.followers.has(message.sourceClientId))fail();
  return {...pendingPlan(policy.state,text),ownerClientId:policy.owner};
}

export function planTurnOverrides(session,plan,text,selection) {
  if(session.ownerClientId!==plan.ownerClientId)fail();
  const current=pendingPlan(session.state,text);
  if(current.requestHash!==plan.requestHash||current.turnId!==plan.turnId||current.requestId!==plan.requestId)fail();
  const original=session.state.latestThreadSettings?.collaborationMode??session.state.latestCollaborationMode;
  if(original?.mode!=='plan'||!original.settings)fail();
  const overrides=modelTurnOverrides(session.state,selection);
  // Preserve GPU instructions/settings; only the explicit Plan -> Default
  // selection changes. No notebook permission or instruction fields are used.
  return {...overrides,collaborationMode:{...structuredClone(original),mode:'default',
    settings:{...structuredClone(original.settings),...overrides.collaborationMode?.settings}}};
}
