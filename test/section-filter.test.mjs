import test from 'node:test';
import assert from 'node:assert/strict';
import {hubReadRoute,desktopHubRoute} from '../src/guard-policy.mjs';
const pinned='01984de2-8f74-7c91-a3b2-5c5e937cf318';

test('pinned section membership and order survive both laptop and GPU read guards',()=>{
  const laptop=desktopHubRoute('thread/list',{sectionId:pinned,sortKey:'section_position',limit:100,cursor:'next'});
  const gpu=hubReadRoute(laptop.method,laptop.params);
  assert.equal(gpu.params.sectionId,pinned);
  assert.equal(gpu.params.sortKey,'section_position');
  assert.equal(gpu.params.cursor,'next');
  assert.equal(gpu.params.useStateDbOnly,true);
});
test('recent ordering and explicit sort directions survive the read facade',()=>{
  assert.equal(hubReadRoute('thread/list',{}).params.sortKey,'updated_at');
  const requested=hubReadRoute('thread/list',{sortKey:'created_at',sortDirection:'asc'});
  assert.equal(requested.params.sortKey,'created_at');
  assert.equal(requested.params.sortDirection,'asc');
  assert.equal(Object.hasOwn(requested.params,'sectionId'),false);
  assert.equal(requested.params.useStateDbOnly,false);
});
test('malformed section and ordering filters are refused instead of returning unrelated tasks',()=>{
  for(const params of [{sectionId:'../all'},{sectionId:{}},{sortKey:'unknown'},{sortDirection:'sideways'}]){
    assert.throws(()=>hubReadRoute('thread/list',params));
  }
});
