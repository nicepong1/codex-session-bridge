import {createHash} from 'node:crypto';
import {turnsOf} from './state.mjs';
import {CommandApprovalJournal, sameApprovalDecision} from './command-approval.mjs';
import {UUID} from './guard-policy.mjs';

export const PERMISSIONS_APPROVAL_METHOD = 'thread-follower-permissions-request-approval-response';
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function validateResponse(response, requested) {
  if (!only(response, ['permissions','scope','strictAutoReview']) ||
      !only(response.permissions, ['network','fileSystem']) || !only(requested, ['network','fileSystem']) ||
      (response.scope !== undefined && !['turn','session'].includes(response.scope)) ||
      (response.strictAutoReview != null && typeof response.strictAutoReview !== 'boolean'))
    throw Error('지원하지 않는 추가 권한 응답입니다');
  // The native UI returns the requested group verbatim, or omits it when denying.
  // Do not normalize paths or remove nested deny entries: either can widen access.
  for (const kind of ['network','fileSystem']) {
    const granted = response.permissions[kind];
    if (granted != null && (!object(granted) || !sameApprovalDecision(granted, requested[kind])))
      throw Error('GPU가 요청한 범위를 벗어나는 권한은 전달할 수 없습니다');
  }
}

export function pendingPermissionsApproval(state, threadId, requestId, response) {
  const validId = (Number.isSafeInteger(requestId) && requestId >= 0) ||
    (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200);
  if (!UUID.test(threadId ?? '') || state?.id !== threadId || state.sessionId !== threadId || !validId)
    throw Error('추가 권한 요청의 작업을 확인할 수 없습니다');
  const matches = (state.requests ?? []).filter(r => r.id === requestId);
  const request = matches.length === 1 ? matches[0] : null, params = request?.params;
  if (request?.method !== 'item/permissions/requestApproval' || params?.threadId !== threadId ||
      !UUID.test(params.turnId ?? '') || typeof params.itemId !== 'string' || !params.itemId ||
      typeof params.cwd !== 'string' || !params.cwd ||
      (params.environmentId != null && params.environmentId !== 'local') ||
      !Number.isSafeInteger(params.startedAtMs) || params.startedAtMs < 0 ||
      !turnsOf(state).some(turn => turn.turnId === params.turnId && turn.status === 'inProgress'))
    throw Error('현재 대기 중인 추가 권한 요청이 아닙니다');
  validateResponse(response, params.permissions);
  return {threadId,requestId,turnId:params.turnId,itemId:params.itemId,requestHash:hash(request),response:structuredClone(response)};
}

export function permissionsApprovalFromFollower(message, policy) {
  if (message?.method !== PERMISSIONS_APPROVAL_METHOD || message.version !== 1 || !policy?.online || policy.preview ||
      !policy.followers.has(message.sourceClientId) || !policy.matches(message) || message.params?.conversationId !== policy.threadId)
    throw Error('연결된 작업 창에서 권한 승인 버튼을 눌러 주세요');
  return {...pendingPermissionsApproval(policy.state,policy.threadId,message.params.requestId,message.params.response),ownerClientId:policy.owner};
}

export function verifyPermissionsApproval(session, expected) {
  if (!expected || !UUID.test(expected.ownerClientId ?? '') || session?.ownerClientId !== expected.ownerClientId ||
      session.threadId !== expected.threadId || session.stale || !Number.isFinite(session.receivedAt) ||
      Date.now()-session.receivedAt > 5000 || session.receivedAt > Date.now()+1000)
    throw Error('GPU 추가 권한 요청의 연결이 바뀌었습니다');
  const current = pendingPermissionsApproval(session.state,expected.threadId,expected.requestId,expected.response);
  if (current.turnId !== expected.turnId || current.itemId !== expected.itemId || current.requestHash !== expected.requestHash)
    throw Error('GPU 추가 권한 요청이 변경되어 선택을 전달하지 않았습니다');
  return current;
}

// Reuse the durable once-only journal, storing a decision hash instead of paths.
export class PermissionsApprovalJournal extends CommandApprovalJournal {
  run({response,...approval},send) { return super.run({...approval,decision:hash(response)},send); }
}
