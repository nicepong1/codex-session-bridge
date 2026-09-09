import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PIPE_PATH } from '../src/ipc.mjs';
import { FrameDecoder, encodeFrame } from '../src/framing.mjs';

// Diagnostic fault injection only. One local client; no TCP listener or retry.
export async function createDropAckProxy({ upstreamPath = PIPE_PATH, onDrop = () => {} } = {}) {
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-bridge-fault-${randomUUID()}` : join(tmpdir(), `cb-fault-${randomUUID()}.sock`);
  const stats = { writesForwarded: 0, replyDropped: false, acceptedTurnId: null, ownerMatched: false };
  const sockets = new Set();
  let attached = false;
  const server = net.createServer(down => {
    if (attached) { down.destroy(); return; }
    attached = true;
    const up = net.createConnection(upstreamPath);
    for (const socket of [up, down]) sockets.add(socket);
    const stop = () => { up.destroy(); down.destroy(); };
    up.on('error', stop); down.on('error', stop);
    up.on('close', () => { sockets.delete(up); down.destroy(); });
    down.on('close', () => { sockets.delete(down); up.destroy(); });
    let targetRequest = null;
    const downstreamDecoder = new FrameDecoder(), upstreamDecoder = new FrameDecoder();
    down.on('data', chunk => {
      try {
        downstreamDecoder.push(chunk, message => {
          if (message.type === 'request' && message.method === 'thread-follower-start-turn') {
            if (targetRequest) { stop(); return; }
            targetRequest = { requestId: message.requestId, owner: message.targetClientId };
            stats.writesForwarded++;
          }
          if (up.writable) up.write(encodeFrame(message));
        });
      } catch { stop(); }
    });
    up.on('data', chunk => {
      try {
        upstreamDecoder.push(chunk, message => {
          if (message.type === 'response' && message.requestId === targetRequest?.requestId &&
              message.method === 'thread-follower-start-turn' && message.resultType === 'success') {
            stats.replyDropped = true;
            stats.acceptedTurnId = message.result?.result?.turn?.id ?? null;
            stats.ownerMatched = message.handledByClientId === targetRequest.owner;
            onDrop({ ...stats });
            stop(); // The app accepted the input; the sender never receives that reply.
          } else if (down.writable) down.write(encodeFrame(message));
        });
      } catch { stop(); }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  return { path, stats, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
