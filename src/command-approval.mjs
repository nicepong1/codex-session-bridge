import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {turnsOf} from './state.mjs';

export const COMMAND_APPROVAL_METHOD = 'thread-follower-command-approval-decision';
const REQUEST_METHOD = 'item/commandExecution/requestApproval';
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const validId = id => (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && id.length > 0 && id.length <= 200);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const sameApprovalDecision = (a,b) => hash(a) === hash(b);

function validDecision(decision, params) {
  const ordinary = ['accept','acceptForSession','decline','cancel'].includes(decision);
  const amendment = decision?.acceptWithExecpolicyAmendment;
  const rule = amendment?.execpolicy_amendment;
  const proposed = !ordinary && decision && Object.keys(decision).length === 1 && amendment && Object.keys(amendment).length === 1 &&
    Array.isArray(rule) && rule.length > 0 && rule.every(v => typeof v === 'string' && v.length > 0) &&
    sameApprovalDecision(rule, params.proposedExecpolicyAmendment);
  if (!ordinary && !proposed) throw Error('GPU가 제시하지 않은 승인 선택입니다');
  const available = params.availableDecisions;
  if (available != null && (!Array.isArray(available) || !available.some(value => sameApprovalDecision(value, decision))))
    throw Error('GPU가 제공한 승인 선택이 아닙니다');
  if (available == null && !['accept','decline','cancel'].includes(decision)) throw Error('GPU 승인 선택 목록이 필요합니다');
}

export function pendingCommand(state, threadId, requestId, decision) {
  if (!UUID.test(threadId ?? '') || state?.id !== threadId || state.sessionId !== threadId || !validId(requestId))
    throw Error('승인 요청의 작업을 확인할 수 없습니다');
  const matches = (state.requests ?? []).filter(request => request.id === requestId);
  const request = matches.length === 1 ? matches[0] : null, params = request?.params;
  if (request?.method !== REQUEST_METHOD || params?.threadId !== threadId || !UUID.test(params.turnId ?? '') ||
      typeof params.itemId !== 'string' || !params.itemId || typeof params.command !== 'string' || !params.command ||
      typeof params.cwd !== 'string' || !params.cwd ||
      !turnsOf(state).some(turn => turn.turnId === params.turnId && turn.status === 'inProgress'))
    throw Error('현재 대기 중인 명령 승인 요청이 아닙니다. 화면을 다시 확인해 주세요');
  // Carry the actual click; never synthesize a saved rule or upgrade accept.
  validDecision(decision, params);
  return {threadId, requestId, turnId: params.turnId, itemId: params.itemId,
    requestHash: hash({id: request.id, method: request.method, params}), decision: structuredClone(decision)};
}

export function commandApprovalFromFollower(message, policy) {
  if (message?.method !== COMMAND_APPROVAL_METHOD || message.version !== 1 ||
      !policy?.online || policy.preview || !policy.followers.has(message.sourceClientId) ||
      !policy.matches(message) || message.params?.conversationId !== policy.threadId)
    throw Error('연결된 작업 창에서 승인 버튼을 눌러 주세요');
  return {...pendingCommand(policy.state, policy.threadId, message.params.requestId, message.params.decision),
    ownerClientId: policy.owner};
}

export function verifyCommandApproval(session, expected) {
  if (!expected || !UUID.test(expected.ownerClientId ?? '') || session?.ownerClientId !== expected.ownerClientId ||
      session.threadId !== expected.threadId || session.stale || !Number.isFinite(session.receivedAt) ||
      Date.now() - session.receivedAt > 5000 || session.receivedAt > Date.now() + 1000)
    throw Error('GPU 승인 요청의 연결이 바뀌었습니다');
  const current = pendingCommand(session.state, expected.threadId, expected.requestId, expected.decision);
  if (current.turnId !== expected.turnId || current.itemId !== expected.itemId || current.requestHash !== expected.requestHash)
    throw Error('GPU 승인 요청이 변경되어 선택을 전달하지 않았습니다');
  return current;
}

export function approvalKey(approval) {
  return hash([approval.ownerClientId, approval.threadId, approval.turnId, approval.itemId, approval.requestId, approval.requestHash]);
}

function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Commit the exact request/choice before dispatch. A crash or timeout never
// causes a decision to be replayed to a replacement app-server request.
export class CommandApprovalJournal {
  constructor(directory) { this.directory = directory; this.pending = new Map(); }
  run(approval, send) {
    const key = approvalKey(approval), previous = this.pending.get(key);
    if (previous) return sameApprovalDecision(previous.decision, approval.decision) ? previous.promise : Promise.reject(Error('이미 다른 승인 선택을 전달했습니다'));
    const promise = Promise.resolve().then(async () => {
      fs.mkdirSync(this.directory, {recursive: true});
      const attempted = path.join(this.directory, key + '.json'), result = path.join(this.directory, key + '-result.json');
      if (fs.existsSync(attempted)) {
        if (!sameApprovalDecision(JSON.parse(fs.readFileSync(attempted, 'utf8')).decision, approval.decision)) throw Error('이미 다른 승인 선택을 전달했습니다');
        if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, 'utf8'));
        throw Error('이전 승인 전달 결과가 불확실하여 다시 보내지 않았습니다');
      }
      writeOnce(attempted, {...approval, attemptedAt: new Date().toISOString()});
      const response = await send();
      if (response?.ok !== true) throw Error('GPU 승인 응답을 확인하지 못했습니다');
      writeOnce(result, response); return response;
    });
    this.pending.set(key, {decision: approval.decision, promise}); return promise;
  }
}
