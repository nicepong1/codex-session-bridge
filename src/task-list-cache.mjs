import {hubReadRoute} from './guard-policy.mjs';

// Only sidebar pages. Conversation contents and execution never use this cache.
export class TaskListCache {
  constructor({freshMs = 2000, maxAgeMs = 30000, maxEntries = 8, maxBytes = 8 * 1024 * 1024,
    now = Date.now, onUse = () => {}, onUpdate = () => {}} = {}) {
    Object.assign(this, {freshMs, maxAgeMs, maxEntries, maxBytes, now, onUse, onUpdate});
    this.entries = new Map(); this.generation = 0;
  }
  async read(params, fetch) {
    const normalized = hubReadRoute('thread/list', params).params;
    const key = JSON.stringify(normalized);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {value: null, updatedAt: 0, retryAt: 0, pending: null};
      while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(key, entry);
    }
    const age = this.now() - entry.updatedAt;
    if (entry.value !== null && age < this.maxAgeMs) {
      this.onUse({cache: age < this.freshMs ? 'hit' : 'stale'});
      if (age >= this.freshMs && !entry.pending && this.now() >= entry.retryAt)
        this.refresh(key, entry, normalized, fetch).catch(() => {});
      return structuredClone(entry.value);
    }
    this.onUse({cache: entry.pending ? 'shared' : 'miss'});
    return structuredClone(await (entry.pending ?? this.refresh(key, entry, normalized, fetch)));
  }
  refresh(key, entry, params, fetch) {
    const generation = this.generation;
    entry.pending = Promise.resolve().then(() => fetch(params)).then(result => {
      if (generation !== this.generation) throw new Error('GPU task list connection changed; fetch again');
      if (!Array.isArray(result?.data) || !(result.nextCursor == null || typeof result.nextCursor === 'string'))
        throw new Error('Invalid GPU task list');
      const value = structuredClone(result);
      if (Buffer.byteLength(JSON.stringify(value)) <= this.maxBytes) {
        entry.value = value; entry.updatedAt = this.now(); entry.retryAt = 0;
      } else if (this.entries.get(key) === entry) this.entries.delete(key);
      this.onUpdate(structuredClone(value), params);
      this.onUse({cache: 'refreshed'});
      return value;
    }).catch(error => {
      entry.retryAt = this.now() + this.freshMs;
      this.onUse({cache: 'error'});
      // Keep the last good page only until its original hard deadline.
      if (entry.value === null && this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }
  clear() { this.generation++; this.entries.clear(); }
}
