// Reuse display metadata briefly. Execution, task history, auth, permissions,
// configuration and usage limits always go to the existing read path.
const METHODS = new Set(['model/list', 'modelProvider/capabilities/read', 'collaborationMode/list', 'experimentalFeature/list']);

export class MetadataReadCache {
  constructor({ttlMs = 30000, maxEntries = 32, now = Date.now, onUse = () => {}} = {}) {
    Object.assign(this, {ttlMs, maxEntries, now, onUse});
    this.entries = new Map(); this.generation = 0;
  }
  async read(method, params, fetch) {
    if (!METHODS.has(method)) return fetch();
    // Preserve every parameter and its JSON representation. Different projects,
    // providers, filters and pagination cursors must not share a result.
    const key = JSON.stringify([method, params ?? null]);
    if (key.length > 16384) return fetch();
    let entry = this.entries.get(key);
    if (entry && !entry.pending && entry.expiresAt <= this.now()) {
      this.entries.delete(key); entry = null;
    }
    if (entry) {
      this.onUse({method, cache: entry.pending ? 'shared' : 'hit'});
      return structuredClone(await entry.promise);
    }
    this.onUse({method, cache: 'miss'});
    const generation = this.generation;
    entry = {pending: true, expiresAt: 0};
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, entry);
    entry.promise = Promise.resolve().then(fetch).then(result => {
      if (generation !== this.generation) throw new Error('GPU metadata connection changed; fetch again');
      const stored = structuredClone(result);
      entry.pending = false; entry.expiresAt = this.now() + this.ttlMs;
      if (JSON.stringify(stored).length > 1024 * 1024 && this.entries.get(key) === entry) this.entries.delete(key);
      return stored;
    }).catch(error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return structuredClone(await entry.promise);
  }
  clear() { this.generation++; this.entries.clear(); }
}
