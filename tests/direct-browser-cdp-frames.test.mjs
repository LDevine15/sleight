import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

// The filter's frame sessions: the iframe sessions of an owned page get the caller's scripts before they are resumed, can be listed
// and asked a fixed expression, and are the page's own (never another page's).
const page = { targetId: 'owned', type: 'page', title: '', url: 'about:blank' };
const frame = (targetId, url = '') => ({ targetId, type: 'iframe', title: '', url });
function fixture({ failScript = false } = {}) {
  const listeners = new Set(), calls = [], scripts = new Map();
  let identifier = 0;
  const emit = event => { for (const fn of listeners) fn(event); };
  const upstream = { sessionId: 'root', on: (name, fn) => listeners.add(fn), off: (name, fn) => listeners.delete(fn),
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
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
