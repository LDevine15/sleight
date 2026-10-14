import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontend, compactTools, expandSchema } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { browserTools, validateCall } from '../plugins/sleight/lib/direct-browser/schemas.mjs';

test('every advertised turbo schema is one plain object accepted by the Messages API', () => {
  for (const tool of [...browserTools(), ...compactTools()]) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(Object.hasOwn(tool.inputSchema, key), false, tool.name + ': ' + key);
    assert.deepEqual(expandSchema(compactTools().find(row => row.name === tool.name).inputSchema),
      browserTools().find(row => row.name === tool.name).inputSchema);
  }
  const act = browserTools().find(tool => tool.name === 'browser_act').inputSchema;
  assert.deepEqual(act.required, ['tab', 'op']);
  assert.ok(act.properties.op.enum.includes('batch'));
});
test('advertised batch op normalizes to the exact closed host grammar', () => {
  const steps = [{ op: 'click', ref: 'r1' }, { op: 'key', ref: 'r2', key: 'Enter' }];
  assert.deepEqual(validateCall({ name: 'browser_act', arguments: { tab: 't1', op: 'batch', steps } }).arguments,
    { tab: 't1', steps });
  for (const args of [{ tab: 't1', op: 'click', steps }, { tab: 't1', op: 'batch', steps, ref: 'r1' },
    { tab: 't1', op: 'batch' }, { tab: 't1', op: 'click', ref: 'r1', value: 'wrong' }])
    assert.throws(() => validateCall({ name: 'browser_act', arguments: args }), /INVALID_ARGUMENT/);
});
test('an unknown ordinary field does not require whole-page completeness before unrelated input', async () => {
  let calls = 0;
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    client: { request() {
      calls++;
      if (calls === 1) return { effect: 'unknown', completed: 0, untouched: 0,
        error: { code: 'EFFECT_UNKNOWN', effect: 'unknown', completed: 0 } };
      return { effect: 'verified', completed: 1, observation: { complete: false } };
    } } });
  const first = await frontend.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r1', value: 'x' }] } });
  assert.equal(first.receipt.effect, 'unknown');
  const next = await frontend.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r2', value: 'y' }] } });
  assert.equal(next.completed, 1, JSON.stringify(next));
  assert.equal(calls, 2);
  assert.equal(frontend.receipt(first.receipt.operation).effect, 'unknown');
  await frontend.end();
});
test('the trusted host submit refusal survives projection without a weaker retry or fallback', async () => {
  let calls = 0;
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    client: { request() { calls++; return { effect: 'none', completed: 0,
      error: { code: 'RECOVERY_READ_REQUIRED', effect: 'none', completed: 0 } }; } } });
  const result = await frontend.call({ name: 'browser_act', arguments: { tab: 't1', op: 'click', ref: 'rsubmit' } });
  assert.equal(result.error.code, 'RECOVERY_READ_REQUIRED');
  assert.equal(result.receipt.effect, 'none'); assert.equal(calls, 1);
  await frontend.end();
});
test('a host timeout retains its verified form prefix even when per-field observations were withheld', async () => {
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    client: { request() { return { effect: 'unknown', completed: 2, unknownStep: 2, untouched: 1,
      error: { code: 'TIMEOUT', effect: 'unknown', completed: 2, unknownStep: 2, untouched: 1 } }; } } });
  const result = await frontend.call({ name: 'browser_fill', arguments: { tab: 't1',
    fields: [1, 2, 3, 4].map(n => ({ ref: 'r' + n, value: 'x' })) } });
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.receipt.completed, 2, JSON.stringify(result));
  assert.equal(result.receipt.unknownStep, 2); assert.equal(result.receipt.untouched, 1);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(row => row.observation.omitted === true));
  await frontend.end();
});
test('semantic refs and submit recovery acknowledge only the exact successful read after client delivery', async () => {
  const delivered = [];
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    onDelivered: value => { delivered.push(value); return true; },
    client: { request: () => ({ effect: 'verified', completed: 1, observation: { observation: 'o1', complete: false, data: [{ ref: 'r1' }] } }) } });
  const result = await frontend.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(typeof frontend.delivered, 'function', 'semantic delivery join is absent');
  assert.equal(delivered.length, 0, 'preparation is not delivery');
  assert.equal(frontend.delivered(structuredClone(result)), false);
  assert.equal(frontend.delivered(result), true); assert.equal(frontend.delivered(result), false);
  assert.equal(delivered.length, 1); assert.equal(delivered[0].name, 'browser_read');
  assert.equal(delivered[0].tab, 't1'); assert.equal(delivered[0].observation.observation, 'o1');
  assert.equal(Object.hasOwn(delivered[0], 'arguments'), false);
  const omitted = await frontend.call({ name: 'browser_read', arguments: { tab: 't1' } });
  await frontend.end(); assert.equal(frontend.delivered(omitted), false);
});
test('omitted, failed, mutated and asynchronous delivery acknowledgements cannot advance a semantic baseline', async () => {
  let calls = 0, mode = 'large';
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    onDelivered: () => { calls++; return Promise.resolve(true); },
    client: { request: () => mode === 'failed' ? { effect: 'none', completed: 0, error: { code: 'TIMEOUT', effect: 'none', completed: 0 } }
      : { effect: 'verified', completed: 1, observation: { observation: 'o1', text: mode === 'large' ? 'x'.repeat(20000) : '' } } } });
  assert.equal(typeof frontend.delivered, 'function', 'semantic delivery join is absent');
  const read = { name: 'browser_read', arguments: { tab: 't1', max_bytes: 1024 } };
  assert.equal(frontend.delivered(await frontend.call(read)), false);
  mode = 'failed'; assert.equal(frontend.delivered(await frontend.call(read)), false);
  mode = 'small'; const mutated = await frontend.call(read); mutated.observation = { ...mutated.observation, observation: 'forged' };
  assert.equal(frontend.delivered(mutated), false);
  assert.equal(calls, 0);
  const valid = await frontend.call(read); assert.equal(frontend.delivered(valid), false); assert.equal(calls, 1);
  await frontend.end();
});
test('unknown input reports cleanup ownership privately without retaining values or gating another field', async () => {
  const unknown = []; let calls = 0;
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', redact: value => value, onUnknown: receipt => unknown.push(receipt),
    endSession: () => ({ revoked: true, cleanup: [] }), client: { request() {
      if (++calls === 1) return { effect: 'unknown', completed: 0, untouched: 0, error: { code: 'EFFECT_UNKNOWN', effect: 'unknown' } };
      return { effect: 'verified', completed: 1, observation: { complete: false } };
    } } });
  await frontend.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r1', value: 'private-fixture' }] } });
  assert.equal(unknown.length, 1, 'unknown input was absent from semantic cleanup ownership');
  assert.equal(unknown[0].tab, 't1'); assert.doesNotMatch(JSON.stringify(unknown), /private-fixture|arguments|fields/);
  assert.equal((await frontend.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r2', value: 'Example' }] } })).completed, 1);
  await frontend.end();
});
