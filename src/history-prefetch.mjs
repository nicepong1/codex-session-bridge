import {EventEmitter} from 'node:events';
import {UUID} from './guard-policy.mjs';
import {TESTED_APP_VERSION,supportedHostVersion} from './installed.mjs';
import {PREVIEW_MAX_BYTES} from './stored-history-preview.mjs';

// One low-priority read at a time. Cache holds display data only, never an owner
// or an input destination. It is private to this connection window in memory.
export class HistoryPrefetch extends EventEmitter {
  constructor({fetch, canFetch = () => true, now = Date.now, maxEntries = 256, maxBytes = 128 * 1024 * 1024,
    ttlMs = 300000, autoStart = true} = {}) {
    super(); Object.assign(this, {fetch, canFetch, now, maxEntries, maxBytes, ttlMs});
    this.entries = new Map(); this.queue = new Map(); this.versions = new Map(); this.failures = new Map();
    this.bytes = 0; this.generation = 0; this.pending = null; this.closed = false;
    if (autoStart) this.timer = setInterval(() => { this.pump().catch(() => {}); }, 150);
  }
  enqueue(threads) {
    if (this.closed) return;
    for (const thread of threads) {
      if (!UUID.test(thread.id ?? '') || thread.ephemeral || (thread.sessionId != null && thread.sessionId !== thread.id)) continue;
      const version = JSON.stringify([thread.sessionId ?? thread.id, thread.updatedAt ?? null]);
      const entry = this.entries.get(thread.id);
      if (!this.versions.has(thread.id) && this.versions.size >= this.maxEntries) continue;
      this.versions.set(thread.id, version);
      if (entry && entry.version !== version) this.remove(thread.id);
      if ((!entry || entry.version !== version || this.now() - entry.savedAt >= this.ttlMs) && this.pending?.id !== thread.id)
        this.queue.set(thread.id, version);
    }
  }
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (this.now() - entry.savedAt >= this.ttlMs || entry.version !== this.versions.get(id)) { this.remove(id); return null; }
    this.entries.delete(id); this.entries.set(id, entry);
    return structuredClone(entry.preview);
  }
  remove(id) { const entry = this.entries.get(id); if (entry) this.bytes -= entry.bytes; this.entries.delete(id); }
  async pump() {
    if (this.closed || this.pending || !this.canFetch()) return;
    for (const [id, entry] of this.entries) if (this.now() - entry.savedAt >= this.ttlMs) this.queue.set(id, this.versions.get(id));
    const next = [...this.queue].find(([id]) => (this.failures.get(id) ?? 0) <= this.now());
    if (!next) return;
    const [id, version] = next, generation = this.generation;
    this.queue.delete(id);
    const pending = {id}; this.pending = pending;
    try {
      const preview = await this.fetch(id);
      if (this.closed || generation !== this.generation || this.versions.get(id) !== version) return;
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
    } catch (error) {
      if (!this.closed && generation === this.generation) {
        this.failures.set(id, this.now() + 60000);
        this.emit('failure', {threadId: id, reason: error.message});
      }
    } finally {
      if (this.pending === pending) this.pending = null;
      if (!this.closed && generation === this.generation && this.versions.get(id) !== version && this.versions.has(id))
        this.queue.set(id, this.versions.get(id));
      this.emit('progress', {cached: this.entries.size, queued: this.queue.size, bytes: this.bytes});
    }
  }
  invalidate() {
    this.generation++; this.entries.clear(); this.failures.clear(); this.bytes = 0;
    this.queue = new Map(this.versions);
  }
  clear() { this.invalidate(); this.queue.clear(); this.versions.clear(); }
  close() { this.closed = true; clearInterval(this.timer); this.clear(); }
}
