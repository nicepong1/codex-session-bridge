const CURSOR_LIMIT = 4096;
export const TURN_PAGE_LIMIT = 200;
export const TURN_PAGE_BYTES = 8 * 1024 * 1024;

export function threadTurnsParams(params, threadId) {
  if (!params || Array.isArray(params) || params.threadId !== threadId ||
      Object.keys(params).some(key => !['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'].includes(key)))
    throw new Error('gpu-guard-denied: invalid turn history query');
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > TURN_PAGE_LIMIT ||
      (params.cursor != null && (typeof params.cursor !== 'string' || !params.cursor.length || params.cursor.length > CURSOR_LIMIT)) ||
      (params.sortDirection != null && !['asc', 'desc'].includes(params.sortDirection)) ||
      (params.itemsView != null && !['notLoaded', 'summary', 'full'].includes(params.itemsView)))
    throw new Error('gpu-guard-denied: invalid turn history query');
  return {threadId, cursor: params.cursor ?? null, limit,
    sortDirection: params.sortDirection ?? 'desc', itemsView: params.itemsView ?? 'summary'};
}

export function verifiedTurnPage(result, {limit = 50} = {}) {
  if (!result || !Array.isArray(result.data) || result.data.length > limit ||
      !validCursor(result.nextCursor) || !validCursor(result.backwardsCursor))
    throw new Error('Invalid GPU turn history page');
  const ids = new Set();
  for (const turn of result.data) {
    if (!turn || typeof turn !== 'object' || typeof turn.id !== 'string' || !turn.id.length || turn.id.length > CURSOR_LIMIT || ids.has(turn.id))
      throw new Error('Invalid GPU turn history page');
    ids.add(turn.id);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > TURN_PAGE_BYTES) throw new Error('GPU turn history page exceeds size limit');
  return structuredClone(result);
}

function validCursor(value) {
  return value == null || (typeof value === 'string' && value.length > 0 && value.length <= CURSOR_LIMIT);
}
