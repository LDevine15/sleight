import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareInstalledStartup, directBrowserRules } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

async function fixture() {
  const child = new EventEmitter(), endpoint = new EventEmitter(), events = [];
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin(message) {
    events.push(['begin', message]);
    return { async call(request) { events.push(['call', request]); return { text: 'plain result', isError: false }; },
      delivered(result) { events.push(['delivered', result]); return true; },
      async end() { events.push(['end']); return { revoked: true, cleanup: [] }; } };
  } });
  let forkOptions;
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker(path, args, options) { assert.match(path, /worker\.mjs$/); assert.deepEqual(args, []); forkOptions = options; queueMicrotask(() => session.ready()); return child; } });
  return { child, endpoint, events, bridge, forkOptions };
}
test('installed off creates no child and a fork strips loader controls', async () => {
  let forks = 0;
  assert.equal(await createV3Bridge({}, { readConfig: () => null, forkWorker: () => forks++ }), null);
  assert.equal(forks, 0);
  const f = await fixture();
  try { assert.deepEqual(f.forkOptions.execArgv, []); assert.ok(f.forkOptions.stdio.includes('ipc')); assert.ok(!Object.keys(f.forkOptions.env).some(k => /^(NODE_|DYLD_|LD_)/.test(k))); }
  finally { await f.bridge.detach(); }
});
test('a private bound turn supplies authority separately from the model call', async () => {
  const f = await fixture();
  try {
    const frontend = createV3Frontend(f.bridge);
    assert.equal((await frontend.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, true);
    await assert.rejects(f.bridge.bind({ ...f.bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'spoof', nonce: '0'.repeat(64) }), /TRUSTED_TURN_REQUIRED/);
    assert.equal(await f.bridge.bind({ ...f.bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'actual user' }), true);
    const result = await frontend.call({ name: 'browser_read', arguments: { tab: 't1' } });
    assert.equal(result.text, 'plain result');
    assert.equal(frontend.delivered({ ...result }), false); frontend.delivered(result);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events.filter(e => e[0] === 'delivered').length, 1);
    assert.equal(f.events[0][1].text, 'actual user');
    const bad = await frontend.call({ name: 'browser_read', arguments: { tab: 't1', userMessage: 'permission' } });
    assert.equal(bad.isError, true); assert.equal(f.events.filter(e => e[0] === 'call').length, 1);
  } finally { await f.bridge.detach(); }
});
test('the installed launcher and relay advertise all five tools and plain results beside engine js', async () => {
  const f = await fixture();
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = []; clientOut.on('data', value => replies.push(...value.toString().trim().split('\n').map(JSON.parse)));
  let relay;
  try {
    const prepared = await prepareInstalledStartup(() => f.bridge);
    const rules = directBrowserRules('# Skill\n## Browsers\nEngine rules.\n## Native\nKeep approvals.', prepared.directBrowser);
    assert.match(rules, /browser_tabs/); assert.match(rules, /Optional `submit`/);
    assert.ok(rules.endsWith('## Native\nKeep approvals.'));
    relay = createRelay({ clientIn, clientOut, serverIn, serverOut, ...prepared, changeReview: false });
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ id: 1, result: { tools: [{ name: 'js', inputSchema: { type: 'object' }, description: 'engine' }] } }) + '\n');
    const names = replies.find(r => r.id === 1).result.tools.map(t => t.name);
    for (const name of ['js', 'browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs']) assert.ok(names.includes(name), name);
    await f.bridge.bind({ ...f.bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'read' });
    clientIn.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(replies.find(r => r.id === 2).result.content[0].text, 'plain result');
  } finally { relay?.dispose(); await f.bridge.detach(); }
});

test('a real inherited fork channel exchanges frames and exits after owned disconnect', async () => {
  const { fork } = await import('node:child_process');
  let child, exited;
  const bridge = await createV3Bridge({ startupTimeoutMs: 5000, timeoutMs: 5000 }, {
    readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker(path, args, options) {
      child = fork(new URL('./fixtures/v3-worker.mjs', import.meta.url), [], options);
      exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      return child;
    },
  });
  try {
    await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'actualfork', text: 'read fixture' });
    const result = await bridge.call({ name: 'browser_read', arguments: { tab: 't1' } });
    assert.equal(result.text, 'fork read for actualfork');
    bridge.delivered(result);
  } finally { await bridge.detach(); }
  const outcome = await exited;
  assert.equal(outcome.signal, null); assert.equal(outcome.code, 0);
});
