import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/direct-browser-open.mjs';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';

async function joined(t, options) {
  const f = await fixture(t, options);
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    selectedBrowser: 'bfixture', status: () => 'connected', redact: v => v, client: f.client,
    onDelivered: value => value.name === 'browser_read' && f.adapter.delivered(f.root.leaseFor(value.tab,
      { session: 'client', turn: 'turn', brokerEpoch: 1, browserIncarnation: 'browser' }), value.observation.observation),
    endSession: async () => { f.root.revokeSession('client'); return { revoked: true, cleanup: (await f.root.cleanupSession('client')).cleanup }; } });
  t.after(() => frontend.end()); return { ...f, frontend };
}
for (const max_bytes of [undefined, 4096, 64000]) test('a bounded page remains useful through the frontend: ' + (max_bytes ?? 'default'), async t => {
  const f = await joined(t, { manyRows: 100 });
  const opened = await f.frontend.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  const read = await f.frontend.call({ name: 'browser_read', arguments: { tab: opened.tab, ...(max_bytes ? { max_bytes } : {}) } });
  assert.equal(read.effect, 'verified', JSON.stringify(read));
  assert.ok(read.observation.data?.length > 1, 'page rows and actionable refs must survive the receipt budget');
  assert.ok(Buffer.byteLength(JSON.stringify(read)) <= (max_bytes ?? 12000));
  assert.equal(read.observation.complete, false);
  assert.match(read.observation.note, /more with scope or max_bytes/);
  assert.equal(f.frontend.delivered(read), true);
  const row = read.observation.data.find(row => row.role === 'textbox');
  const fill = await f.frontend.call({ name: 'browser_fill', arguments: { tab: opened.tab, fields: [{ ref: row.ref, value: 'Delivered' }] } });
  assert.equal(fill.effect, 'verified', JSON.stringify(fill));
});
test('production four-tool flow must open an owned background tab before reading it', async t => {
  const f = await joined(t);
  const result = await f.frontend.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  assert.match(result.tab ?? '', /^t[A-Za-z0-9_-]+$/, JSON.stringify(result));
  assert.ok(f.calls.some(c => c.method === 'Target.createTarget' && c.params.background === true));
  const read = await f.frontend.call({ name: 'browser_read', arguments: { tab: result.tab } });
  assert.equal(read.effect, 'verified', JSON.stringify(read)); assert.equal(f.frontend.delivered(read), true);
  const ref = role => read.observation.data.find(row => row.role === role).ref;
  const fill = await f.frontend.call({ name: 'browser_fill', arguments: { tab: result.tab, fields: [{ ref: ref('textbox'), value: 'Example' }] } });
  assert.equal(fill.effect, 'verified', JSON.stringify(fill)); assert.equal(f.value(), 'Example');
  const submit = await f.frontend.call({ name: 'browser_act', arguments: { tab: result.tab, op: 'click', ref: ref('button') } });
  assert.equal(submit.error.effect, 'unknown', JSON.stringify(submit));
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 2);
  assert.equal(f.calls.some(c => ['Page.bringToFront', 'Target.activateTarget'].includes(c.method)), false);
});
test('semantic allocator cleanup retains authenticated pending leases before any target close', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; }); t.after(() => finish());
  const f = await fixture(t, { send(method) { if (method === 'Input.dispatchMouseEvent') return pending; } });
  const opened = await f.client.request({ id: 'open', operation: 'browser_open', args: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  const read = await f.client.request({ id: 'read', operation: 'browser_read', args: { tab: opened.tab } });
  const binding = { session: 'client', turn: 'turn', brokerEpoch: 1, browserIncarnation: 'browser' };
  const lease = f.root.leaseFor(opened.tab, binding);
  assert.equal(f.adapter.delivered(lease, read.observation.observation), true);
  const action = f.client.request({ id: 'held', operation: 'browser_act', args: { tab: opened.tab, op: 'click', ref: read.observation.data.find(row => row.role === 'button').ref } });
  for (let i = 0; i < 50 && !f.calls.some(c => c.method === 'Input.dispatchMouseEvent'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(c => c.method === 'Input.dispatchMouseEvent'));
  const retainedTargets = f.owner.pendingOperations('client').map(row => row.lease);
  f.client.disconnect();
  const first = await f.adapter.cleanupSession('client', { retainedTargets });
  assert.ok(first.cleanup.some(row => row.target === 'owned' && row.code === 'EFFECT_UNKNOWN'));
  assert.equal(f.calls.some(c => c.method === 'Target.closeTarget'), false);
  assert.equal((await action).effect, 'unknown'); finish(); await new Promise(resolve => setImmediate(resolve));
  await f.adapter.cleanupSession('client');
  assert.equal(f.calls.some(c => c.method === 'Target.closeTarget'), false);
});
