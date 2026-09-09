import {UUID} from './guard-policy.mjs';
import {TESTED_APP_VERSION} from './installed.mjs';

export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const timeMs = value => Number.isFinite(value) ? value * 1000 : null;

// Map the public stored history into the desktop's display shape. This does not
// claim a live owner, resume a runtime, or import permissions from storage.
export function storedHistoryPreview(thread, id, {maxTurns = 20, maxBytes = PREVIEW_MAX_BYTES, appVersion=TESTED_APP_VERSION} = {}) {
  if (!UUID.test(id ?? '') || thread?.id !== id || thread.sessionId !== id || thread.ephemeral || !Array.isArray(thread.turns))
    throw new Error('Invalid stored GPU history identity');
  const source = thread.turns.slice(-maxTurns);
  const turns = source.map(turn => {
    if (typeof turn.id !== 'string' || !Array.isArray(turn.items)) throw new Error('Invalid stored turn');
    const first = turn.items.find(item => item.type !== 'contextCompaction');
    return {turnId: turn.id, params: {threadId: id, input: first?.type === 'userMessage' ? first.content : [],
      ...(first?.type === 'functionCallOutput' ? {toolOutput: {name: first.name, namespace: first.namespace, output: first.output}} : {}),
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: {type: 'readOnly'},
      model: thread.model ?? '', cwd: thread.cwd ?? null, effort: thread.reasoningEffort ?? null,
      summary: 'none', personality: null, outputSchema: null, collaborationMode: null, attachments: []},
      permissionParamsSource: 'inferred', turnStartedAtMs: timeMs(turn.startedAt), durationMs: turn.durationMs ?? null,
      finalAssistantStartedAtMs: timeMs(turn.completedAt), status: turn.status, error: turn.error ?? null, diff: null,
      items: turn.items.map(item => {
        if (item.type === 'collabAgentToolCall') return {...item, receiverThreads: (item.receiverThreadIds ?? []).map(threadId => ({threadId, thread: null}))};
        // Local GPU image paths are intentionally not interpreted on the laptop.
        if (item.type === 'imageGeneration') return {...item, src: typeof item.result === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(item.result) ? item.result : null};
        return item;
      })};
  });
  if (new Set(turns.map(turn => turn.turnId)).size !== turns.length) throw new Error('Duplicate stored turn IDs');
  const createdAt = timeMs(thread.createdAt) ?? Date.now(), updatedAt = timeMs(thread.updatedAt) ?? createdAt;
  const state = {id, sessionId: id, hostId: 'local', ephemeral: false, forkedFromId: thread.forkedFromId ?? null,
    parentThreadId: thread.parentThreadId ?? null, turns, requests: [], createdAt, updatedAt,
    recencyAt: timeMs(thread.recencyAt) ?? updatedAt, title: thread.name ?? null, source: thread.source,
    agentNickname: thread.agentNickname ?? null, threadSource: thread.threadSource ?? null, historyMode: thread.historyMode,
    mode: thread.mode, threadStartKind: thread.threadStartKind, modelProvider: thread.modelProvider,
    latestModel: thread.model ?? '', latestReasoningEffort: thread.reasoningEffort ?? null, previousTurnModel: null,
    latestCollaborationMode: {mode: 'default', settings: {model: thread.model ?? '', reasoning_effort: thread.reasoningEffort ?? null, developer_instructions: null}},
    hasUnreadTurn: false, threadGoal: null, threadRuntimeStatus: {type: 'notLoaded'}, rolloutPath: '',
    gitInfo: thread.gitInfo ?? null, resumeState: 'resuming', latestTokenUsageInfo: null, workspaceKind: 'project',
    workspaceBrowserRoot: null, projectlessOutputDirectory: null, cwd: thread.cwd ?? null,
    turnsPagination: {olderCursor: null, oldestLoadedTurnId: turns[0]?.turnId ?? null, isLoadingOlder: false,
      hasLoadedOldest: source.length === thread.turns.length}};
  const result = {type: 'history-preview', appVersion, threadId: id,
    fetchedAt: Date.now(), updatedAt: thread.updatedAt, state};
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('GPU history preview exceeds size limit');
  return structuredClone(result);
}
