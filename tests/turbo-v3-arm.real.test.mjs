import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { fork } from 'node:child_process';
import { createProtocol, createSession } from '../bench/turbo/v3-server.mjs';
import { browserTools } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'real-page qualification belongs to the host runner';
test('v3 bench transports five V7 tools through inherited IPC to a local page with fixture providers', { skip, timeout: 90000 }, async t => {
  const posts = [], sockets = new Set(), output = new PassThrough(), replies = [];
  output.on('data', data => replies.push(JSON.parse(data)));
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      let body = ''; for await (const part of request) body += part;
      posts.push(Object.fromEntries(new URLSearchParams(body))); response.end('saved'); return;
    }
    response.end('<!doctype html><title>Fixture</title><form><label>Name<input name="name"></label><button>Save</button></form><p id="status">Ready</p><script>document.querySelector("form").onsubmit=async e=>{e.preventDefault();await fetch("/submit",{method:"POST",body:new URLSearchParams(new FormData(e.target))});document.querySelector("#status").textContent="Saved "+document.querySelector("input").value}</script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let protocol, exited, receipt;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    protocol = createProtocol({ output, start: () => createSession({ origins: [origin], taskMessage: 'Read and fill the local fixture.',
      forkWorker(_path, args, options) {
        const child = fork(new URL('./fixtures/v3-bench-page-worker.mjs', import.meta.url), args,
          { ...options, env: { ...options.env, SLEIGHT_LIVE_DOM_TEST: '1' } });
        exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); return child;
      } }) });
    let id = 0;
    const request = async (method, params) => { await protocol.message({ id: ++id, method, params }); return replies.at(-1); };
    assert.deepEqual((await request('tools/list')).result.tools, browserTools('bbench'));
    const call = async (name, args) => {
      const reply = await request('tools/call', { name, arguments: args }); assert.ok(reply.result, JSON.stringify(reply));
      assert.equal(reply.result.isError, false, reply.result.content[0].text); return reply.result.content[0].text;
    };
    assert.match(await call('browser_open', { url: origin }), /t1.*Fixture/s);
    assert.match(await call('browser_fill', { tab: 't1', fields: [{ ref: 'e1', value: 'Ada' }], submit: 'e2' }), /e1: set/);
    assert.deepEqual(posts, [{ name: 'Ada' }]);
    assert.match(await call('browser_read', { tab: 't1' }), /Saved Ada/);
    assert.match(await call('browser_act', { tab: 't1', steps: [{ do: 'type', ref: 'e1', text: 'Grace' }, { do: 'click', ref: 'e2' }] }), /click: done/);
    assert.deepEqual(posts, [{ name: 'Ada' }, { name: 'Grace' }]);
    assert.match(await call('browser_tabs', { do: 'list' }), /t1/);
    receipt = await protocol.close();
    assert.equal(receipt.turboTabsLeft, 0); assert.equal(receipt.tabsAfterBrowserClose, 0);
    for (const key of ['browserClosed', 'profileDeleted', 'socketsClosed']) assert.equal(receipt[key], true, key);
    assert.deepEqual(await exited, { code: 0, signal: null });
    t.diagnostic('V7 dispatcher and fork transport only; fixture action/snapshot providers, production V10 join unqualified.');
  } finally {
    await protocol?.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sockets.size, 0);
  }
});
