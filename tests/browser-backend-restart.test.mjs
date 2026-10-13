import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), sent = [], replies = [];
  let serverIn, serverOut, changed = false, stops = 0, starts = 0;
  const fresh = () => {
    serverIn = new PassThrough(); serverOut = new PassThrough();
    serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    return { serverIn, serverOut };
  };
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, ...fresh(), changeReview: false,
    backendChanged: () => changed, beginStop: () => {},
    stopEngine: async () => { stops++; return { collected: true }; },
    restartEngine: async () => { starts++; changed = false; return fresh(); },
    ...options,
  });
  t.after(() => relay.close());
  return { sent, replies, replace: () => { changed = true; }, get stops() { return stops; }, get starts() { return starts; },
    call: (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: (id, text = 'Browser tab: 7, Title: "Page", URL: "https://example.test/page".\n0 AXWebArea Page') => {
      const request = sent.findLast(m => m.id === id || (m.method === 'tools/call' && m.params.arguments?.code?.endsWith('await tab.getAXState();')));
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? id, result: { content: [{ type: 'text', text }],
        _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } }) + '\n');
    },
  };
}

test('confirmed socket replacement restarts only the idle session and retains H3 recovery records', async t => {
  const one = fixture(t), two = fixture(t);
  one.call(1, 'let b = await cua.getBrowser({id:"one"});'); one.reply(1);
  one.call(2, 'let tab = await b.tabs.get("7");'); one.reply(2);
  one.replace(); one.call(3, 'await tab.getAXState();');
  await setImmediate(); await setImmediate();
  assert.equal(one.stops, 1); assert.equal(one.starts, 1);
  assert.equal(two.stops, 0); assert.equal(two.starts, 0);
  const request = one.sent.at(-1);
  assert.match(request.params.arguments.code, /restored session handles/);
  one.reply(request.id, '## Computer Use\nDocs');
  assert.match(one.replies.at(-1).result.content.map(c => c.text).join('\n'), /JavaScript session restarted/);
});

test('unconfirmed collection refuses the call without launching a replacement', async t => {
  const h = fixture(t, { stopEngine: async () => ({ collected: false }) });
  h.replace(); h.call(1, 'await cua.listBrowsers();');
  await setImmediate(); await setImmediate();
  assert.equal(h.starts, 0);
  assert.match(h.replies.at(-1).result.content.map(c => c.text).join('\n'), /collection is unconfirmed/);
});

test('extension disconnect during a pending call never restarts mid-call', async t => {
  const h = fixture(t);
  h.call(1, 'let b = await cua.getBrowser({id:"one"});');
  h.replace(); h.call(2, 'await b.tabs.list();');
  await setImmediate();
  assert.equal(h.stops, 0); assert.equal(h.starts, 0);
  assert.match(h.replies.find(m => m.id === 2).result.content.map(c => c.text).join('\n'), /pending/);
  h.reply(1); h.call(3, 'await b.tabs.list();');
  await setImmediate(); await setImmediate();
  assert.equal(h.starts, 1);
});
