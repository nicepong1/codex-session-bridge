import {projectWriteRoute} from './project-write-policy.mjs';
import {archiveWriteRoute} from './archive-policy.mjs';
import {defaultModelWrite} from './model-settings.mjs';
import {newTaskParams,firstTaskTurn} from './new-task-policy.mjs';
import {threadTurnsParams} from './thread-history-policy.mjs';
export const GPU_THREAD = '00000000-0000-4000-8000-000000000001';
export const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const READS = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'model/list',
  'config/read', 'config/requirements/read', 'getAuthStatus', 'getUserAgent',
  'experimentalFeature/list', 'mcpServerStatus/list', 'skills/list', 'app/list',
  'project/list', 'configRequirements/read', 'remoteControl/status/read', 'collaborationMode/list', 'plugin/installed',
  'permissionProfile/list', 'windowsSandbox/readiness', 'threadSection/list', 'app/installed', 'modelProvider/capabilities/read']);

// No default forwarding: unknown methods and all execution/resume methods fail closed.
export function readRoute(method, params, threadId = GPU_THREAD) {
  if (!UUID.test(threadId)) throw new Error('Invalid selected GPU thread');
  if (READS.has(method)) return {method, params: params ?? {}};
  if (method === 'thread/read' && params?.threadId === threadId)
    return {method, params: {threadId, includeTurns: Boolean(params.includeTurns)}};
  if (method === 'thread/turns/list' && params?.threadId === threadId)
    return {method, params: threadTurnsParams(params, threadId)};
  if (method === 'thread/queue/list' && params?.threadId === threadId) {
    const limit = params.limit ?? 100;
    if (Array.isArray(params) || Object.keys(params).some(key => !['threadId','cursor','limit'].includes(key)) ||
        !Number.isInteger(limit) || limit < 1 || limit > 200 ||
        (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 4096)))
      throw Error('gpu-guard-denied: invalid queue query');
    return {method, params: {threadId, cursor: params.cursor ?? null, limit}};
  }
  if (method === 'thread/list') {
    // Returning the task in an archived query makes the desktop hide that same task.
    if (params?.archived === true || params?.cursor) return {local: {data: [], nextCursor: null}};
    return {method: 'thread/read', params: {threadId, includeTurns: false}, list: true};
  }
  if (method === 'thread/loaded/list') return {local: {data: [threadId]}};
  throw new Error('gpu-guard-denied: ' + method);
}

// The multi-task desktop may read GPU metadata for any task. Execution still uses a
// separately verified live owner and is never forwarded through this public facade.
export function hubReadRoute(method, params = {}) {
  if (method === 'project/read') {
    if (!UUID.test(params?.projectId ?? '')) throw new Error('gpu-guard-denied: invalid project');
    return {method, params: {projectId: params.projectId}};
  }
  if (method === 'thread/read' || method === 'thread/turns/list' || method === 'thread/queue/list') {
    if (!UUID.test(params?.threadId ?? '')) throw new Error('gpu-guard-denied: invalid thread');
    return readRoute(method, params, params.threadId);
  }
  if (method === 'thread/list') {
    const limit = params?.limit ?? 50;
    const validCwd = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 ||
        (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 4096)) ||
        (params.archived != null && typeof params.archived !== 'boolean') ||
        (params.sectionId != null && (typeof params.sectionId !== 'string' || !UUID.test(params.sectionId))) ||
        (params.sortKey != null && !['created_at', 'updated_at', 'recency_at', 'section_position'].includes(params.sortKey)) ||
        (params.sortDirection != null && !['asc', 'desc'].includes(params.sortDirection)) ||
        (params.projectId != null && !UUID.test(params.projectId)) ||
        (params.useStateDbOnly != null && typeof params.useStateDbOnly !== 'boolean') ||
        (params.cwd != null && !(validCwd(params.cwd) || (Array.isArray(params.cwd) && params.cwd.length <= 100 && params.cwd.every(validCwd))))) throw new Error('gpu-guard-denied: invalid list query');
    // The desktop queries each sidebar section separately. Dropping this filter
    // makes every GPU task appear pinned, even though its ID and title are correct.
    return {method, params: {limit, cursor: params.cursor ?? null, archived: params.archived ?? false,
      sortKey: params.sortKey ?? 'updated_at', useStateDbOnly: params.sectionId != null || (Array.isArray(params.cwd) && params.useStateDbOnly === true), sourceKinds: [],
      ...(params.sectionId != null ? {sectionId: params.sectionId} : {}),
      ...(params.sortDirection != null ? {sortDirection: params.sortDirection} : {}),
      ...(Object.hasOwn(params, 'projectId') ? {projectId: params.projectId} : {}),
      ...(params.cwd != null ? {cwd: Array.isArray(params.cwd) ? [...params.cwd] : params.cwd} : {})}};
  }
  if (method === 'thread/loaded/list') return {method, params: {}};
  return readRoute(method, params);
}

// The isolated desktop's open request is translated into an official GPU app
// navigation action. It is never passed to a CLI thread/resume endpoint.
export function desktopHubRoute(method, params) {
  if (method === 'thread/archive' || method === 'thread/unarchive') return {write: true, ...archiveWriteRoute(method, params)};
  // The hub must separately authorize creation and verify a bridge-created ID
  // for the first turn. These routes never reach the general metadata proxy.
  if (method === 'thread/start') return {newTask: true, method, params:newTaskParams(params)};
  if (method === 'turn/start') {firstTaskTurn(params);return {newTask: true, method, params};}
  if (method === 'config/batchWrite') return {write: true, method, params: defaultModelWrite(params).params};
  if (method === 'project/create' || method === 'project/move') return {write: true, ...projectWriteRoute(method, params)};
  if (method === 'thread/resume') {
    if (!UUID.test(params?.threadId ?? '')) throw new Error('gpu-guard-denied: invalid task opening');
    // The official app includes a rollout path and local settings here. Drop
    // every field except the ID; only GPU metadata determines what is opened.
    return {activation: true, threadId: params.threadId};
  }
  return hubReadRoute(method, params);
}

export function textFromFollower(request, threadId = GPU_THREAD) {
  if (request?.method !== 'thread-follower-start-turn' || request.version !== 2 ||
      request.params?.conversationId !== threadId) throw new Error('Only a new text turn on the selected GPU task is supported');
  const turn = request.params.turnStart;
  if (turn?.request?.threadId !== threadId) throw new Error('GPU thread mismatch');
  const input = turn.request.input;
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== 'text' ||
      typeof input[0].text !== 'string' || !input[0].text.trim() || input[0].text.length > 16000)
    throw new Error('A single text message of at most 16000 characters is required');
  if ((turn.context?.attachments?.length ?? 0) || (turn.context?.commentAttachments?.length ?? 0) ||
      (input[0].text_elements?.length ?? 0)) throw new Error('Attachments are not supported by the GPU bridge');
  return input[0].text;
}

export function reportStatus(report, {now = Date.now(), alive = false} = {}) {
  if (report.endedAt || report.status === 'stopped') return 'stopped';
  if (!report.pid || !report.heartbeatAt) return 'unverified-legacy-report';
  const age = now - Date.parse(report.heartbeatAt);
  if (!Number.isFinite(age) || age < -5000 || age > 15000 || !alive) return 'offline';
  return report.status;
}
