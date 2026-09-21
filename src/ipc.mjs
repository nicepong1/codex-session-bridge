import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FrameDecoder, encodeFrame } from './framing.mjs';
import {TESTED_APP_VERSION,hostModelSettingsVersion,supportedHostVersion} from './installed.mjs';
import { turnsOf } from './state.mjs';
import {modelSettings, modelTurnOverrides, modelCondition} from './model-settings.mjs';
import {planTurnOverrides} from './plan-followup.mjs';
import {COMMAND_APPROVAL_METHOD, verifyCommandApproval} from './command-approval.mjs';
import {COMPUTER_APPROVAL_METHOD, verifyComputerApproval} from './computer-approval.mjs';
import {PERMISSIONS_APPROVAL_METHOD, verifyPermissionsApproval} from './permissions-approval.mjs';
import {FILE_APPROVAL_METHOD, verifyPopupReply} from './popup-replies.mjs';

export const TEST_CHAT_TEXT = '테스트용으로 열어둔 채팅이야';

export const PIPE_PATH = '\\\\.\\pipe\\codex-ipc';

// Observed in desktop package 26.901.5280.0. This is NOT the public app-server protocol.
export const VERSIONS = Object.freeze({
  initialize: 0,
  'thread-owner-discovery': 1,
  'thread-stream-state-changed': 11,
  'thread-stream-following-changed': 1,
  'thread-stream-following-status-requested': 1,
});
const READ_REQUESTS = new Set(['initialize', 'thread-owner-discovery']);

export class DesktopIpc extends EventEmitter {
  #socket;
  #decoder = new FrameDecoder();
  #pending = new Map();
  #closed = false;
  #following = new Map();
  #allowProbeWrite = false;
  #probeUsed = false;
  #allowRemoteInput = false;
  #allowedThreadId;
  clientId = null;

