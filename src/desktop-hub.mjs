import {prepareRemoteProfile} from './remote-installation.mjs';
import {loadProfile,profilePaths} from './connection-config.mjs';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {FrameDecoder, encodeFrame} from './framing.mjs';
import {PIPE_PATH} from './ipc.mjs';
import {installedDesktop} from './installed.mjs';
import {startGuardServer} from './guard-server.mjs';
import {GPU_THREAD, UUID, desktopHubRoute, textFromFollower} from './guard-policy.mjs';
import {TaskHub} from './task-hub.mjs';
import {turnsOf} from './state.mjs';
import {readLastTask, saveLastTask} from './launch-state.mjs';
import {readProjectCatalog, projectDisplayState, orderProjectsByActivity} from './project-catalog.mjs';
import {settingsFromFollower, settingsFromTurn} from './model-settings.mjs';
import {COMMAND_APPROVAL_METHOD} from './command-approval.mjs';
import {COMPUTER_APPROVAL_METHOD} from './computer-approval.mjs';

const {values} = parseArgs({options: {report: {type: 'string'}, thread: {type: 'string'},
  seconds: {type: 'string', default: '0'}, launch: {type: 'boolean'}, 'enable-text-input': {type: 'boolean'},
  'test-drop-ssh-after': {type: 'string'}, 'test-idle-after': {type: 'string'}, 'test-catalog-reveal-after': {type: 'string'}}});
const selectedProfile=loadProfile();
await prepareRemoteProfile(selectedProfile);
const lastTaskFile=profilePaths(selectedProfile.id).lastTask;
const seconds=Number(values.seconds);
let initialThread=values.thread??readLastTask(lastTaskFile)??null;
const dropAfter = values['test-drop-ssh-after'] == null ? null : Number(values['test-drop-ssh-after']);
const idleAfter = values['test-idle-after'] == null ? null : Number(values['test-idle-after']);
const revealAfter = values['test-catalog-reveal-after'] == null ? null : Number(values['test-catalog-reveal-after']);
const testLimit = seconds || 3600;
if (!values.report || (initialThread!=null&&!UUID.test(initialThread)) || !Number.isInteger(seconds) || (seconds !== 0 && seconds < 10) || seconds > 86400) throw new Error('Report, valid initial task and duration required (0 = until window closes)');
if (values['enable-text-input'] && !values.launch) throw new Error('Input requires an isolated official app');
if (dropAfter != null && (!Number.isInteger(dropAfter) || dropAfter < 15 || dropAfter > testLimit - 10)) throw new Error('Invalid SSH test delay');
if (idleAfter != null && (initialThread !== GPU_THREAD || !Number.isInteger(idleAfter) || idleAfter < 15 || idleAfter > testLimit - 10)) throw new Error('Invalid idle test scope/delay');
if (revealAfter != null && (initialThread === GPU_THREAD || !Number.isInteger(revealAfter) || revealAfter < 20 || revealAfter > 120 || revealAfter > testLimit - 10)) throw new Error('Invalid catalog visibility test');
const desktop = installedDesktop();
if (!desktop.testedBuild) throw new Error('Unsupported client Codex build; see docs/COMPATIBILITY.md');
const singleton = net.createServer(socket => socket.destroy());
await new Promise((resolve, reject) => {
  singleton.once('error', () => reject(new Error('Another GPU connection is running; close its separate window first')));
  singleton.listen('\\\\.\\pipe\\codex-session-bridge-gpu-guard', resolve);
});
const fd = fs.openSync(values.report, 'wx');
const report = {mode: 'hub', pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  status: 'starting', threadId: initialThread, durationSeconds: seconds, lifetimeMode: seconds === 0 ? 'until-window-closes' : 'bounded',
  inputEnabled: false, tasks: {}, catalog: [], rpc: [], submissions: [], errors: [], followerClientIds: []};
