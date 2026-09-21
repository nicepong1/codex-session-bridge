import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogPoller} from '../src/catalog-poller.mjs';
import {GPU_THREAD} from '../src/guard-policy.mjs';
const other = '714adca2-1120-4134-83ad-82c84799ea63';
const row = (id, title = '작업', updatedAt = 1) => ({id, title, updatedAt, sessionId: id});
const page = tasks => ({tasks, nextCursor: null});

test('background catalog refresh defaults to a low duty cycle', t => {
  const poller = new CatalogPoller({autoStart: false, fetchPage: async () => page([])}); t.after(() => poller.close());
  assert.equal(poller.intervalMs, 30000);
});

test('metadata scan detects newly visible tasks and edits across pages without repeating unchanged events', async t => {
  let rows = [row(GPU_THREAD)], calls = 0;
  const poller = new CatalogPoller({autoStart: false, fetchPage: async ({cursor}) => {
    calls++; return cursor ? page(rows.slice(1)) : {tasks: rows.slice(0, 1), nextCursor: rows.length > 1 ? 'page-2' : null};
  }}); t.after(() => poller.close());
  const changes = []; poller.on('changes', value => changes.push(value));
  assert.equal((await poller.scan()).initial, true); assert.equal(changes.length, 0);
  rows.push(row(other, '새 작업')); await poller.scan();
  assert.deepEqual(changes[0].map(r => r.id), [other]);
  rows[0] = row(GPU_THREAD, '수정된 제목', 2); await poller.scan();
  assert.deepEqual(changes[1].map(r => r.title), ['수정된 제목']);
  await poller.scan(); assert.equal(changes.length, 2); assert.equal(calls, 7);
});

test('an incomplete or failed scan cannot replace the baseline or generate false changes', async t => {
  let fail = false;
  const poller = new CatalogPoller({autoStart: false, fetchPage: async ({cursor}) => {
    if (fail && cursor) throw new Error('offline');
    return cursor ? page([]) : {tasks: [row(GPU_THREAD, fail ? 'not committed' : 'original')], nextCursor: 'tail'};
  }}); t.after(() => poller.close());
  await poller.scan(); const baseline = new Map(poller.baseline); fail = true;
  await assert.rejects(poller.scan(), /offline/); assert.deepEqual(poller.baseline, baseline);
  assert.equal(poller.failures, 1); assert.ok(poller.nextAt > Date.now());
});

test('only one scan is active and late results from a disconnected generation are discarded', async t => {
  let finish;
  const poller = new CatalogPoller({autoStart: false, fetchPage: () => new Promise(resolve => { finish = resolve; })});
  t.after(() => poller.close());
  let published = 0; poller.on('rows', () => published++);
  const a = poller.scan(), b = poller.scan(); assert.equal(a, b);
  poller.invalidate(); finish(page([row(GPU_THREAD)]));
  await assert.rejects(a, /interrupted/); assert.equal(published, 0); assert.equal(poller.baseline, null); assert.equal(poller.nextAt, 0);
});

test('foreground work pauses paging; closed pollers and malformed rows never publish', async t => {
  let allowed = false, calls = 0;
  const poller = new CatalogPoller({autoStart: false, canRun: () => allowed, fetchPage: async () => { calls++; return page([row('../bad')]); }});
  t.after(() => poller.close()); assert.equal(await poller.scan(), null); assert.equal(calls, 0);
  allowed = true; await assert.rejects(poller.scan(), /Invalid catalog row/);
  poller.close(); assert.equal(await poller.scan(), null); assert.equal(calls, 1);
});

test('repeated cursors are rejected and scan size is bounded without declaring removals', async t => {
  const loop = new CatalogPoller({autoStart: false, fetchPage: async () => ({tasks: [row(GPU_THREAD)], nextCursor: 'same'})});
  t.after(() => loop.close()); await assert.rejects(loop.scan(), /cursor/);
  const limited = new CatalogPoller({autoStart: false, maxPages: 1, fetchPage: async () => ({tasks: [row(GPU_THREAD)], nextCursor: 'more'})});
  t.after(() => limited.close()); const result = await limited.scan();
  assert.equal(result.complete, false); assert.equal(result.pages, 1); assert.equal(limited.baseline.size, 1);
});

test('reconnection preserves the last baseline and discovers changes made while offline', async t => {
  let rows = [row(GPU_THREAD)];
  const poller = new CatalogPoller({autoStart: false, fetchPage: async () => page(rows)}); t.after(() => poller.close());
  await poller.scan(); poller.invalidate(); rows = [...rows, row(other)];
  const changed = []; poller.on('changes', value => changed.push(...value));
  await poller.scan(); assert.deepEqual(changed.map(r => r.id), [other]);
});
