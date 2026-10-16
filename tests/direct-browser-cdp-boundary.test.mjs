import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
const globalCommands = ['Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.getAllCookies',
  'Network.deleteCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies',
  'Network.enableDeviceBoundSessions', 'Network.deleteDeviceBoundSession', 'Page.deleteCookie', 'Page.setDownloadBehavior'];
function fixture({ delayedInfo = false } = {}) {
  const listeners = new Set(), calls = []; let finishInfo;
  const info = { targetId: 'owned', type: 'page', title: 'Owned fixture', url: 'about:blank' };
  const upstream = { sessionId: 'root', on: (name, fn) => listeners.add(fn), off: (name, fn) => listeners.delete(fn),
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
      if (method === 'Target.attachToTarget') {
        if (!delayedInfo) emit({ method: 'Target.attachedToTarget', params: { sessionId: 'owned-route', targetInfo: info, waitingForDebugger: false } });
        return { sessionId: 'owned-route' };
      }
      if (method === 'Target.getTargetInfo') return delayedInfo ? new Promise(resolve => { finishInfo = resolve; }) : { targetInfo: info };
      if (['Target.detachFromTarget', 'Runtime.enable', ...globalCommands].includes(method)) return {};
      throw Error('unknown fake method: ' + method);
    } };
  const emit = event => { for (const fn of listeners) fn(event); };
  return { upstream, calls, emit, resolveInfo: () => finishInfo({ targetInfo: info }), infoPending: () => !!finishInfo };
}
for (const method of globalCommands) {
  test('review: refuses browser-wide ' + method + ' even on an owned page route', async t => {
    const f = fixture(), filter = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
    await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true }); f.calls.length = 0;
    let refused = false;
    try { await filter.session.send(method, {}, 'owned-route'); } catch (error) { refused = /CDP_COMMAND_REFUSED/.test(error.message); }
    t.diagnostic(JSON.stringify({ method, refused, forwarded: f.calls.map(call => call.method) }));
    assert.equal(refused, true); assert.equal(f.calls.length, 0);
  });
}
test('review: release during attachment metadata lookup still detaches the acquired session', async t => {
  const f = fixture({ delayedInfo: true }), filter = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'] });
  t.after(() => filter.dispose());
  const attaching = filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  while (!f.infoPending()) await new Promise(resolve => setImmediate(resolve));
  filter.release('owned'); f.resolveInfo();
  await assert.rejects(attaching, /CDP_TARGET_NOT_OWNED/);
  const disposed = await filter.dispose(), detached = f.calls.some(call => call.method === 'Target.detachFromTarget' && call.params.sessionId === 'owned-route');
  t.diagnostic(JSON.stringify({ disposed, detached, calls: f.calls.map(call => call.method) }));
  assert.equal(detached, true, 'the acquired route cannot disappear from cleanup while its metadata is pending');
});

test('browser-wide commands are refused by the private WebSocket bridge too', { timeout: 5000 }, async t => {
  const f = fixture(), filter = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'] });
  const bridge = await filter.listen();
  const { ws } = createRequire(import.meta.url)('../plugins/sleight/vendor/playwright-core/lib/utilsBundle.js');
  const socket = new ws(bridge.endpoint);
  t.after(async () => { socket.terminate(); await bridge.close(); await filter.dispose(); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let serial = 0;
  const send = (method, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial, receive = data => { const reply = JSON.parse(data.toString()); if (reply.id !== id) return;
      clearTimeout(timer); socket.off('message', receive); resolve(reply); };
    const timer = setTimeout(() => { socket.off('message', receive); reject(Error('fixture reply timed out')); }, 1000);
    socket.on('message', receive);
    socket.send(JSON.stringify({ id, method, params: method === 'Target.attachToTarget' ? { targetId: 'owned', flatten: true } : {},
      ...(sessionId ? { sessionId } : {}) }));
  });
  assert.equal((await send('Target.attachToTarget')).result.sessionId, 'owned-route');
  f.calls.length = 0;
  for (const method of globalCommands) assert.equal((await send(method, 'owned-route')).error?.message, 'CDP_COMMAND_REFUSED', method);
  assert.deepEqual(f.calls, []);
});
test('review: target destruction revokes nested routes, preserving the owned parent', async t => {
  const f = fixture(), filter = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  for (const [parent, child] of [['owned-route', 'child'], ['child', 'grandchild']])
    f.emit({ method: 'Target.attachedToTarget', sessionId: parent, params: { sessionId: child, targetInfo: { targetId: child, type: 'iframe', url: 'about:blank' }, waitingForDebugger: false } });
  f.emit({ method: 'Target.targetDestroyed', params: { targetId: 'child' } }); f.calls.length = 0;
  let refused = false; try { await filter.session.send('Runtime.enable', {}, 'grandchild'); } catch { refused = true; }
  t.diagnostic(JSON.stringify({ refused, parentOwned: filter.owns('owned'), childOwned: filter.owns('child'), grandchildOwned: filter.owns('grandchild'), calls: f.calls.map(call => call.route) }));
  assert.equal(refused, true); assert.equal(filter.owns('owned'), true);
});