let reportClosed = false, stopping = false, socket, clientId, server, app, ticker, lifetime, localRetry, resetTimer, dropTimer, idleTimer, idleAnnounceTimer;
let wsClients = 0, recoverySnapshots = 0, localGeneration = 0;
function record() { if (reportClosed) return; const text = JSON.stringify(report, null, 2); fs.writeSync(fd, text, 0, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(text)); }
record();
const revealAt = revealAfter == null ? 0 : Date.now() + revealAfter * 1000;
if (revealAfter != null) report.catalogVisibilityTest = {threadId: GPU_THREAD, revealAt: new Date(revealAt).toISOString(), scope: 'Existing stored test row hidden then revealed; no new task or prompt'};
const hub = new TaskHub({seconds, allowActivation: true, allowNewTasks:Boolean(values['enable-text-input']), allowCommandApprovals:Boolean(values['enable-text-input']), allowComputerApprovals:Boolean(values['enable-text-input']), allowProjectCreation: Boolean(values.launch), allowModelSettings: Boolean(values.launch), mapGpuPaths: true, prefetchHistory: true, refreshCatalog: true,
  canRefreshCatalog: () => wsClients > 0,
  catalogFilter: rows => Date.now() < revealAt ? rows.filter(row => row.id !== GPU_THREAD) : rows});
report.historyPrefetch = {cached: 0, queued: 0, bytes: 0, failures: [],
  policy: {maxTasks: hub.history.maxEntries, maxBytes: hub.history.maxBytes, refreshMs: hub.history.ttlMs, memoryOnly: true}};
report.recentTaskRetention = {maxInactiveTasks: hub.maxWarmTasks, maxParkedHistories: hub.maxParkedHistories, milliseconds: hub.warmRetentionMs};

function send(message) {
  if (!message || !socket?.writable || socket.destroyed) return false;
  if (socket.writableLength > 32 * 1024 * 1024) throw new Error('Desktop IPC stalled');
  socket.write(encodeFrame(message));
  if (message.method === 'thread-stream-state-changed') report.sentSnapshots = (report.sentSnapshots ?? 0) + 1;
  return true;
}
function canWrite(task) {
  return Boolean(values['enable-text-input'] && app && app.exitCode == null && wsClients && clientId && socket?.writable && !socket.destroyed &&
    hub.connection.online && task?.policy.online && !task.blocked && task.policy.followers.size);
}
function syncTask(task) {
  report.tasks[task.id] = {title: task.title, online: task.policy.online, blocked: task.blocked, ownerClientId: task.policy.owner,
    storedPreview: task.policy.preview,
    sourceRevision: task.policy.sourceRevision, followerClientIds: [...task.policy.followers], inputEnabled: canWrite(task),
    desired: task.desired, parked: task.parked, lastUsedAt: new Date(task.lastUsed).toISOString(),
    viewRefreshCount: task.viewRefreshCount,
    turnCount: turnsOf(task.policy.state).length, lastTurnId: turnsOf(task.policy.state).at(-1)?.turnId ?? null, error: task.error};
  report.followerClientIds = [...new Set([...hub.tasks.values()].flatMap(t => [...t.policy.followers]))];
  report.inputEnabled = [...hub.tasks.values()].some(canWrite);
  if (report.idleTest?.parked && task.id === initialThread && task.policy.online && task.policy.followers.size && !report.idleTest.restoredAt) {
    report.idleTest.restoredAt = new Date().toISOString(); report.idleTest.restoredOwner = task.policy.owner;
  }
}
function publish(task, recipients) {
  if (task.policy.state) task.policy.state.title = task.title;
  syncTask(task);
  const sent = send(task.policy.snapshot(clientId, recipients));
  if (sent && task.policy.preview && task.followStartedAt != null && !task.previewReported) {
    report.followTimings = [...(report.followTimings ?? []), {threadId: task.id, state: 'preview-written',
      elapsedMs: Math.round((performance.now() - task.followStartedAt) * 100) / 100, at: new Date().toISOString()}].slice(-80);
    task.previewReported = true;
  }
  if (sent && task.policy.online && task.followStartedAt != null) {
    report.followTimings = [...(report.followTimings ?? []), {threadId: task.id, state: 'snapshot-written',
      elapsedMs: Math.round((performance.now() - task.followStartedAt) * 100) / 100, at: new Date().toISOString()}].slice(-80);
    task.followStartedAt = null;
  }
}
function announce(task) { if (clientId) send({type: 'broadcast', method: 'thread-stream-following-status-requested', version: 1,
  sourceClientId: clientId, params: {hostId: 'local', conversationId: task.id}}); }
