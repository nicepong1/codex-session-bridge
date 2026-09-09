import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {PersistentTaskOpener} from '../src/persistent-task-opener.mjs';
import {GPU_THREAD} from '../src/guard-policy.mjs';

test('prepared opener reuses one connection and never replays an uncertain opening', async t => {
  let launches = 0, socket; const received = [];
  const server = net.createServer(client => {
    socket = client; client.write('READY 0.9.0 123\n');
    client.on('data', data => { const id = data.toString().trim(); received.push(id); client.destroy(); });
  });
  const opener = new PersistentTaskOpener({prepare: async () => 'a'.repeat(64), launch: async (_script, {token}) => {
    launches++; await new Promise(resolve => server.listen('\\\\.\\pipe\\codex-open-' + token, resolve));
  }});
  t.after(async () => { opener.close(); socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
  await opener.ready;
  await assert.rejects(opener.open('../bad'), /Invalid/);
  await assert.rejects(opener.open(GPU_THREAD), /closed/);
  await assert.rejects(opener.open(GPU_THREAD), /unavailable/);
  assert.deepEqual(received, [GPU_THREAD]); assert.equal(launches, 1);
});

async function compiledHelper(t, parentPid = process.pid) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(path.resolve('bin/codex-interactive-opener.exe'), [token, String(parentPid), '15'], {windowsHide: true, stdio: 'ignore'});
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let socket;
  for (let n = 0; n < 80; n++) {
    socket = net.createConnection('\\\\.\\pipe\\codex-open-' + token);
    const connected = await new Promise(resolve => { socket.once('connect', () => resolve(true)); socket.once('error', () => resolve(false)); });
    if (connected) break;
    socket.destroy(); await delay(25);
  }
  t.after(() => socket.destroy());
  const [ready] = await once(socket, 'data'); assert.match(ready.toString(), /^READY 0\.9\.0 /);
  return {socket, child, exited};
}

test('compiled helper accepts health checks, refuses paths and exits after pipe loss', {timeout: 10000}, async t => {
  const {socket, exited} = await compiledHelper(t);
  const pong = once(socket, 'data'); socket.write('PING\n');
  assert.equal((await pong)[0].toString().trim(), 'PONG');
  socket.write('../not-a-task\n');
  assert.equal((await exited)[0], 64);
});

test('compiled helper exits when its owning worker exits without opening a task', {timeout: 10000}, async t => {
  const token = randomBytes(32).toString('hex');
  const script = "const net=require('node:net');function connect(){const s=net.createConnection('\\\\\\\\.\\\\pipe\\\\codex-open-'+process.argv[1]);s.on('error',()=>{s.destroy();setTimeout(connect,25)});s.on('data',d=>{if(d.toString().startsWith('READY'))process.stdout.write('ready\\n')})}connect();";
  const parent = spawn(process.execPath, ['-e', script, token], {windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
  t.after(() => parent.kill());
  const child = spawn(path.resolve('bin/codex-interactive-opener.exe'), [token, String(parent.pid), '15'], {windowsHide: true, stdio: 'ignore'});
  const exited = once(child, 'exit'); t.after(() => child.kill());
  assert.match((await once(parent.stdout, 'data'))[0].toString(), /ready/);
  parent.kill(); assert.equal((await exited)[0], 0);
});
