import {setTimeout as delay} from 'node:timers/promises';
import {UUID} from './guard-policy.mjs';

// Opening a stored task is an explicit foreground action, separate from reads.
// Serialize desktop navigation and reuse in-flight attempts; never start a turn.
export class TaskActivation {
  constructor({readThread, observe, openTask, isClosed = () => false, wait = delay, timeoutMs = 15000, onTiming = () => {}}) {
    Object.assign(this, {readThread, observe, openTask, isClosed, wait, timeoutMs, onTiming});
    this.pending = new Map(); this.failures = new Map(); this.tail = Promise.resolve();
  }
  activate(id) {
    if (!UUID.test(id ?? '')) return Promise.reject(new Error('Invalid existing GPU task ID'));
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size >= 8) return Promise.reject(new Error('Too many GPU tasks waiting to open'));
    for (const [key, expiry] of this.failures) if (expiry <= Date.now()) this.failures.delete(key);
    if ((this.failures.get(id) ?? 0) > Date.now()) return Promise.reject(new Error('GPU task opening recently failed; wait before trying again'));
    const attempt = this.tail.then(async () => {
      const measure = async (stage, operation) => {
        const start = performance.now();
        try { return await operation(); }
        finally { this.onTiming({threadId: id, stage, elapsedMs: Math.round(performance.now() - start)}); }
      };
      if (this.isClosed()) throw new Error('GPU connection stopped');
      const {thread} = await measure('metadata', () => this.readThread(id));
      if (thread?.id !== id || thread.ephemeral) throw new Error('An existing stored GPU task is required');
      try { return await measure('existing-owner', () => this.observe(id)); }
      catch (error) { if (error.message !== 'no-client-found') throw error; }
      if (this.isClosed()) throw new Error('GPU connection stopped');
      await measure('open-uri', () => this.openTask(id));
      const waitingSince = Date.now(), deadline = waitingSince + this.timeoutMs;
      do {
        if (this.isClosed()) throw new Error('GPU connection stopped');
        try { return await measure('snapshot', () => this.observe(id)); }
        catch (error) { if (error.message !== 'no-client-found') throw error; }
        await this.wait(Date.now() - waitingSince < 1000 ? 40 : 250);
      } while (Date.now() < deadline);
      throw new Error('GPU official app did not open this task');
    }).catch(error => { this.failures.set(id, Date.now() + 30000); throw error; }).finally(() => this.pending.delete(id));
    this.pending.set(id, attempt); this.tail = attempt.catch(() => {});
    return attempt;
  }
}
