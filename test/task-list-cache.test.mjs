import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskListCache} from '../src/task-list-cache.mjs';
const page = id => ({data: [{id}], nextCursor: null});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a repeated page returns immediately while one background refresh runs, then exposes new tasks', async () => {
  let now = 0, calls = 0, finish;
  const updates = [], cache = new TaskListCache({now: () => now, onUpdate: value => updates.push(value)});
  await cache.read({}, async () => { calls++; return page('old'); }); now = 2100;
  const fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = await cache.read({}, fetch), b = await cache.read({limit: 50, cursor: null, archived: false}, fetch);
  assert.equal(a.data[0].id, 'old'); assert.equal(b.data[0].id, 'old'); assert.equal(calls, 2);
  a.data[0].id = 'tampered'; finish(page('new')); await flush();
  const c = await cache.read({}, () => { throw new Error('no extra fetch'); });
  assert.equal(c.data[0].id, 'new'); assert.equal(updates.at(-1).data[0].id, 'new');
});

test('first requests merge; archive, project, cursor, page size, section and order never share pages', async () => {
  const cache = new TaskListCache(); let calls = 0, finish;
  const fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = cache.read({}, fetch), b = cache.read({}, fetch); await flush();
  assert.equal(calls, 1); finish(page('first')); await Promise.all([a, b]);
  for (const params of [{archived: true}, {cwd: 'C:\\project'}, {cursor: 'page2'}, {limit: 100},
    {sectionId: '01984de2-8f74-7c91-a3b2-5c5e937cf318', sortKey: 'section_position'},
    {sortKey: 'created_at'}, {sortDirection: 'asc'}]) {
    const result = await cache.read(params, async normalized => { calls++; return page(JSON.stringify(normalized)); });
    assert.notEqual(result.data[0].id, 'first');
  }
  assert.equal(calls, 8);
  await assert.rejects(cache.read({limit: -1}, fetch), /denied/);
});

test('the hard deadline waits for current data and failures cannot keep old pages alive forever', async () => {
  let now = 0, finish, calls = 0;
  const cache = new TaskListCache({now: () => now});
  await cache.read({}, async () => page('old')); now = 2100;
  const failed = async () => { calls++; throw new Error('unavailable'); };
  assert.equal((await cache.read({}, failed)).data[0].id, 'old'); await flush();
  await cache.read({}, failed); assert.equal(calls, 1); // backoff
  now = 30000;
  let settled = false;
  const pending = cache.read({}, () => new Promise(r => { finish = r; })).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false); finish(page('fresh'));
  assert.equal((await pending).data[0].id, 'fresh'); now = 60000;
  await assert.rejects(cache.read({}, failed), /unavailable/);
});

test('connection changes reject pending pages and prevent background results from changing the catalog', async () => {
  let finish; const updates = [], cache = new TaskListCache({onUpdate: result => updates.push(result)});
  const pending = cache.read({}, () => new Promise(r => { finish = r; })); await flush();
  cache.clear(); await cache.read({}, async () => page('replacement'));
  finish(page('old-connection')); await assert.rejects(pending, /connection changed/);
  assert.deepEqual(updates.map(p => p.data[0].id), ['replacement']);
  assert.equal((await cache.read({}, () => { throw new Error('cached'); })).data[0].id, 'replacement');
});

test('large pages and entry counts stay bounded and malformed results are not saved', async () => {
  const cache = new TaskListCache({maxEntries: 2, maxBytes: 100});
  await assert.rejects(cache.read({}, async () => ({data: 'invalid'})), /Invalid/);
  for (const cursor of ['a', 'b', 'c']) await cache.read({cursor}, async () => page(cursor));
  assert.equal(cache.entries.size, 2);
  let calls = 0;
  const huge = async () => { calls++; return page('x'.repeat(200)); };
  await cache.read({}, huge); await cache.read({}, huge); assert.equal(calls, 2);
  assert.ok(cache.entries.size <= 2);
});
