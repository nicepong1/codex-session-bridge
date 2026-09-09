import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {encodeSshFrame, SshFrameDecoder} from './ssh-framing.mjs';
import {RpcPeer} from './json-rpc-peer.mjs';
import {UUID} from './guard-policy.mjs';
import {loadProfile} from './connection-config.mjs';
import {resolvedProfile} from './remote-installation.mjs';
import {sshArguments,remoteNodeCommand} from './ssh-command.mjs';

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
    this.lastHeartbeat = Date.now();
    const decoder = new SshFrameDecoder();
    this.child.stdout.on('data', data => { try { decoder.push(data, msg => {
      this.lastHeartbeat = Date.now(); this.peer.accept(msg);
    }); } catch { this.close(); this.emit('offline', 'Invalid GPU stream'); } });
    this.peer.on('message', message => this.emit('message', message));
    this.failureKind = 'unknown';
    this.child.stderr.on('data', data => {
      const diagnostic = data.toString('utf8');
      // Classify only. Never persist raw stderr, usernames, keys, or command text.
      if (/timed out|timeout/i.test(diagnostic)) this.failureKind = 'timeout';
      else if (/reset|broken pipe|closed by remote|connection.*closed/i.test(diagnostic)) this.failureKind = 'connection-closed';
      else if (/permission denied|authentication failed/i.test(diagnostic)) this.failureKind = 'authentication-or-access';
      else if (/host key verification|REMOTE HOST IDENTIFICATION/i.test(diagnostic)) this.failureKind = 'host-key';
      else if (/refused|unreachable|no route/i.test(diagnostic)) this.failureKind = 'unreachable';
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => { this.peer.close(); this.emit('offline', 'SSH failed'); });
    this.child.on('close', code => { clearInterval(this.monitor); this.peer.close(); this.emit('offline', 'SSH closed (' + code + ', ' + this.failureKind + ')'); });
    this.monitor = setInterval(() => { if (Date.now() - this.lastHeartbeat > 15000) { this.close(); this.emit('offline', 'GPU heartbeat expired'); } }, 1000);
  }
  request(method, params) { return this.peer.request(method, params, ['activate','createTask'].includes(method) ? 45000 : method==='submitFirstText'?30000:15000); }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.monitor); this.peer.close(); this.child.stdin.end(); this.child.kill(); }
}
