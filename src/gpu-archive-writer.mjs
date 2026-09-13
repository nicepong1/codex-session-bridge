import fs from 'node:fs';
import path from 'node:path';
import {archiveWriteRoute, archiveResponse} from './archive-policy.mjs';
import {SubmissionRegistry} from './submission-registry.mjs';

// Only the official lifecycle API changes storage. No rollout moves, database
// edits, resume, execution, worktree cleanup, or retry after an uncertain write.
export class GpuArchiveWriter {
  constructor({request, journalDirectory}) {
    Object.assign(this, {request, journalDirectory});
    this.operations = new SubmissionRegistry(); this.busy = new Set();
  }
  handle({operationId, method, params} = {}) {
    const write = archiveWriteRoute(method, params);
    return this.operations.run(operationId, JSON.stringify(write), async () => {
      if (this.busy.has(params.threadId)) throw Error('GPU archive operation already pending');
      this.busy.add(params.threadId);
      try {
        const current = await this.request('thread/read', {threadId: params.threadId, includeTurns: false});
        if (current?.thread?.id !== params.threadId) throw Error('GPU archive target mismatch');
        fs.mkdirSync(this.journalDirectory, {recursive: true});
        // An interrupted worker cannot later replay this operation ID. Do not
        // persist conversation contents from an unarchive response.
        const file = path.join(this.journalDirectory, operationId + '.json');
        let fd;
        try { fd = fs.openSync(file, 'wx'); }
        catch (error) {
          if (error.code === 'EEXIST') throw Error('Earlier archive request was attempted; automatic replay refused');
          throw error;
        }
        try { fs.writeSync(fd, JSON.stringify(write)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return archiveResponse(method, params, await this.request(method, params));
      } finally { this.busy.delete(params.threadId); }
    });
  }
}
