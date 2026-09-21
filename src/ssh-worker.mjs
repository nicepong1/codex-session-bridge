import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {encodeSshFrame, SshFrameDecoder} from './ssh-framing.mjs';
import {RpcPeer} from './json-rpc-peer.mjs';
import {UUID} from './guard-policy.mjs';
import {loadProfile} from './connection-config.mjs';
import {resolvedProfile} from './remote-installation.mjs';
import {sshArguments,remoteNodeCommand} from './ssh-command.mjs';
import {ConnectionFailureClassifier} from './connection-notice.mjs';
import {SnapshotReceiver} from './snapshot-wire.mjs';
import {TransportLiveness} from './transport-liveness.mjs';

export class SshWorker extends EventEmitter {
  constructor({threadId, seconds = 600, mode = 'session', profile = resolvedProfile(loadProfile())}) {
    super();
    if (!UUID.test(threadId) || !Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new Error('Invalid worker scope');
    if (!['session', 'catalog', 'hub', 'history'].includes(mode)) throw new Error('Invalid worker mode');
    const remoteCommand = remoteNodeCommand(profile,'guarded-gpu-worker.mjs',[threadId,String(seconds),mode]);
    this.child = spawn('ssh', sshArguments(profile,remoteCommand),
      {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.peer = new RpcPeer(message => {
      if (!this.child.stdin.writable || this.child.stdin.writableLength > 1024 * 1024) throw new Error('SSH input unavailable');
      this.child.stdin.write(encodeSshFrame(message));
    });
    const decoder = new SshFrameDecoder();
    const snapshots = new SnapshotReceiver(), liveness = new TransportLiveness();
    this.child.stdout.on('data', data => { try {
      let completed = false;
      decoder.push(data, msg => { completed = true; this.peer.accept(snapshots.decode(msg)); });
      liveness.received(Date.now(),decoder.pending,completed);
    } catch { this.close(); this.emit('offline', 'Invalid GPU stream'); } });
    this.peer.on('message', message => this.emit('message', message));
    this.failureKind = 'unknown';
    const failure = new ConnectionFailureClassifier();
    this.child.stderr.on('data', data => {
      this.failureKind = failure.accept(data.toString('utf8'));
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => { this.peer.close(); this.emit('offline', 'SSH failed'); });
    this.child.on('close', code => { clearInterval(this.monitor); this.peer.close(); this.emit('offline', 'SSH closed (' + code + ', ' + this.failureKind + ')'); });
    this.monitor = setInterval(() => { if (liveness.expired(Date.now())) { this.close(); this.emit('offline', 'GPU heartbeat expired'); } }, 1000);
  }
  request(method, params) { return this.peer.request(method, params,
    ['activate','createTask','watch','history'].includes(method) ? 45000 : 15000); }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.monitor); this.peer.close(); this.child.stdin.end(); this.child.kill(); }
}
