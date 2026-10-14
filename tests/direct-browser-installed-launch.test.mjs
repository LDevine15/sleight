import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInstalledStartup, turboState } from '../plugins/sleight/lib/launch.mjs';
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
