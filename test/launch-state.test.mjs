import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readLastTask, saveLastTask} from '../src/launch-state.mjs';
import {GPU_THREAD} from '../src/guard-policy.mjs';
test('last selection stores only a validated ID and can be replaced atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-launch-test-')); t.after(() => fs.rmSync(dir, {recursive: true}));
  const file = path.join(dir, 'last.json'); assert.equal(readLastTask(file), null);
  saveLastTask(file, GPU_THREAD); assert.equal(readLastTask(file), GPU_THREAD);
  const other = '714adca2-1120-4134-83ad-82c84799ea63'; saveLastTask(file, other); assert.equal(readLastTask(file), other);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file))), ['version', 'threadId', 'updatedAt']);
  assert.deepEqual(fs.readdirSync(dir), ['last.json']);
  assert.throws(() => saveLastTask(file, '../invalid')); assert.equal(readLastTask(file), other);
});
test('corrupt, future-version and oversized launch files are ignored', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-launch-test-')); t.after(() => fs.rmSync(dir, {recursive: true}));
  const file = path.join(dir, 'last.json');
  for (const value of ['{', JSON.stringify({version: 2, threadId: GPU_THREAD}), ' '.repeat(1025)]) {
    fs.writeFileSync(file, value); assert.equal(readLastTask(file), null);
  }
});
