import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomBytes, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {UUID} from './guard-policy.mjs';
import {interactiveHelperScript, runInteractiveScript} from './interactive-task-open.mjs';

async function ensureOpenerBinary() {
  const source = fileURLToPath(new URL('./InteractiveOpener.cs', import.meta.url));
  const hash = createHash('sha256').update('winexe-v1\0').update(fs.readFileSync(source)).digest('hex');
  const directory = path.join(process.env.LOCALAPPDATA, 'CodexSessionBridge', 'bin');
  const executable = path.join(directory, 'opener-' + hash + '.exe');
  if (!fs.existsSync(executable)) {
    fs.mkdirSync(directory, {recursive: true});
    const temporary = path.join(directory, 'build-' + randomBytes(16).toString('hex') + '.exe');
    try {
      const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:winexe', '/out:' + temporary, source], {windowsHide: true, timeout: 20000});
      if (!fs.existsSync(executable)) fs.renameSync(temporary, executable);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  const version = await promisify(execFile)(executable, ['--version'], {windowsHide: true, timeout: 5000});
  if (version.stdout.trim() !== 'codex-interactive-opener 0.9.0') throw new Error('Untested opener executable');
  return hash;
}

export class PersistentTaskOpener {
  constructor({seconds = 3600, launch = runInteractiveScript, prepare = ensureOpenerBinary} = {}) {
    this.closed = false; this.pending = new Map(); this.token = randomBytes(32).toString('hex');
    this.ready = this.start(seconds, launch, prepare).catch(error => {
      const failureFile = path.join(process.env.LOCALAPPDATA, 'CodexSessionBridge', 'bin', 'opener-failure-' + this.token + '.txt');
      if (fs.existsSync(failureFile)) {
        const reason = fs.readFileSync(failureFile, 'utf8'); fs.unlinkSync(failureFile);
        if (/^[a-z-]+:[A-Za-z]+Exception$/.test(reason)) throw new Error('GPU opener startup ' + reason);
      }
      throw error;
    });
    this.ready.catch(() => {});
  }
  async start(seconds, launch, prepare) {
    const start = performance.now();
    const sourceHash = await prepare();
    if (this.closed) throw new Error('GPU opener stopped');
    await launch(interactiveHelperScript(this.token, process.pid, seconds, sourceHash), {token: this.token, parentPid: process.pid, seconds});
    const deadline = Date.now() + 10000;
    while (!this.closed) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection('\\\\.\\pipe\\codex-open-' + this.token);
          const failed = error => { candidate.destroy(); reject(error); };
          candidate.once('error', failed);
          candidate.once('connect', () => { candidate.off('error', failed); resolve(candidate); });
        });
        if (this.closed) { socket.destroy(); throw new Error('GPU opener stopped'); }
        this.socket = socket;
        await new Promise((resolve, reject) => {
          let buffer = '', initialized = false;
          const timer = setTimeout(() => { reject(new Error('GPU opener handshake timed out')); this.close(); }, 5000);
          const fail = error => { clearTimeout(timer); if (!initialized) reject(error); this.fail(error); };
          socket.on('error', () => fail(new Error('GPU opener pipe failed')));
          socket.on('close', () => fail(new Error('GPU opener closed; pending opens will not be replayed')));
          socket.on('data', bytes => {
            try {
              buffer += bytes.toString('ascii');
              let end;
              while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
                if (line.length > 100) throw new Error('Invalid GPU opener frame');
                if (!initialized) {
                  const match = /^READY 0\.9\.0 (\d+)$/.exec(line);
                  if (!match) throw new Error('Untested GPU opener');
                  this.pid = Number(match[1]); initialized = true; clearTimeout(timer); resolve();
                } else {
                  const match = /^(OPENED|FAILED) ([a-fA-F0-9-]{36})$/.exec(line);
                  if (!match || !UUID.test(match[2])) throw new Error('Invalid GPU opener response');
                  const pending = this.pending.get(match[2]);
                  if (!pending) throw new Error('Unexpected GPU opener response');
                  this.pending.delete(match[2]); clearTimeout(pending.timer);
                  if (match[1] === 'OPENED') pending.resolve(); else pending.reject(new Error('GPU URI opening failed'));
                }
              }
              if (buffer.length > 100) throw new Error('Oversize GPU opener frame');
            } catch (error) { fail(error); socket.destroy(); }
          });
        });
        this.startupMs = Math.round(performance.now() - start); return;
      } catch (error) {
        if (this.closed || !['ENOENT', 'EBUSY'].includes(error.code) || Date.now() >= deadline) {
          throw error;
        }
        await delay(50);
      }
    }
    throw new Error('GPU opener stopped');
  }
  async open(id) {
    if (!UUID.test(id ?? '')) throw new Error('Invalid existing GPU task ID');
    await this.ready;
    if (this.closed || this.failure || !this.socket?.writable) throw new Error('GPU opener unavailable');
    if (this.pending.has(id) || this.pending.size >= 8) throw new Error('GPU opening already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('GPU opening outcome unknown; not replayed')); this.socket.destroy(); }, 10000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.write(id + '\n');
    });
  }
  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close() {
    if (this.closed) return; this.closed = true;
    this.fail(new Error('GPU opener stopped')); this.socket?.destroy();
  }
}
