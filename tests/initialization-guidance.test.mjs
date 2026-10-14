import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const docs = '## Computer Use\nRequired API reference.\n```js\nthrow new Error("example");\nWindow: "Example"\n```\nFollow the documented approval rules.';
function reply(content, isError = false, code = 'await app.click(3)') {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const requests = [], replies = [];
  serverIn.on('data', data => requests.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  try {
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    serverOut.write(JSON.stringify({ id: 1, result: { isError, content } }) + '\n');
    assert.equal(requests.length, 1, 'the relay must not replay pending input');
    return replies.find(r => r.id === 1).result;
  } finally { relay.dispose(); }
}
test('docs-only initialization preserves documentation and marks execution unconfirmed', () => {
  const result = reply([{ type: 'text', text: docs }]);
  assert.equal(result.content[0].text, docs);
  const hint = result.content.find(c => /execution is unconfirmed/.test(c.text ?? ''))?.text;
  assert.match(hint, /only required API documentation/);
  assert.match(hint, /execution is unconfirmed/);
  assert.match(hint, /await cua.getState\(\)/);
  assert.match(hint, /Do not replay/);
  assert.equal(result.isError, false);
});
test('browser docs-only initialization supplies a supported inventory read', () => {
  const result = reply([{ type: 'text', text: '# Other Browser APIs\nRequired API reference.' }], false, 'let tab = await cua.getTab("observed", { browser: "session" }); await tab.click(3)');
  assert.match(result.content.find(c => /execution is unconfirmed/.test(c.text ?? ''))?.text, /await cua.listTabs\(\)/);
  assert.match(result.content.find(c => /execution is unconfirmed/.test(c.text ?? ''))?.text, /execution is unconfirmed/);
});
test('documentation plus a real error retains the error verdict and a distinct notice', () => {
  const raw = 'Error: app handle is missing';
  const result = reply([{ type: 'text', text: docs }, { type: 'text', text: raw }], true);
  assert.equal(result.isError, true);
  assert.ok(result.content.some(c => c.text === raw));
  assert.match(result.content.find(c => /execution is unconfirmed/.test(c.text ?? ''))?.text, /documentation accompanied an error/);
  assert.doesNotMatch(result.content.find(c => /execution is unconfirmed/.test(c.text ?? ''))?.text, /only required API documentation/);
});
test('successful setup with real state does not get a docs-only notice', () => {
  const state = 'Window: "Document", App: Editor.\n0 standard window Document\n1 button Save';
  for (const content of [[{ type: 'text', text: docs }, { type: 'text', text: state }], [{ type: 'text', text: docs + '\n' + state }]]) {
    const result = reply(content, false, 'let app = await cua.getApp("com.example.editor")');
    assert.ok(result.content.some(c => c.text.includes(state)));
    assert.doesNotMatch(result.content.map(c => c.text ?? '').join('\n'), /execution is unconfirmed/);
  }
});
test('ordinary output resembling documentation stays unchanged', () => {
  const result = reply([{ type: 'text', text: 'caller output: ## Computer Use\nnot API documentation' }], false, 'await cua.getState()');
  assert.equal(result.content.length, 1);
});


test('nested short fences in documentation do not fabricate successful setup', () => {
  const text = '## Computer Use\n````md\n```js\nWindow: "Example"\n```\n````\nRequired API reference.';
  const result = reply([{ type: 'text', text }]);
  assert.ok(result.content.some(c => /only required API documentation/.test(c.text ?? '')));
});
