import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFileSync} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {encodeSshFrame, SshFrameDecoder} from './ssh-framing.mjs';
import {RpcPeer} from './json-rpc-peer.mjs';
import {readRoute, hubReadRoute, UUID} from './guard-policy.mjs';
import {installedDesktop, discoverCli, TESTED_APP_VERSION, BRIDGE_VERSION} from './installed.mjs';
import {observeSession} from '../diagnostics/observe-session.mjs';
import {TaskActivation} from './task-activation.mjs';
import {PersistentTaskOpener} from './persistent-task-opener.mjs';
import {observeReadySession} from './observation-readiness.mjs';
import {storedHistoryPreview} from './stored-history-preview.mjs';
import {GpuProjectWriter} from './gpu-project-writer.mjs';
import {readGpuShareRoots} from './gpu-share-roots.mjs';
import {GpuModelSettings} from './model-settings.mjs';
import {GpuNewTasks,createEmptyGpuTask} from './gpu-new-task.mjs';
import {turnsOf} from './state.mjs';
import {CommandApprovalJournal, verifyCommandApproval} from './command-approval.mjs';
import {ComputerApprovalJournal, verifyComputerApproval} from './computer-approval.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const [threadId, duration, mode = 'session'] = process.argv.slice(2);
const seconds = Number(duration);
if (!UUID.test(threadId ?? '') || !['session', 'catalog', 'hub', 'history'].includes(mode) || !Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new Error('Invalid selected GPU scope');
const hostDesktop=installedDesktop('host');
const hostAppVersion=hostDesktop.versions?.[0];
if (!hostDesktop.testedBuild) throw new Error('Unsupported host Codex build; see docs/COMPATIBILITY.md');
const send = message => { if (process.stdout.writableLength > 32 * 1024 * 1024) throw new Error('SSH output stalled'); process.stdout.write(encodeSshFrame(message)); };
const {executable:cliPath}=discoverCli();
const cli = spawn(cliPath, ['app-server', '--listen', 'stdio://'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
const rpc = new RpcPeer(message => cli.stdin.write(JSON.stringify(message) + '\n'));
const models = new GpuModelSettings((method, params) => rpc.request(method, params));
const approvals = new CommandApprovalJournal(path.join(process.env.LOCALAPPDATA, 'CodexSessionBridge', 'command-approval-journal'));
const computerApprovals = new ComputerApprovalJournal(path.join(process.env.LOCALAPPDATA, 'CodexSessionBridge', 'computer-approval-journal'));
const newTasks=new GpuNewTasks({request:(method,params)=>rpc.request(method,params),create:params=>createEmptyGpuTask(cliPath,params),
  journalDirectory:path.join(process.env.LOCALAPPDATA,'CodexSessionBridge','new-task-journal')});
const projectWriter = new GpuProjectWriter({request: (method, params) => rpc.request(method, params),
  journalDirectory: path.join(process.env.LOCALAPPDATA, 'CodexSessionBridge', 'project-journal'), userHome: os.homedir()});
let buffer = '';
const cliDecoder = new StringDecoder('utf8');
cli.stdout.on('data', data => {
  try {
    buffer += cliDecoder.write(data);
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) throw new Error('CLI output too large');
    let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) rpc.accept(JSON.parse(line)); }
  } catch { finish(2); }
});
cli.stderr.on('data', () => {});
cli.stdin.on('error', () => finish(2));
cli.on('error', () => finish(2));
cli.on('close', () => finish(2));
let watch, timer, lifetime, initialized, initializing;
let finishing = false;
let busy = false;
const watches = new Map(), pendingWatches = new Map(), busyThreads = new Set();
const opener = mode === 'hub' ? new PersistentTaskOpener({seconds}) : null;
opener?.ready.then(() => { if (!finishing) send({type: 'opener-ready', pid: opener.pid, startupMs: opener.startupMs}); }, error => {
  if (!finishing) send({type: 'opener-unavailable', reason: error.message});
});
const activation = new TaskActivation({
  readThread: async id => { await initialize(); return rpc.request('thread/read', {threadId: id, includeTurns: false}); },
  observe: id => observeTask(id), openTask: id => opener.open(id), isClosed: () => finishing,
  onTiming: event => { if (!finishing) send({type: 'activation-timing', ...event}); },
});
function snapshotFor(id, observation) { return {type: 'snapshot', appVersion: hostAppVersion, threadId: id,
  ownerClientId: observation.state.ownerClientId, revision: observation.state.revision, state: observation.state.state}; }
