import {TESTED_APP_VERSION,supportedHostVersion} from './installed.mjs';
import {popupNoticeState} from './popup-catalog.mjs';
import {connectionNoticeState, connectionFailureKind} from './connection-notice.mjs';

// A read-only view of one explicitly selected GPU conversation. No local task is created.
export class NativeViewPolicy {
  constructor(threadId, viewThreadId = threadId) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(threadId)) throw new Error('Invalid thread ID');
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(viewThreadId)) throw new Error('Invalid view thread ID');
    this.threadId = threadId;
    this.viewThreadId = viewThreadId;
    this.owner = null;
    this.state = null;
    this.sourceRevision = -1;
    this.revision = 0;
    this.online = false;
    this.preview = false;
    this.connectionFailure = null;
    this.followers = new Set();
  }

  acceptSnapshot(message, {freshObservation = false} = {}) {
    if (message.type !== 'snapshot' || !supportedHostVersion(message.appVersion) ||
        message.threadId !== this.threadId || message.state?.id !== this.threadId ||
        message.state?.sessionId !== this.threadId || !message.ownerClientId ||
        !Number.isSafeInteger(message.revision) || message.revision < 0) throw new Error('GPU snapshot identity/version mismatch');
    if (this.owner && this.owner !== message.ownerClientId) throw new Error('GPU owner changed; reconnect explicitly');
    // Reopening the same stored conversation can restart its app-side revision.
    // Only a correlated, freshly resumed observation may establish that baseline;
    // broadcasts and snapshots received while already online remain monotonic.
    const canReset = freshObservation && !this.online && message.state.resumeState === 'resumed';
    if (message.revision < this.sourceRevision && !canReset) throw new Error('GPU revision moved backwards');
    this.owner = message.ownerClientId;
    this.sourceRevision = message.revision;
    this.state = structuredClone(message.state);
    this.state.id = this.viewThreadId;
    if (this.viewThreadId !== this.threadId) this.state.title = '[GPU 읽기 전용] ' + (this.state.title || '테스트 작업');
    // Never give a notebook resume path to a GPU rollout file.
    this.state.rolloutPath = '';
    this.state.resumeState = 'resumed';
    this.online = true;
    this.connectionFailure = null;
    this.preview = false;
    this.revision += 1;
  }

  acceptPreview(message) {
    if (this.online || (this.state && !this.preview)) return false;
    if (message?.type !== 'history-preview' || !supportedHostVersion(message.appVersion) ||
        message.threadId !== this.threadId || message.state?.id !== this.threadId || message.state?.sessionId !== this.threadId ||
        message.state.resumeState !== 'resuming' || message.state.threadRuntimeStatus?.type !== 'notLoaded' ||
        message.state.rolloutPath !== '' || message.state.requests?.length !== 0) throw new Error('Invalid stored GPU preview');
    this.state = structuredClone(message.state); this.state.id = this.viewThreadId;
    this.preview = true; this.revision++;
    // owner, sourceRevision and online remain unchanged until a live snapshot.
    return true;
  }

  disconnect(reason = 'unknown') {
    this.online = false;
    this.connectionFailure = connectionFailureKind(reason);
    if (this.state) {
      this.state = {...this.state, threadRuntimeStatus: {type: 'systemError'}};
      this.revision += 1;
    }
  }

  matches(request) {
    return request?.params?.conversationId === this.viewThreadId &&
      (request.hostId == null || request.hostId === 'local') &&
      (request.params.hostId == null || request.params.hostId === 'local');
  }

  canHandle(request) {
    return this.state !== null && this.matches(request) &&
      (request.method === 'thread-owner-discovery' || request.method?.startsWith('thread-follower-'));
  }

  handleRequest(request, clientId) {
    const base = {type: 'response', requestId: request.requestId, method: request.method, handledByClientId: clientId};
    if (!this.canHandle(request)) return {...base, resultType: 'error', error: 'native-view-wrong-thread'};
    if (request.method === 'thread-owner-discovery' && request.version === 1 && this.online) {
      return {...base, resultType: 'success', result: {supportsUntrustedAppInput: false}};
    }
    // Remain reachable after upstream loss and reject requests without triggering the app's missing-owner fallback.
    return {...base, resultType: 'error', error: this.online ? 'native-view-read-only' : 'native-view-gpu-offline'};
  }

  acceptsFollowing(message) {
    return message?.method === 'thread-stream-following-changed' && message.version === 1 &&
      this.matches(message) && typeof message.sourceClientId === 'string' && message.sourceClientId.length > 0 &&
      typeof message.params.following === 'boolean';
  }

  follow(message) {
    if (!this.acceptsFollowing(message)) return false;
    if (message.params.following) this.followers.add(message.sourceClientId);
    else this.followers.delete(message.sourceClientId);
    return message.params.following;
  }

  snapshot(clientId, recipients = [...this.followers]) {
    if (!this.state || !recipients.length) return null;
    return {type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
      sourceClientId: clientId, targetClientIds: recipients,
      params: {hostId: 'local', conversationId: this.viewThreadId,
        change: {type: 'snapshot', revision: this.revision,
          conversationState: connectionNoticeState(popupNoticeState(this.state), this.connectionFailure)}}};
  }
}
