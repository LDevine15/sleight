import test from 'node:test';
import assert from 'node:assert/strict';
import { app, identity, recipe, page, fakeUpstream } from './fixtures/electron-graph.mjs';

const moduleURL = new URL('../plugins/sleight/lib/direct-browser/electron-targets.mjs', import.meta.url);
async function load() {
  let module;
  try { module = await import(moduleURL); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof module?.createAppTargets, 'function', 'EPV3-3 must provide app target admission');
  return module;
}
const started = async (initial, options = {}) => {
  const { createAppTargets } = await load(), f = fakeUpstream(initial);
  const targets = createAppTargets({ upstream: f.session, identity, expected: app, recipe, verify: async () => true, ...options });
  await targets.start();
  return { f, targets };
};

test('only top-level app documents are members; DevTools, workers, webviews, extensions and foreign schemes are not', async () => {
  const { classifyTarget } = await load();
  const kinds = Object.fromEntries([
    ['main', page('a', 'app://main/index.html')],
    ['file', page('b', 'file:///Applications/Fixture.app/Contents/Resources/app/index.html')],
    ['web', page('c', 'https://chat.example/')],
    ['devtools', page('d', 'devtools://devtools/bundled/inspector.html')],
    ['extension', page('e', 'chrome-extension://abc/page.html')],
    ['blank', page('f', 'about:blank')],
    ['data', page('g', 'data:text/html,hi')],
    ['http', page('h', 'http://127.0.0.1:3000/')],
    ['outside', page('i', 'file:///Users/someone/notes.html')],
    ['iframe', { ...page('j'), type: 'iframe' }],
    ['worker', { ...page('k'), type: 'worker' }],
    ['service', { ...page('l'), type: 'service_worker' }],
    ['shared', { ...page('m'), type: 'shared_worker' }],
    ['webview', { ...page('n'), type: 'webview' }],
    ['browser', { ...page('o'), type: 'browser' }],
    ['other', { ...page('p'), type: 'other' }],
    ['malformed', { type: 'page', url: 'app://main/' }],
  ].map(([name, info]) => [name, classifyTarget(info, recipe).kind]));
  assert.deepEqual(kinds, { main: 'member', file: 'member', web: 'member', devtools: 'hidden', extension: 'hidden', blank: 'hidden',
    data: 'hidden', http: 'hidden', outside: 'hidden', iframe: 'hidden', worker: 'lifecycle', service: 'lifecycle', shared: 'lifecycle',
    webview: 'hidden', browser: 'hidden', other: 'hidden', malformed: 'hidden' });
});

test('start checks the pipe identity against the opted-in instance: a second same-bundle process or a reused PID is refused', async () => {
  const { createAppTargets } = await load();
  for (const expected of [{ ...app, pid: 4200 }, { ...app, pidBirth: '1700000999.000001' }]) {
    const f = fakeUpstream([page('a')]);
    const targets = createAppTargets({ upstream: f.session, identity, expected, recipe, verify: async () => true });
    await assert.rejects(targets.start(), /ELECTRON_IDENTITY_CHANGED/);
    assert.deepEqual(f.calls, [], 'nothing is sent before identity holds');
  }
  const f = fakeUpstream([page('a')]);
  const targets = createAppTargets({ upstream: f.session, identity, expected: app, recipe, verify: async () => false });
  await assert.rejects(targets.start(), /ELECTRON_IDENTITY_CHANGED/);
  assert.throws(() => createAppTargets({ upstream: f.session, identity, expected: app, recipe: { schemes: ['https'] }, verify: async () => true }), /INVALID_APP_RECIPE/);
});

test('members carry a creation epoch; DevTools and workers never get an attach, and geometry refuses them before any send', async () => {
  const { f, targets } = await started([page('a'), page('d', 'devtools://devtools/inspector.html'), { ...page('w'), type: 'service_worker' }]);
  assert.deepEqual(targets.members().map(row => row.targetId), ['a']);
  assert.deepEqual(targets.lifecycle().map(row => [row.targetId, row.type]), [['w', 'service_worker']]);
  const before = f.calls.length;
  await assert.rejects(targets.geometry('d'), /ELECTRON_TARGET_NOT_MEMBER/);
  await assert.rejects(targets.geometry('w'), /ELECTRON_TARGET_NOT_MEMBER/);
  await assert.rejects(targets.geometry('nobody'), /ELECTRON_TARGET_NOT_MEMBER/);
  assert.equal(f.calls.length, before);
  const g = await targets.geometry('a');
  assert.deepEqual(g, { x: 0, y: 0, width: 800, height: 600, scale: 2, visible: true });
  assert.deepEqual(f.attaches(), ['a']);
  assert.equal(f.calls.find(row => row.method === 'Page.createIsolatedWorld').params.grantUniveralAccess, false);
  targets.stop();
});

test('a recycled target ID is a new epoch, and destruction revokes synchronously inside the event', async () => {
  const { f, targets } = await started([page('a')]);
  const first = targets.record('a');
  const revoked = [];
  targets.onRevoke(id => revoked.push([id, targets.current('a', first.epoch)]));
  f.destroy('a');
  assert.deepEqual(revoked, [['a', false]], 'listeners run before the event returns and see the old epoch dead');
  f.create(page('a'));
  const second = targets.record('a');
  assert.ok(second.epoch > first.epoch);
  assert.equal(targets.current('a', first.epoch), false);
  assert.equal(targets.current('a', second.epoch), true);
  f.emit({ method: 'Target.targetCrashed', params: { targetId: 'a', status: 'crashed', errorCode: 1 } });
  assert.equal(targets.current('a', second.epoch), false);
  assert.equal(revoked.length, 2);
});

