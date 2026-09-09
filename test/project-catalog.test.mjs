import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectCatalog, projectDisplayState, orderProjectsByActivity} from '../src/project-catalog.mjs';
const first = {id:'00000000-0000-4000-8000-000000000014', name:'inventory-demo', roots:[{path:'C:\\Projects\\inventory-demo'}], createdAt:2,updatedAt:3,position:1};
const second = {...first,id:'00000000-0000-4000-8000-000000000015', name:'notes-demo',position:0,roots:[{path:'C:\\projects\\notes-demo'}]};
test('GPU project pages preserve IDs, paths and order in a separate display state',async()=>{
  const calls=[];
  const projects=await readProjectCatalog(async(method,params)=>{
    calls.push({method,params});
    return params.cursor ? {data:[second],nextCursor:null} : {data:[{...first,metadata:{unrelated:'do not copy'}}],nextCursor:'next'};
  });
  const state=projectDisplayState(projects);
  assert.deepEqual(calls.map(c=>c.method),['project/list','project/list']);
  assert.deepEqual(state['project-order'],[second.id,first.id]);
  assert.equal(state['local-projects'][first.id].createdAt,2000);
  assert.deepEqual(state['local-projects'][first.id].rootPaths,first.roots.map(r=>r.path));
  assert.deepEqual(Object.keys(state),['local-projects','project-order','electron-persisted-atom-state']);
  assert.equal(Object.hasOwn(state['local-projects'][first.id],'metadata'),false);
});
test('empty GPU projects produce an empty display state without creating a project',async()=>{
  const result=await readProjectCatalog(async()=>({data:[],nextCursor:null}));
  assert.deepEqual(projectDisplayState(result),{'local-projects':{},'project-order':[],'electron-persisted-atom-state':{}});
});
test('malformed metadata and looping or duplicate pages cannot populate the profile',async()=>{
  for(const row of [{...first,id:'../wrong'},{...first,roots:[{path:'relative'}]},{...first,name:{}},{...first,updatedAt:NaN}])
    await assert.rejects(readProjectCatalog(async()=>({data:[row],nextCursor:null})),/metadata/);
  await assert.rejects(readProjectCatalog(async()=>({data:[first,first],nextCursor:null})),/metadata/);
  await assert.rejects(readProjectCatalog(async()=>({data:[],nextCursor:'loop'})),/cursor/);
});

test('project recency follows tasks across Windows path casing and equal-second ties without removing older projects',async()=>{
  const catalog=await readProjectCatalog(async()=>({data:[{...first,position:0},{...second,position:1}],nextCursor:null}));
  const original=catalog.map(p=>p.id);
  const sorted=orderProjectsByActivity(catalog,[
    {id:'00000000-0000-4000-8000-000000000010',cwd:'c:/projects/inventory-demo/',updatedAt:5},
    {id:'00000000-0000-4000-8000-000000000012',cwd:'C:/PROJECTS/NOTES-DEMO',updatedAt:5}]);
  assert.deepEqual(sorted.map(p=>p.id),[second.id,first.id]);
  assert.deepEqual(catalog.map(p=>p.id),original);
  assert.deepEqual(orderProjectsByActivity(catalog,[]).map(p=>p.id),original);
  assert.equal(orderProjectsByActivity(catalog,[{id:'a',projectId:second.id,cwd:'unrelated',updatedAt:6}])[0].id,second.id);
});
