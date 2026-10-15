import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

// The filter's frame sessions: the iframe sessions of an owned page get the caller's scripts before they are resumed, can be listed
// and asked a fixed expression, and are the page's own (never another page's).
const page = { targetId: 'owned', type: 'page', title: '', url: 'about:blank' };
const frame = (targetId, url = '') => ({ targetId, type: 'iframe', title: '', url });
function fixture({ failScript = false, failGuardOn, infos = {} } = {}) {
  const listeners = new Set(), calls = [], scripts = new Map();
  let identifier = 0;
  const emit = event => { for (const fn of listeners) fn(event); };
  const upstream = { sessionId: 'root', on: (name, fn) => listeners.add(fn), off: (name, fn) => listeners.delete(fn),
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
      if (method === 'Target.attachToTarget' && params.targetId !== 'owned') return { sessionId: 'read-' + params.targetId };
      if (method === 'Target.getTargetInfo' && params.targetId !== 'owned') return { targetInfo: infos[params.targetId] ?? { targetId: params.targetId, type: 'iframe' } };
      if (method === 'Fetch.enable' && route === failGuardOn) throw Error('guard refused');
      if (method === 'Target.attachToTarget') {
        emit({ method: 'Target.attachedToTarget', params: { sessionId: 'page-session', targetInfo: page, waitingForDebugger: false } });
        return { sessionId: 'page-session' };
      }
      if (method === 'Target.getTargetInfo') return { targetInfo: page };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        if (failScript) throw Error('Session with given id not found.');
        const name = 'script-' + ++identifier; scripts.set(name, { route, source: params.source }); return { identifier: name };
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') { scripts.delete(params.identifier); return {}; }
      if (method === 'Runtime.evaluate') return { result: { value: 'value of ' + params.expression } };

      return {};
    } };
  return { upstream, calls, scripts, emit,
    attachFrame: (sessionId, targetId, waiting = true, parent = 'page-session') =>
      emit({ sessionId: parent, method: 'Target.attachedToTarget', params: { sessionId, targetInfo: frame(targetId), waitingForDebugger: waiting } }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function open(options) {
  const f = fixture(options), filter = createCDPFilter({ session: f.upstream, ownedTargets: ['owned'], protectedPort: 9222 });
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  return { f, filter };
}

test('an iframe session gets the page scripts before it is resumed, and is listed once it is running', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  await filter.frames.addScript('owned', '(hook)()');
  f.calls.length = 0;
  f.attachFrame('frame-session', 'frame-1');
  assert.deepEqual(filter.frames.sessions('owned'), [], 'a frame still being set up is not listed');
  await settle();
  const order = f.calls.filter(call => call.route === 'frame-session').map(call => call.method);
  assert.ok(order.indexOf('Page.addScriptToEvaluateOnNewDocument') >= 0, order.join());
  assert.ok(order.indexOf('Page.enable') >= 0 && order.indexOf('Page.enable') < order.indexOf('Page.addScriptToEvaluateOnNewDocument'), 'the Page domain must be on before the script: ' + order.join());
  assert.ok(order.indexOf('Fetch.enable') < order.indexOf('Runtime.runIfWaitingForDebugger'), order.join());
  assert.ok(order.indexOf('Page.addScriptToEvaluateOnNewDocument') < order.indexOf('Runtime.runIfWaitingForDebugger'), order.join());
  assert.ok(order.indexOf('Target.setAutoAttach') < order.indexOf('Runtime.runIfWaitingForDebugger'), order.join());
  assert.deepEqual(filter.frames.sessions('owned'), ['frame-session']);
});

test('a script added after the frame started is installed there, and remove() takes it out of every session', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); f.attachFrame('nested-session', 'frame-2', false, 'frame-session'); await settle();
  assert.deepEqual(filter.frames.sessions('owned').sort(), ['frame-session', 'nested-session']);
  const added = await filter.frames.addScript('owned', 'lock()');
  assert.deepEqual([...f.scripts.values()].map(entry => entry.route).sort(), ['frame-session', 'nested-session']);
  await added.remove();
  assert.equal(f.scripts.size, 0);
  f.attachFrame('late-session', 'frame-3', false); await settle();
  assert.equal(f.scripts.size, 0, 'a removed script does not follow later frames');
});

test('evaluate answers only for a running iframe session of the page it was asked about', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); await settle();
  assert.equal(await filter.frames.evaluate('owned', 'frame-session', '1+1'), 'value of 1+1');
  await assert.rejects(filter.frames.evaluate('owned', 'page-session', '1'), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(filter.frames.evaluate('owned', 'unknown-session', '1'), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(filter.frames.evaluate('other', 'frame-session', '1'), /CDP_TARGET_NOT_OWNED/);
  assert.throws(() => filter.frames.sessions('other'), /CDP_TARGET_NOT_OWNED/);
});

test('a script that cannot be installed in a running frame fails addScript, and leaves nothing behind', async t => {
  const { f, filter } = await open({ failScript: true }); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); await settle();
  await assert.rejects(filter.frames.addScript('owned', 'x()'), /Session with given id|CDP_FRAME_SCRIPT_FAILED/);
  assert.equal(f.scripts.size, 0);
});

// Reading a frame in another process: the snapshot attaches a session to each iframe target of the page. The filter hands one out
// only for an iframe its own auto-attach chain from an owned page delivered, with the port guard on it before any other command.
const unseen = (f, targetId) => !f.calls.some(call => call.method === 'Target.attachToTarget' && call.params.targetId === targetId);

