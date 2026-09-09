import {setTimeout as delay} from 'node:timers/promises';

export async function waitForResumedObservation(observation, {isClosed = () => false, timeoutMs = 10000, wait = delay} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (observation.error) throw observation.error;
    if (isClosed() || observation.error || observation.disconnected || observation.state?.stale) throw new Error('GPU observation closed before history was ready');
    if (observation.state?.state?.resumeState === 'resumed') return observation;
    if (Date.now() >= deadline) throw new Error('GPU conversation history is still loading');
    await wait(20);
  }
}

export async function observeReadySession(id, observe, {isClosed = () => false, timeoutMs = 10000, wait = delay} = {}) {
  const deadline = Date.now() + timeoutMs;
  let owner;
  while (!isClosed() && Date.now() < deadline) {
    let observation;
    try {
      observation = await observe(id);
      const currentOwner = observation.state.ownerClientId;
      if (owner && owner !== currentOwner) throw new Error('GPU task owner changed while loading');
      owner = currentOwner;
      return await waitForResumedObservation(observation, {isClosed, timeoutMs: Math.max(0, deadline - Date.now()), wait});
    } catch (error) {
      observation?.close();
      // Hydration can replace a field omitted from the serialized snapshot.
      // Keep strict patch validation; discard it and request a full snapshot.
      if (!['Missing patch target', 'Revision gap; fresh snapshot required'].includes(error.message)) throw error;
      await wait(20);
    }
  }
  throw new Error('GPU history readiness timed out or connection stopped');
}
