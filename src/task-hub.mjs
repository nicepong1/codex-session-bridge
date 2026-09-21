import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {newTaskParams,firstTaskTurn} from './new-task-policy.mjs';
import {ReconnectingWorker} from './reconnecting-worker.mjs';
import {SshWorker} from './ssh-worker.mjs';
import {NativeViewPolicy} from './native-view-policy.mjs';
import {SubmissionRegistry} from './submission-registry.mjs';
import {GPU_THREAD, UUID, hubReadRoute} from './guard-policy.mjs';
import {TESTED_APP_VERSION,supportedHostVersion} from './installed.mjs';
import {MetadataReadCache} from './metadata-read-cache.mjs';
import {TaskListCache} from './task-list-cache.mjs';
import {HistoryPrefetch} from './history-prefetch.mjs';
import {CatalogPoller} from './catalog-poller.mjs';
import {DesktopRecentOrder} from './desktop-recent-order.mjs';
import {projectWriteRoute} from './project-write-policy.mjs';
import {archiveWriteRoute, archiveResponse} from './archive-policy.mjs';
import {GpuPathMapper} from './gpu-path-mapper.mjs';
import {defaultModelWrite, modelSettings, modelCondition} from './model-settings.mjs';
import {commandApprovalFromFollower, approvalKey, sameApprovalDecision} from './command-approval.mjs';
import {computerApprovalFromFollower} from './computer-approval.mjs';
import {permissionsApprovalFromFollower} from './permissions-approval.mjs';
import {popupReplyFromFollower} from './popup-replies.mjs';

