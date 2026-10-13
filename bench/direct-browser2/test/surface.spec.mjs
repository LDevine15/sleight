import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurface } from '../surface.mjs';

test('offline fixture transcript uses open, read, act and fill with per-field proof', async () => {
  let connects = 0;
  const inputs = [];
  const session = new Proxy({ sessionId: 'fixture', send: async (...args) => inputs.push(args), on() {}, off() {} },
    { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('Unsupported CDP member ' + key); } });
  const operate = async (args, context) => {
    await context.session.send('Fixture.operation', args);
    return { effect: 'verified', observation: { text: 'synthetic fixture proof', untrusted: true }, ...(args.browser ? { tab: 't1' } : {}) };
  };
  const surface = createSurface({ state: 'ready', authorize: () => true, redact: x => x,
    connect: async () => { connects++; return { session, operations: { open: operate, read: operate, act: operate, fill: operate } }; } });
  const transcript = [
    { name: 'browser_open', arguments: { browser: 'b1', url: 'https://example.test/form' } },
    { name: 'browser_read', arguments: { tab: 't1' } },
    { name: 'browser_act', arguments: { tab: 't1', op: 'click', ref: 'r1' } },
    { name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r2', value: 'Ada' }, { ref: 'r3', value: true }] } },
  ];
  const output = [];
  for (const request of transcript) output.push(await surface.call(request));
  assert.deepEqual(output.map(result => result.receipt.stage), ['verified', 'verified', 'verified', 'verified']);
  assert.deepEqual(output.map(result => result.receipt.completed), [1, 1, 1, 2]);
  assert.equal(connects, 1); assert.equal(inputs.length, 5);
  assert.equal(output[0].results[0].tab, 't1');
  console.log('OFFLINE_TRANSCRIPT', JSON.stringify(output.map(result => ({ route: result.route, receipt: result.receipt }))));
});
