const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function archiveWriteRoute(method, params) {
  if (!['thread/archive', 'thread/unarchive'].includes(method) || !params || Array.isArray(params) ||
      Object.keys(params).some(key => key !== 'threadId') || !UUID.test(params.threadId ?? ''))
    throw Error('gpu-guard-denied: invalid archive request');
  return {method, params: {threadId: params.threadId}};
}

export function archiveResponse(method, params, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      (method === 'thread/unarchive' && result.thread?.id !== params.threadId))
    throw Error('GPU archive result could not be verified; do not automatically resend');
  return method === 'thread/archive' ? {} : result;
}
