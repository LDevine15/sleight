import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { stripHandBindings } from '../plugins/sleight/lib/hand/bindings.mjs';

test('guard reports its actual successful binding decisions without changing reads or clicks', async () => {
  const window = { title: 'Fixture', app: 'Editor', url: null }, mark = '[private-hand-binding]';
  const tree = 'Window: "Fixture", App: Editor.\n0 standard window\n\t1 button Description: 7, ID: Seven\n\t2 button Description: 8, ID: Eight';
  const output = [], actions = [];
  let reads = 0;
  const app = { getAXState: async () => { reads++; return tree; }, click: async n => actions.push(n) };
  await vm.runInNewContext('(async () => {' + guardedCode('await app.click(1); await app.click(2)', window, 'changed', undefined,
    { bind: true, focused: true, handBindingMark: mark }) + '})()', { app, cua: { getApp: async () => app }, nodeRepl: { write: v => output.push(v) } });
  let binding;
  const clean = stripHandBindings(output.map(text => ({ type: 'text', text })), mark, value => { binding = value; });
  assert.deepEqual(binding, [{ index: 0, bound: false }, { index: 1, bound: true }]);
  assert.deepEqual(actions, [1, 2]); assert.equal(reads, 2);
  assert.ok(clean.every(b => !b.text.includes(mark)));
});

test('binding telemetry accepts only numeric indices and booleans under this call mark', () => {
  const content = [{ type: 'text', text: 'before[mark]{"index":1,"bound":true}\nafter[mark]{"index":"2","bound":true}\n[foreign]{"index":2,"bound":true}\n' }];
  let bindings;
  const clean = stripHandBindings(content, '[mark]', value => { bindings = value; });
  assert.deepEqual(bindings, [{ index: 1, bound: true }]);
  assert.match(clean[0].text, /beforeafter\[foreign\]/);
});


test('a successor UI channel discards old nonce replies and authenticates only its own native reply', async () => {
  const { createUiChannel } = await import('../plugins/sleight/lib/direct-browser/host.mjs');
  const { PassThrough } = await import('node:stream');
  const read = new PassThrough(), write = new PassThrough(), sent = [], delivered = [];
  write.on('data', chunk => sent.push(JSON.parse(chunk)));
  let lost = 0;
  const channel = createUiChannel({ read, write, discardOldNonce: true, onLoss: () => lost++ });
  channel.present('new', {}, ['once'], event => delivered.push(event));
  read.write(JSON.stringify({ id: 'old', nonce: 'a'.repeat(64), choice: 'always' }) + '\n');
  read.write(JSON.stringify({ id: 'new', nonce: sent[0].nonce, choice: 'once' }) + '\n');
  assert.equal(lost, 0); assert.equal(delivered.length, 1);
  assert.equal(channel.authenticate(delivered[0]), true); assert.equal(channel.authenticate(delivered[0]), false);
  channel.close();
});
