import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';

export class RpcPeer extends EventEmitter {
  pending = new Map();
  closed = false;
  constructor(send) { super(); this.send = send; }
  request(method, params, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('RPC channel closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC outcome unknown: ' + method)); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  accept(message) {
    if (message.id != null && (Object.hasOwn(message, 'result') || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error.message ?? 'RPC error')));
      else pending.resolve(message.result);
    } else this.emit('message', message);
  }
  close() { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('RPC channel lost; do not automatically resend')); } this.pending.clear(); }
}
