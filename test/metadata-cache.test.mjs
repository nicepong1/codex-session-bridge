import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataReadCache} from '../src/metadata-read-cache.mjs';

test('model list requests share work, return isolated objects and expire without extending freshness', async () => {
  let now = 0, calls = 0, resolve;
  const cache = new MetadataReadCache({now: () => now, ttlMs: 30});
  const fetch = () => { calls++; return new Promise(r => { resolve = r; }); };
  const a = cache.read('model/list', {limit: 5}, fetch), b = cache.read('model/list', {limit: 5}, fetch);
  await Promise.resolve(); assert.equal(calls, 1); resolve({data: [{id: 'first'}]});
  const results = await Promise.all([a, b]); results[0].data[0].id = 'modified';
  assert.equal(results[1].data[0].id, 'first');
  now = 29; assert.equal((await cache.read('model/list', {limit: 5}, fetch)).data[0].id, 'first');
  now = 30;
  const next = cache.read('model/list', {limit: 5}, fetch);
  await Promise.resolve(); assert.equal(calls, 2); resolve({data: []}); await next;
});

test('providers, filters and pagination remain separate, and nonmetadata never uses cache', async () => {
  const cache = new MetadataReadCache(); let calls = 0;
  const fetch = async () => ({value: ++calls});
  for (const params of [{limit: 5}, {limit: 6}, {limit: 5, cursor: 'next'}, {provider: 'other'}]) await cache.read('model/list', params, fetch);
  assert.equal(calls, 4);
  for (const method of ['account/read', 'config/read', 'permissionProfile/list', 'thread/read', 'account/rateLimits/read', 'turn/start']) {
    const a = await cache.read(method, {}, fetch), b = await cache.read(method, {}, fetch);
    assert.notEqual(a.value, b.value);
  }
});

test('connection invalidation rejects late metadata and does not evict a replacement request', async () => {
  const cache = new MetadataReadCache(); let resolveOld;
  const old = cache.read('model/list', {}, () => new Promise(r => { resolveOld = r; }));
  await Promise.resolve(); cache.clear();
  assert.deepEqual(await cache.read('model/list', {}, async () => ({version: 2})), {version: 2});
  resolveOld({version: 1}); await assert.rejects(old, /connection changed/);
  assert.deepEqual(await cache.read('model/list', {}, () => { throw new Error('should stay cached'); }), {version: 2});
});

test('failed metadata is retried on a later explicit request and entry count is bounded', async () => {
  const cache = new MetadataReadCache({maxEntries: 2});
  await assert.rejects(cache.read('model/list', {}, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(cache.entries.size, 0);
  await cache.read('model/list', {}, async () => 1);
  await cache.read('model/list', {cursor: 'a'}, async () => 2);
  await cache.read('model/list', {cursor: 'b'}, async () => 3);
  assert.equal(cache.entries.size, 2);
});
