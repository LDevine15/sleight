import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { finalExpression, autoPrintCode, noOutputNotice } from '../plugins/sleight/lib/no-output.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const empty = [{ type: 'text', text: 'JavaScript code completed with no output.' }];

test('finds a final bare expression across comments, strings and ASI', () => {
  for (const [code, expected] of [
    ['let result = 1; result; // end', 'result'],
    ['const value = "a; b";\nvalue + "!";', 'value + "!"'],
    ['const x = 2\nx\n + 3', 'x\n + 3'],
    ['let url="x"; `URL: ${url}`;', '`URL: ${url}`'],
    ['const rx = /[;{}]/;\nrx.source;', 'rx.source'],
  ]) assert.equal(finalExpression(code)?.expression, expected, code);
});

test('declarations, blocks, output calls and actions do not get a bare-value notice', () => {
  for (const code of ['const x = 2;', 'function x() {}', 'class X {}',
    'if (ok) { value; }', 'nodeRepl.write(value);', 'console.log(value);',
    'await tab.click(1);', 'await app.pressKey(null, "Enter");',
    'const x = "unterminated', '"use strict";', '// comment\n"use strict";',
    '// comment\nconsole.log(value);', '// comment\n{value: 1}']) {
    assert.equal(noOutputNotice(code, empty), undefined, code);
  }
});

test('the notice explains a successful empty result without claiming action success', () => {
  const note = noOutputNotice('submissionId || "Checking page...";', empty);
  assert.match(note, /call ran|call completed/);
  assert.match(note, /kernel/);
  assert.match(note, /nodeRepl\.write/);
  assert.doesNotMatch(note, /submitted|action succeeded/);
});

test('real output, images and error-shaped text do not get an empty-result notice', () => {
  for (const content of [[], [{ type: 'text', text: 'value' }],
    [...empty, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
    [{ type: 'text', text: 'Error: completed with no output' }]]) {
    assert.equal(noOutputNotice('value;', content), undefined);
  }
});

test('autoprint is opt-in and prints a pure final expression exactly once', async () => {
  const code = 'let value="hello"; value + "!";';
  assert.equal(autoPrintCode(code), code);
  const rewritten = autoPrintCode(code, true);
  assert.notEqual(rewritten, code);
  const output = [];
  await new (Object.getPrototypeOf(async function() {}).constructor)('nodeRepl', rewritten)({ write: value => output.push(value) });
  assert.deepEqual(output, ['hello!']);
});

test('autoprint does not repeat a prior action', async () => {
  const code = 'await tab.click(1); "done";';
  let clicks = 0;
  const output = [];
  await new (Object.getPrototypeOf(async function() {}).constructor)('tab', 'nodeRepl', autoPrintCode(code, true))(
    { click: async () => { clicks++; } }, { write: value => output.push(value) });
  assert.equal(clicks, 1);
  assert.deepEqual(output, ['done']);
});

test('autoprint refuses calls, writes, computed actions and template interpolation', () => {
  for (const expression of ['await tab.click(1)', 'app.click(1)', 'value = 3', 'value++',
    '++value', '(fn)()', 'tab["click"](1)', 'new Thing()', 'delete value.x',
    '`value: ${tab.click(1)}`', 'fn?.()', '(value, app.click(1))', '/"/.test(value)']) {
    const code = 'let value = 1; ' + expression + ';';
    assert.equal(autoPrintCode(code, true), code, expression);
  }
});

test('printed strings and object values are bounded without invoking getters or custom inspectors', async () => {
  for (const value of ['x'.repeat(10000), { get danger() { throw new Error('getter'); }, text: 'x'.repeat(10000) }]) {
    const output = [];
    await new (Object.getPrototypeOf(async function() {}).constructor)('value', 'nodeRepl', autoPrintCode('value;', true))(
      value, { write: text => output.push(text) });
    assert.equal(output.length, 1);
    assert.ok(output[0].length <= 4000);
  }
});

test('an expression exception still propagates once', async () => {
  const code = 'missingValue;';
  await assert.rejects(new (Object.getPrototypeOf(async function() {}).constructor)('nodeRepl', autoPrintCode(code, true))(
    { write() { assert.fail('must not write'); } }), /missingValue/);
});

test('recorded empty results have reproducible hint and autoprint coverage', () => {
  const rows = JSON.parse(readFileSync(new URL('fixtures/no-output-haiku.json', import.meta.url)));
  assert.equal(rows.length, 34);
  assert.equal(rows.filter(row => noOutputNotice(row.code, empty)).length, 23);
  assert.equal(rows.filter(row => autoPrintCode(row.code, true) !== row.code).length, 17);
});

function relayResult(t, code, result, enabled = false) {
  const previous = process.env.SLEIGHT_AUTOPRINT;
  if (enabled) process.env.SLEIGHT_AUTOPRINT = '1'; else delete process.env.SLEIGHT_AUTOPRINT;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_AUTOPRINT; else process.env.SLEIGHT_AUTOPRINT = previous; });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', b => sent.push(...b.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', b => received.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result }) + '\n');
  return { sent: sent.find(m => m.id === 1), received: received.find(m => m.id === 1) };
}

test('relay appends the hint only to a successful empty result', t => {
  const out = relayResult(t, 'let result=1; result;', { content: empty });
  assert.match(out.received.result.content.at(-1).text, /nodeRepl\.write/);
  const failed = relayResult(t, 'result;', { isError: true, content: empty });
  assert.equal(failed.received.result.content.length, 1);
});

test('relay applies optional printing before guard setup and forwards one call', t => {
  const out = relayResult(t, 'let result=1; result;', { content: [{ type: 'text', text: '1' }] }, true);
  assert.match(out.sent.params.arguments.code, /maxStringLength: 2000/);
  assert.equal(out.received.result.content.length, 1);
});
