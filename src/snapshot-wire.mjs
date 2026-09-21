import {applyPatches} from './state.mjs';

const MAX_PATCHES = 4096;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
// SessionState replaces its state on each update. Compare values so unchanged
// inline images stay local instead of being sent again on every text delta.
function diff(before, after, path, patches) {
  if (before === after) return;
  if (path.length > 64 || patches.length >= MAX_PATCHES) throw Error('Use snapshot');
  if (before && after && typeof before === 'object' && typeof after === 'object' &&
      Array.isArray(before) === Array.isArray(after)) {
    if (Array.isArray(before)) {
      for (let i = before.length - 1; i >= after.length; i--) patches.push({op:'remove',path:[...path,i]});
      for (let i = 0; i < after.length; i++) {
        if (i < before.length) diff(before[i],after[i],[...path,i],patches);
        else patches.push({op:'add',path:[...path,i],value:after[i]});
        if (patches.length > MAX_PATCHES) throw Error('Use snapshot');
      }
    } else {
      for (const key of Object.keys(before)) {
        if (unsafe.has(key)) throw Error('Use snapshot');
        if (!Object.hasOwn(after,key)) patches.push({op:'remove',path:[...path,key]});
      }
      for (const key of Object.keys(after)) {
        if (unsafe.has(key)) throw Error('Use snapshot');
        if (Object.hasOwn(before,key)) diff(before[key],after[key],[...path,key],patches);
        else patches.push({op:'add',path:[...path,key],value:after[key]});
        if (patches.length > MAX_PATCHES) throw Error('Use snapshot');
      }
    }
  } else patches.push({op:'replace',path,value:after});
}
class SnapshotCache {
  states = new Map();
  save(message) {
    this.states.delete(message.threadId);
    this.states.set(message.threadId,message);
    if (this.states.size > 16) this.states.delete(this.states.keys().next().value);
  }
  envelope(message, transform) {
    if (message?.type === 'snapshot' || message?.type === 'snapshot-delta') return transform(message);
    if (message?.result?.type === 'snapshot' || message?.result?.type === 'snapshot-delta')
      return {...message,result:transform(message.result)};
    return message;
  }
}
export class SnapshotSender extends SnapshotCache {
  encode(message) {
    return this.envelope(message,snapshot => {
      const old = this.states.get(snapshot.threadId);
      let wire = snapshot;
      if (old && old.ownerClientId === snapshot.ownerClientId && old.appVersion === snapshot.appVersion && snapshot.revision >= old.revision) {
        try {
          const patches = [];
          diff(old.state,snapshot.state,[],patches);
          const {state,...metadata} = snapshot;
          wire = {...metadata,type:'snapshot-delta',baseRevision:old.revision,patches};
        } catch { /* Large structural changes start a fresh baseline. */ }
      }
      this.save(snapshot);
      return wire;
    });
  }
}
export class SnapshotReceiver extends SnapshotCache {
  decode(message) {
    return this.envelope(message,wire => {
      let snapshot = wire;
      if (wire.type === 'snapshot-delta') {
        const old = this.states.get(wire.threadId);
        if (!old || old.revision !== wire.baseRevision || old.ownerClientId !== wire.ownerClientId || old.appVersion !== wire.appVersion ||
            !Number.isSafeInteger(wire.revision) || wire.revision < old.revision || !Array.isArray(wire.patches) || wire.patches.length > MAX_PATCHES)
          throw Error('Snapshot baseline mismatch');
        const {baseRevision,patches,...metadata} = wire;
        snapshot = {...metadata,type:'snapshot',state:applyPatches(old.state,patches)};
        if (snapshot.state?.id !== wire.threadId) throw Error('Snapshot identity mismatch');
      }
      this.save(snapshot);
      return snapshot;
    });
  }
}
