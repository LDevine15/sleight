import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { createSession, createProtocol, executable } from '../bench/turbo/server.mjs';
import { compactTools } from '../plugins/sleight/lib/direct-browser/surface.mjs';

const realSkip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real-page qualification belongs to the host runner'
  : !['darwin', 'linux'].includes(process.platform) || !existsSync(executable) ? 'pinned headless Chromium is absent'
    : typeof globalThis.WebSocket !== 'function' ? 'Node built-in WebSocket is absent' : false;

test('turbo bench fake model fills and submits one real fixture through the four production tools, then collects every resource',
  { skip: realSkip, timeout: 90000 }, async t => {
    const sockets = new Set(), posts = [], output = new PassThrough(), messages = [];
    output.on('data', chunk => messages.push(JSON.parse(chunk)));
    const html = '<!doctype html><title>Bench form</title><form><label>Name<input name="name"></label>'
      + '<button>Save</button></form><p id="status">Ready</p><script>'
      + 'document.querySelector("form").onsubmit=async e=>{e.preventDefault();'
      + 'await fetch("/submit",{method:"POST",body:new URLSearchParams(new FormData(e.target))});'
      + 'document.querySelector("#status").textContent="Saved"}</script>';
    const server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/submit') {
        let body = ''; for await (const chunk of request) body += chunk;
        posts.push(Object.fromEntries(new URLSearchParams(body))); response.end('saved'); return;
      }
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    let protocol, session;
    t.after(async () => {
      try {
        const receipt = await protocol?.close();
        if (session) {
          assert.deepEqual(receipt, { browserClosed: true, profileDeleted: true, socketsClosed: true });
          assert.equal(existsSync(session.profile), false);
          t.diagnostic('Cleanup: browserClosed=true profileDeleted=true socketsClosed=true');
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sockets.size, 0, 'fixture HTTP sockets collected');
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    protocol = createProtocol({ output, start: async () => session = await createSession({ origins: [origin],
      taskMessage: 'Fill Name with TB2R-FIXTURE at ' + origin + '/form then Save.' }) });
    let id = 0;
    const request = async (method, params) => {
      await protocol.message({ jsonrpc: '2.0', id: ++id, method, params });
      const message = messages.at(-1); assert.ok(message.result, JSON.stringify(message)); return message.result;
    };
    assert.deepEqual((await request('tools/list')).tools, compactTools());
    const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).content[0].text);
    const opened = await call('browser_open', { browser: 'bbench', url: origin + '/form' });
    assert.equal(opened.effect, 'verified', JSON.stringify(opened)); assert.equal(opened.observation.background, true);
    const read = await call('browser_read', { tab: opened.tab, max_bytes: 64000 });
    const rows = read.observation.data;
    assert.ok(Array.isArray(rows), JSON.stringify(read));
    const name = rows.find(row => row.name === 'Name' && row.role === 'textbox');
    const save = rows.find(row => row.name === 'Save' && row.role === 'button');
    assert.ok(name && save, JSON.stringify(rows));
    const fill = await call('browser_fill', { tab: opened.tab, fields: [{ ref: name.ref, value: 'TB2R-FIXTURE' }] });
    assert.equal(fill.effect, 'verified', JSON.stringify(fill)); assert.equal(fill.completed, 1);
    const submit = await call('browser_act', { tab: opened.tab, op: 'click', ref: save.ref });
    assert.equal(submit.receipt.effect, 'unknown', JSON.stringify(submit));
    const deadline = Date.now() + 5000;
    while (!posts.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(posts, [{ name: 'TB2R-FIXTURE' }]);
    t.diagnostic('Independent fixture proof: exactly one POST with Name=TB2R-FIXTURE; production submit receipt remains unknown.');
  });
