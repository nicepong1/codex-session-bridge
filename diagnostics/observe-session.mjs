import { setTimeout as delay } from 'node:timers/promises';
import { DesktopIpc } from '../src/ipc.mjs';
import { SessionState } from '../src/state.mjs';

export async function observeSession(threadId, { path, allowProbeWrite = false, allowRemoteInput = false, allowedThreadId } = {}) {
  const client = new DesktopIpc({ allowProbeWrite, allowRemoteInput, allowedThreadId });
  const watch = { client, state: null, error: null, activeSeen: false, disconnected: false, finished: false,
    close() { this.finished = true; client.close(); } };
  client.on('broadcast', message => {
    try {
      if (watch.state?.accept(message) && watch.state.summary().runtimeStatus === 'active') watch.activeSeen = true;
    } catch (error) { watch.error ??= error; }
  });
  client.on('disconnected', () => {
    watch.disconnected = true;
    if (watch.state) watch.state.stale = true;
    if (!watch.finished) watch.error ??= new Error('Observation connection closed');
  });
  try {
    await client.connect(path ? { path } : {});
    const owner = await client.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
    watch.state = new SessionState(threadId, owner.handledByClientId);
    client.follow(threadId, owner.handledByClientId);
    const deadline = Date.now() + 5000;
    while (!watch.state.snapshots && !watch.error && Date.now() < deadline) await delay(20);
    if (watch.error) throw watch.error;
    if (!watch.state.snapshots) throw new Error('No session snapshot');
    return watch;
  } catch (error) { watch.close(); throw error; }
}
