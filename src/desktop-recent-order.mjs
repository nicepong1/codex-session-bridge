import {UUID} from './guard-policy.mjs';

// The GPU desktop's Recent list is ordered by recencyAt (last viewed), which is
// intentionally different from updatedAt (last file/content write). Preserve
// that official display metadata so background imports and direct GPU work do
// not reorder the notebook sidebar. A subsecond rank only breaks exact ties.
export class DesktopRecentOrder {
  constructor() { this.rows = new Map(); this.ready = false; }
  clear() { this.rows.clear(); this.ready = false; }
  replace(rows) {
    if (!Array.isArray(rows) || rows.length > 5000) throw new Error('Invalid remote ordering catalog');
    const rank = row => Number.isFinite(row.recencyAt) ? row.recencyAt : row.updatedAt;
    const ordered = rows.filter(t => UUID.test(t?.id ?? '') && Number.isFinite(t.updatedAt) && Number.isFinite(rank(t)))
      .sort((a,b) => rank(b) - rank(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const next = new Map();
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && rank(ordered[end]) === rank(ordered[start])) end++;
      for (let i = start; i < end; i++) {
        const row = ordered[i];
        next.set(row.id, {cwd: row.cwd, projectId: row.projectId, updatedAt: row.updatedAt, createdAt: row.createdAt,
          recencyAt: rank(row) + (end - i) / (end - start + 1) / 2});
      }
      start = end;
    }
    this.rows = next; this.ready = true;
  }
  project(thread) {
    const row = this.rows.get(thread?.id);
    if (!row) return thread;
    const updatedAt = Math.max(Number.isFinite(thread.updatedAt) ? thread.updatedAt : -Infinity, row.updatedAt);
    const recencyAt = Math.max(Number.isFinite(thread.recencyAt) ? thread.recencyAt : -Infinity, row.recencyAt);
    return {...thread, updatedAt, recencyAt,
      ...(Number.isFinite(row.createdAt) ? {createdAt: row.createdAt} : {})};
  }
  response(method, result) {
    if (method === 'thread/list') return {...result, data: result.data.map(t => this.project(t))};
    if (method === 'thread/read' && result.thread) return {...result, thread: this.project(result.thread)};
    return result;
  }
}
