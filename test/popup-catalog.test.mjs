import test from 'node:test';
import assert from 'node:assert/strict';
import {popupCapability,popupCapabilities,popupNoticeState} from '../src/popup-catalog.mjs';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {randomUUID} from 'node:crypto';

test('all installed request branches have a truthful route classification',()=>{
  for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'])
    assert.equal(popupCapability({method}).status,'supported');
  assert.equal(popupCapability({method:'item/plan/requestImplementation'}).status,'partial');
  for(const method of ['item/tool/requestOptionPicker','item/tool/requestSetupCodexContextPicker','future/unknown'])
    assert.equal(popupCapability({method}).status,'host-required');
  assert.equal(popupCapability({method:'item/tool/call',params:{tool:'request_onboarding_input'}}).status,'supported');
  assert.equal(popupCapability({method:'item/tool/call',params:{tool:'setup_codex_step'}}).status,'host-required');
  assert.equal(popupCapability({method:'mcpServer/elicitation/request',params:{mode:'form',requestedSchema:{type:'object',properties:{}}}}).status,'supported');
});

test('guidance is view-only, leaves requests intact, contains no private payload and disappears on resolution',()=>{
  const id=randomUUID(),state={id,sessionId:id,turns:[{turnId:randomUUID(),items:[{id:'original',type:'agentMessage',text:'GPU response'}]}],
    requests:[{id:42,method:'unknown/secret-value',params:{credential:'secret-value',question:'private-question'}}]};
  const original=structuredClone(state),policy=new NativeViewPolicy(id);policy.state=state;policy.followers.add('laptop');
  const view=policy.snapshot('bridge').params.change.conversationState;
  assert.deepEqual(state,original);assert.deepEqual(view.requests,state.requests);assert.equal(view.turns[0].items.length,2);
  assert.match(view.turns[0].items[1].text,/Session Bridge/);assert.doesNotMatch(view.turns[0].items[1].text,/secret-value|private-question/);
  assert.doesNotMatch(JSON.stringify(popupCapabilities(state)),/secret-value|private-question/);
  state.requests=[];assert.equal(popupNoticeState(state),state);assert.equal(policy.snapshot('bridge').params.change.conversationState.turns[0].items.length,1);
});

test('malformed schemas remain host-only without breaking snapshot publication',()=>{
  assert.equal(popupCapability({method:'mcpServer/elicitation/request',params:{mode:'form',requestedSchema:{oneOf:{}}}}).status,'host-required');
  assert.doesNotThrow(()=>popupCapability(null));
});
