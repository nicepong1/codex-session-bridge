import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {readRoute, GPU_THREAD, UUID} from './guard-policy.mjs';

// The desktop can never reach a local CLI through this adapter, even after its IPC owner disappears.
export async function startGuardServer({read, threadId = GPU_THREAD, route = (method, params) => readRoute(method, params, threadId), onRequest = () => {}, onClientsChanged = () => {}, onUnsupportedReply = () => {}}) {
  const capabilityPath = '/' + randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false});
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== capabilityPath || req.headers.origin || !['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const clients = new Set(), notificationReady = new Set(), taskNames = new Map();
  function sendName(ws, id, title) {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return false; }
    // The catalog coordinator invalidates its list on this metadata-only event.
    // Unlike thread/started, it does not mark a conversation locally resumed.
    ws.send(JSON.stringify({method: 'thread/name/updated', params: {threadId: id, threadName: title}}));
    return true;
  }
  wss.on('connection', ws => {
    let initialized = false, initializing = false, inFlight = 0;
    const connectionId=randomUUID();
    clients.add(ws); onClientsChanged(clients.size);
    ws.on('error', () => {});
    ws.on('close', () => { clients.delete(ws); notificationReady.delete(ws); onClientsChanged(clients.size); });
    ws.on('message', async (data, binary) => {
      let message, beganInitialize = false;
      const started = performance.now();
      try {
        if (binary) throw new Error('Text frames required');
        message = JSON.parse(data.toString('utf8'));
        // Some native pickers reply directly to the app-server, even on a
        // follower. No such request was issued by this guard. Do not route an
        // uncorrelated ID to a different process, close the channel, or reply
        // to a JSON-RPC response. Discard values and refresh GPU-owned state.
        if(initialized&&message&&!Array.isArray(message)&&message.method==null&&
           (typeof message.id==='string'||Number.isSafeInteger(message.id))&&
           (Object.hasOwn(message,'result')||Object.hasOwn(message,'error'))) {
          try{onUnsupportedReply({requestId:message.id});}catch{}
          onRequest({method:'native-popup-response',allowed:false,reason:'owner-response-route-unavailable'});
          return;
        }
        if (!message || Array.isArray(message) || typeof message.method !== 'string') throw new Error('Invalid request');
        if (message.method === 'initialized' && message.id == null) {
          if (!initialized) throw new Error('Initialize first');
          if (!notificationReady.has(ws)) {
            notificationReady.add(ws);
            for (const [id, title] of taskNames) sendName(ws, id, title);
          }
          return;
        }
        if (typeof message.id !== 'number' && typeof message.id !== 'string') throw new Error('Request ID required');
        if (inFlight >= 32) throw new Error('Too many pending requests');
        route(message.method, message.params);
        if (message.method === 'initialize') {
          if (initialized || initializing) throw new Error('Already initialized');
          initializing = true;
          beganInitialize = true;
        } else if (!initialized) throw new Error('Initialize first');
        inFlight += 1;
        let result;
        try { result = await read(message.method, message.params,{requestKey:connectionId+':'+String(message.id)}); } finally { inFlight -= 1; }
        if (message.method === 'initialize') { initialized = true; initializing = false; }
        onRequest({method: message.method, allowed: true, elapsedMs: Math.round(performance.now() - started),
          ...(message.method === 'thread/list' ? {sectionId: message.params?.sectionId ?? null,
            sortKey: message.params?.sortKey ?? null, sortDirection: message.params?.sortDirection ?? null,
            returnedCount: result?.data?.length ?? null, hasMore: result?.nextCursor != null} : {}),
          ...(message.method === 'thread/read' ? {threadId: message.params.threadId, includeTurns: Boolean(message.params.includeTurns)} : {}),
          ...(message.method === 'thread/turns/list' ? {threadId: message.params.threadId, limit: message.params.limit ?? null,
            sortDirection: message.params.sortDirection ?? null, itemsView: message.params.itemsView ?? null,
            hasCursor: message.params.cursor != null, returnedCount: result?.data?.length ?? null, hasMore: result?.nextCursor != null} : {}),
          ...(['thread/archive','thread/unarchive'].includes(message.method) ? {threadId: message.params.threadId} : {})});
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({id: message.id, result}));
          // The installed desktop starts requests after initialize succeeds and
          // does not always send the optional initialized notification.
          if (message.method === 'initialize' && !notificationReady.has(ws)) {
            notificationReady.add(ws);
            for (const [id, title] of taskNames) sendName(ws, id, title);
          }
        }
      } catch (error) {
        if (beganInitialize) initializing = false;
        onRequest({method: message?.method ?? 'invalid', allowed: false, elapsedMs: Math.round(performance.now() - started),
          ...(['thread/resume','thread/turns/list','turn/start','thread/archive','thread/unarchive'].includes(message?.method) && typeof message.params?.threadId === 'string' ? {threadId: message.params.threadId} : {}),
          ...(['thread/start','turn/start'].includes(message?.method) ? {detail:error.message,paramKeys:Object.keys(message.params??{}),cwd:message.params?.cwd,permissions:message.params?.permissions,sandbox:message.params?.sandbox} : {}),
          reason: error.message === 'Initialize first' ? 'initialization-required' : error.message.startsWith('gpu-guard-denied:') ? 'method-denied' : 'upstream-error'});
        if (message?.id != null && ws.readyState === ws.OPEN) ws.send(JSON.stringify({id: message.id, error: {code: -32020, message: error.message}}));
        else ws.close(1008, 'Invalid RPC message');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {url: 'ws://127.0.0.1:' + server.address().port + capabilityPath,
    port: server.address().port,
    notifyArchiveState: (threadId, archived) => {
      if (!UUID.test(threadId ?? '') || typeof archived !== 'boolean') throw Error('Invalid archive notification');
      if (archived) taskNames.delete(threadId);
      let delivered = 0;
      for (const ws of notificationReady) {
        if (ws.readyState !== ws.OPEN) continue;
        if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); continue; }
        ws.send(JSON.stringify({method: archived ? 'thread/archived' : 'thread/unarchived', params: {threadId}})); delivered++;
      }
      return {delivered};
    },
    notifyTaskNames: rows => {
      if (!Array.isArray(rows) || rows.length > 5000 || rows.some(row => !UUID.test(row?.id ?? '') || typeof row.title !== 'string' || row.title.length > 160)) throw new Error('Invalid catalog notifications');
      let delivered = 0;
      for (const row of rows) {
        taskNames.delete(row.id); taskNames.set(row.id, row.title);
        while (taskNames.size > 1000) taskNames.delete(taskNames.keys().next().value);
        for (const ws of notificationReady) if (sendName(ws, row.id, row.title)) delivered++;
      }
      return {tasks: rows.length, delivered, retained: taskNames.size};
    },
    resetClients: () => { for (const ws of clients) ws.terminate(); },
    close: async () => { for (const ws of clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); }};
}
