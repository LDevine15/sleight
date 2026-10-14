import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function harness() {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const requests = [], replies = [];
  serverIn.on('data', data => requests.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  return { requests, replies, relay, call(code) { clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'); } };
}
for (const [label, code, line, correction] of [
  ['bare', '\napp.click(3); await app.getAXState()', 2, 'await app.click(…)'],
  ['chained', 'const before = "private";\n\nconst p = app.click(3).then(f); await app.getAXState()', 3, 'await app.click(…)'],
  ['multiline string before action', 'const s = `private\ntext`;\napp.typeText("secret"); await app.getAXState()', 3, 'await app.typeText(…)'],
  ['page callback before action', 'await tab.evaluate(() => {\n return document.title;\n});\napp.pressKey("secret"); await app.getAXState()', 4, 'await app.pressKey(…)'],
]) test(`${label} refusal gives a line and minimal awaited form before engine dispatch`, () => {
  const h = harness();
  try {
    h.call(code);
    assert.equal(h.requests.length, 0);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].result.isError, true);
    const text = h.replies[0].result.content[0].text;
    assert.match(text, new RegExp(`line ${line}\\b`));
    assert.ok(text.includes(correction));
    assert.doesNotMatch(text, /private|secret/);
  } finally { h.relay.dispose(); }
});
test('awaited chains preserve dispatch without a correction or another request', () => {
  const h = harness(), code = 'await app.click(3).then(f); await app.getAXState()';
  try {
    h.call(code);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].params.arguments.code.includes(code));
    assert.equal(h.replies.length, 0);
  } finally { h.relay.dispose(); }
});
