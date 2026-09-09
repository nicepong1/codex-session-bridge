import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForResumedObservation, observeReadySession} from '../src/observation-readiness.mjs';

test('a provisional empty snapshot is withheld until the GPU finishes resuming', async () => {
  const observation = {state: {stale: false, state: {resumeState: 'resuming', turns: []}}};
  let waits = 0;
  const ready = await waitForResumedObservation(observation, {wait: async () => {
    waits++; observation.state.state = {resumeState: 'resumed', turns: [{turnId: 'existing'}]};
  }});
  assert.equal(waits, 1); assert.equal(ready.state.state.turns[0].turnId, 'existing');
});
test('an unusable hydration patch triggers a fresh read without accepting another owner', async () => {
  for (const replacementOwner of ['same', 'other']) {
    let reads = 0, closed = 0;
    const observe = async () => (++reads === 1
      ? {error: new Error('Missing patch target'), state: {ownerClientId: 'same'}, close: () => closed++}
      : {state: {ownerClientId: replacementOwner, state: {resumeState: 'resumed'}}, close: () => closed++});
    const result = observeReadySession('task', observe, {wait: async () => {}});
    if (replacementOwner === 'same') assert.equal((await result).state.ownerClientId, 'same');
    else await assert.rejects(result, /owner changed/);
    assert.equal(reads, 2); assert.ok(closed >= 1);
  }
});
test('a genuinely empty resumed task is ready, but a lost or cancelled observation is not', async () => {
  const observation = {state: {stale: false, state: {resumeState: 'resumed', turns: []}}};
  assert.equal(await waitForResumedObservation(observation), observation);
  await assert.rejects(waitForResumedObservation(observation, {isClosed: () => true}), /closed/);
  observation.state.stale = true;
  await assert.rejects(waitForResumedObservation(observation), /closed/);
});
