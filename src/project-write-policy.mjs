import path from 'node:path';
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = text => { throw new Error('gpu-guard-denied: ' + text); };
export function projectRoot(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || value.length > 4096 ||
      /[\x00-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':') ||
      value.slice(3).split(/[\\/]/).some(p => p === '..' || /[ .]$/.test(p))) fail('GPU의 Windows 폴더 전체 경로가 필요합니다');
  const normalized = path.win32.normalize(value);
  return normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized;
}
export function projectWriteRoute(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('invalid project request');
  if (method === 'project/create') {
    if (Object.keys(params).some(k => !['name', 'roots', 'metadata', 'idempotencyKey'].includes(k)) ||
        !uuid.test(params.idempotencyKey ?? '') || typeof params.name !== 'string' || !params.name.trim() ||
        params.name.length > 1024 || /[\x00-\x1f]/.test(params.name) || !Array.isArray(params.roots) ||
        !params.roots.length || params.roots.length > 100) fail('invalid project creation');
    const roots = params.roots.map(root => {
      if (!root || Object.keys(root).some(k => k !== 'path')) fail('invalid project root');
      return {path: projectRoot(root.path)};
    });
    if (new Set(roots.map(r => r.path.toLowerCase())).size !== roots.length) fail('duplicate project roots');
    const metadata = params.metadata ?? {};
    if (typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length > 20 ||
        Object.entries(metadata).some(([k,v]) => !['appearance.color', 'appearance.marker'].includes(k) ||
          typeof v !== 'string' || v.length > 4096)) fail('invalid project appearance');
    return {method, params: {name: params.name.trim(), roots, metadata: {...metadata}, idempotencyKey: params.idempotencyKey}};
  }
  if (method === 'project/move') {
    if (Object.keys(params).some(k => !['projectId','beforeProjectId'].includes(k)) || !uuid.test(params.projectId ?? '') ||
        (params.beforeProjectId != null && !uuid.test(params.beforeProjectId)) || params.projectId === params.beforeProjectId)
      fail('invalid project order');
    return {method, params: {projectId: params.projectId, beforeProjectId: params.beforeProjectId ?? null}};
  }
  fail(method);
}
