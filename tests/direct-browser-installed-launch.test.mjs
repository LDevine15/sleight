import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInstalledStartup, turboState, createInstalledBrowserBridge } from '../plugins/sleight/lib/launch.mjs';
import { createInstalledFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';

test('ordinary installed startup stays off without an operator setting', async () => {
  const value = await prepareInstalledStartup(() => null);
  assert.equal(value.directBrowser, undefined);
  assert.equal(value.directHost, undefined);
});
test('installed startup refuses a project supplied frontend or bridge', async () => {
  assert.throws(() => createInstalledFrontend({ browser: 'bfixture', call() {} }), /TRUSTED_ROUTE_REQUIRED/);
  await assert.rejects(prepareInstalledStartup(() => ({ browser: 'bfixture' })), /TRUSTED_ROUTE_REQUIRED/);
});
test('turbo discovery exposes only operator enablement and never receipt or profile data', () => {
  assert.deepEqual(turboState(() => null), { enabled: false });
  assert.deepEqual(turboState(() => ({ receipt: 'private', profileRoot: 'private', enabled: true })), { enabled: true });
  assert.deepEqual(turboState(() => { throw Error('unsafe'); }), { enabled: false });
});
test('unavailable selected connection keeps the ordinary engine route with a typed notice', async () => {
  const notices = [];
  const value = await prepareInstalledStartup(() => { throw Error('SELECTED_ENDPOINT_UNPROVED'); }, code => notices.push(code));
  assert.equal(value.directBrowser, undefined); assert.deepEqual(notices, ['SELECTED_ENDPOINT_UNPROVED']);
});
test('launcher stderr names the v2 turbo or engine route that actually started', async t => {
  const messages=[];t.mock.method(process.stderr,'write',text=>{messages.push(text);return true;});
  const bridge={};
  assert.equal(await createInstalledBrowserBridge({v3:async()=>{throw Error('V3_RUNTIME_UNAVAILABLE');},v2:async()=>bridge}),bridge);
  assert.match(messages.pop(),/using v2 turbo/);
  await prepareInstalledStartup(()=>{throw Error('INSTALLED_WORKER_UNAVAILABLE');});
  assert.match(messages.pop(),/using the engine/);
  assert.equal(await createInstalledBrowserBridge({v3:async()=>{throw Error('V3_WORKER_UNAVAILABLE');},v2:async()=>null}),null);
  assert.match(messages.pop(),/using the engine/);
});
for(const code of ['HOST_PACKAGE_MISMATCH','HOST_SOURCE_MISMATCH','HOST_CACHE_UNSAFE']) test('launcher stops on '+code,async()=>{
  await assert.rejects(prepareInstalledStartup(()=>{throw Error(code);}),new RegExp(code));
  await assert.rejects(createInstalledBrowserBridge({v3:async()=>{throw Error(code);},v2:async()=>assert.fail('unsafe fallback')}),new RegExp(code));
});
