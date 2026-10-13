// Offline fake sessions only. Wall times include fixture setup and cleanup.
import { dependencyPlan } from '../planner.mjs';
import { relayTrial } from './relay-fixture.mjs';

const plan = dependencyPlan([{ read: true }, { set: { id: 'entry', value: 'after' } }]);
const trials = [];
for (let i = 0; i < 5; i++) {
  const pair = {};
  for (const combined of i % 2 ? [true, false] : [false, true]) {
    const start = performance.now();
    const result = await relayTrial(combined, combined ? { plan: plan.code } : {});
    pair[combined ? 'planned' : 'separate'] = { allInMs: performance.now() - start,
      engineCalls: result.engineCalls, reads: result.reads, inputOperations: result.actions,
      failed: !!result.error, finalValue: result.value, finalRead: result.finalRead,
      modelCalls: null };
  }
  trials.push(pair);
}
console.log(JSON.stringify({ kind: 'offline-fake-relay', trials, observationReasons: plan.steps.map(step => step.observationReason),
  finalObservationReason: plan.finalObservationReason, liveTrials: 0 }, null, 2));
