import {EventEmitter} from 'node:events';
import {SshWorker} from './ssh-worker.mjs';

// Reconnect the read/observation transport. Never replay a dispatched RPC or queue a write.
export class ReconnectingWorker extends EventEmitter {
  constructor({threadId, seconds = 600, readySignal = 'snapshot', acceptSnapshot = () => {},
    createWorker = options => new SshWorker(options), delays = [1000, 2000, 5000, 10000, 30000], readyTimeoutMs = 30000}) {
    super();
    if (!Number.isInteger(seconds) || (seconds !== 0 && seconds < 10) || seconds > 86400 || !delays.length || delays.some(d => !Number.isInteger(d) || d < 1) ||
        !Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 120000) throw new Error('Invalid reconnect limits');
    if (!['snapshot', 'ready'].includes(readySignal)) throw new Error('Invalid readiness signal');
    Object.assign(this, {threadId, acceptSnapshot, createWorker, delays, readySignal, readyTimeoutMs});
    this.deadline = seconds === 0 ? Infinity : Date.now() + seconds * 1000;
    this.online = false; this.closed = false; this.blocked = false;
    this.attempts = 0; this.recoveries = 0; this.failures = 0; this.everOnline = false;
    this.waiters = new Set(); this.child = null;
    this.lifetime = seconds === 0 ? null : setTimeout(() => this.close(), seconds * 1000);
    queueMicrotask(() => this.connect());
  }
  connect() {
    if (this.closed || this.blocked) return;
    const remaining = Math.floor((this.deadline - Date.now()) / 1000);
    if (remaining < 10) { this.close(); return; }
    this.attempts++;
    this.emit('state', {status: 'connecting', attempts: this.attempts, recoveries: this.recoveries});
    let child;
    try { child = this.createWorker({threadId: this.threadId, seconds: Math.min(3600, remaining)}); }
    catch { this.lost(null, 'SSH launch failed'); return; }
    this.child = child;
    this.readyTimer = setTimeout(() => this.lost(child, 'GPU startup readiness timed out'), this.readyTimeoutMs);
    child.on('message', message => {
      if (this.closed || this.child !== child) return;
      if (message.type === this.readySignal) {
        clearTimeout(this.readyTimer);
        try { this.acceptSnapshot(message); }
        catch {
          this.blocked = true; this.online = false; this.child = null; child.close();
          this.rejectWaiters('GPU identity changed; restart explicitly');
          this.emit('offline', 'GPU identity or revision check failed');
          this.emit('state', {status: 'blocked', attempts: this.attempts, recoveries: this.recoveries});
          return;
        }
        const restored = !this.online;
        if (restored && this.everOnline) this.recoveries++;
        this.online = true; this.everOnline = true; this.failures = 0;
        this.emit('message', message);
        if (restored) {
          this.emit('state', {status: 'online', attempts: this.attempts, recoveries: this.recoveries});
          for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve(); }
          this.waiters.clear();
        }
      } else this.emit('message', message);
    });
    child.on('offline', reason => this.lost(child, reason));
  }
  lost(child, reason) {
    if (this.closed || this.blocked || this.child !== child) return;
    clearTimeout(this.readyTimer);
    this.child = null; this.online = false; child?.close();
    this.emit('offline', reason);
    const retryInMs = this.delays[Math.min(this.failures++, this.delays.length - 1)];
    this.emit('state', {status: 'reconnecting', reason, retryInMs, attempts: this.attempts, recoveries: this.recoveries});
    this.retryTimer = setTimeout(() => this.connect(), retryInMs);
  }
  waitUntilReady(timeoutMs = 12000) {
    if (this.closed || this.blocked) return Promise.reject(new Error('GPU connection unavailable'));
    if (this.online) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {resolve, reject};
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error('GPU reconnecting; request was not sent')); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
  async request(method, params) {
    if (method === 'read') await this.waitUntilReady();
    if (!this.online || !this.child || this.closed || this.blocked) throw new Error('GPU reconnecting; request was not sent');
    // Capture this generation. Its promise fails on loss instead of being sent to a new child.
    return this.child.request(method, params);
  }
  rejectWaiters(reason) {
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
    this.waiters.clear();
  }
  disconnectForTest() { if (this.child) this.lost(this.child, 'Injected SSH disconnect'); }
  close() {
    if (this.closed) return;
    this.closed = true; this.online = false;
    clearTimeout(this.retryTimer); clearTimeout(this.lifetime); clearTimeout(this.readyTimer);
    const child = this.child; this.child = null; child?.close();
    this.rejectWaiters('GPU connection stopped');
    this.emit('state', {status: 'stopped', attempts: this.attempts, recoveries: this.recoveries});
  }
}
