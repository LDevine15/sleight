import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBrowserFixture, browserHandler, checkBrowserFixture } from '../bench/world/browser-fixtures.mjs';

async function request(fixture, path, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: `/fixture/${path}`, headers: {
    host: '127.0.0.1:54321', ...(body !== undefined ? { 'content-type': 'application/json', origin: 'http://127.0.0.1:54321' } : {}) } });
  let status, output;
  const res = { writeHead(code) { status = code; return this; }, end(value) { output = value; } };
  await browserHandler(fixture, 'http://127.0.0.1:54321')(req, res);
  return { status, output };
}

for (const kind of ['local-wikipedia', 'local-mdn', 'table-scrape', 'file-upload', 'tab-switching', 'multi-page-search', 'form-controls']) {
  test(`${kind} checks generated fixture state instead of model knowledge`, async () => {
    const fixture = createBrowserFixture(kind, { nonce: 'fixture', seed: 'test-seed' });
    const other = createBrowserFixture(kind, { nonce: 'fixture', seed: 'different-seed' });
    assert.notDeepEqual(fixture.expected, other.expected);
    assert.notEqual(checkBrowserFixture(fixture, JSON.stringify(fixture.expected)), true, 'unread fixture cannot pass');
    const first = await request(fixture, '');
    assert.equal(first.status, 200);
    assert.match(first.output, /<!doctype html>/i);
    if (kind === 'file-upload') {
      await request(fixture, 'state', { uploadText: 'wrong' });
      assert.notEqual(checkBrowserFixture(fixture, 'done'), true);
      await request(fixture, 'state', fixture.expected);
      assert.equal(checkBrowserFixture(fixture, 'done'), true);
    } else if (kind === 'tab-switching') {
      await request(fixture, 'state', fixture.expected);
      assert.notEqual(checkBrowserFixture(fixture, 'done'), true);
      await request(fixture, 'second');
      await request(fixture, 'state', fixture.expected);
      assert.equal(checkBrowserFixture(fixture, 'done'), true);
    } else if (kind === 'form-controls') {
      await request(fixture, 'state', fixture.expected);
      assert.equal(checkBrowserFixture(fixture, 'done'), true);
    } else {
      if (kind === 'multi-page-search') await request(fixture, 'record/2');
      assert.notEqual(checkBrowserFixture(fixture, '{}'), true);
      assert.equal(checkBrowserFixture(fixture, JSON.stringify(fixture.expected)), true);
    }
    const foreign = await request(fixture, '../other');
    assert.equal(foreign.status, 404);
  });
}

test('the local page handler refuses cross-origin state writes and oversized payloads', async () => {
  const fixture = createBrowserFixture('file-upload', { nonce: 'fixture', seed: 'test' });
  const handle = browserHandler(fixture, 'http://127.0.0.1:54321');
  for (const [origin, body, expected] of [['http://other.test', '{}', 403], ['http://127.0.0.1:54321', 'x'.repeat(32769), 413]]) {
    const req = Readable.from([body]);
    Object.assign(req, { method: 'POST', url: '/fixture/state', headers: { host: '127.0.0.1:54321', origin, 'content-type': 'application/json' } });
    let status;
    await handle(req, { writeHead(code) { status = code; return this; }, end() {} });
    assert.equal(status, expected);
  }
});
