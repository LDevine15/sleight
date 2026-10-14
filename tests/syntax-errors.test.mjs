import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntaxErrorHint } from '../plugins/sleight/lib/syntax-errors.mjs';

for (const [error, code, expected] of [
  ['[2:11-2:12]: Unexpected token', 'const secret = "private";\nconst x = ;', /line 2, column 11/],
  ['SyntaxError: Invalid left-hand side in assignment\n at <anonymous>:2:1', 'const secret = "private";\n1 = "sensitive";', /line 2, column 1/],
]) test('known syntax coordinates return only their redacted source line', () => {
  const hint = syntaxErrorHint(error, code, code);
  assert.match(hint, expected);
  assert.doesNotMatch(hint, /private|sensitive|const secret/);
  assert.ok(hint.length < 400);
});
test('literals, comments, templates and regex text are hidden on the selected line', () => {
  const code = 'const a = "private"; /* hidden */ const b = `template${"nested"}`; const r = /credential/; !';
  const hint = syntaxErrorHint('[1:7-1:8]: Unexpected token', code, code);
  assert.match(hint, /<string>/);
  assert.doesNotMatch(hint, /private|hidden|template|nested|credential/);
});
test('wrapped source coordinates map to the original line and column', () => {
  const code = 'const x = ;', sent = '// internal\nfunction wrapper(){\n' + code + '\n}';
  const hint = syntaxErrorHint('[3:11-3:12]: Unexpected token', code, sent);
  assert.match(hint, /line 1, column 11/);
  assert.doesNotMatch(hint, /internal|wrapper/);
});
test('unknown, ambiguous and out-of-range locations never expose source', () => {
  const code = 'const secret = "private";';
  for (const [error, sent] of [
    ['SyntaxError: Unexpected token', code],
    ['[99:1-99:2]: Unexpected token', code],
    ['[1:1-1:2]: Unexpected token', code + '\n' + code],
    ['[1:1-1:2]: Unexpected token', '// wrapper\n' + code],
  ]) {
    const hint = syntaxErrorHint(error, code, sent);
    assert.doesNotMatch(hint ?? '', /private|secret|wrapper/);
  }
  assert.equal(syntaxErrorHint('caller says SyntaxError: Unexpected token at 1:2', code, code), undefined);
});
test('source context is capped at one line and 240 characters', () => {
  const code = 'a'.repeat(500) + '\nprivateIdentifier';
  const hint = syntaxErrorHint('[1:2-1:3]: Unexpected token', code, code);
  assert.match(hint, /truncated/);
  assert.ok(hint.length < 400);
  assert.doesNotMatch(hint, /privateIdentifier/);
});

test('the relay adds one syntax hint to a failed reply without dispatching a correction', async () => {
  const { PassThrough } = await import('node:stream');
  const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const requests = [], replies = [];
  serverIn.on('data', data => requests.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  try {
    const code = 'const secret = "private";\nconst x = ;';
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    assert.equal(requests.length, 1);
    const sent = requests[0].params.arguments.code, start = sent.indexOf(code);
    assert.ok(start >= 0);
    const before = sent.slice(0, start + code.indexOf('const x') + 10);
    const line = before.split('\n').length, column = before.length - before.lastIndexOf('\n');
    const raw = `[${line}:${column}-${line}:${column + 1}]: Unexpected token`;
    serverOut.write(JSON.stringify({ id: 1, result: { isError: true, content: [{ type: 'text', text: raw }] } }) + '\n');
    assert.equal(requests.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result.isError, true);
    assert.equal(replies[0].result.content[0].text, raw);
    assert.match(replies[0].result.content[1].text, /caller line 2, column 11/);
    assert.doesNotMatch(replies[0].result.content[1].text, /private|secret/);
  } finally { relay.dispose(); }
});