  constructor({ allowProbeWrite = false, allowRemoteInput = false, allowedThreadId = '00000000-0000-4000-8000-000000000001' } = {}) { super(); this.#allowProbeWrite = allowProbeWrite; this.#allowRemoteInput = allowRemoteInput; this.#allowedThreadId = allowedThreadId; }

  async connect({ path = PIPE_PATH, timeoutMs = 5000 } = {}) {
    if (this.#socket || this.#closed) throw new Error('Create a new client for each connection');
    const socket = this.#socket = net.createConnection(path);
    socket.on('data', chunk => {
      try { this.#decoder.push(chunk, msg => this.#receive(msg)); }
      catch (error) { this.#fail(error); socket.destroy(); }
    });
    socket.on('error', error => this.#fail(error));
    socket.on('close', () => {
      this.#fail(new Error('IPC connection closed'));
      this.#closed = true;
      this.emit('disconnected');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC connection timed out')); }, timeoutMs);
      const done = fn => arg => { clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed); fn(arg); };
      const connected = done(resolve);
      const failed = done(reject);
      socket.once('connect', connected);
      socket.once('error', failed);
    });
    const response = await this.request('initialize', { clientType: 'codex-session-bridge-probe' }, { timeoutMs });
    if (typeof response.result?.clientId !== 'string') throw new Error('Invalid initialization response');
    this.clientId = response.result.clientId;
    return this.clientId;
  }

  request(method, params, { timeoutMs = 5000, targetClientId } = {}) {
    if (!READ_REQUESTS.has(method)) throw new Error(`Read-only client rejects: ${method}`);
    return this.#request(method, params, { timeoutMs, targetClientId });
  }

  #request(method, params, { timeoutMs = 5000, targetClientId, version = VERSIONS[method] } = {}) {
    if (!this.clientId && method !== 'initialize') throw new Error('Not initialized');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`IPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, method, targetClientId });
      try {
        this.#write({ type: 'request', requestId, sourceClientId: this.clientId ?? 'initializing-client',
          version, method, params, timeoutMs, ...(targetClientId ? { targetClientId } : {}) });
      } catch (error) {
        clearTimeout(timer); this.#pending.delete(requestId); reject(error);
      }
    });
  }

  sendProbe({ session, expectedTurnId, appVersion, nonce }) {
    if (!this.#allowProbeWrite) throw new Error('Read-only client: probe writes are disabled');
    if (this.#probeUsed) throw new Error('Probe already attempted; never automatically resend');
    if (!supportedHostVersion(appVersion)) throw new Error('Untested desktop version: probe write refused');
    if (!/^[a-f\d]{24}$/.test(nonce ?? '')) throw new Error('Invalid probe nonce');
    const summary = session.summary();
    if (summary.stale || !session.state || Date.now() - session.receivedAt > 5000) throw new Error('Fresh session snapshot required');
    if (summary.activeTurnIds.length !== 1 || summary.activeTurnIds[0] !== expectedTurnId) throw new Error('Active turn changed or unavailable');
    if (this.#following.get(session.threadId) !== session.ownerClientId) throw new Error('Must follow the verified session owner');
    const text = `[Codex Session Bridge 연결 검증 ${nonce}] 사용자 요청에 따른 동일 세션 입력 전달 시험 메시지입니다.`;
    const state = session.state;
    this.#probeUsed = true;
    // Fixed test text only. No arbitrary prompts, starts, resumes, approvals, or interruption API.
    // The private follower method has no atomic expectedTurnId guard. The caller MUST check the returned turn id.
    return this.#request('thread-follower-steer-turn', {
      conversationId: session.threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text, text_elements: [] }],
      attachments: [],
      serviceTier: null,
      restoreMessage: { text, cwd: state.cwd ?? null, context: {
        workspaceRoots: state.cwd ? [state.cwd] : [], commentAttachments: [],
        collaborationMode: state.latestCollaborationMode ?? null,
      }, responsesapiClientMetadata: {} },
    }, { version: 1, targetClientId: session.ownerClientId, timeoutMs: 15000 });
  }

  startIdleProbe({ session, expectedLastTurnId, appVersion, nonce }) {
    if (!this.#allowProbeWrite) throw new Error('Read-only client: probe writes are disabled');
    if (this.#probeUsed) throw new Error('Probe already attempted; never automatically resend');
    if (!supportedHostVersion(appVersion)) throw new Error('Untested desktop version: probe write refused');
    if (!/^[a-f\d]{24}$/.test(nonce ?? '')) throw new Error('Invalid probe nonce');
    const summary = session.summary();
    if (summary.stale || !session.state || Date.now() - session.receivedAt > 5000) throw new Error('Fresh session snapshot required');
    if (summary.runtimeStatus !== 'idle' || summary.activeTurnIds.length) throw new Error('Idle test conversation required');
    const turns = turnsOf(session.state);
    if (!expectedLastTurnId || turns.at(-1)?.turnId !== expectedLastTurnId || turns.at(-1)?.status !== 'completed') {
      throw new Error('Last completed turn changed or unavailable');
    }
    if (!turns.some(turn => turn.params?.input?.some(item => item.type === 'text' && item.text?.includes(TEST_CHAT_TEXT)))) {
      throw new Error('User-designated test chat marker is missing');
    }
    if (session.state.unconfirmedTurnSubmissions?.length) throw new Error('Earlier submission is not confirmed');
    if (this.#following.get(session.threadId) !== session.ownerClientId) throw new Error('Must follow the verified session owner');
    this.#probeUsed = true;
    const text = `[Codex Session Bridge GPU 연결 검증 ${nonce}] 이 메시지는 사용자가 지정한 테스트 채팅에 노트북에서 보낸 연결 시험입니다. 도구를 사용하거나 파일을 변경하지 말고, 'GPU 원격 연결 확인'이라고만 답해 주세요.`;
    return this.#request('thread-follower-start-turn', {
      conversationId: session.threadId,
      turnStart: {
        request: { threadId: session.threadId, clientUserMessageId: randomUUID(),
          input: [{ type: 'text', text, text_elements: [] }] },
        context: { inheritThreadSettings: true, attachments: [], commentAttachments: [] },
      },
    }, { version: 2, targetClientId: session.ownerClientId, timeoutMs: 15000 });
  }

  updateModelSettings({session, appVersion, settings, condition = null}) {
    const selection = modelSettings(settings);
    const expected = modelCondition(condition);
    if (!this.#allowRemoteInput || this.#probeUsed || !supportedHostVersion(appVersion) || session.threadId !== this.#allowedThreadId ||
        session.stale || Date.now() - session.receivedAt > 5000 || this.#following.get(session.threadId) !== session.ownerClientId)
      throw new Error('A fresh, followed GPU owner is required for model settings');
    // Select the protocol by the verified host build, never the notebook build.
    // Older hosts cannot atomically check conditions; do not lower those writes.
    const version = hostModelSettingsVersion(appVersion);
    if (version === 1 && expected !== null) return Promise.resolve({applied: false});
    this.#probeUsed = true;
    return this.#request('thread-follower-update-thread-settings', {conversationId: session.threadId, threadSettings: selection,
      ...(version === 2 ? {activeTurnId: null, condition: expected} : {})},
      {version, targetClientId: session.ownerClientId, timeoutMs: 15000}).then(response => {
        if (version === 2) {
          if (typeof response.result?.applied !== 'boolean') throw Error('GPU model settings were not acknowledged');
          return {applied: response.result.applied};
        }
        if (response.result?.ok !== true) throw Error('GPU model settings were not acknowledged');
        return {applied: true};
      });
  }

  replyCommandApproval({session, appVersion, approval}) {
    if (!this.#allowRemoteInput || this.#probeUsed || !supportedHostVersion(appVersion) ||
        session.threadId !== this.#allowedThreadId || this.#following.get(session.threadId) !== session.ownerClientId)
      throw Error('A fresh, followed GPU owner is required for this approval');
    verifyCommandApproval(session, approval);
    this.#probeUsed = true;
    return this.#request(COMMAND_APPROVAL_METHOD, {conversationId: session.threadId,
      requestId: approval.requestId, decision: approval.decision},
      {version: 1, targetClientId: session.ownerClientId, timeoutMs: 10000}).then(response => response.result);
  }

  replyComputerApproval({session, appVersion, approval}) {
    if (!this.#allowRemoteInput || this.#probeUsed || !supportedHostVersion(appVersion) ||
        session.threadId !== this.#allowedThreadId || this.#following.get(session.threadId) !== session.ownerClientId)
      throw Error('A fresh, followed GPU owner is required for this app approval');
    verifyComputerApproval(session, approval);
    this.#probeUsed = true;
    return this.#request(COMPUTER_APPROVAL_METHOD, {conversationId: session.threadId,
      requestId: approval.requestId, response: approval.response},
      {version: 1, targetClientId: session.ownerClientId, timeoutMs: 10000}).then(response => response.result);
  }

  replyPermissionsApproval({session, appVersion, approval}) {
    if (!this.#allowRemoteInput || this.#probeUsed || !supportedHostVersion(appVersion) ||
        session.threadId !== this.#allowedThreadId || this.#following.get(session.threadId) !== session.ownerClientId)
      throw Error('A fresh, followed GPU owner is required for this permission approval');
    verifyPermissionsApproval(session, approval);
    this.#probeUsed = true;
    return this.#request(PERMISSIONS_APPROVAL_METHOD, {conversationId: session.threadId,
      requestId: approval.requestId, response: approval.response},
      {version: 1, targetClientId: session.ownerClientId, timeoutMs: 10000}).then(response => response.result);
  }

  replyPopup({session,appVersion,approval}) {
    if(!this.#allowRemoteInput||this.#probeUsed||!supportedHostVersion(appVersion)||session.threadId!==this.#allowedThreadId||this.#following.get(session.threadId)!==session.ownerClientId)
      throw Error('A fresh, followed GPU owner is required for this reply');
    verifyPopupReply(session,approval);this.#probeUsed=true;
    const responseKey=approval.method===FILE_APPROVAL_METHOD?'decision':'response';
    return this.#request(approval.method,{conversationId:session.threadId,requestId:approval.requestId,[responseKey]:approval.response},
      {version:1,targetClientId:session.ownerClientId,timeoutMs:10000}).then(response=>response.result);
  }

  startTextTurn({session, appVersion, text, clientUserMessageId, settings = {}, allowEmptyInitial = false, plan = null, images = []}) {
    if (!this.#allowRemoteInput || this.#probeUsed) throw new Error('Remote input is disabled or already attempted');
    const overrides = plan ? planTurnOverrides(session,plan,text,settings) : modelTurnOverrides(session.state, settings);
    if (!supportedHostVersion(appVersion) || session.threadId !== this.#allowedThreadId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(session.threadId)) throw new Error('Untested GPU scope');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(clientUserMessageId ?? '') ||
        !Array.isArray(images) || images.length > 4 || images.some(image => image?.type !== 'image' || typeof image.url !== 'string' ||
          !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url) || ![null,'auto','low','high','original'].includes(image.detail ?? null)))
      throw new Error('Invalid text or image input');
    const summary = session.summary();
    const turns = turnsOf(session.state);
    if (summary.stale || Date.now() - session.receivedAt > 5000 || summary.runtimeStatus !== 'idle' || summary.activeTurnIds.length ||
        (!(allowEmptyInitial === true && turns.length === 0 && session.state.resumeState === 'resumed') && turns.at(-1)?.status !== 'completed') ||
        session.state.unconfirmedTurnSubmissions?.length) throw new Error('A fresh, idle GPU task is required');
    if (this.#following.get(session.threadId) !== session.ownerClientId) throw new Error('GPU owner is not being followed');
    this.#probeUsed = true;
    return this.#request('thread-follower-start-turn', {conversationId: session.threadId,
      turnStart: {request: {threadId: session.threadId, clientUserMessageId,
        input: [{type: 'text', text, text_elements: []}, ...images], ...overrides},
        context: {inheritThreadSettings: true, attachments: [], commentAttachments: []}}},
      {version: 2, targetClientId: session.ownerClientId, timeoutMs: 15000}).then(response => response.result);
  }

  follow(conversationId, ownerClientId, following = true) {
    if (!this.clientId || typeof conversationId !== 'string' || typeof ownerClientId !== 'string') {
      throw new Error('Following requires an initialized client, thread id, and discovered owner');
    }
    if (following) this.#following.set(conversationId, ownerClientId);
    else this.#following.delete(conversationId);
    this.#write({ type: 'broadcast', method: 'thread-stream-following-changed',
      sourceClientId: this.clientId, targetClientIds: [ownerClientId], version: 1,
      params: { conversationId, hostId: 'local', following } });
  }

  #write(message) {
    if (this.#closed || !this.#socket?.writable) throw new Error('IPC is not connected');
    this.#socket.write(encodeFrame(message));
  }

  #receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid IPC envelope');
    if (message.type === 'client-discovery-request') {
      // Never claim ownership or accept work from the app or another client.
      this.#write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'response') {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(message.requestId);
      if (message.resultType !== 'success') pending.reject(new Error(String(message.error ?? 'IPC request failed')));
      else if (message.method !== pending.method) pending.reject(new Error('IPC response method mismatch'));
      else if (pending.targetClientId && message.handledByClientId !== pending.targetClientId) pending.reject(new Error('IPC response owner mismatch'));
      else pending.resolve(message);
    } else if (message.type === 'broadcast') {
      if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
      if (message.method === 'thread-stream-following-status-requested' && message.version === 1) {
        const threadId = message.params?.conversationId;
        const owner = this.#following.get(threadId);
        if (message.params?.hostId === 'local' && owner === message.sourceClientId) this.follow(threadId, owner);
      }
      this.emit('broadcast', message);
    } else if (message.type === 'request') {
      this.#write({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'read-only-probe' });
    }
  }

  #fail(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.emit('diagnostic', { error: error.message });
  }

  close() {
    for (const [threadId, owner] of this.#following) {
      try { this.follow(threadId, owner, false); } catch { /* disconnected already */ }
    }
    this.#closed = true; this.#fail(new Error('Client closed')); this.#socket?.destroy();
  }
}
