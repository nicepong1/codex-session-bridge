const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function applyPatches(state, patches) {
  let next = structuredClone(state);
  if (!Array.isArray(patches)) throw new Error('Invalid patch list');
  for (const patch of patches) {
    if (!['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path)) {
      throw new Error('Unsupported patch');
    }
    if (patch.path.some(key => !['string', 'number'].includes(typeof key) || FORBIDDEN.has(String(key)))) {
      throw new Error('Unsafe patch path');
    }
    if (patch.path.length === 0) {
      if (patch.op === 'remove') throw new Error('Cannot remove state root');
      next = structuredClone(patch.value); continue;
    }
    let parent = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Missing patch path');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('Invalid patch parent');
    const key = patch.path.at(-1);
    if (Array.isArray(parent)) {
      if (!Number.isInteger(key) || key < 0 || key > parent.length || (patch.op !== 'add' && key === parent.length)) {
        throw new Error('Invalid array patch index');
      }
      if (patch.op === 'add') parent.splice(key, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') parent.splice(key, 1);
      else parent[key] = structuredClone(patch.value);
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('Missing patch target');
      if (patch.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(patch.value);
    }
  }
  return next;
}

export function turnsOf(state) {
  if (state?.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    return (history?.islands ?? []).flatMap(island => (island.entries ?? [])
      .map(entry => history.entitiesByKey?.[entry.value]).filter(Boolean));
  }
  return state?.turns ?? [];
}

export class SessionState {
  constructor(threadId, ownerClientId) { this.threadId = threadId; this.ownerClientId = ownerClientId; }
  state = null;
  revision = null;
  snapshots = 0;
  patches = 0;
  stale = true;
  receivedAt = 0;

  accept(message) {
    const params = message.params;
    if (message.method !== 'thread-stream-state-changed' || params?.conversationId !== this.threadId ||
        params?.hostId !== 'local' || message.sourceClientId !== this.ownerClientId) return false;
    if (message.version !== 11) { this.stale = true; throw new Error('Unsupported stream protocol version'); }
    const change = params.change;
    if (!Number.isSafeInteger(change?.revision) || change.revision < 0) { this.stale = true; throw new Error('Invalid revision'); }
    if (change.type === 'snapshot') {
      if (change.conversationState?.id !== this.threadId) { this.stale = true; throw new Error('Snapshot thread mismatch'); }
      if (this.revision !== null && change.revision < this.revision) return false;
      this.state = structuredClone(change.conversationState);
      this.snapshots++;
      this.stale = false;
    } else if (change.type === 'patches') {
      if (this.stale || this.state === null) throw new Error('Snapshot required before patches');
      if (change.revision <= this.revision) return false;
      if (change.baseRevision !== this.revision) { this.stale = true; throw new Error('Revision gap; fresh snapshot required'); }
      try { this.state = applyPatches(this.state, change.patches); }
      catch (error) { this.stale = true; throw error; }
      if (this.state?.id !== this.threadId) { this.stale = true; throw new Error('Patched thread mismatch'); }
      this.patches++;
    } else { this.stale = true; throw new Error('Unknown stream change'); }
    this.revision = change.revision;
    this.receivedAt = Date.now();
    return true;
  }

  summary() {
    const turns = turnsOf(this.state);
    const active = turns.filter(turn => turn.status === 'inProgress');
    return { threadId: this.threadId, sessionId: this.state?.sessionId ?? null, revision: this.revision,
      stale: this.stale, snapshots: this.snapshots, patches: this.patches, loadedTurnCount: turns.length,
      activeTurnIds: active.map(turn => turn.turnId).filter(Boolean),
      runtimeStatus: this.state?.threadRuntimeStatus?.type ?? null };
  }
}
