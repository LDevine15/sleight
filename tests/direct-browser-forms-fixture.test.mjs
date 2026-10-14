import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFormsFixtureHandler, finishTravelFixture } from './fixtures/direct-browser-forms-fixture.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

async function request(handler, method, url, body = '', contentType = 'application/json') {
  const incoming = Readable.from([body]);
  Object.assign(incoming, { method, url, headers: { 'content-type': contentType } });
  const result = {};
  await handler(incoming, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); return this; },
    end(body) { result.body = body; },
  });
  return result;
}

test('travel fixture navigation reaches the pinned wizard panels and waits for submission', async () => {
  // These IDs are the MIT pinned travel.html's wizard panels, not #next1/#next2.
  const panels = new Map([['#to2', [1, 2]], ['#to3', [2, 3]]]);
  let panel = 1, destination = false, airport = false, seat = false, submissions = 0;
  const receipt = { path: '/submit/travel', data: { country: 'Japan', city: 'Osaka', airport: 'AAA', seat: '1A' } };
  const posted = await finishTravelFixture({
    async click(selector) {
      if (panels.has(selector)) {
        const [from, to] = panels.get(selector); assert.equal(panel, from);
        if (to === 3) assert.ok(destination && airport);
        panel = to; return;
      }
      if (selector === '#airports [role="option"]') { assert.equal(panel, 2); airport = true; return; }
      if (selector === '#seatmap button:not(:disabled)') { assert.equal(panel, 3); seat = true; return; }
      if (selector === 'button[type="submit"]') { assert.ok(seat); submissions++; return; }
      assert.fail('fixture target missing: ' + selector);
    },
    async fill(fields) { assert.equal(panel, 2); assert.deepEqual(fields, [['#country', 'Japan'], ['#city', 'Osaka']]); destination = true; },
    async posted() { assert.equal(submissions, 1); return receipt; },
  });
  assert.equal(posted, receipt);
});

test('shop fixture logging cannot qualify an order or inflate its count', async () => {
  const posts = [];
  const handler = createFormsFixtureHandler({ route: 'shop', posts });
  for (const path of ['/api/log', '/shop/checkout/api/log']) {
    const response = await request(handler, 'POST', path, JSON.stringify({ kind: 'input', field: 'number' }), 'text/plain');
    assert.equal(response.status, 204); assert.equal(posts.length, 0);
  }
  const response = await request(handler, 'POST', '/shop/checkout/order', 'number=4242424242424242&expiry=12%2F30&cvc=123', 'application/x-www-form-urlencoded');
  assert.equal(response.status, 200);
  await request(handler, 'POST', '/shop/checkout/api/log', JSON.stringify({ kind: 'pointer' }), 'text/plain');
  assert.deepEqual(posts, [{ path: '/shop/checkout/order', data: { number: '4242424242424242', expiry: '12/30', cvc: '123' } }]);
});

test('shop fixture records only the exact order endpoint', async () => {
  const posts = [];
  const handler = createFormsFixtureHandler({ route: 'shop', posts });
  for (const path of ['/submit/travel', '/shop/checkout/order/extra', '/shop/checkout/order?log=1']) {
    assert.equal((await request(handler, 'POST', path, '{}')).status, 404);
  }
  assert.deepEqual(posts, []);
});

test('form fixtures record their own exact submission endpoint and JSON payload', async () => {
  for (const route of ['travel', 'settings']) {
    const posts = [], handler = createFormsFixtureHandler({ route, posts });
    assert.equal((await request(handler, 'POST', '/api/log', JSON.stringify({ kind: 'input' }))).status, 204);
    assert.equal((await request(handler, 'POST', '/submit/other', '{}')).status, 404);
    const response = await request(handler, 'POST', '/submit/' + route, JSON.stringify({ reference: 'P2', twoFactor: true }));
    assert.deepEqual(JSON.parse(response.body), { id: 'P2-FIXTURE' });
    assert.deepEqual(posts, [{ path: '/submit/' + route, data: { reference: 'P2', twoFactor: true } }]);
  }
});

test('travel fixture serves the stylesheet that hides inactive wizard panels', async t => {
  const siteRoot = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-p2-forms-site-')));
  t.after(() => { removeTemp(siteRoot); assert.equal(existsSync(siteRoot), false); });
  writeFileSync(join(siteRoot, 'style.css'), '.hidden { display: none !important; }');
  const handler = createFormsFixtureHandler({ route: 'travel', posts: [], siteRoot });
  const response = await request(handler, 'GET', '/style.css');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/css');
  assert.equal(response.body, readFileSync(join(siteRoot, 'style.css'), 'utf8'));
});
