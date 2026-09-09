import {createHash} from 'node:crypto';
import {UUID} from './guard-policy.mjs';

// The desktop's message ID is also the GPU journal ID, including across reconnects/restarts.
export class SubmissionRegistry {
  entries = new Map();
  run(id, text, send) {
    if (!UUID.test(id ?? '')) return Promise.reject(new Error('A stable desktop message ID is required'));
    const hash = createHash('sha256').update(text).digest('hex');
    const previous = this.entries.get(id);
    if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error('Message ID was reused with different content'));
    if (this.entries.size >= 1000) return Promise.reject(new Error('Input limit reached; restart the connection'));
    // Keep both successful and rejected promises. An uncertain result is never retried here.
    const promise = Promise.resolve().then(send);
    this.entries.set(id, {hash, promise});
    return promise;
  }
}