export class TaskHub extends EventEmitter {
  constructor({seconds = 28800, createConnection, allowActivation = false, warmRetentionMs = 600000, maxWarmTasks = 6,
    prefetchHistory = false, createHistoryConnection, refreshCatalog = false, canRefreshCatalog = () => true,
    catalogFilter = rows => rows, maxParkedHistories = 6, allowProjectCreation = false, allowModelSettings = false, mapGpuPaths = false, pathMapper, allowNewTasks = false, allowCommandApprovals = false, allowComputerApprovals = false, allowPermissionsApprovals = false, allowPopupReplies = false, allowArchiving = false} = {}) {
    if (!Number.isInteger(warmRetentionMs) || warmRetentionMs < 1000 || warmRetentionMs > 600000 ||
        !Number.isInteger(maxWarmTasks) || maxWarmTasks < 0 || maxWarmTasks > 6 ||
        !Number.isInteger(maxParkedHistories) || maxParkedHistories < 0 || maxParkedHistories > 6) throw new Error('Invalid recent task retention limits');
    super(); this.tasks = new Map(); this.knownIds = new Set(); this.titles = new Map(); this.submissions = new SubmissionRegistry(); this.closed = false;
    if (refreshCatalog && !prefetchHistory) throw new Error('Catalog refresh requires the read-only history connection');
    this.catalogFilter = catalogFilter;
    this.desktopOrder = new DesktopRecentOrder(); this.orderPending = null; this.orderGeneration = 0;
    this.warmRetentionMs = warmRetentionMs; this.maxWarmTasks = maxWarmTasks;
    this.maxParkedHistories = maxParkedHistories;
    this.allowActivation = allowActivation;
    this.allowArchiving = allowArchiving; this.archiveRequests = new Map(); this.archivedIds = new Set();
    this.allowProjectCreation = allowProjectCreation;
    this.allowModelSettings = allowModelSettings;
    this.allowNewTasks=allowNewTasks;this.newTasks=new Set();this.creations=new Map();this.firstTurns=new SubmissionRegistry();
    this.lastSelectedAt = 0; this.observationGeneration = 0; this.commandApprovals = new Map(); this.allowCommandApprovals = allowCommandApprovals;
    this.computerApprovals = new Map(); this.allowComputerApprovals = allowComputerApprovals;
    this.permissionsApprovals = new Map(); this.allowPermissionsApprovals = allowPermissionsApprovals;
    this.popupReplies = new Map(); this.allowPopupReplies = allowPopupReplies;
    this.metadataCache = new MetadataReadCache({onUse: event => this.emit('metadata', event)});
    this.taskListCache = new TaskListCache({onUse: event => this.emit('taskListCache', event),
      onUpdate: (result, params) => this.acceptCatalog(result, params)});
    this.connection = createConnection ? createConnection() : new ReconnectingWorker({threadId: GPU_THREAD, seconds, readySignal: 'ready',
      createWorker: options => new SshWorker({...options, mode: 'hub'}),
      acceptSnapshot: message => { if (!supportedHostVersion(message.appVersion)) throw new Error('Untested GPU hub'); }});
    this.connection.on('message', message => {
      if (message.type === 'snapshot') this.accept(message);
      else if (message.type === 'task-offline') this.markOffline(this.tasks.get(message.threadId), 'GPU task owner unavailable');
      else if (message.type === 'opener-ready' || message.type === 'opener-unavailable' || message.type === 'activation-timing') this.emit('opener', message);
      this.emit('contact');
    });
    this.pathMapper = pathMapper ?? (mapGpuPaths ? new GpuPathMapper({
      readShares: names => this.connection.request('shareRoots', {names}),
      onResolved: mappings => this.emit('pathMappings', mappings)}) : null);
    this.connection.on('offline', reason => { this.observationGeneration++; this.metadataCache.clear(); this.taskListCache.clear(); this.history?.invalidate(); this.catalogPoller?.invalidate(); for (const task of this.tasks.values()) if (task.desired) this.markOffline(task, reason); });
    this.connection.on('state', state => {
      if (state.status !== 'online') this.observationGeneration++;
      this.pathMapper?.invalidate();
      this.orderGeneration++; this.desktopOrder.clear(); this.orderPending = null;
      this.metadataCache.clear();
      this.taskListCache.clear();
      this.catalogPoller?.invalidate();
      if (state.status !== 'online') this.history?.invalidate();
      this.emit('connection', state);
      if (state.status === 'online') {
        this.pruneWarmTasks();
        for (const task of this.tasks.values()) if (task.desired && !task.blocked) this.prepare(task.id, {touch: false, activate: this.allowActivation && task.policy.followers.size > 0}).catch(() => {});
      }
    });
    if (prefetchHistory) {
      this.historyConnection = createHistoryConnection ? createHistoryConnection() : new ReconnectingWorker({threadId: GPU_THREAD, seconds, readySignal: 'ready',
        createWorker: options => new SshWorker({...options, mode: 'history'}),
        acceptSnapshot: message => { if (!supportedHostVersion(message.appVersion)) throw new Error('Untested GPU history worker'); }});
      this.history = new HistoryPrefetch({fetch: async id => {
        await this.historyConnection.waitUntilReady();
        return this.historyConnection.request('history', {threadId: id});
      }, canFetch: () => this.connection.online && this.historyConnection.online && Date.now() - this.lastSelectedAt > 1200 &&
        ![...this.tasks.values()].some(task => task.pending)});
      this.history.on('ready', event => {
        const task = this.tasks.get(event.threadId);
        if (task?.policy.followers.size) this.showStoredPreview(task);
        this.emit('prefetch', {type: 'ready', ...event});
      });
      this.history.on('progress', event => this.emit('prefetch', {type: 'progress', ...event}));
      this.history.on('failure', event => this.emit('prefetch', {type: 'failure', ...event}));
      this.historyConnection.on('state', state => this.emit('prefetch', {type: 'connection', ...state}));
    }
    if (refreshCatalog) {
      this.catalogPoller = new CatalogPoller({fetchPage: async params => {
        const page = await this.historyConnection.request('catalog', params);
        return {...page, tasks: this.catalogFilter(page.tasks)};
      }, canRun: () => !this.closed && this.connection.online && this.historyConnection.online && canRefreshCatalog() &&
        Date.now() - this.lastSelectedAt > 1200 && ![...this.tasks.values()].some(task => task.pending)});
      this.catalogPoller.on('rows', rows => {
        this.desktopOrder.replace(rows);
        this.acceptCatalog({data: rows.map(row => ({...row, name: row.title})), nextCursor: null}, {archived: false});
      });
      this.catalogPoller.on('changes', rows => {
        this.taskListCache.clear(); this.emit('catalogChanged', rows);
      });
      this.catalogPoller.on('progress', progress => this.emit('catalogRefresh', progress));
      this.catalogPoller.on('failure', failure => this.emit('catalogRefresh', {...failure, failed: true}));
      this.historyConnection.on('state', () => this.catalogPoller.invalidate());
    }
    this.maintenance = setInterval(() => this.maintain(), 2000);
  }
  maintain(now = Date.now()) {
    if (!this.connection.online || this.closed) return;
    this.pruneWarmTasks(now);
    for (const task of this.tasks.values()) {
      if (this.archivedIds.has(task.id)) continue;
      // An app can re-follow its cached conversation without owner discovery.
      if (task.policy.followers.size) task.desired = true;
      if (task.desired && !task.policy.online && !task.pending && !task.blocked && now >= task.retryAt) this.prepare(task.id, {touch: false, activate: this.allowActivation && task.policy.followers.size > 0}).catch(() => {});
      // The desktop's pending resume/history promise can settle after the first
      // IPC snapshot. Re-send fresh revisions briefly, after that promise settles.
      if (task.policy.online && !task.blocked && task.policy.followers.size && now < task.viewRefreshUntil && now >= task.viewRefreshAt) {
        task.viewRefreshAt = now + 3000; task.viewRefreshCount++; task.policy.revision++;
        this.emit('snapshot', task);
      }
    }
  }
  pruneWarmTasks(now = Date.now()) {
    if (this.closed) return;
    const recent = [...this.tasks.values()].filter(task => task.desired && task.policy.state &&
      !task.policy.followers.size && !task.pending && !task.blocked && !task.releasing)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const [index, task] of recent.entries()) {
      if (now - task.lastUsed > this.warmRetentionMs) this.park(task, 'expired');
      else if (index >= this.maxWarmTasks) this.park(task, 'recent-limit');
    }
    const parked = [...this.tasks.values()].filter(task => !task.desired && !task.policy.followers.size && task.policy.state &&
      !task.pending && !task.releasing && !task.blocked).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const task of parked.slice(this.maxParkedHistories)) {
      // Keep owner/revision identity guards while releasing unused large bodies.
      task.policy.state = null; task.policy.preview = false;
      this.emit('retention', {threadId: task.id, reason: 'parked-history-released'});
    }
  }
  park(task, reason = 'inactive') {
    if (task.policy.followers.size || !task.desired || !task.policy.state || task.pending || task.releasing || this.closed) return;
    task.desired = false; task.parked = true; task.policy.online = false;
    // Normal inactivity is not a GPU execution failure. Keep the last history
    // intact and require a fresh verified snapshot before enabling input again.
    task.releasing = (this.connection.online ? this.connection.request('unwatch', {threadId: task.id}) : Promise.resolve())
      .catch(() => {}).finally(() => { task.releasing = null; });
    this.emit('retention', {threadId: task.id, reason});
    this.emit('snapshot', task);
  }
  follow(message) {
    if (this.closed) return false;
    const id = message?.params?.conversationId;
    if (this.archivedIds.has(id)) return false;
    let task = this.tasks.get(id);
    if (!task) {
      // The official view announces its active conversation before its slower
      // history/resume preparation. A catalog row alone never opens anything.
      if (!this.knownIds.has(id) || !UUID.test(id ?? '') || message.params.following !== true ||
          !new NativeViewPolicy(id).acceptsFollowing(message)) return false;
      task = this.task(id);
    }
    const wasFollowing = task.policy.followers.has(message.sourceClientId);
    const isFollowing = task.policy.follow(message);
    if (wasFollowing && !task.policy.followers.has(message.sourceClientId)) {
      // Retention starts when a real viewer leaves, even after hours of reading.
      task.lastUsed = Date.now(); this.pruneWarmTasks();
    }
    if (!isFollowing) return false;
    if (!wasFollowing) {
      task.followStartedAt = performance.now();
      task.previewReported = false;
      this.emit('following', {threadId: id, state: 'selected', retained: task.policy.online});
    }
    this.lastSelectedAt = Date.now();
    task.lastUsed = Date.now(); task.desired = true;
    this.showStoredPreview(task);
    this.refreshView(task);
    this.prepare(task.id, {activate: this.allowActivation}).catch(() => {});
    return true;
  }
  showStoredPreview(task) {
    if (!this.history || task.blocked || task.policy.online || (task.policy.state && !task.policy.preview) || this.closed || !this.connection.online) return false;
    const preview = this.history.get(task.id);
    if (!preview) return false;
    try {
      if (!task.policy.acceptPreview(preview)) return false;
      this.emit('snapshot', task); return true;
    } catch { this.history.remove(task.id); return false; }
  }
  acceptCatalog(result, params) {
    if (this.closed) return;
    for (const thread of result.data ?? []) if (UUID.test(thread.id ?? '')) {
      // A fresh active catalog also observes restoration from another device.
      if (params?.archived !== true) this.archivedIds.delete(thread.id);
      this.knownIds.add(thread.id); this.titles.set(thread.id, String(thread.name ?? thread.preview ?? 'GPU 작업').slice(0, 160));
    }
    if (params?.archived !== true) this.history?.enqueue(result.data ?? []);
    this.emit('catalog', {count: result.data?.length ?? 0, archived: params?.archived === true, nextCursor: Boolean(result.nextCursor)});
  }
  removeFollower(clientId) {
    for (const task of this.tasks.values()) if (task.policy.followers.delete(clientId)) task.lastUsed = Date.now();
    this.pruneWarmTasks();
  }
  task(id) {
    if (!UUID.test(id ?? '')) throw new Error('Invalid GPU task ID');
    let task = this.tasks.get(id);
    if (!task) {
      task = {id, policy: new NativeViewPolicy(id), title: this.titles.get(id) ?? 'GPU 작업', desired: false, pending: null,
        blocked: false, parked: false, releasing: null, retryAt: 0, lastUsed: Date.now(), error: null, observationGeneration: 0,
        viewRefreshUntil: 0, viewRefreshAt: 0, viewRefreshCount: 0, viewFastTimers: []};
      this.tasks.set(id, task);
    }
    return task;
  }
  async read(method, params, context={}) {
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      const write = archiveWriteRoute(method, params);
      if (!this.allowArchiving || this.closed || !this.connection.online ||
          typeof context.requestKey !== 'string' || !context.requestKey.length || context.requestKey.length > 300)
        throw Error('GPU 보관 연결을 사용할 수 없어 요청을 보내지 않았습니다');
      const fingerprint = JSON.stringify(write), previous = this.archiveRequests.get(context.requestKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Error('Archive request ID reused with different data');
        return previous.promise;
      }
      if (this.archiveRequests.size >= 1000) throw Error('Archive request limit reached; restart the connection');
      const operationId = randomUUID();
      const promise = Promise.resolve().then(async () => {
        try {
          const result = archiveResponse(method, params, await this.connection.request('archiveWrite', {operationId, ...write}));
          const archived = method === 'thread/archive';
          if (archived) {
            this.archivedIds.add(params.threadId); this.knownIds.delete(params.threadId); this.history?.remove(params.threadId);
            const task = this.tasks.get(params.threadId);
            if (task) {
              task.observationGeneration++; task.desired = false; task.policy.followers.clear(); task.policy.disconnect();
              for (const timer of task.viewFastTimers) clearTimeout(timer);
              task.viewRefreshUntil = 0;
              // No active viewer should revive the archived conversation on a
              // maintenance tick or accept an older in-flight watch response.
              this.connection.request('unwatch', {threadId: task.id}).catch(() => {});
            }
          } else {
            this.archivedIds.delete(params.threadId); this.knownIds.add(params.threadId);
          }
          this.emit('archiveChanged', {threadId: params.threadId, archived});
          return result;
        } finally {
          this.metadataCache.clear(); this.taskListCache.clear(); this.catalogPoller?.invalidate();
          this.orderGeneration++; this.desktopOrder.clear(); this.orderPending = null;
        }
      });
      this.archiveRequests.set(context.requestKey, {fingerprint, promise}); return promise;
    }
    if(method==='thread/start') {
      if(!this.allowNewTasks || !this.allowActivation || !this.connection.online || this.closed || typeof context.requestKey!=='string' || context.requestKey.length>300)
        throw Error('gpu-guard-denied: new GPU task creation unavailable');
      const fingerprint=JSON.stringify(newTaskParams(params));
      const old=this.creations.get(context.requestKey);
      if(old){if(old.fingerprint!==fingerprint)throw Error('Creation request changed');return old.promise;}
      if(this.creations.size>=100)throw Error('New task limit reached');
      const operationId=randomUUID();
      const promise=(async()=>{
        let accepted=newTaskParams(params);
        if(this.pathMapper)accepted=newTaskParams(await this.pathMapper.params(method,accepted,{fresh:true}));
        this.emit('newTask',{stage:'creating',operationId,cwd:accepted.cwd});
        const response=await this.connection.request('createTask',{operationId,params:accepted},45000);
        const id=response?.thread?.id;if(!UUID.test(id??''))throw Error('Invalid new GPU task ID');
        this.newTasks.add(id);this.knownIds.add(id);this.taskListCache.clear();this.metadataCache.clear();
        // The GPU creation worker has exited and released the writer lock.
        const task=await this.prepare(id,{activate:true});
        this.emit('newTask',{stage:'ready',operationId,threadId:id,owner:task.policy.owner,cwd:accepted.cwd});
        return response;
      })().catch(error=>{this.emit('newTask',{stage:'failed',operationId,reason:error.message});throw error;});
      this.creations.set(context.requestKey,{fingerprint,promise});return promise;
    }
    if(method==='turn/start') {
      if(!this.allowNewTasks||!this.newTasks.has(params?.threadId))throw Error('gpu-guard-denied: Only the first input of a bridge-created task is supported');
      const input=firstTaskTurn(params);
      return this.firstTurns.run(input.operationId,JSON.stringify(input),async()=>{
        await this.prepare(input.threadId,{activate:true});
        const response=await this.connection.request('submitFirstText',input,30000);
        const result=response?.result??response;
        if(!UUID.test(result?.turn?.id??''))throw Error('First GPU input outcome unknown; do not resend');
        this.emit('newTask',{stage:'first-input-acknowledged',threadId:input.threadId,operationId:input.operationId,turnId:result.turn.id});
        return result;
      });
    }
    if (method === 'config/batchWrite') {
      if (!this.allowModelSettings) throw new Error('gpu-guard-denied: model settings disabled');
      const write = defaultModelWrite(params);
      if (this.closed || !this.connection.online) throw new Error('GPU 연결이 끊겨 모델을 변경하지 않았습니다');
      try {
        const result = await this.connection.request('modelConfig', write.params);
        this.emit('modelSettings', {scope: 'default', ...write.settings, profile: write.profile, outcome: 'acknowledged'});
        return result;
      } finally { this.metadataCache.clear(); }
    }
    if (method === 'project/create' || method === 'project/move') {
      if (!this.allowProjectCreation) throw new Error('gpu-guard-denied: project creation disabled');
      let write = projectWriteRoute(method, params);
      // A write goes straight to the current GPU generation, without caching,
      // offline queueing, reconnect retries or any local CLI fallback.
      if (this.closed || !this.connection.online) throw new Error('GPU 연결이 끊겨 프로젝트 요청을 보내지 않았습니다');
      try {
        if(this.pathMapper) write=projectWriteRoute(method,await this.pathMapper.params(method,write.params,{fresh:true}));
        const result = await this.connection.request('projectWrite', write);
        this.emit('projectWrite', {method, projectId: result?.project?.id ?? params.projectId, outcome: 'acknowledged'});
        return result;
      } catch (error) {
        this.emit('projectWrite', {method, outcome: 'unconfirmed-or-rejected', reason: error.message});
        throw error;
      } finally { this.metadataCache.clear(); this.taskListCache.clear(); }
    }
    if (method === 'thread/resume' && this.allowActivation) {
      if (!this.knownIds.has(params?.threadId)) throw new Error('gpu-guard-denied: unknown task opening');
      const task = await this.prepare(params.threadId, {activate: true});
      this.refreshView(task);
      // End the notebook's attempted ownership path. On its next owner lookup,
      // the original GPU task is already available through desktop IPC.
      throw new Error('GPU 공식 앱에서 작업을 열었습니다. 기존 세션에 연결하는 중입니다.');
    }
    hubReadRoute(method, params);
    if (method === 'thread/turns/list' && !this.knownIds.has(params.threadId))
      throw new Error('gpu-guard-denied: unknown task history');
    // Do not let an offline cache hide a lost GPU connection.
    await this.connection.waitUntilReady();
    if (this.closed || !this.connection.online) throw new Error('GPU read connection unavailable');
    if(this.pathMapper) params=await this.pathMapper.params(method,params);
    if (method === 'thread/list' && params?.sectionId == null && this.catalogPoller) await this.ensureDesktopOrder();
    const result = method === 'thread/list'
      ? await this.taskListCache.read(params, async normalized => {
        const page = await this.connection.request('read', {method, params: normalized});
        return {...page, data: this.catalogFilter(page.data)};
      })
      : await this.metadataCache.read(method, params, () => this.connection.request('read', {method, params}));
    if (method === 'thread/read' && result.thread?.id === params.threadId) {
      this.knownIds.add(params.threadId);
      this.history?.enqueue([result.thread]);
      // Sidebar hydration reads metadata for every row. Only a full conversation
      // read or owner discovery should attach to a live GPU task.
      if (params.includeTurns === true) this.prepare(params.threadId).catch(() => {});
    }
    return this.desktopOrder.response(method, result);
  }
  ensureDesktopOrder() {
    if (this.desktopOrder.ready) return Promise.resolve();
    if (this.orderPending) return this.orderPending;
    const generation = this.orderGeneration;
    const pending = (async () => {
      const rows = [], seen = new Set(); let cursor = null;
      do {
        const page = await this.connection.request('catalog', {cursor, limit: 100});
        if (!Array.isArray(page?.tasks) || page.tasks.length > 100 || !(page.nextCursor == null || typeof page.nextCursor === 'string'))
          throw new Error('Invalid remote ordering page');
        rows.push(...page.tasks); cursor = page.nextCursor ?? null;
        if (cursor && (seen.has(cursor) || cursor.length > 4096)) throw new Error('Invalid remote ordering cursor');
        if (cursor) seen.add(cursor);
        if (generation !== this.orderGeneration || this.closed || !this.connection.online) throw new Error('Remote ordering connection changed');
      } while (cursor && rows.length < 5000);
      this.desktopOrder.replace(this.catalogFilter(rows));
    })().finally(() => { if (this.orderPending === pending) this.orderPending = null; });
    this.orderPending = pending;
    return pending;
  }
  refreshView(task, now = Date.now()) {
    for (const timer of task.viewFastTimers) clearTimeout(timer);
    // Deliver again just after pending desktop history/resume promises settle,
    // without waiting for the two-second maintenance tick.
    task.viewFastTimers = [350, 900].map(ms => setTimeout(() => {
      if (this.closed || !this.connection.online || !task.policy.online || task.blocked || !task.policy.followers.size) return;
      task.viewRefreshCount++; task.policy.revision++; this.emit('snapshot', task);
    }, ms));
    task.viewRefreshAt = now + 1000; task.viewRefreshUntil = now + 45000;
  }
  prepare(id, {activate = false, touch = true} = {}) {
    if (this.archivedIds.has(id)) return Promise.reject(new Error('이 작업은 보관되었습니다. 보관을 해제한 뒤 열어 주세요'));
    if (activate && !this.allowActivation) return Promise.reject(new Error('GPU task opening is disabled'));
    const task = this.task(id); if (touch) task.lastUsed = Date.now(); task.desired = true;
    if (task.blocked || this.closed) return Promise.reject(new Error('GPU task identity changed; restart explicitly'));
    if (task.policy.online) return Promise.resolve(task);
    if (task.pending) return activate ? task.pending.catch(() => this.prepare(id, {activate: true})) : task.pending;
    if (!activate && Date.now() < task.retryAt) return Promise.reject(new Error('GPU에서 이 작업을 먼저 열어 주세요'));
    task.pending = (async () => {
      await task.releasing;
      await this.connection.waitUntilReady();
      const generation = this.observationGeneration;
      const taskGeneration = task.observationGeneration;
      if (activate) this.emit('activation', {threadId: id, state: 'opening'});
      const snapshot = await this.connection.request(activate ? 'activate' : 'watch', {threadId: id});
      if (this.closed || !this.connection.online || generation !== this.observationGeneration || taskGeneration !== task.observationGeneration) throw new Error('GPU observation connection changed');
      if (snapshot?.threadId !== id) throw new Error('GPU observation response task mismatch');
      // A newer streamed snapshot may precede the response to an already-open watch.
      if (!task.policy.online || snapshot.revision >= task.policy.sourceRevision) this.accept(snapshot, {freshObservation: true});
      if (!task.policy.online) throw new Error(task.error ?? 'GPU observation unavailable');
      if (activate) this.emit('activation', {threadId: id, state: 'opened', owner: task.policy.owner});
      return task;
    })().catch(error => {
      task.retryAt = Date.now() + 10000;
      if (activate) this.emit('activation', {threadId: id, state: 'failed'});
      this.markOffline(task, error.message); throw error;
    }).finally(() => { task.pending = null; this.pruneWarmTasks(); });
    return task.pending;
  }
  accept(snapshot, {freshObservation = false} = {}) {
    const task = this.tasks.get(snapshot.threadId);
    if (!task || !task.desired || task.blocked || this.closed) return;
    // A replacement observation may stream before its watch/activate response.
    // Wait for the correlated response before accepting a lower baseline. Never
    // let an unsolicited broadcast reset it or change the original owner.
    if (!freshObservation && !task.policy.online && task.policy.owner === snapshot.ownerClientId &&
        Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 && snapshot.revision < task.policy.sourceRevision) return;
    try {
      task.policy.acceptSnapshot(snapshot, {freshObservation}); task.title = snapshot.state.title || 'GPU 작업'; task.error = null; task.parked = false;
      this.emit('snapshot', task);
    } catch {
      task.blocked = true; this.markOffline(task, 'GPU task identity or revision changed');
      this.connection.request('unwatch', {threadId: task.id}).catch(() => {});
    }
  }
  markOffline(task, reason) {
    if (!task || this.closed) return;
    task.observationGeneration++;
    task.policy.disconnect(reason); task.error = reason;
    this.emit('snapshot', task); this.emit('taskError', {threadId: task.id, reason});
  }
  async discover(request) {
    const id = request?.params?.conversationId;
    if (!this.knownIds.has(id) && !this.tasks.has(id)) return false;
    if (request?.method !== 'thread-owner-discovery' || request.version !== 1) return this.tasks.get(id)?.policy.canHandle(request) ?? false;
    try { const task = await this.prepare(id); return task.policy.canHandle(request); } catch { return false; }
  }
  async updateModel(id, selection, {condition = null} = {}) {
    const settings = modelSettings(selection), expected = modelCondition(condition), task = this.tasks.get(id);
    if (!this.allowModelSettings || this.closed || !task?.policy.online || !this.connection.online || task.blocked)
      throw new Error('GPU task model settings unavailable');
    const result = await this.connection.request('modelSettings', {threadId: id, settings, ...(expected !== null ? {condition: expected} : {})});
    if (typeof result?.applied !== 'boolean') throw Error('Invalid GPU model settings response');
    this.emit('modelSettings', {scope: 'task', threadId: id, ...settings, outcome: result.applied ? 'acknowledged' : 'not-applied'});
    return result;
  }
  approveCommand(message) { return this.#approve(message, 'command'); }
  approveComputer(message) { return this.#approve(message, 'computer'); }
  approvePermissions(message) { return this.#approve(message, 'permissions'); }
  replyPopup(message) { return this.#approve(message, 'popup'); }
  async #approve(message, kind) {
    const {enabled, registry, method, parse} = {
      command: {enabled:this.allowCommandApprovals, registry:this.commandApprovals, method:'commandApproval', parse:commandApprovalFromFollower},
      computer: {enabled:this.allowComputerApprovals, registry:this.computerApprovals, method:'computerApproval', parse:computerApprovalFromFollower},
      permissions: {enabled:this.allowPermissionsApprovals, registry:this.permissionsApprovals, method:'permissionsApproval', parse:permissionsApprovalFromFollower},
      popup: {enabled:this.allowPopupReplies, registry:this.popupReplies, method:'popupReply', parse:popupReplyFromFollower},
    }[kind];
    const task = this.tasks.get(message?.params?.conversationId);
    if (!enabled || this.closed || !this.connection.online || task?.blocked) throw Error('GPU 연결이 끊겼거나 승인 전달이 비활성화되어 선택을 보내지 않았습니다');
    const approval = parse(message, task?.policy), key = approvalKey(approval);
    const decision = kind === 'command' ? approval.decision : approval.response;
    const previous = registry.get(key);
    if (previous) {
      if (!sameApprovalDecision(previous.decision, decision)) throw Error('이미 다른 승인 선택을 전달했습니다');
      return previous.promise;
    }
    const promise = Promise.resolve().then(async () => {
      this.emit(method, {...approval, outcome: 'pending'});
      try {
        const result = await this.connection.request(method, approval);
        if (result?.ok !== true) throw Error('GPU 승인 응답을 확인하지 못했습니다');
        this.emit(method, {...approval, outcome: 'acknowledged'}); return result;
      } catch (error) {
        this.emit(method, {...approval, outcome: 'unconfirmed-or-rejected', reason: error.message}); throw error;
      }
    });
    registry.set(key, {decision, promise}); return promise;
  }
  async submit(id, operationId, text, selection = {}, plan = null) {
    const settings = modelSettings(selection, {empty: true});
    const task = this.tasks.get(id);
    if (!task?.policy.online || !this.connection.online || task.blocked) throw new Error('GPU task input unavailable');
    task.lastUsed = Date.now();
    if (Object.keys(settings).length && !this.allowModelSettings) throw new Error('gpu-guard-denied: model settings disabled');
    return this.submissions.run(operationId, id + '\0' + text + JSON.stringify({settings,plan}),
      () => this.connection.request('submitText', {threadId: id, operationId, text, ...(Object.keys(settings).length ? {settings} : {}),...(plan?{plan}:{})}));
  }
  close() {
    if (this.closed) return; this.closed = true; clearInterval(this.maintenance);
    this.metadataCache.clear();
    this.taskListCache.clear();
    this.history?.close(); this.historyConnection?.close();
    this.catalogPoller?.close();
    for (const task of this.tasks.values()) for (const timer of task.viewFastTimers) clearTimeout(timer);
    this.connection.close();
  }
}
