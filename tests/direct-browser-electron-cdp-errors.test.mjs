const MAC_USERS = '/' + 'Users/';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilterTransport } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { errorFrame } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { staleDOMReference } from '../plugins/sleight/lib/direct-browser/electron-cdp-errors.mjs';
import { connectWorker, makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';

test('an expired DOM object keeps its CDP cause through the host and Playwright transport', async t => {
  const h = await makeHost();
  t.after(() => { h.host._crashForTest(); h.state.remove(); });
  await h.host.start({ build: 'fake-build' });
  const { connection } = await connectWorker(h.host);
  const route = await pageSession(connection);
  h.app.hang.add('DOM.describeNode');
  h.app.input.on('data', bytes => {
    for (const raw of bytes.toString().split('\0').filter(Boolean)) {
      const command = JSON.parse(raw);
      if (command.method !== 'DOM.describeNode') continue;
      h.app.emit({ id: command.id, sessionId: command.sessionId,
        error: { code: -32000, message: 'Could not find object with given id' } });
    }
  });
  const transport = createFilterTransport({ session: connection.session });
  t.after(() => transport.close());
  const replies = [];
  transport.onmessage = frame => replies.push(frame);
  transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'expired-utility-object' }, sessionId: route });
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { id: 1, sessionId: route,
    error: { code: -32000, message: 'Could not find object with given id' } });
  assert.equal(h.host.broker.state, 'ready', 'a CDP refusal does not park a healthy app');
  assert.equal(await connection.verifyConnection(connection.session), true);
  assert.equal((await connection.session.send('Runtime.evaluate', {}, route)).ok, true, 'a fresh read remains possible');
  assert.equal(h.app.frames.some(frame => frame.method.startsWith('Input.')), false, 'no retry sends input');
});

test('host CDP errors expose only fixed reasons and numeric protocol codes', () => {
  const cdp = (message, code = -32000) => errorFrame(Object.assign(Error(message), { cdp: true, code }));
  for (const message of ['Could not find object with given id', 'No node with given id found', 'Cannot find context with specified id',
    'Argument should belong to the same JavaScript world as target object']) {
    assert.deepEqual(cdp(message), { code: 'CDP_ERROR', reason: message, protocolCode: -32000, dispatched: true });
  }
  assert.deepEqual(cdp(`secret ${MAC_USERS}fixture/private.html object-123`),
    { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', protocolCode: -32000, dispatched: true });
  assert.deepEqual(cdp(`Could not find object with given id ${MAC_USERS}fixture/private.html`, 'secret'),
    { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', dispatched: true });
});

test('detached and layout errors stay generic at both CDP boundaries to avoid Playwright retries', async () => {
  for (const message of ['Node is detached from document', 'Node does not have a layout object']) {
    const error = Object.assign(Error(message), { cdp: true, code: -32000 });
    assert.deepEqual(errorFrame(error), { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', protocolCode: -32000, dispatched: true });
    const session = { on() {}, off() {}, async send() { throw error; } };
    const transport = createFilterTransport({ session });
    try {
      const reply = new Promise(resolve => { transport.onmessage = resolve; });
      transport.send({ id: 1, method: 'DOM.getContentQuads', params: { objectId: 'expired' }, sessionId: 'owned' });
      assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32000, message: 'CDP_COMMAND_FAILED' } });
    } finally { transport.close(); }
  }
});

test('the Playwright transport never forwards arbitrary error text or invalid codes', async () => {
  const session = { on() {}, off() {}, async send() {
    throw Object.assign(Error(`secret ${MAC_USERS}fixture/private.html`), { cdp: true, code: 'secret' });
  } };
  const transport = createFilterTransport({ session });
  try {
    const reply = new Promise(resolve => { transport.onmessage = resolve; });
    transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'gone' }, sessionId: 'owned' });
    assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32000, message: 'CDP_COMMAND_FAILED' } });
  } finally { transport.close(); }
});

test('numeric CDP errors survive the bridge without exposing an unknown message', async () => {
  const session = { on() {}, off() {}, async send() {
    throw Object.assign(Error(`secret ${MAC_USERS}fixture/private.html`), { cdp: true, code: -32602 });
  } };
  const transport = createFilterTransport({ session });
  try {
    const reply = new Promise(resolve => { transport.onmessage = resolve; });
    transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'gone' }, sessionId: 'owned' });
    assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32602, message: 'CDP_COMMAND_FAILED' } });
  } finally { transport.close(); }
});

test('only a fixed missing DOM reference asks the preflight for a new read', () => {
  assert.equal(staleDOMReference('Protocol error (DOM.describeNode): Could not find object with given id'), true);
  assert.equal(staleDOMReference('Protocol error (DOM.resolveNode): No node with given id found'), true);
  for (const message of ['Protocol error (Runtime.callFunctionOn): Could not find object with given id',
    'Protocol error (DOM.describeNode): CDP_COMMAND_FAILED',
    'Protocol error (DOM.describeNode): Could not find object with given id secret',
    'Protocol error (DOM.describeNode): Argument should belong to the same JavaScript world as target object'])
    assert.equal(staleDOMReference(message), false, message);
});
