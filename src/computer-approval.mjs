import {createHash} from 'node:crypto';
import {turnsOf} from './state.mjs';
import {CommandApprovalJournal} from './command-approval.mjs';

export const COMPUTER_APPROVAL_METHOD = 'thread-follower-submit-mcp-server-elicitation-response';
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
const empty = value => object(value) && Object.keys(value).length === 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function validateResponse(response, persist) {
  if (!object(response) || Object.keys(response).some(key => !['action','content','_meta'].includes(key)) ||
      !['accept','decline','cancel'].includes(response.action)) throw Error('지원하지 않는 앱 승인 응답입니다');
  if (response.action === 'accept' ? !empty(response.content) : response.content !== null)
    throw Error('앱 승인에 추가 입력 내용을 전달할 수 없습니다');
  if (response._meta != null) {
    if (!object(response._meta) || Object.keys(response._meta).some(key => key !== 'persist'))
      throw Error('앱 승인 선택 범위를 확인할 수 없습니다');
    if (response._meta.persist != null && (response.action !== 'accept' ||
        !['session','always'].includes(response._meta.persist) || ![persist].flat().includes(response._meta.persist)))
      throw Error('GPU가 제공한 앱 허용 범위가 아닙니다');
  }
}

export function pendingComputerApproval(state, threadId, requestId, response) {
  const validId = (Number.isSafeInteger(requestId) && requestId >= 0) ||
    (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200);
  if (!UUID.test(threadId ?? '') || state?.id !== threadId || state.sessionId !== threadId || !validId)
    throw Error('앱 승인 요청의 작업을 확인할 수 없습니다');
  const matches = (state.requests ?? []).filter(r => r.id === requestId);
  const request = matches.length === 1 ? matches[0] : null, params = request?.params;
  const meta = params?._meta, schema = params?.requestedSchema;
  // Only native Computer Use app access. No connector OAuth, browser auth,
  // arbitrary MCP forms, tool execution approval, or credential content.
  if (request?.method !== 'mcpServer/elicitation/request' || params?.threadId !== threadId ||
      !UUID.test(params.turnId ?? '') || params.mode !== 'form' || !['node_repl','computer-use'].includes(params.serverName) ||
      meta?.codex_approval_kind !== 'mcp_tool_call' || meta.connector_id !== 'computer-use' || meta.tool_name != null ||
      !object(meta.tool_params) || Object.keys(meta.tool_params).length !== 1 ||
      typeof meta.tool_params.app !== 'string' || !meta.tool_params.app.trim() ||
      schema?.type !== 'object' || !empty(schema.properties) ||
      (schema.required != null && (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
      (schema.additionalProperties != null && schema.additionalProperties !== false) ||
      !turnsOf(state).some(turn => turn.turnId === params.turnId && turn.status === 'inProgress'))
    throw Error('현재 대기 중인 Computer Use 앱 승인 요청이 아닙니다');
  validateResponse(response, meta.persist);
  return {threadId,requestId,turnId:params.turnId,itemId:'mcp:computer-use',requestHash:hash(request),response:structuredClone(response)};
}

export function computerApprovalFromFollower(message, policy) {
  if (message?.method !== COMPUTER_APPROVAL_METHOD || message.version !== 1 || !policy?.online || policy.preview ||
      !policy.followers.has(message.sourceClientId) || !policy.matches(message) || message.params?.conversationId !== policy.threadId)
    throw Error('연결된 작업 창에서 앱 승인 버튼을 눌러 주세요');
  return {...pendingComputerApproval(policy.state,policy.threadId,message.params.requestId,message.params.response),ownerClientId:policy.owner};
}

export function verifyComputerApproval(session, expected) {
  if (!expected || !UUID.test(expected.ownerClientId ?? '') || session?.ownerClientId !== expected.ownerClientId ||
      session.threadId !== expected.threadId || session.stale || !Number.isFinite(session.receivedAt) ||
      Date.now()-session.receivedAt > 5000 || session.receivedAt > Date.now()+1000)
    throw Error('GPU 앱 승인 요청의 연결이 바뀌었습니다');
  const current = pendingComputerApproval(session.state,expected.threadId,expected.requestId,expected.response);
  if (current.turnId !== expected.turnId || current.itemId !== expected.itemId || current.requestHash !== expected.requestHash)
    throw Error('GPU 앱 승인 요청이 변경되어 선택을 전달하지 않았습니다');
  return current;
}

// The durable journal stores only identity/hash and the user's response scope.
// App names, messages and request metadata are never written to the journal.
export class ComputerApprovalJournal extends CommandApprovalJournal {
  run({response,...approval},send) { return super.run({...approval,decision:response},send); }
}
