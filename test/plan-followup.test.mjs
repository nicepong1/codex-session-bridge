import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NativeViewPolicy} from '../src/native-view-policy.mjs';
import {PLAN_PREFIX,planFollowupFromFollower,planTurnOverrides} from '../src/plan-followup.mjs';

function fixture(){
  const id=randomUUID(),turnId=randomUUID(),owner=randomUUID(),policy=new NativeViewPolicy(id);
  const request={id:`implement-plan:${turnId}`,method:'item/plan/requestImplementation',params:{threadId:id,turnId,planContent:'Review then implement.'}};
  const state={id,sessionId:id,requests:[request],turns:[{turnId,status:'completed',items:[]}],threadRuntimeStatus:{type:'idle'},
    latestCollaborationMode:{mode:'plan',settings:{model:'example',reasoning_effort:'medium',developer_instructions:'GPU instructions'}}};
  Object.assign(policy,{state,owner,online:true});policy.followers.add('laptop');
  const message={sourceClientId:'laptop',params:{conversationId:id,turnStart:{request:{collaborationMode:{mode:'default',settings:{developer_instructions:'ignored'}}}}}};
  const text=PLAN_PREFIX+request.params.planContent,session={ownerClientId:owner,state};
  return {policy,message,text,session,request};
}

test('native plan implementation changes mode only for the exact completed GPU plan',()=>{
  const f=fixture(),before=structuredClone(f.session.state),plan=planFollowupFromFollower(f.message,f.policy,f.text);
  const overrides=planTurnOverrides(f.session,plan,f.text,{model:'chosen',effort:'high'});
  assert.equal(overrides.collaborationMode.mode,'default');assert.equal(overrides.collaborationMode.settings.model,'chosen');
  assert.equal(overrides.collaborationMode.settings.developer_instructions,'GPU instructions');
  assert.deepEqual(f.session.state,before);
  f.request.params.planContent='Changed';assert.throws(()=>planTurnOverrides(f.session,plan,f.text,{}));
});

test('stale plans, another owner, duplicate requests, edited plans and active turns cannot execute',()=>{
  for(const mutate of [f=>{f.policy.followers.clear()},f=>{f.policy.online=false},f=>{f.policy.preview=true},
    f=>{f.request.params.threadId=randomUUID()},f=>{f.request.id='another'},f=>{f.session.state.requests.push(f.request)},
    f=>{f.session.state.turns[0].status='inProgress'},f=>{f.session.state.threadRuntimeStatus.type='active'},
    f=>{f.session.state.turns.push({turnId:randomUUID(),status:'completed'})},f=>{f.text+='edited'}]){
    const f=fixture();mutate(f);assert.throws(()=>planFollowupFromFollower(f.message,f.policy,f.text));
  }
  const f=fixture(),plan=planFollowupFromFollower(f.message,f.policy,f.text);
  assert.throws(()=>planTurnOverrides({...f.session,ownerClientId:randomUUID()},plan,f.text,{}));
});

test('ordinary feedback stays an ordinary message and cannot silently select another mode',()=>{
  const f=fixture();f.message.params.turnStart.request.collaborationMode.mode='plan';
  assert.equal(planFollowupFromFollower(f.message,f.policy,'Please revise the plan'),null);
  f.message.params.turnStart.request.collaborationMode.mode='default';
  assert.throws(()=>planFollowupFromFollower(f.message,f.policy,'An unrelated instruction'));
});