async function respond(message) {
  const task = hub.tasks.get(message.params?.conversationId);
  const base = {type: 'response', requestId: message.requestId, method: message.method, handledByClientId: clientId};
  if (message.method === 'thread-owner-discovery') {
    send(task ? task.policy.handleRequest(message, clientId) : {...base, resultType: 'error', error: 'Unknown GPU task'}); return;
  }
  try {
    if (!canWrite(task)) throw new Error('GPU에서 이 작업을 열고 연결될 때까지 기다려 주세요');
    if ([COMMAND_APPROVAL_METHOD,COMPUTER_APPROVAL_METHOD].includes(message.method)) {
      const result = await hub[message.method === COMPUTER_APPROVAL_METHOD ? 'approveComputer' : 'approveCommand'](message);
      send({...base, resultType: 'success', result}); return;
    }
    if (message.method === 'thread-follower-update-thread-settings') {
      const result = await hub.updateModel(task.id, settingsFromFollower(message, task.id));
      send({...base, resultType: 'success', result});
      return;
    }
    const text = textFromFollower(message, task.id), operationId = message.params.turnStart.request.clientUserMessageId;
    const settings = settingsFromTurn(message.params.turnStart.request);
    let operation = report.submissions.find(s => s.operationId === operationId);
    if (!operation) { operation = {threadId: task.id, operationId, attemptedAt: new Date().toISOString(), outcome: 'pending'}; report.submissions.push(operation); record(); }
    try {
      const result = await hub.submit(task.id, operationId, text, settings);
      operation.outcome = 'acknowledged'; operation.turnId = result?.result?.turn?.id ?? null; record();
      send({...base, resultType: 'success', result});
    } catch (error) { if (operation.outcome !== 'acknowledged') operation.outcome = 'unconfirmed-or-rejected'; record(); throw error; }
  } catch (error) {
    report.followerErrors = [...(report.followerErrors ?? []), {method: message.method, threadId: task?.id, reason: error.message,
      ...(message.method===COMMAND_APPROVAL_METHOD?{decisionKind:typeof message.params?.decision==='string'?message.params.decision:Object.keys(message.params?.decision??{})}:{}),
      at: new Date().toISOString()}].slice(-30);
    record(); send({...base, resultType: 'error', error: error.message});
  }
}
function connectLocal() {
  if (stopping || (socket && !socket.destroyed)) return;
  const current = socket = net.createConnection(PIPE_PATH), generation = ++localGeneration;
  const initId = randomUUID(), decoder = new FrameDecoder();
  const deadline = setTimeout(() => { if (!clientId && socket === current) current.destroy(); }, 5000);
  current.once('connect', () => send({type: 'request', requestId: initId, sourceClientId: 'initializing-client', method: 'initialize', version: 0,
    params: {clientType: 'codex-session-bridge-desktop-hub'}}));
  current.on('data', bytes => {
    if (socket !== current || stopping) return;
    try { decoder.push(bytes, message => {
      if (message.type === 'response' && message.requestId === initId) {
        if (message.resultType !== 'success') throw new Error('IPC initialize failed');
        clearTimeout(deadline); clientId = message.result.clientId; report.bridgeClientId = clientId; report.localConnected = true; recoverySnapshots = 0;
        for (const task of hub.tasks.values()) if (task.policy.online) announce(task);
        if (report.localReconnects) resetTimer = setTimeout(() => {
          if (!stopping && hub.connection.online && !report.followerClientIds.length) { report.desktopTransportResets = (report.desktopTransportResets ?? 0) + 1; server.resetClients(); record(); }
        }, 5000);
      } else if (message.type === 'client-discovery-request') {
        hub.discover(message.request).then(canHandle => {
          if (message.request?.method?.startsWith('thread-')) report.discovery = [...(report.discovery ?? []), {method: message.request?.method, version: message.request?.version,
            threadId: message.request?.params?.conversationId, hostId: message.request?.params?.hostId,
            known: hub.knownIds.has(message.request?.params?.conversationId), canHandle, at: new Date().toISOString()}].slice(-40);
          if (generation === localGeneration && !stopping) send({type: 'client-discovery-response', requestId: message.requestId, response: {canHandle}});
          record();
        }).catch(() => {});
      } else if (message.type === 'request') respond(message).catch(() => current.destroy());
      else if (message.type === 'broadcast') {
        if (message.targetClientIds && !message.targetClientIds.includes(clientId)) return;
        const following = hub.follow(message);
        const task = hub.tasks.get(message.params?.conversationId);
        if (task) {
          if (following) publish(task, [message.sourceClientId]);
          syncTask(task);
        }
        if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
          hub.removeFollower(message.params.clientId);
          for (const task of hub.tasks.values()) syncTask(task);
        }
      }
      record();
    }); } catch { current.destroy(); }
  });
  current.on('error', () => {});
  current.on('close', () => {
    clearTimeout(deadline);
    if (socket !== current || stopping) return;
    socket = null; clientId = null; report.localConnected = false; report.inputEnabled = false;
    report.localReconnects = (report.localReconnects ?? 0) + 1;
    for (const task of hub.tasks.values()) { task.policy.followers.clear(); syncTask(task); }
    record(); localRetry = setTimeout(connectLocal, 1000);
  });
}
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(ticker); clearTimeout(lifetime); clearTimeout(localRetry); clearTimeout(resetTimer); clearTimeout(dropTimer);
  clearTimeout(idleTimer); clearTimeout(idleAnnounceTimer);
  hub.close(); for (const task of hub.tasks.values()) syncTask(task);
  socket?.destroy(); await server?.close(); await new Promise(resolve => singleton.close(resolve));
  if (app?.exitCode == null) app?.kill();
  report.status = 'stopped'; report.inputEnabled = false; report.endedAt = new Date().toISOString(); record(); reportClosed = true; fs.closeSync(fd);
}
hub.on('snapshot', task => { if (!stopping) { publish(task); if (!task.policy.followers.size && task.policy.online) announce(task); record(); } });
hub.on('contact', () => { report.lastGpuContactAt = new Date().toISOString(); });
hub.on('prefetch', event => {
  if (stopping) return;
  if (event.type === 'progress') {
    Object.assign(report.historyPrefetch, event);
    report.historyPrefetch.cachedTaskIds = [...hub.history.entries.keys()];
  }
  else if (event.type === 'connection') report.historyPrefetch.connection = event;
  else if (event.type === 'failure') report.historyPrefetch.failures = [...report.historyPrefetch.failures, {...event, at: new Date().toISOString()}].slice(-40);
  record();
});
hub.on('metadata', event => {
  report.metadataCache ??= {hit: 0, shared: 0, miss: 0}; report.metadataCache[event.cache]++;
});
hub.on('projectWrite', event => {
  report.projectWrites = [...(report.projectWrites ?? []), {...event, at: new Date().toISOString()}].slice(-50);
  record();
});
hub.on('modelSettings', event => {
  report.modelSettings = [...(report.modelSettings ?? []), {...event, at: new Date().toISOString()}].slice(-50); record();
});
hub.on('commandApproval', event => {
  report.commandApprovals = [...(report.commandApprovals ?? []), {...event, at: new Date().toISOString()}].slice(-100); record();
});
hub.on('computerApproval', event => {
  report.computerApprovals = [...(report.computerApprovals ?? []), {...event, at: new Date().toISOString()}].slice(-100); record();
});
hub.on('newTask',event=>{
  report.newTasks=[...(report.newTasks??[]),{...event,at:new Date().toISOString()}].slice(-100);record();
  if(event.stage==='first-input-acknowledged') {
    // Native thread/start makes the laptop renderer an owner. Restart only its
    // guarded transport after the first response settles; the app's normal
    // recovery drops that temporary role and discovers the original GPU owner.
    setTimeout(()=>{if(!stopping){report.newTaskTransportResets=(report.newTaskTransportResets??0)+1;server.resetClients();record();}},500);
  }
});
hub.on('pathMappings', mappings => { report.pathMappings={at:new Date().toISOString(),mappings};record(); });
hub.on('taskListCache', event => {
  report.taskListCache ??= {};
  report.taskListCache[event.cache] = (report.taskListCache[event.cache] ?? 0) + 1;
});
hub.on('following', event => {
  report.followTimings = [...(report.followTimings ?? []), {...event, at: new Date().toISOString()}].slice(-80);
  if (event.state === 'selected' && values.launch) {
    try { saveLastTask(lastTaskFile, event.threadId); report.lastSelectedThreadId = event.threadId; }
    catch { report.lastTaskSaveError = true; }
  }
});
hub.on('catalogRefresh', event => {
  if (stopping) return;
  report.catalogRefresh = {...event, scans: (report.catalogRefresh?.scans ?? 0) + (event.failed ? 0 : 1)};
  record();
});
hub.on('catalogChanged', rows => {
  if (stopping || !server) return;
  const sent = server.notifyTaskNames(rows);
  report.catalogNotifications = [...(report.catalogNotifications ?? []), {...sent, ids: rows.map(row => row.id).slice(0, 100), at: new Date().toISOString()}].slice(-40);
  record();
});
hub.on('retention', event => {
  report.retentionEvents = [...(report.retentionEvents ?? []), {...event, at: new Date().toISOString()}].slice(-80);
});
hub.on('catalog', event => { report.catalogTaskCount = hub.knownIds.size; report.catalog.push({...event, at: new Date().toISOString()}); report.catalog = report.catalog.slice(-50); record(); });
hub.on('activation', event => { report.activations = [...(report.activations ?? []), {...event, at: new Date().toISOString()}].slice(-30); record(); });
hub.on('opener', event => {
  if (event.type === 'activation-timing') report.activationTimings = [...(report.activationTimings ?? []), {...event, at: new Date().toISOString()}].slice(-80);
  else report.opener = {...event, at: new Date().toISOString()};
  record();
});
hub.on('taskError', event => { report.errors.push({...event, at: new Date().toISOString()}); report.errors = report.errors.slice(-50); record(); });
hub.on('connection', state => { if (stopping) return; report.connection = {...state, changedAt: new Date().toISOString()}; record(); });
try {
  server = await startGuardServer({read: (method, params, context) => hub.read(method, params, context), route: desktopHubRoute,
    onRequest: event => { report.rpc.push({...event, at: new Date().toISOString()}); report.rpc = report.rpc.slice(-500); record(); },
    onClientsChanged: count => { wsClients = count; report.wsClients = count; if (count) recoverySnapshots = 0; record(); }});
  report.port = server.port;
  connectLocal();
  if (values.launch) {
    const catalogProjects = await readProjectCatalog((method, params) => hub.read(method, params));
    await hub.ensureDesktopOrder();
    if(!initialThread||!hub.desktopOrder.rows.has(initialThread))initialThread=hub.desktopOrder.rows.keys().next().value??null;
    report.threadId=initialThread;
    if(initialThread){hub.knownIds.add(initialThread);hub.task(initialThread).desired=true;hub.prepare(initialThread,{touch:false}).catch(()=>{});}
    const projects = orderProjectsByActivity(catalogProjects, [...hub.desktopOrder.rows].map(([id,t]) => ({id,...t})));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gpu-guard-'));
    const userData = path.join(profile, 'user-data'), codexHome = path.join(profile, 'codex-home');
    fs.mkdirSync(userData); fs.mkdirSync(codexHome);
    const displayState = projectDisplayState(projects);
    // Match the user's normal desktop: select a model, then adjust that model's
    // effort. A fresh profile otherwise opens the combined model/power slider.
    displayState['electron-persisted-atom-state']['composer-model-picker-selection-mode-v1'] = 'model';
    fs.writeFileSync(path.join(codexHome, '.codex-global-state.json'), JSON.stringify(displayState), {flag: 'wx'});
    report.projects = {initializedAt: new Date().toISOString(), count: projects.length,
      entries: projects.map(p => ({id: p.id, name: p.name})), source: 'GPU project/list',
      ordering: 'latest GPU file-list task in each project', refresh: 'on-launch'};
    const transport = fileURLToPath(new URL('../bin/codex-gpu-guard.exe',import.meta.url)); if (!fs.existsSync(transport)) throw new Error('Run Build-Guard.ps1 first');
    const exe=desktop.executable;
    const env = {...process.env, CODEX_HOME: codexHome, CODEX_ELECTRON_USER_DATA_PATH: userData,
      CODEX_GPU_GUARD_URL: server.url, CODEX_CLI_PATH: transport, CODEX_APP_SERVER_FORCE_CLI: '1'};
    delete env.CODEX_APP_SERVER_WS_URL;
    app = spawn(exe, ['--user-data-dir=' + userData,...(initialThread?['codex://threads/'+initialThread]:[])], {windowsHide: false, stdio: 'ignore', env});
    app.on('error', () => { report.errors.push({reason: 'Isolated app launch failed'}); stop().catch(() => {}); });
    app.on('exit', () => { if (!stopping) stop().catch(() => {}); });
    report.appPid = app.pid; report.profilePath = profile;
  }
  const endpointFile = path.join(os.tmpdir(), 'codex-gpu-guard-endpoint-' + process.pid + '.json');
  fs.writeFileSync(endpointFile, JSON.stringify({url: server.url}), {flag: 'wx', mode: 0o600}); report.endpointFile = endpointFile;
  ticker = setInterval(() => {
    report.heartbeatAt = new Date().toISOString();
    report.status = hub.connection.online ? clientId ? 'guard-ready' : 'desktop-reconnecting' : hub.connection.blocked ? 'blocked' : 'reconnecting';
    for (const task of hub.tasks.values()) {
      const wasEnabled = report.tasks[task.id]?.inputEnabled;
      syncTask(task);
      if (task.policy.online && (wasEnabled !== canWrite(task) || (report.localReconnects && recoverySnapshots < 15))) { task.policy.revision++; publish(task); }
      if (task.policy.online && !task.policy.followers.size && Date.now() - task.lastUsed < 30000) announce(task);
    }
    recoverySnapshots++; record();
  }, 3000);
  if (seconds > 0) lifetime = setTimeout(() => stop().catch(() => {}), seconds * 1000);
  if (dropAfter != null) dropTimer = setTimeout(() => { report.sshLossInjectedAt = new Date().toISOString(); record(); hub.connection.disconnectForTest(); }, dropAfter * 1000);
  if (idleAfter != null) idleTimer = setTimeout(() => {
    const task = hub.tasks.get(initialThread);
    if (!task?.policy.online || !task.policy.followers.size) { report.idleTest = {skipped: true}; record(); return; }
    report.idleTest = {at: new Date().toISOString(), owner: task.policy.owner, beforeFollowers: [...task.policy.followers]};
    task.policy.followers.clear(); task.lastUsed = Date.now() - hub.warmRetentionMs - 1; hub.maintain();
    report.idleTest.parked = task.parked; record();
    // Ask the real official app to reannounce its existing subscription.
    // No UI clicks, user input, or GPU task execution are performed.
    idleAnnounceTimer = setTimeout(() => { announce(task); }, 500);
  }, idleAfter * 1000);
  process.once('SIGINT', () => stop().catch(() => {})); process.once('SIGTERM', () => stop().catch(() => {}));
  record(); console.log(JSON.stringify({pid: report.pid, appPid: report.appPid ?? null, mode: 'hub', reportPath: values.report}));
} catch (error) { report.errors.push({reason: error.message}); await stop(); process.exitCode = 2; }
