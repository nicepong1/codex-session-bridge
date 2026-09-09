import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {startGuardServer} from '../src/guard-server.mjs';
import {RpcPeer} from '../src/json-rpc-peer.mjs';
import {GPU_THREAD} from '../src/guard-policy.mjs';

const exe = path.resolve('bin/codex-gpu-guard.exe');
test('compiled stdio transport preserves Unicode, rejects execution and exits on server loss', {skip: process.platform !== 'win32' || !fs.existsSync(exe)}, async () => {
  const seen = [];
  const server = await startGuardServer({read: async method => { seen.push(method); return {text: 'GPU 응답 😀'}; }});
  const child = spawn(exe, ['app-server'], {windowsHide: true, env: {...process.env, CODEX_GPU_GUARD_URL: server.url}, stdio: ['pipe', 'pipe', 'pipe']});
  const peer = new RpcPeer(message => child.stdin.write(JSON.stringify(message) + '\n'));
  const decoder = new StringDecoder('utf8'); let buffer = '';
  child.stdout.on('data', chunk => { buffer += decoder.write(chunk); let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); peer.accept(JSON.parse(line)); } });
  child.on('error', () => peer.close()); child.stdin.on('error', () => {});
  const exit = once(child, 'exit');
  try {
    assert.equal((await peer.request('initialize', {})).text, 'GPU 응답 😀');
    assert.equal((await peer.request('thread/read', {threadId: GPU_THREAD})).text, 'GPU 응답 😀');
    await assert.rejects(peer.request('turn/start', {threadId: GPU_THREAD}), /gpu-guard-denied/);
    assert.deepEqual(seen, ['initialize', 'thread/read']);
    await server.close();
    let timeout;
    try { await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Transport did not exit on connection loss')), 5000); })]); }
    finally { clearTimeout(timeout); }
  } finally { peer.close(); child.kill(); if (child.exitCode == null) await server.close().catch(() => {}); }
});
