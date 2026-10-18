import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function engine() {
  const input = [];
  const tab = Object.seal({
    pressKey(index, key) {
      if (index !== null && (!Number.isInteger(index) || index < 0)) throw Error('Browser input requires an element index from the latest AX snapshot, or null to use current focus.');
      input.push(['key', index, key]);
    },
    click(index) {
      if (index === 17) throw Error('Accessibility element 17 is stale or missing');
      if (typeof index !== 'number' && !Array.isArray(index)) throw Error('Accessibility action requires an element index or point');
      input.push(['click', index]);
    },
  });
  return {tab, input, getTab(reference) {
    if (typeof reference !== 'string') throw TypeError("Cannot use 'in' operator to search for 'mention' in " + reference);
    return tab;
  }};
}

for (const [name, invoke, code] of [
  ['string key index', f => f.tab.pressKey('17', 'Enter'), 'await tab.pressKey("17", "Enter")'],
  ['null click target', f => f.tab.click(null), 'await tab.click(null)'],
  ['stale numeric index', f => f.tab.click(17), 'await tab.click(17)'],
  ['native window number used as a tab reference', f => f.getTab(123), 'await cua.getTab(123, {browser:"b"})'],
]) test(`${name} retains refusal and explains the supported format without input`, () => {
  const f = engine();
  let error;
  try { invoke(f); } catch (caught) { error = caught; }
  assert.ok(error);
  const out = rewriteTabError(error.message, {code});
  assert.match(out, /getAXState|cua.listTabs/);
  if (name === 'stale numeric index') {
    assert.match(out, /Use an index from a fresh read\./);
    assert.ok(out.length < 220, out.length);
  } else {
    assert.match(out, /App.*cua.getApp\(bundleId\)/);
    assert.match(out, /cua.getTab\(tabId, \{ browser: browserId \}\).*string/);
  }
  if (name !== 'native window number used as a tab reference' && name !== 'stale numeric index') {
    assert.match(out, /numeric.*index/);
    assert.match(out, /null.*text.*key|text.*key.*null/);
  }
  assert.deepEqual(f.input, []);
});

test('the documented focus form remains valid for tab keys', () => {
  const f = engine(); f.tab.pressKey(null, 'Enter');
  assert.deepEqual(f.input, [['key', null, 'Enter']]);
  assert.throws(() => f.tab.madeUp(), /is not a function/);
});

test('ordinary JavaScript in-operator errors are unchanged', () => {
  const raw = "TypeError: Cannot use 'in' operator to search for 'mention' in 123";
  assert.equal(rewriteTabError(raw, {code: 'nodeRepl.write("mention" in 123)'}), raw);
});

test('the relay preserves an invalid reference and sends neither a coercion nor an input retry', t => {
  const streams = Array.from({length: 4}, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
  clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
  const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview: false});
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientIn.write(JSON.stringify({id: 1, method: 'tools/call', params: {name: 'js', arguments: {code: 'await cua.getTab(123, {browser:"b"})'}}}) + '\n');
  const text = "TypeError: Cannot use 'in' operator to search for 'mention' in 123";
  serverOut.write(JSON.stringify({id: 1, result: {isError: true, content: [{type: 'text', text}]}}) + '\n');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.arguments.code.includes('cua.getTab(123'));
  assert.equal(replies[0].result.isError, true);
  assert.ok(replies[0].result.content[0].text.startsWith(text));
  assert.match(replies[0].result.content[0].text, /cua.listTabs\(\)/);
});
