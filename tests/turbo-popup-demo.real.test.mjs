import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSession, executable } from '../bench/turbo/server.mjs';

const demoPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/demo/server.mjs');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real demo qualification belongs to the host runner'
  : !['darwin', 'linux'].includes(process.platform) || !existsSync(executable) ? 'pinned headless Chromium is absent'
    : !existsSync(demoPath) ? 'the read-only MIT demo server is absent'
      : typeof globalThis.WebSocket !== 'function' ? 'Node built-in WebSocket is absent' : false;

async function freePair() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const probes = [createServer(), createServer()];
    const listen = (server, port) => new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
    });
    try {
      await listen(probes[0], 0);
      const port = probes[0].address().port;
      if (port === 65535) continue;
      await listen(probes[1], port + 1); return port;
    } catch { /* Another fixture owns the adjacent port; try a new pair. */ }
    finally { await Promise.all(probes.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve)))); }
  }
  throw Error('No adjacent fixture ports available');
}

async function fixture(t) {
  const { startServer } = await import(pathToFileURL(demoPath));
  const port = await freePair(), origin = 'http://127.0.0.1:' + port;
  const server = startServer({ port }); let session;
  t.after(async () => {
    try {
      if (session) {
        assert.deepEqual(await session.close(), { browserClosed: true, profileDeleted: true, socketsClosed: true });
        assert.equal(existsSync(session.profile), false);
      }
    } finally { await server.close(); }
    t.diagnostic('cleanup: browserClosed=true profileDeleted=true socketsClosed=true; both real demo listeners closed');
  });
  session = await createSession({ origins: [origin], taskMessage: 'Read the local demo shop and its independent popup.' });
  const call = async (name, args) => {
    const result = await session.call({ name, arguments: args });
    assert.equal(result.effect, 'verified', JSON.stringify(result));
    if (name === 'browser_read') assert.equal(session.delivered(result), true);
    return result;
  };
  async function rows(tab, max_bytes) {
    const rows = []; let scope;
    for (let page = 0; page < 64; page++) {
      const result = await call('browser_read', { tab, ...(max_bytes ? { max_bytes } : {}), ...(scope ? { scope } : {}) });
      assert.ok(result.observation.data?.length, JSON.stringify(result));
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= (max_bytes ?? 12000));
      rows.push(...result.observation.data); scope = result.observation.cursor;
      if (!scope) return rows;
      assert.match(result.observation.note, /more with scope or max_bytes/);
    }
    assert.fail('demo read exceeded its page bound');
  }
  return { origin, call, rows };
}

test('real demo benchmark route reads the shop by default and returns the Shipping rates tab', { skip, timeout: 120000 }, async t => {
  const f = await fixture(t);
  const opened = await f.call('browser_open', { browser: 'bbench', url: f.origin + '/t/tf4-shipping/shop/' });
  const first = await f.call('browser_read', { tab: opened.tab });
  assert.ok(first.observation.data?.length > 1, 'first default read must show the shop');
  const rows = await f.rows(opened.tab), link = rows.find(row => row.role === 'link' && row.name === 'Shipping rates');
  assert.ok(link, 'the delivered shop read contains Shipping rates');
  const result = await f.call('browser_act', { tab: opened.tab, op: 'click', ref: link.ref });
  assert.notEqual(result.tab, opened.tab); assert.match(result.tab, /^t/);
  assert.equal(result.observation.title, 'Shipping rates · Tidewell Demo Shop');
  assert.match(JSON.stringify(await f.rows(result.tab)), /12\.40/);
});

test('real demo benchmark route keeps 4096-byte reads useful and returns the named Size guide tab', { skip, timeout: 120000 }, async t => {
  const f = await fixture(t);
  const opened = await f.call('browser_open', { browser: 'bbench', url: f.origin + '/t/tf4-size/shop/product/harbor' });
  const rows = await f.rows(opened.tab, 4096), button = rows.find(row => row.role === 'button' && row.name === 'Size guide');
  assert.ok(button, 'the delivered product read contains Size guide');
  const result = await f.call('browser_act', { tab: opened.tab, op: 'click', ref: button.ref });
  assert.notEqual(result.tab, opened.tab); assert.match(result.tab, /^t/);
  assert.equal(result.observation.nullReturned, true);
  assert.match(result.observation.title, /Size guide/);
  assert.match(JSON.stringify(await f.rows(result.tab)), /11 cm/);
});
