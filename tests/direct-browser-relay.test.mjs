import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { directBrowserServer } from '../plugins/sleight/lib/launch.mjs';

async function route(options = {}) {
  return createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true, status: () => 'connected',
    redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    client: { request: () => ({ phase: 'verified', effect: 'verified', completed: 1, untouched: 0,
      observation: { complete: true }, results: [{ effect: 'verified', observation: { complete: true } }] }) }, ...options });
}
function harness(t, directBrowser, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, records] of [[serverIn, sent], [clientOut, received]]) stream.on('data', b => records.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, directBrowser, changeReview: false, ...options });
  t.after(() => relay.close());
  return { relay, sent, received, clientOut,
    send: message => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'),
    reply: message => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') };
}
test('turbo keeps browser and computer engine authority without changing the default config', async () => {
  const server = { command: 'synthetic-engine', env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer', other: 'kept' } };
  assert.equal(directBrowserServer(server), server);
  assert.throws(() => directBrowserServer(server, { approved: true }), /TRUSTED_ROUTE_REQUIRED/);
  const selected = directBrowserServer(server, await route());
  assert.equal(selected.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(selected.env.other, 'kept');
});
test('relay advertises four verbs and handles them without engine native leases', async t => {
  const h = harness(t, await route());
  h.send({ id: 1, method: 'tools/list' });
  h.reply({ id: 1, result: { tools: [{ name: 'js', description: 'native engine JS' }, { name: 'turn_ended' }] } });
  assert.deepEqual(h.received.at(-1).result.tools.filter(t => t.name.startsWith('browser_')).map(t => t.name),
    ['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
  for (const tool of h.received.at(-1).result.tools.filter(tool => tool.name.startsWith('browser_'))) {
    assert.equal(tool.inputSchema.type, 'object');
    for (const key of ['oneOf', 'anyOf', 'allOf']) assert.equal(Object.hasOwn(tool.inputSchema, key), false, tool.name);
  }
  const before = h.sent.length;
  h.send({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.sent.length, before);
  assert.equal(JSON.parse(h.received.at(-1).result.content[0].text).completed, 1);
  await h.relay.close();
  h.send({ id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.received.at(-1).result.isError, true);
});
test('an unbranded project object cannot install a direct route', t => {
  assert.throws(() => harness(t, { approved: true }), /TRUSTED_ROUTE_REQUIRED/);
});

test('Stop synchronously revokes direct work and reports retained browser resources', async t => {
  let finish, revoked = false, reported;
  const frontend = await route({ client: { request: () => new Promise(resolve => { finish = resolve; }) },
    endSession: () => { revoked = true; return { revoked: true, cleanup: [{ resource: 'owned-target', target: 'target', status: 'retained' }] }; } });
  t.after(() => finish?.({ completed: 1, effect: 'verified', observation: { complete: true } }));
  const h = harness(t, frontend, { stopGraceMs: 2, stopEngine: async () => ({ collected: true }),
    inspectInput: async () => ({ ok: true }), onStopReported: value => { reported = value; } });
  h.send({ id: 1, method: 'tools/call', params: { name: 'browser_act', arguments: { tab: 't1', op: 'click', ref: 'r1' } } });
  h.send({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  assert.equal(revoked, true, 'engine collection alone cannot stop direct input');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(reported.inFlight.some(detail => detail.includes('browser_act')));
  assert.equal(reported.directBrowser.cleanup[0].status, 'retained');
  assert.equal(h.received.find(row => row.id === 2).result.isError, true);
  finish({ phase: 'verified', effect: 'verified', completed: 1, observation: { value: 'late-private' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify(h.received), /late-private/);
});
test('engine resume parameters cannot resume a stopped direct frontend', async t => {
  let calls = 0;
  const frontend = await route({ client: { request() { calls++; return { completed: 1, effect: 'verified', observation: { complete: true } }; } } });
  const h = harness(t, frontend);
  await h.relay.close();
  h.send({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_resume: true } } });
  h.send({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(h.received.find(row => row.id === 2).result.isError, true);
});

test('the fixed launcher binds its private turn pipe to the branded frontend', async t => {
  const launch = await import('../plugins/sleight/lib/launch.mjs');
  assert.equal(typeof launch.directBrowserTurnHook, 'function', 'fixed launcher hook is absent');
  const read = new PassThrough(), write = new PassThrough(), frames = []; let ended = false;
  write.on('data', bytes => frames.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const frontend = await route({ endSession: () => { ended = true; return { revoked: true, cleanup: [] }; } });
  const hook = launch.directBrowserTurnHook(frontend, { read, write, session: 'session', turn: 'turn', brokerEpoch: 1 });
  t.after(() => hook.close());
  read.write(JSON.stringify({ ...frames[0], event: 'end' }) + '\n');
  assert.equal(ended, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.at(-1).revoked, true);
  assert.throws(() => launch.directBrowserTurnHook({ approved: true }, { read, write, session: 'session', turn: 'turn', brokerEpoch: 1 }), /TRUSTED_ROUTE_REQUIRED/);
});

test('trusted turbo rules offer both browser paths and keep every native rule', async () => {
  const launch = await import('../plugins/sleight/lib/launch.mjs');
  assert.equal(typeof launch.directBrowserRules, 'function', 'coherent compact guidance is absent');
  const native = launch.skillRules(), frontend = await route({ selectedBrowser: 'bselected' });
  assert.equal(launch.directBrowserRules(native), native);
  const rules = launch.directBrowserRules(native, frontend);
  assert.ok(rules.includes('bselected'));
  assert.match(rules, /browser_open/); assert.match(rules, /browser_fill/);
  assert.match(rules, /cua\.getBrowser/); assert.match(rules, /cua\.createBrowserTab/);
  assert.match(rules, /Each path acts on and closes only its own tabs/);
  const [before, browserAndAfter] = native.split('## Browsers\n');
  const after = browserAndAfter.slice(browserAndAfter.indexOf('\n## '));
  assert.ok(rules.startsWith(before)); assert.ok(rules.endsWith(after));
  assert.match(rules, /Never try to unmask/);
  assert.match(rules, /user asked/); assert.match(rules, /confirmation/);
  assert.ok(rules.trim().split(/\s+/).length <= 930);
  assert.throws(() => launch.directBrowserRules(native, { approved: true }), /TRUSTED_ROUTE_REQUIRED/);
});
test('direct read delivers compact rules once and acknowledges only after its output write', async t => {
  let delivered = 0;
  const frontend = await route({ onDelivered: () => { assert.match(JSON.stringify(h.received.find(row => row.id === 10)), /fresh refs/); delivered++; return true; } });
  const h = harness(t, frontend, { firstCallRules: 'turbo uses fresh refs' });
  // Capture actual client output rather than the broker's preparation reply.
  h.send({ id: 10, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(JSON.stringify(h.received.find(row => row.id === 10)), /fresh refs/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, 1);
  h.send({ id: 11, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify(h.received.find(row => row.id === 11)), /fresh refs/);
});
test('normal fixed turn completion fences turbo before engine dispatch and reports semantic cleanup', async t => {
  let revoked = false;
  const h = harness(t, await route({ endSession: () => { revoked = true; return { revoked: true,
    cleanup: [{ target: 'owned', status: 'retained', resource: 'file-stage' }] }; } }));
  h.send({ id: 20, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } });
  assert.equal(revoked, true, 'normal completion left turbo live');
  assert.equal(h.sent.at(-1).params.name, 'turn_ended');
  h.reply({ id: 20, result: { content: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const result = h.received.find(row => row.id === 20).result;
  assert.equal(result.isError, true);
  assert.equal(result._meta['sleight/directBrowser'].cleanup[0].resource, 'file-stage');
});
test('client output loss revokes an in-flight turbo operation before engine fault handling', async t => {
  let revoked = false, finish, faultSawRevocation;
  const frontend = await route({ client: { request: () => new Promise(resolve => { finish = resolve; }) },
    endSession: () => { revoked = true; return { revoked: true, cleanup: [] }; } });
  t.after(() => finish?.({ completed: 1, effect: 'verified', observation: { complete: true } }));
  const h = harness(t, frontend, { onLeaseFault: () => { faultSawRevocation = revoked; } });
  h.send({ id: 30, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  h.clientOut.emit('error', Error('synthetic output loss'));
  assert.equal(faultSawRevocation, true);
});
