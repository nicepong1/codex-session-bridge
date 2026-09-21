import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionFailureClassifier,connectionFailureKind} from '../src/connection-notice.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {turnsOf} from '../src/state.mjs';

test('startup version failures survive split stderr and later generic disconnects without exposing diagnostics',()=>{
  for(const [message,expected] of [
    ['Unsupported host Codex build; see docs/COMPATIBILITY.md','unsupported-host-app'],
    ['Compatible official Codex CLI cache not found. Open the host Codex app.','unsupported-host-cli']]) {
    const f=new ConnectionFailureClassifier();
    for(const c of message)f.accept(c);
    f.accept('\nprivate-path private-key connection closed');
    assert.equal(f.kind,expected);assert.deepEqual(Object.keys(f),['kind']);
    assert.equal(connectionFailureKind(`SSH closed (1, ${f.kind})`),expected);
  }
  const f=new ConnectionFailureClassifier();f.accept('x'.repeat(4096));
  assert.equal(f.accept('Permission denied'),'authentication-or-access');
  assert.equal(connectionFailureKind('unknown private diagnostic'),'unknown');
});

for(const canonical of [false,true])test(`disconnected ${canonical?'canonical':'legacy'} view warns once and fresh GPU state clears it`,()=>{
  const id='00000000-0000-4000-8000-000000000001',turn={turnId:'turn',status:'completed',items:[{type:'agentMessage',id:'original',text:'GPU content'}]};
  const history=canonical?{turnHistory:{kind:'canonical',history:{islands:[{entries:[{value:'turn'}]}],entitiesByKey:{turn}}}}:{turns:[turn]};
  const original={type:'snapshot',appVersion:'26.908.4834.0',threadId:id,ownerClientId:'gpu-owner',revision:8,
    state:{id,sessionId:id,resumeState:'resumed',requests:[{id:1,method:'item/commandExecution/requestApproval'}],...history}};
  const policy=new NativeViewPolicy(id);policy.acceptSnapshot(original);
  policy.disconnect('SSH closed (1, unsupported-host-app) private-host');
  for(let i=0;i<2;i++){
    const displayed=policy.snapshot('bridge',['laptop']).params.change.conversationState;
    const items=turnsOf(displayed).at(-1).items;
    assert.equal(items.length,2);assert.match(items.at(-1).text,/마지막으로 받은 내용/);
    assert.match(items.at(-1).text,/호환되는 릴리스/);assert.doesNotMatch(items.at(-1).text,/private-host/);
    assert.deepEqual(displayed.requests,original.state.requests);
  }
  assert.equal(turnsOf(policy.state).at(-1).items.length,1);assert.equal(turn.items.length,1);
  assert.equal(policy.online,false);
  const fresh=structuredClone(original);fresh.revision=9;turnsOf(fresh.state).at(-1).items.push({id:'latest',type:'agentMessage',text:'Latest GPU work'});
  policy.acceptSnapshot(fresh,{freshObservation:true});
  const displayed=policy.snapshot('bridge',['laptop']).params.change.conversationState;
  assert.equal(policy.online,true);assert.equal(policy.connectionFailure,null);
  assert.deepEqual(turnsOf(displayed).at(-1).items,turnsOf(fresh.state).at(-1).items);
});