test('a read session on an owned page iframe gets the port guard first, no hook and no child auto-attach, and Playwright never hears of it', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); await settle();
  await filter.frames.addScript('owned', '(hook)()');
  const events = []; filter.session.on('event', event => events.push(event));
  f.calls.length = 0; f.scripts.clear();
  const { sessionId } = await filter.session.send('Target.attachToTarget', { targetId: 'frame-1', flatten: true });
  assert.equal(sessionId, 'read-frame-1');
  const onSession = f.calls.filter(call => call.route === sessionId).map(call => call.method);
  assert.deepEqual(onSession, ['Fetch.enable']);
  assert.deepEqual(f.calls.find(call => call.route === sessionId).params.patterns, [{ urlPattern: '*://*:9222/*', requestStage: 'Request' }]);
  assert.equal(f.scripts.size, 0, 'the hook belongs to the frame\'s own session');
  // The browser reports the attach and the detach; neither may reach the client (Playwright would adopt the iframe as a new frame).
  f.emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: frame('frame-1'), waitingForDebugger: false } });
  await filter.session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sessionId);
  assert.deepEqual(filter.frames.sessions('owned'), ['frame-session'], 'the read session is not a frame session');
  await assert.rejects(filter.frames.evaluate('owned', sessionId, '1'), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(filter.session.send('Target.setAutoAttach', { autoAttach: true, flatten: true }, sessionId), /CDP_COMMAND_REFUSED/);
  await filter.session.send('Target.detachFromTarget', { sessionId });
  f.emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: 'frame-1' } });
  assert.deepEqual(events, []);
  await assert.rejects(filter.session.send('DOMSnapshot.captureSnapshot', {}, sessionId), /CDP_SESSION_NOT_OWNED/);
});

test('a read session paused request to the protected port is failed like any other session of the page', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); await settle();
  const { sessionId } = await filter.session.send('Target.attachToTarget', { targetId: 'frame-1', flatten: true });
  f.calls.length = 0;
  f.emit({ sessionId, method: 'Fetch.requestPaused', params: { requestId: 'r1', resourceType: 'Document', request: { url: 'http://127.0.0.1:9222/json' } } });
  await settle();
  assert.deepEqual(f.calls.map(call => [call.method, call.route, call.params.errorReason]), [['Fetch.failRequest', sessionId, 'BlockedByClient']]);
  assert.equal(filter.endpointBlocked('owned'), true);
});

test('only an iframe the filter itself attached for an owned page can be read; every other target is refused before any attach', async t => {
  const { f, filter } = await open(); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false);
  f.emit({ sessionId: 'page-session', method: 'Target.attachedToTarget', params: { sessionId: 'worker-session',
    targetInfo: { targetId: 'worker-1', type: 'worker', title: '', url: '' }, waitingForDebugger: false } });
  // Not delivered by an owned session: another tab's frame, a popup, a service worker, the browser, a guess.
  f.emit({ sessionId: 'other-session', method: 'Target.attachedToTarget', params: { sessionId: 'foreign-frame-session', targetInfo: frame('foreign-frame'), waitingForDebugger: false } });
  await settle();
  for (const targetId of ['worker-1', 'foreign-frame', 'foreign-tab', 'popup', 'service-worker', 'sleight-browser', 'guess', '']) {
    await assert.rejects(filter.session.send('Target.attachToTarget', { targetId, flatten: true }), /CDP_TARGET_NOT_OWNED|CDP_ATTACHMENT_INVALID/, targetId);
    assert.ok(unseen(f, targetId), 'Target.attachToTarget was sent upstream for ' + targetId);
  }
  assert.ok((await filter.session.send('Target.attachToTarget', { targetId: 'frame-1', flatten: true })).sessionId);
});

test('a read session is refused when the browser says the target is not an iframe, and when the owner was released', async t => {
  const { f, filter } = await open({ infos: { 'frame-1': { targetId: 'frame-1', type: 'page' }, 'frame-2': { targetId: 'frame-2', type: 'iframe' } } });
  t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); f.attachFrame('frame-session-2', 'frame-2', false); await settle();
  await assert.rejects(filter.session.send('Target.attachToTarget', { targetId: 'frame-1', flatten: true }), /CDP_ATTACHMENT_INVALID/);
  assert.ok(f.calls.some(call => call.method === 'Target.detachFromTarget' && call.params.sessionId === 'read-frame-1'), 'the refused session is detached');
  filter.release('owned');
  await assert.rejects(filter.session.send('Target.attachToTarget', { targetId: 'frame-2', flatten: true }), /CDP_TARGET_NOT_OWNED/);
});

test('a read session whose port guard cannot be installed is detached and never usable', async t => {
  const { f, filter } = await open({ failGuardOn: 'read-frame-1' }); t.after(() => filter.dispose());
  f.attachFrame('frame-session', 'frame-1', false); await settle();
  await assert.rejects(filter.session.send('Target.attachToTarget', { targetId: 'frame-1', flatten: true }), /guard refused/);
  await settle();
  assert.ok(f.calls.some(call => call.method === 'Target.detachFromTarget' && call.params.sessionId === 'read-frame-1'));
  await assert.rejects(filter.session.send('DOMSnapshot.captureSnapshot', {}, 'read-frame-1'), /CDP_SESSION_NOT_OWNED/);
});