function finish(code) {
  if (finishing) return; finishing = true;
  opener?.close();
  clearInterval(timer); clearTimeout(lifetime); watch?.close(); rpc.close(); cli.kill();
  for (const observation of watches.values()) observation.close(); watches.clear();
  for (const pending of pendingWatches.values()) pending.cancelled = true;
  process.stdin.destroy(); process.exitCode = code;
}
async function initialize(params) {
  if (initialized) return initialized;
  if (!initializing) initializing = rpc.request('initialize', params ?? {clientInfo: {name: 'codex_session_bridge', version: BRIDGE_VERSION}, capabilities: {experimentalApi: true}}).then(result => {
    cli.stdin.write(JSON.stringify({method: 'initialized'}) + '\n'); initialized = result; return result;
  });
  return initializing;
}
async function handle(message) {
  if (!message || !UUID.test(message.id ?? '') || typeof message.method !== 'string') throw new Error('Malformed bridge request');
  if (message.method === 'catalog' && ['history', 'hub', 'catalog'].includes(mode)) {
    const {cursor, limit = 30} = message.params ?? {};
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096))) throw new Error('Invalid catalog query');
    await initialize();
    const result = await rpc.request('thread/list', {limit, cursor: cursor ?? null, sourceKinds: [], archived: false,
      sortKey: 'updated_at', useStateDbOnly: false});
    return {tasks: (result.data ?? []).filter(t => UUID.test(t.id ?? '') && !t.ephemeral).map(t => ({id: t.id,
      sessionId: t.sessionId ?? t.id, title: String(t.name ?? t.preview ?? '제목 없음').slice(0, 160),
      cwd: t.cwd ?? null, projectId: t.projectId ?? null, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null})), nextCursor: result.nextCursor ?? null};
  }
  if (mode === 'history') {
    const id = message.params?.threadId;
    if (message.method !== 'history' || !UUID.test(id ?? '')) throw new Error('History connection is read-only');
    await initialize();
    const {thread} = await rpc.request('thread/read', {threadId: id, includeTurns: true});
    return storedHistoryPreview(thread, id, {appVersion:hostAppVersion});
  }
  if (mode === 'hub' && message.method === 'activate') return snapshotFor(message.params?.threadId, await activation.activate(message.params?.threadId));
  if (mode === 'hub' && ['watch', 'unwatch'].includes(message.method)) {
    const id = message.params?.threadId;
    if (!UUID.test(id ?? '')) throw new Error('Invalid GPU task');
    if (message.method === 'unwatch') {
      watches.get(id)?.close(); watches.delete(id);
      const pending = pendingWatches.get(id); if (pending) pending.cancelled = true;
      return {unwatched: true};
    }
    return snapshotFor(id, await observeTask(id));
  }
  if (mode === 'catalog') throw new Error('Catalog connection is read-only');
  if(mode==='hub'&&message.method==='createTask') {
    await initialize();await models.validate(message.params?.params?.model?{model:message.params.params.model}:{});
    return newTasks.handle(message.params);
  }
  if (mode === 'hub' && message.method === 'shareRoots') return readGpuShareRoots(message.params?.names);
  if (mode === 'hub' && message.method === 'modelConfig') { await initialize(); return models.write(message.params); }
  if (mode === 'hub' && ['commandApproval','computerApproval'].includes(message.method)) {
    const computer = message.method === 'computerApproval';
    const approval = message.params, id = approval?.threadId, watched = watches.get(id);
    if (!UUID.test(id ?? '') || !watched || watched.error || watched.disconnected || busyThreads.has(id)) throw Error('GPU not ready');
    busyThreads.add(id); let fresh;
    try {
      fresh = await observeSession(id, {allowRemoteInput: true, allowedThreadId: id});
      if (fresh.state.ownerClientId !== watched.state.ownerClientId) throw Error('GPU owner changed');
      (computer ? verifyComputerApproval : verifyCommandApproval)(fresh.state, approval);
      return await (computer ? computerApprovals : approvals).run(approval, async () => {
        const result = await fresh.client[computer ? 'replyComputerApproval' : 'replyCommandApproval']({session: fresh.state, appVersion: hostAppVersion, approval});
        if (result?.ok !== true) throw Error('GPU approval was not acknowledged');
        // The private handler can return ok even when a request disappeared.
        // Observe resolution as well; never simulate a successful local click.
        const deadline = Date.now() + 3000;
        while (!fresh.error && !fresh.disconnected && fresh.state.state.requests?.some(r => r.id === approval.requestId) && Date.now() < deadline) await delay(25);
        if (fresh.error || fresh.disconnected || fresh.state.stale || fresh.state.state.requests?.some(r => r.id === approval.requestId))
          throw Error('GPU 승인 처리 결과를 아직 확인하지 못했습니다. 자동으로 다시 보내지 않습니다');
        return {ok: true};
      });
    } finally { fresh?.close(); busyThreads.delete(id); }
  }
  if (mode === 'hub' && message.method === 'modelSettings') {
    const id = message.params?.threadId, watched = watches.get(id);
    if (!UUID.test(id ?? '') || !watched || watched.error || watched.disconnected || busyThreads.has(id)) throw new Error('GPU not ready');
    busyThreads.add(id); let fresh;
    try {
      await initialize();
      const settings = await models.validate(message.params?.settings, watched.state.state.latestThreadSettings?.model ?? watched.state.state.latestModel);
      fresh = await observeSession(id, {allowRemoteInput: true, allowedThreadId: id});
      if (fresh.state.ownerClientId !== watched.state.ownerClientId) throw new Error('GPU owner changed');
      return await fresh.client.updateModelSettings({session: fresh.state, appVersion: hostAppVersion, settings, condition: message.params?.condition});
    } finally { fresh?.close(); busyThreads.delete(id); }
  }
  if (mode === 'hub' && message.method === 'projectWrite') {
    await initialize();
    return projectWriter.handle(message.params?.method, message.params?.params);
  }
  if (message.method === 'read') {
    const route = mode === 'hub' ? hubReadRoute(message.params?.method, message.params?.params) : readRoute(message.params?.method, message.params?.params, threadId);
    if (mode === 'hub' && route.method === 'thread/loaded/list') return {data: [...watches.keys()]};
    if (route.local) return route.local;
    if (route.method === 'initialize') return initialize(route.params);
    await initialize();
    const result = await rpc.request(route.method, route.params);
    if (route.list) return {data: [result.thread], nextCursor: null};
    return result;
  }
  if (message.method === 'submitText' || (mode==='hub' && message.method==='submitFirstText')) {
    const {operationId, text} = message.params ?? {};
    const targetId = mode === 'hub' ? message.params?.threadId : threadId;
    const targetWatch = mode === 'hub' ? watches.get(targetId) : watch;
    if (!UUID.test(operationId ?? '') || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid message');
    if (!UUID.test(targetId ?? '') || !targetWatch || targetWatch.error || targetWatch.disconnected || (mode === 'hub' ? busyThreads.has(targetId) : busy)) throw new Error('GPU not ready');
    if (mode === 'hub') busyThreads.add(targetId); else busy = true;
    let fresh;
    try {
      await initialize();
      const settings = await models.validate(message.params?.settings ?? {}, targetWatch.state.state.latestThreadSettings?.model ?? targetWatch.state.state.latestModel);
      fresh = await observeSession(targetId, {allowRemoteInput: true, allowedThreadId: targetId});
      if (fresh.state.ownerClientId !== targetWatch.state.ownerClientId) throw new Error('GPU owner changed');
      const empty=turnsOf(fresh.state.state).length===0;
      if(message.method==='submitFirstText'&&!empty)throw Error('First GPU input already exists; automatic replay refused');
      if(empty)newTasks.claimFirst(targetId,operationId);
      const inputJournal=path.join(process.env.LOCALAPPDATA,'CodexSessionBridge','input-journal');
      fs.mkdirSync(inputJournal, {recursive: true});
      const journal = path.join(inputJournal, operationId + '.json');
      const fd = fs.openSync(journal, 'wx');
      try { fs.writeSync(fd, JSON.stringify({operationId, threadId: targetId, attemptedAt: new Date().toISOString()})); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      // Record before the side effect; retries with this operation ID are always refused.
      return await fresh.client.startTextTurn({session: fresh.state, appVersion: hostAppVersion, text, clientUserMessageId: operationId, settings,allowEmptyInitial:empty});
    } finally { fresh?.close(); if (mode === 'hub') busyThreads.delete(targetId); else busy = false; }
  }
  throw new Error('Unknown bridge operation');
}
async function observeTask(id) {
  const existing = watches.get(id);
  if (existing && !existing.error && !existing.disconnected && !existing.state.stale && existing.state.state.resumeState === 'resumed') return existing;
  if (existing) { existing.close(); watches.delete(id); }
  if (!pendingWatches.has(id)) {
    if (watches.size + pendingWatches.size >= 16) throw new Error('Too many observed GPU tasks');
    const pending = {cancelled: false};
    pending.promise = observeReadySession(id, observeSession, {isClosed: () => pending.cancelled || finishing}).then(observation => {
      if (pending.cancelled || finishing) { observation.close(); throw new Error('Observation cancelled'); }
      observation.lastSentRevision = observation.state.revision;
      watches.set(id, observation); return observation;
    }).finally(() => pendingWatches.delete(id));
    pendingWatches.set(id, pending);
  }
  return pendingWatches.get(id).promise;
}
try {
  if (mode === 'session') watch = await observeSession(threadId);
  const decoder = new SshFrameDecoder();
  process.stdin.on('data', data => { try { decoder.push(data, message => {
    handle(message).then(result => send({id: message.id, result}), error => send({id: message.id, error: {message: error.message}})).catch(() => finish(2));
  }); } catch { finish(2); } });
  process.stdin.once('end', () => finish(0));
  process.stdout.once('error', () => finish(2));
  if (mode === 'hub' || mode === 'history') send({type: 'ready', appVersion: hostAppVersion});
  let revision = -1;
  let lastHeartbeat = 0;
  timer = setInterval(() => {
    try {
      if (mode === 'session' && (watch.error || watch.disconnected || watch.state.stale)) throw new Error('GPU owner unavailable');
      if (mode === 'session' && watch.state.revision !== revision) {
        revision = watch.state.revision;
        send({type: 'snapshot', appVersion: hostAppVersion, threadId, ownerClientId: watch.state.ownerClientId, revision, state: watch.state.state});
      }
      for (const [id, observation] of watches) {
        if (observation.error || observation.disconnected || observation.state.stale || observation.state.state.resumeState !== 'resumed') {
          observation.close(); watches.delete(id); send({type: 'task-offline', threadId: id}); continue;
        }
        if (observation.state.revision !== observation.lastSentRevision) {
          observation.lastSentRevision = observation.state.revision; send(snapshotFor(id, observation));
        }
      }
      if (Date.now() - lastHeartbeat > 3000) { send({type: 'heartbeat'}); lastHeartbeat = Date.now(); }
    } catch { finish(2); }
  }, 80);
  lifetime = setTimeout(() => finish(0), seconds * 1000);
  process.once('SIGINT', () => finish(0)); process.once('SIGTERM', () => finish(0));
} catch { finish(2); }