test('navigation to a non-member document revokes; a foreign opener grants nothing; malformed and oversize graphs are bounded', async () => {
  const { f, targets } = await started([page('a')], { maxTargets: 3 });
  const revoked = []; targets.onRevoke(id => revoked.push(id));
  f.change(page('a', 'https://chat.example/'));
  assert.deepEqual(revoked, [], 'a real HTTPS document is still an app window');
  f.change(page('a', 'devtools://devtools/inspector.html'));
  assert.deepEqual(revoked, ['a']);
  f.create(page('p', 'chrome-extension://x/popup.html', { openerId: 'a' }));
  assert.equal(targets.record('p')?.kind, 'hidden', 'an opener ID is corroboration, never membership');
  f.create(page('q', 'app://main/second.html', { openerId: 'not-in-this-app' }));
  assert.equal(targets.record('q').kind, 'member', 'membership never depends on the opener');
  f.emit({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page' } } });
  f.emit({ method: 'Target.targetCreated', params: { targetInfo: page('r'), extra: true }, sessionId: 'child' });
  assert.equal(targets.record('r'), undefined, 'events from child sessions never change the graph');
  f.create(page('s')); f.create(page('t'));
  assert.ok(targets.members().length <= 3);
  assert.equal(targets.record('t'), undefined, 'targets past the bound are not tracked');
  assert.equal(targets.overflow(), true);
});

test('grants need a current member; the filter hooks admit only a granted target at its granted epoch', async () => {
  const { f, targets } = await started([page('a'), page('d', 'devtools://devtools/x.html')]);
  const a = targets.record('a');
  assert.throws(() => targets.grant('d', 1, { id: 1, epoch: 1 }), /ELECTRON_TARGET_NOT_MEMBER/);
  assert.throws(() => targets.grant('a', a.epoch + 1, { id: 1, epoch: 1 }), /ELECTRON_TARGET_NOT_MEMBER/);
  assert.equal(await targets.filterHooks.admit({ targetId: 'a', type: 'page' }), false, 'no grant, no admission');
  targets.grant('a', a.epoch, { id: 7, epoch: 2 });
  assert.equal(await targets.filterHooks.admit({ targetId: 'a', type: 'page', url: 'app://main/index.html' }), true);
  assert.equal(targets.filterHooks.current('a'), true);
  assert.deepEqual(targets.granted('a'), { epoch: a.epoch, window: { id: 7, epoch: 2 } });
  f.destroy('a');
  assert.equal(targets.filterHooks.current('a'), false);
  assert.equal(targets.granted('a'), undefined);
  f.create(page('a'));
  assert.equal(await targets.filterHooks.admit({ targetId: 'a', type: 'page' }), false, 'the recycled ID carries no old grant');
});

test('geometry reads are fenced to the epoch: a target replaced during the read gives no geometry', async () => {
  const { f, targets } = await started([page('a')]);
  f.geometry.set('a', async () => { f.destroy('a'); f.create(page('a')); return { x: 0, y: 0, width: 800, height: 600, scale: 2, visible: true }; });
  await assert.rejects(targets.geometry('a'), /ELECTRON_TARGET_NOT_MEMBER|ELECTRON_TARGET_CHANGED/);
  f.geometry.set('a', { x: 'one', y: 0, width: 800, height: 600, scale: 2, visible: true });
  await assert.rejects(targets.geometry('a'), /ELECTRON_GEOMETRY_INVALID/);
  f.geometry.set('a', { x: 0, y: 0, width: 800, height: 600, scale: 2, visible: true, title: 'secret' });
  await assert.rejects(targets.geometry('a'), /ELECTRON_GEOMETRY_INVALID/);
});

test('the instance fence keeps one mutation owner; others get busy until release, and a park stops everyone', async () => {
  const { createInstanceFence } = await load();
  const fence = createInstanceFence();
  assert.equal(fence.acquire('session-a'), true);
  assert.equal(fence.acquire('session-a'), true);
  assert.equal(fence.acquire('session-b'), false);
  assert.equal(fence.holder(), 'session-a');
  fence.release('session-b');
  assert.equal(fence.holder(), 'session-a', 'only the holder releases');
  fence.release('session-a');
  assert.equal(fence.acquire('session-b'), true);
  fence.park('takeover');
  assert.equal(fence.acquire('session-b'), false);
  assert.equal(fence.parked(), 'takeover');
  assert.throws(() => fence.acquire(''), /INVALID_FENCE_OWNER/);
});

test('sync finds targets the host never announced (lifecycle events go only to a target\'s holder) and drops vanished ones', async () => {
  const { f, targets } = await started([page('a')]);
  const revoked = []; targets.onRevoke(id => revoked.push(id));
  f.targets.set('b', page('b', 'app://main/b.html'));   // a new window, no event
  f.targets.delete('a');                                  // gone, no event
  await targets.sync();
  assert.deepEqual(targets.members().map(row => row.targetId), ['b']);
  assert.deepEqual(revoked, ['a']);
  targets.stop();
  await assert.rejects(targets.sync(), /ELECTRON_IDENTITY_CHANGED/);
});
