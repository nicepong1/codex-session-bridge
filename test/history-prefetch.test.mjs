import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HistoryPrefetch} from '../src/history-prefetch.mjs';
import {storedHistoryPreview} from '../src/stored-history-preview.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {TESTED_APP_VERSION} from '../src/installed.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const thread = (taskId = id, updatedAt = 10) => ({id: taskId, sessionId: taskId, name: '저장된 대화', updatedAt, createdAt: 1,
  cwd: 'C:\\GPU', path: 'private-rollout', status: {type: 'active'}, turns: [{id: 'turn-1', status: 'completed', startedAt: 2,
    completedAt: 3, items: [{type: 'userMessage', id: 'u1', content: [{type: 'text', text: '질문'}]},
      {type: 'agentMessage', id: 'a1', text: '원래 답변'}, {type: 'commandExecution', id: 'c1', command: 'existing command', status: 'completed'}]}]});
const cacheFor = options => new HistoryPrefetch({autoStart: false, fetch: async taskId => storedHistoryPreview(thread(taskId), taskId), ...options});

test('stored history preserves text, tools, order and identity without copying live authority', () => {
  const source = thread(), preview = storedHistoryPreview(source, id), state = preview.state;
  assert.deepEqual(state.turns[0].items, source.turns[0].items);
  assert.equal(state.turns[0].params.input[0].text, '질문'); assert.equal(state.turns[0].turnStartedAtMs, 2000);
  assert.equal(state.sessionId, id); assert.equal(state.rolloutPath, ''); assert.deepEqual(state.requests, []);
  assert.deepEqual(state.threadRuntimeStatus, {type: 'notLoaded'}); assert.equal(state.resumeState, 'resuming');
  assert.deepEqual(state.turns[0].params.sandboxPolicy, {type: 'readOnly'});
  state.turns[0].items[1].text = 'changed'; assert.equal(source.turns[0].items[1].text, '원래 답변');
});

test('preview keeps the newest twenty turns and does not claim complete older history', () => {
  const source = thread(); source.turns = Array.from({length: 24}, (_, i) => ({...source.turns[0], id: 'turn-' + i}));
  const preview = storedHistoryPreview(source, id);
  assert.equal(preview.state.turns.length, 20); assert.equal(preview.state.turns[0].turnId, 'turn-4');
  assert.equal(preview.state.turns.at(-1).turnId, 'turn-23');
  assert.equal(preview.state.turnsPagination.hasLoadedOldest, false);
  assert.equal(preview.state.turnsPagination.olderCursor, null);
});

test('bad identities, ephemeral histories, duplicate turn IDs and oversized previews are rejected', () => {
  for (const source of [{...thread(), id: randomUUID()}, {...thread(), sessionId: randomUUID()}, {...thread(), ephemeral: true}, {...thread(), turns: null}])
    assert.throws(() => storedHistoryPreview(source, id), /Invalid/);
  const duplicate = thread(); duplicate.turns.push(duplicate.turns[0]);
  assert.throws(() => storedHistoryPreview(duplicate, id), /Duplicate/);
  assert.throws(() => storedHistoryPreview(thread(), id, {maxBytes: 50}), /size limit/);
});

test('a displayed preview never grants an owner or live input and cannot replace a verified snapshot', () => {
  const policy = new NativeViewPolicy(id); policy.acceptPreview(storedHistoryPreview(thread(), id));
  assert.equal(policy.online, false); assert.equal(policy.owner, null); assert.equal(policy.sourceRevision, -1);
  const request = {method: 'thread-owner-discovery', version: 1, params: {hostId: 'local', conversationId: id}};
  assert.equal(policy.handleRequest(request, 'bridge').resultType, 'error');
  const revision = policy.revision;
  policy.acceptSnapshot({type: 'snapshot', appVersion: TESTED_APP_VERSION, threadId: id, revision: 0,
    ownerClientId: 'real-gpu-owner', state: {id, sessionId: id, turns: [{turnId: 'live'}]}});
  assert.equal(policy.online, true); assert.equal(policy.preview, false); assert.ok(policy.revision > revision);
  assert.equal(policy.acceptPreview(storedHistoryPreview(thread(), id)), false);
  policy.disconnect(); assert.equal(policy.acceptPreview(storedHistoryPreview(thread(), id)), false);
});

test('prefetch is sequential, yields to foreground work and never fetches an invalid or temporary task', async () => {
  let allowed = false, finish, calls = 0;
  const cache = cacheFor({canFetch: () => allowed, fetch: taskId => { calls++; return new Promise(resolve => { finish = () => resolve(storedHistoryPreview(thread(taskId), taskId)); }); }});
  cache.enqueue([thread(), thread(), {...thread(randomUUID()), ephemeral: true}, {id: 'wrong'}]);
  await cache.pump(); assert.equal(calls, 0); allowed = true;
  const pending = cache.pump(); await cache.pump(); assert.equal(calls, 1);
  finish(); await pending; assert.equal(cache.entries.size, 1); assert.equal(cache.queue.size, 0);
  const a = cache.get(id); a.state.title = 'changed'; assert.equal(cache.get(id).state.title, '저장된 대화'); cache.close();
});

