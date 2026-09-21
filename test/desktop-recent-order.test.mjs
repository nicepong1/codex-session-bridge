import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopRecentOrder} from '../src/desktop-recent-order.mjs';
const ids = ['00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010'];
const rows = ids.map((id,i) => ({id, title: i < 2 ? 'Mindmap' : 'Samwoo-ERP', updatedAt: 1788776111,
  recencyAt: 300 - i * 100, createdAt: 1788776111}));
test('desktop recent sorting preserves the GPU desktop last-viewed order across pages', () => {
  const order = new DesktopRecentOrder(); order.replace([...rows].reverse());
  const source = rows.map((r,i) => ({...r, recencyAt: 100 + i}));
  const projected = source.map(t => order.response('thread/list', {data: [t], nextCursor: 'next'}).data[0]);
  projected.reverse().sort((a,b) => b.recencyAt - a.recencyAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  assert.deepEqual(projected.map(t => t.id), ids);
  assert.deepEqual(source.map(t => t.recencyAt), [100,101,102]);
  assert.deepEqual(projected.map(t => Math.floor(t.recencyAt)), [300,200,102]);
  for (const row of projected) { assert.equal(row.createdAt,1788776111); assert.equal(row.updatedAt,1788776111); }
});
test('individual hydration retains file-list metadata without touching the actual conversation', () => {
  const order = new DesktopRecentOrder(); order.replace(rows);
  const thread = {id: ids[0], updatedAt: 100, createdAt: 50, recencyAt: 80, turns: [{turnId: 'actual', startedAt: 70}]};
  const response = order.response('thread/read', {thread});
  assert.equal(response.thread.updatedAt,1788776111);
  assert.equal(response.thread.turns,thread.turns);
  assert.equal(thread.updatedAt,100);
  const newer = order.project({...thread, updatedAt:1788776200});
  assert.equal(newer.updatedAt,1788776200); assert.equal(Math.floor(newer.recencyAt),300);
  const imported = order.project({...thread, updatedAt:1788779999, recencyAt:80});
  assert.equal(imported.updatedAt,1788779999); assert.equal(Math.floor(imported.recencyAt),300);
});
test('catalog replacement, unknown tasks and reset cannot retain removed ranks', () => {
  const order = new DesktopRecentOrder(); order.replace(rows);
  order.replace(rows.slice(1));
  const missing = {id: ids[0], updatedAt: 1};
  assert.equal(order.project(missing),missing);
  order.clear(); assert.equal(order.ready,false); assert.equal(order.rows.size,0);
  assert.throws(() => order.replace(Array(5001).fill(rows[0])));
});
