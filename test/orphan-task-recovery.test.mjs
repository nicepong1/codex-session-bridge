import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {recentRolloutIds, recentRollouts, recoverMissingAgentThreads} from '../src/orphan-task-recovery.mjs';

function rollout(root, id, age = 0) {
  const directory = path.join(root, '2026', '09', '21'); fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, `rollout-2026-09-21T10-00-00-${id}.jsonl`); fs.writeFileSync(file, 'not read');
  const time = new Date(Date.now() - age); fs.utimesSync(file, time, time); return file;
}

test('recent rollout discovery uses bounded file metadata and newest order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-orphans-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const old = randomUUID(), recent = randomUUID(); rollout(root, old, 5000); rollout(root, recent, 10);
  fs.writeFileSync(path.join(root, '2026', '09', '21', 'ignore.txt'), 'ignored');
  assert.deepEqual(recentRolloutIds(root, {maxFiles: 1}), [recent]);
  assert.equal(recentRollouts(root, {maxFiles: 1})[0].id, recent);
  assert.ok(Number.isFinite(recentRollouts(root, {maxFiles: 1})[0].mtimeMs));
});

test('unscoped recent page recovers active root threads and uses observed activity order', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-orphans-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const visible = randomUUID(), recovered = randomUUID(), normal = randomUUID(), archived = randomUUID(), internal = randomUUID();
  const files = new Map([[visible, rollout(root, visible, 40000)], [recovered, rollout(root, recovered)],
    [normal, rollout(root, normal, 10000)], [archived, rollout(root, archived, 20000)], [internal, rollout(root, internal, 30000)]]);
  const readThread = async id => ({thread: {id, name: id, updatedAt: 20, source: id === internal ? 'exec' : 'vscode',
    threadSource: id === recovered ? 'agent_created_thread' : 'user', ephemeral: false,
    path: id === archived ? path.join(root, '..', 'archived_sessions', id + '.jsonl') : files.get(id)}});
  const page = {data: [{id: visible, updatedAt: 1}], nextCursor: 'next'};
  const result = await recoverMissingAgentThreads({page, params: {archived: false}, sessionsRoot: root, readThread});
  assert.deepEqual(result.data.map(row => row.id), [recovered, normal, visible]);
  assert.ok(result.data[0].updatedAt >= result.data[1].updatedAt);
  assert.ok(result.data[2].updatedAt > 1);
  assert.equal(result.nextCursor, 'next');
  assert.equal((await recoverMissingAgentThreads({page, params: {cursor: 'next'}, sessionsRoot: root, readThread})), page);
  assert.equal((await recoverMissingAgentThreads({page, params: {projectId: randomUUID()}, sessionsRoot: root, readThread})), page);
});