test('default preview work is bounded to the newest catalog window and follows a changed top item', async () => {
  const cache = cacheFor({fetch: async taskId => storedHistoryPreview(thread(taskId), taskId)});
  assert.equal(cache.maxEntries, 32); assert.equal(cache.maxBytes, 32 * 1024 * 1024);
  const rows = Array.from({length: 40}, (_, i) => thread(randomUUID(), 100 - i));
  cache.replace(rows); assert.equal(cache.versions.size, 40); assert.equal(cache.queue.size, 32);
  assert.deepEqual([...cache.queue.keys()], rows.slice(0, 32).map(row => row.id));
  cache.queue.clear(); cache.enqueue(rows.slice(32)); assert.equal(cache.queue.size, 0);
  const newest = thread(randomUUID(), 200); cache.replace([newest, ...rows]);
  assert.equal([...cache.queue.keys()][0], newest.id); assert.equal(cache.queue.has(rows[31].id), false);
  cache.close();
});

test('a selected task can load a safe preview while background reads are paused', async () => {
  let calls = 0;
  const cache = cacheFor({canFetch: () => false, fetch: async taskId => { calls++; return storedHistoryPreview(thread(taskId), taskId); }});
  cache.enqueue([thread()]); await cache.pump(); assert.equal(calls, 0);
  const preview = await cache.load(id); assert.equal(calls, 1); assert.equal(preview.threadId, id);
  assert.equal(cache.get(id).state.resumeState, 'resuming'); cache.close();
});

test('catalog changes and connection loss cannot publish an outdated in-flight preview', async () => {
  let finish; const cache = cacheFor({fetch: taskId => new Promise(resolve => { finish = () => resolve(storedHistoryPreview(thread(taskId), taskId)); })});
  cache.enqueue([thread()]); const first = cache.pump(); cache.enqueue([thread(id, 20)]); finish(); await first;
  assert.equal(cache.get(id), null); assert.equal(cache.queue.size, 1);
  const next = cache.pump(); cache.clear(); finish(); await next; assert.equal(cache.entries.size, 0); cache.close();
});

test('age, count and byte limits bound previews, and failures do not retry in a tight loop', async () => {
  let now = 0, calls = 0;
  const previewBytes = Buffer.byteLength(JSON.stringify(storedHistoryPreview(thread(), id)));
  const cache = cacheFor({now: () => now, ttlMs: 100, maxEntries: 2, maxBytes: previewBytes + 100,
    fetch: async taskId => { calls++; return storedHistoryPreview(thread(taskId), taskId); }});
  const b = randomUUID(); cache.enqueue([thread(), thread(b), thread(randomUUID())]);
  await cache.pump(); await cache.pump(); assert.equal(calls, 2); assert.ok(cache.bytes <= cache.maxBytes); assert.equal(cache.entries.size, 1);
  now = 100; assert.equal(cache.get(b), null); cache.close();
  const failed = cacheFor({now: () => now, fetch: async () => { calls++; throw new Error('not available'); }});
  failed.enqueue([thread()]); await failed.pump(); failed.enqueue([thread()]); await failed.pump(); assert.equal(calls, 3); failed.close();
});

test('oversized previews are not retried by every catalog scan until that task changes', async () => {
  let now = 0, calls = 0;
  const cache = cacheFor({now: () => now, fetch: async () => { calls++; throw new Error('GPU history preview exceeds size limit'); }});
  cache.replace([thread()]); await cache.pump(); assert.equal(calls, 1);
  now = 600000; cache.replace([thread()]); await cache.pump(); assert.equal(calls, 1);
  assert.equal(await cache.load(id), null); assert.equal(calls, 1);
  cache.replace([thread(id, 11)]); await cache.pump(); assert.equal(calls, 2); cache.close(); assert.equal(cache.failures.size, 0);
});

test('a loaded preview refreshes after expiration without user clicks; close stops late delivery', async () => {
  let now = 0, calls = 0, finish;
  const cache = cacheFor({now: () => now, ttlMs: 100, fetch: async taskId => { calls++; return storedHistoryPreview(thread(taskId), taskId); }});
  cache.enqueue([thread()]); await cache.pump(); now = 100; await cache.pump(); assert.equal(calls, 2);
  cache.fetch = taskId => new Promise(resolve => { finish = () => resolve(storedHistoryPreview(thread(taskId), taskId)); });
  now = 200; const pending = cache.pump(); cache.close(); finish(); await pending; assert.equal(cache.entries.size, 0);
});

test('main connection loss removes old bodies and queues the known catalog for fresh reads after recovery', async () => {
  let calls = 0;
  const cache = cacheFor({fetch: async taskId => { calls++; return storedHistoryPreview(thread(taskId), taskId); }});
  cache.enqueue([thread()]); await cache.pump(); assert.ok(cache.get(id));
  cache.invalidate(); assert.equal(cache.get(id), null); assert.equal(cache.queue.size, 1);
  await cache.pump(); assert.ok(cache.get(id)); assert.equal(calls, 2); cache.close();
});
