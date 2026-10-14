import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { installedFixture } from './fixtures/direct-browser-installed-runtime.mjs';
import { createInstalledBridge } from '../plugins/sleight/lib/direct-browser/installed-bridge.mjs';
import { serveInstalledWorker } from '../plugins/sleight/lib/direct-browser/installed-worker.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';

test('ordinary installed frontend joins genuine turn, exact delivered read, fill and submit through private worker pipes', async t => {
  const f = await installedFixture(t), read = new PassThrough(), write = new PassThrough(), child = new EventEmitter();
  child.stdio = [null, null, null, read, write];
  t.after(() => { read.destroy(); write.destroy(); });
  const bridge = await createInstalledBridge({}, { readConfig: () => ({ enabled: true }),
    acceptPackage: () => ({ inventory: f.packageInventory, current: f.packageInventory.current }),
    spawnWorker() {
      queueMicrotask(() => serveInstalledWorker({ read, write, runtime: f.runtime, control: { read: f.hostRead },
        hello: f.hostFrames[0], browser: 'bfixture' }));
      return child;
    } });
  const prepared = await prepareInstalledStartup(() => bridge), direct = prepared.directBrowser;
  const binding = bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn', text: 'Fill Name with Example, then submit.' });
  await f.enable(); assert.equal(await binding, true);
  assert.equal(f.runtime.userMessage().text, 'Fill Name with Example, then submit.');
  const opened = await direct.call({ name: 'browser_open', arguments: { browser: direct.browser, url: 'https://fixture.invalid' } });
  assert.match(opened.tab ?? '', /^t[A-Za-z0-9_-]+$/, JSON.stringify(opened));
  const readResult = await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } });
  assert.equal(readResult.effect, 'verified', JSON.stringify(readResult));
  assert.equal(direct.delivered(readResult), false);
  const ref = role => readResult.observation.data.find(row => row.role === role).ref;
  const filled = await direct.call({ name: 'browser_fill', arguments: { tab: opened.tab, fields: [{ ref: ref('textbox'), value: 'Example' }] } });
  assert.equal(filled.effect, 'verified', JSON.stringify(filled)); assert.equal(f.value(), 'Example');
  const submit = await direct.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref: ref('button') } });
  assert.equal(submit.error.effect, 'unknown', JSON.stringify(submit));
  const clicks = f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length;
  const fresh = await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } });
  direct.delivered(fresh);
  const nextRef = fresh.observation.data.find(row => row.role === 'button').ref;
  await direct.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref: nextRef } });
  assert.equal(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').length, clicks + 2,
    'actual worker-held read acknowledgment did not clear unknown-submit recovery');
  assert.equal(f.calls.some(call => ['Page.bringToFront', 'Target.activateTarget'].includes(call.method)), false);
  const deliveryFrame = JSON.stringify(bridge.bootstrapEnvelope());
  for (const result of [opened, readResult, filled, submit]) assert.equal(JSON.stringify(result).includes(deliveryFrame), false);
  const ended = await bridge.endTurn();
  assert.ok(ended.cleanup.some(row => row.resource === 'owned-target' && row.status === 'retained'));
  assert.equal((await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } })).error.code, 'LEASE_LOST');
});
