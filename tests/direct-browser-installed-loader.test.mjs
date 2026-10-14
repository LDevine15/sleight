import test from 'node:test';
import assert from 'node:assert/strict';
import { installedFixture } from './fixtures/direct-browser-installed-runtime.mjs';
import * as launch from '../plugins/sleight/lib/launch.mjs';
test('installed launcher opt-in drives open, delivered read, fill and submit on strict fake CDP', async t => {
  const f = await installedFixture(t), direct = await f.begin();
  assert.equal(typeof launch.prepareInstalledBrowser, 'function', 'ordinary launcher binding missing');
  const prepared = await launch.prepareInstalledBrowser(f.runtime);
  assert.equal(prepared.directBrowser, direct);
  const opened = await direct.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  assert.match(opened.tab ?? '', /^t[A-Za-z0-9_-]+$/, JSON.stringify(opened));
  const read = await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } });
  assert.equal(read.effect, 'verified', JSON.stringify(read)); assert.equal(direct.delivered(read), true);
  const ref = role => read.observation.data.find(row => row.role === role).ref;
  const filled = await direct.call({ name: 'browser_fill', arguments: { tab: opened.tab, fields: [{ ref: ref('textbox'), value: 'Example' }] } });
  assert.equal(filled.effect, 'verified', JSON.stringify(filled)); assert.equal(f.value(), 'Example');
  const acted = await direct.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref: ref('button') } });
  assert.equal(acted.error.effect, 'unknown', JSON.stringify(acted));
  assert.equal(f.calls.some(c => ['Page.bringToFront', 'Target.activateTarget'].includes(c.method)), false);
});
test('authenticated next turn replaces the frontend and revokes prior handles without asking opt-in again', async t => {
  const f = await installedFixture(t), first = await f.begin();
  const opened = await first.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  const second = await f.begin('next', 'Read another form.');
  assert.notEqual(second, first); assert.equal(second.ownership.turn, 'next');
  assert.equal((await first.call({ name: 'browser_read', arguments: { tab: opened.tab } })).error.effect, 'none');
  assert.equal((await second.call({ name: 'browser_read', arguments: { tab: opened.tab } })).error.effect, 'none');
  assert.equal(f.runtime.userMessage().text, 'Read another form.');
});
test('wrong private nonce and project-like configuration cannot enable or rebind installed runtime', async t => {
  const f = await installedFixture(t);
  f.hostRead.write(JSON.stringify({ ...f.hostFrames[0], nonce: 'forged', event: 'begin', turn: 'turn', text: 'Pay' }) + '\n');
  assert.equal(f.runtime.userMessage(), null); assert.equal(f.calls.length, 0);
  await assert.rejects(launch.prepareInstalledBrowser({ ready: () => {} }), /TRUSTED_ROUTE_REQUIRED/);
});
test('private pipe loss revokes the route synchronously and retains uncertain submit targets', async t => {
  const f = await installedFixture(t), direct = await f.begin();
  const opened = await direct.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  const read = await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } }); direct.delivered(read);
  const ref = read.observation.data.find(row => row.role === 'button').ref;
  await direct.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref } });
  f.hostRead.end();
  await new Promise(r => setImmediate(r));
  assert.equal((await direct.call({ name: 'browser_read', arguments: { tab: opened.tab } })).error.effect, 'none');
  const receipt = await f.runtime.close();
  assert.ok(receipt.cleanup.some(row => row.resource === 'owned-target' && row.status === 'retained'));
});
test('replaying an authenticated begin frame cannot create another frontend for the same turn', async t => {
  const f = await installedFixture(t), first = await f.begin();
  const replay = await f.begin();
  assert.equal(replay, first); assert.equal(first.ownership.turn, 'turn');
});
