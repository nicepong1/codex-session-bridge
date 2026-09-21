import {EventEmitter} from 'node:events';
import {UUID} from './guard-policy.mjs';

// Poll metadata on the read-only history transport; never open or execute tasks.
export class CatalogPoller extends EventEmitter {
  constructor({fetchPage, canRun = () => true, intervalMs = 30000, maxPages = 50, now = Date.now, autoStart = true}) {
    super();
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('Invalid catalog polling limits');
    Object.assign(this, {fetchPage, canRun, intervalMs, maxPages, now});
    this.baseline = null; this.pending = null; this.closed = false; this.generation = 0; this.nextAt = 0; this.failures = 0;
    if (autoStart) this.timer = setInterval(() => {
      if (!this.closed && !this.pending && this.canRun() && this.now() >= this.nextAt) this.scan().catch(() => {});
    }, 1000);
  }
  scan() {
    if (this.pending) return this.pending;
    if (this.closed || !this.canRun()) return Promise.resolve(null);
    const generation = this.generation, started = this.now();
    this.pending = (async () => {
      const rows = new Map(), cursors = new Set(); let cursor = null, pages = 0;
      do {
        if (this.closed || generation !== this.generation || !this.canRun()) throw new Error('Catalog scan interrupted');
        const result = await this.fetchPage({cursor, limit: 100}); pages++;
        if (!Array.isArray(result?.tasks) || result.tasks.length > 100 || !(result.nextCursor == null || typeof result.nextCursor === 'string')) throw new Error('Invalid catalog page');
        for (const row of result.tasks) {
          if (!UUID.test(row?.id ?? '') || !UUID.test(row.sessionId ?? row.id) || typeof row.title !== 'string' || row.title.length > 160 ||
              (row.cwd != null && (typeof row.cwd !== 'string' || row.cwd.length > 4096)) ||
              (row.projectId != null && !UUID.test(row.projectId)) ||
              (row.updatedAt != null && !Number.isFinite(row.updatedAt)) ||
              (row.recencyAt != null && !Number.isFinite(row.recencyAt))) throw new Error('Invalid catalog row');
          rows.set(row.id, {id: row.id, sessionId: row.sessionId ?? row.id, title: row.title, cwd: row.cwd ?? null,
            ...(row.projectId != null ? {projectId: row.projectId} : {}),
            ...(Number.isFinite(row.createdAt) ? {createdAt: row.createdAt} : {}), updatedAt: row.updatedAt ?? null,
            ...(Number.isFinite(row.recencyAt) ? {recencyAt: row.recencyAt} : {})});
        }
        cursor = result.nextCursor ?? null;
        if (cursor && (cursor.length > 4096 || cursors.has(cursor))) throw new Error('Invalid catalog cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor && pages < this.maxPages);
      if (this.closed || generation !== this.generation || !this.canRun()) throw new Error('Catalog scan interrupted');
      const fingerprints = new Map([...rows].map(([id, row]) => [id, JSON.stringify(row)]));
      const changes = this.baseline === null ? [] : [...rows.values()].filter(row => this.baseline.get(row.id) !== fingerprints.get(row.id));
      const initial = this.baseline === null;
      this.baseline = fingerprints; this.failures = 0;
      this.emit('rows', [...rows.values()]);
      if (changes.length) this.emit('changes', changes);
      const progress = {checkedAt: new Date(this.now()).toISOString(), tasks: rows.size, pages, complete: cursor === null,
        initial, changed: changes.length, elapsedMs: this.now() - started};
      this.emit('progress', progress); return progress;
    })().catch(error => {
      if (!this.closed && generation === this.generation) { this.failures++; this.emit('failure', {reason: error.message, failures: this.failures}); }
      throw error;
    }).finally(() => {
      this.pending = null;
      this.nextAt = generation === this.generation ? this.now() + Math.min(60000, this.intervalMs * 2 ** Math.min(this.failures, 3)) : 0;
    });
    return this.pending;
  }
  invalidate() { this.generation++; this.nextAt = 0; }
  close() { this.closed = true; this.generation++; clearInterval(this.timer); this.baseline = null; }
}
