import {EventEmitter} from 'node:events';
import {UUID} from './guard-policy.mjs';
import {TESTED_APP_VERSION,supportedHostVersion} from './installed.mjs';
import {PREVIEW_MAX_BYTES} from './stored-history-preview.mjs';

// One low-priority read at a time. Cache holds display data only, never an owner
// or an input destination. It is private to this connection window in memory.
export class HistoryPrefetch extends EventEmitter {
  constructor({fetch, canFetch = () => true, now = Date.now, maxEntries = 32, maxKnown = 5000,
    maxBytes = 32 * 1024 * 1024, ttlMs = 300000, autoStart = true} = {}) {
    super(); Object.assign(this, {fetch, canFetch, now, maxEntries, maxKnown, maxBytes, ttlMs});
    this.entries = new Map(); this.queue = new Map(); this.versions = new Map(); this.eligible = new Set(); this.failures = new Map();
    this.foreground = new Map(); this.bytes = 0; this.generation = 0; this.pending = null; this.closed = false;
    if (autoStart) this.timer = setInterval(() => { this.pump().catch(() => {}); }, 150);
  }
  version(thread) { return JSON.stringify([thread.sessionId ?? thread.id, thread.updatedAt ?? null]); }
  retryAt(id) { return this.failures.get(id)?.retryAt ?? 0; }
  noteFailure(id, version, error) {
    const permanent = /exceeds (?:size|cache) limit/i.test(error?.message ?? '');
    this.failures.set(id, {version, retryAt: permanent ? Infinity : this.now() + 60000});
    this.emit('failure', {threadId: id, reason: error.message, permanent});
  }
  enqueue(threads) {
    if (this.closed) return;
    for (const thread of threads) {
      if (!UUID.test(thread.id ?? '') || thread.ephemeral || (thread.sessionId != null && thread.sessionId !== thread.id)) continue;
      const version = this.version(thread);
      const entry = this.entries.get(thread.id);
      if (!this.versions.has(thread.id) && this.versions.size >= this.maxKnown) continue;
      const oldVersion = this.versions.get(thread.id);
      this.versions.set(thread.id, version);
      if (oldVersion != null && oldVersion !== version) this.failures.delete(thread.id);
      if (!this.eligible.has(thread.id) && this.eligible.size < this.maxEntries) this.eligible.add(thread.id);
      if (entry && entry.version !== version) this.remove(thread.id);
      if (this.eligible.has(thread.id) && this.queue.size < this.maxEntries &&
          (!entry || entry.version !== version || this.now() - entry.savedAt >= this.ttlMs) &&
          this.pending?.id !== thread.id && !this.foreground.has(thread.id))
        this.queue.set(thread.id, version);
    }
  }
  replace(threads) {
    if (this.closed) return;
    const next = new Map();
    for (const thread of threads) {
      if (next.size >= this.maxKnown) break;
      if (!UUID.test(thread.id ?? '') || thread.ephemeral || (thread.sessionId != null && thread.sessionId !== thread.id)) continue;
      next.set(thread.id, this.version(thread));
    }
    for (const id of this.versions.keys()) if (!next.has(id)) { this.remove(id); this.failures.delete(id); }
    for (const [id, failure] of this.failures) if (next.get(id) !== failure.version) this.failures.delete(id);
    this.versions = next; this.eligible = new Set([...next.keys()].slice(0, this.maxEntries)); this.queue.clear();
    for (const id of this.entries.keys()) if (!this.eligible.has(id)) this.remove(id);
    for (const [id, version] of next) {
      if (this.queue.size >= this.maxEntries) break;
      const entry = this.entries.get(id);
      if (entry && entry.version !== version) this.remove(id);
      if ((!entry || entry.version !== version || this.now() - entry.savedAt >= this.ttlMs) &&
          this.pending?.id !== id && !this.foreground.has(id)) this.queue.set(id, version);
    }
  }
  prioritize(id) {
    const version = this.versions.get(id);
    if (!version || this.closed || this.get(id)) return false;
    this.eligible.delete(id); this.eligible = new Set([id, ...this.eligible]);
    while (this.eligible.size > this.maxEntries) this.eligible.delete([...this.eligible].at(-1));
    this.queue.delete(id);
    this.queue = new Map([[id, version], ...this.queue]);
    while (this.queue.size > this.maxEntries) this.queue.delete([...this.queue.keys()].at(-1));
    return true;
  }
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (this.now() - entry.savedAt >= this.ttlMs || entry.version !== this.versions.get(id)) { this.remove(id); return null; }
    this.entries.delete(id); this.entries.set(id, entry);
    return structuredClone(entry.preview);
  }
  remove(id) { const entry = this.entries.get(id); if (entry) this.bytes -= entry.bytes; this.entries.delete(id); }
  store(id, version, preview, generation) {
    if (this.closed || generation !== this.generation || this.versions.get(id) !== version) return null;
    if (preview?.type !== 'history-preview' || !supportedHostVersion(preview.appVersion) || preview.threadId !== id ||
        preview.state?.id !== id || preview.state?.sessionId !== id || preview.state?.resumeState !== 'resuming')
      throw new Error('GPU stored preview identity mismatch');
    const bytes = Buffer.byteLength(JSON.stringify(preview));
    if (bytes > PREVIEW_MAX_BYTES || bytes > this.maxBytes) throw new Error('GPU stored preview exceeds cache limit');
    this.remove(id);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
    this.entries.set(id, {preview: structuredClone(preview), bytes, savedAt: this.now(), version}); this.bytes += bytes;
    this.failures.delete(id);
    this.emit('ready', {threadId: id, bytes});
    return this.get(id);
  }
  async load(id) {
    const cached = this.get(id);
    if (cached) return cached;
    const version = this.versions.get(id), generation = this.generation;
    if (!version || this.closed) return null;
    const failure = this.failures.get(id);
    if (failure?.version === version && failure.retryAt === Infinity) return null;
    if (this.pending?.id === id) { await this.pending.promise; return this.get(id); }
    if (this.foreground.has(id)) return this.foreground.get(id);
    this.queue.delete(id);
    const request = (async () => {
      try { return this.store(id, version, await this.fetch(id), generation); }
      catch (error) {
        if (!this.closed && generation === this.generation) {
          this.noteFailure(id, version, error);
        }
        return null;
      } finally {
        this.foreground.delete(id);
        this.emit('progress', {cached: this.entries.size, queued: this.queue.size, bytes: this.bytes});
      }
    })();
    this.foreground.set(id, request); return request;
  }
  async pump() {
    if (this.closed || this.pending || !this.canFetch()) return;
    for (const [id, entry] of this.entries) if (this.now() - entry.savedAt >= this.ttlMs && this.queue.size < this.maxEntries)
      this.queue.set(id, this.versions.get(id));
    const next = [...this.queue].find(([id]) => !this.foreground.has(id) && this.retryAt(id) <= this.now());
    if (!next) return;
    const [id, version] = next, generation = this.generation;
    this.queue.delete(id);
    const pending = {id, promise: null}; this.pending = pending;
    try {
      pending.promise = Promise.resolve(this.fetch(id)).then(preview => this.store(id, version, preview, generation));
      await pending.promise;
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.noteFailure(id, version, error);
      }
    } finally {
      if (this.pending === pending) this.pending = null;
      if (!this.closed && generation === this.generation && this.versions.get(id) !== version && this.versions.has(id))
        this.queue.set(id, this.versions.get(id));
      this.emit('progress', {cached: this.entries.size, queued: this.queue.size, bytes: this.bytes});
    }
  }
  invalidate() {
    this.generation++; this.entries.clear(); this.bytes = 0;
    for (const [id, failure] of this.failures) if (failure.retryAt !== Infinity) this.failures.delete(id);
    this.queue = new Map([...this.eligible].map(id => [id, this.versions.get(id)]).filter(([, version]) => version != null));
  }
  clear() { this.invalidate(); this.queue.clear(); this.versions.clear(); this.eligible.clear(); this.failures.clear(); }
  close() { this.closed = true; clearInterval(this.timer); this.clear(); }
}
