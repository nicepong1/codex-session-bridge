import {UUID} from './guard-policy.mjs';

// Desktop sorts its catalog by recencyAt; mobile's file-backed updated_at list
// also breaks equal-second ties by descending ID. This is display metadata only.
// A subsecond rank preserves those ties without changing createdAt, updatedAt,
// turns, task IDs, or any data on the GPU. Keep the complete bounded index so
// pagination and individual hydration reads use the same ordering.
export class DesktopRecentOrder {
  constructor() { this.rows = new Map(); this.ready = false; }
  clear() { this.rows.clear(); this.ready = false; }
  replace(rows) {
    if (!Array.isArray(rows) || rows.length > 5000) throw new Error('Invalid remote ordering catalog');
    const ordered = rows.filter(t => UUID.test(t?.id ?? '') && Number.isFinite(t.updatedAt))
      .sort((a,b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const next = new Map();
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end].updatedAt === ordered[start].updatedAt) end++;
      for (let i = start; i < end; i++) {
        const row = ordered[i];
        next.set(row.id, {cwd: row.cwd, projectId: row.projectId, updatedAt: row.updatedAt, createdAt: row.createdAt,
          recencyAt: row.updatedAt + (end - i) / (end - start + 1) / 2});
      }
      start = end;
    }
    this.rows = next; this.ready = true;
  }
  project(thread) {
    const row = this.rows.get(thread?.id);
    if (!row) return thread;
    // A newly observed turn may be newer than the last catalog scan.
    if (Number.isFinite(thread.updatedAt) && thread.updatedAt > row.updatedAt)
      return {...thread, recencyAt: thread.updatedAt};
    return {...thread, updatedAt: row.updatedAt, recencyAt: row.recencyAt,
      ...(Number.isFinite(row.createdAt) ? {createdAt: row.createdAt} : {})};
  }
  response(method, result) {
    if (method === 'thread/list') return {...result, data: result.data.map(t => this.project(t))};
    if (method === 'thread/read' && result.thread) return {...result, thread: this.project(result.thread)};
    return result;
  }
}
