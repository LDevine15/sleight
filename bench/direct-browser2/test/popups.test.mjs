import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { ScopedAttachment as RealAttachment } from '../attachment.mjs';
import { PopupController, popupHook } from '../popups.mjs';
import { DownloadObserver } from '../downloads.mjs';

const identity = Object.freeze({ browserIncarnation: 'browser-1', brokerEpoch: 1,
  clientSession: 'client-1', turn: 1, targetId: 'parent', leaseGeneration: 1,
  frameId: 'frame-1', documentGeneration: 1, operationSequence: 1,
  origin: 'https://fixture.invalid' });
const request = () => ({ ...identity });
class Session extends EventEmitter {
  sessionId = 'root';
  calls = [];
  handler = async () => ({});
  async send(method, params = {}, sessionId = this.sessionId) {
    const allowed = ['Target.autoAttachRelated', 'Target.setAutoAttach', 'Target.detachFromTarget',
      'Target.closeTarget', 'Target.createTarget', 'Runtime.runIfWaitingForDebugger',
      'Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.evaluate', 'Browser.setDownloadBehavior', 'Browser.cancelDownload'];
    assert.ok(allowed.includes(method), `unexpected CDP method ${method}`);
    this.calls.push({ method, params, sessionId });
    return this.handler(method, params, sessionId);
  }
}
const child = (targetId = 'child', openerId = 'parent', type = 'page') => ({
  sessionId: `session-${targetId}`, waitingForDebugger: true,
  targetInfo: { targetId, openerId, type, url: 'https://fixture.invalid/child' },
});
const fence = async () => true;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
class ScopedAttachment extends RealAttachment {
  constructor(options) {
    super({ resolveScope: async (info, parent, origin) => ({ ...parent, origin,
      targetId: info.targetId, frameId: `frame-${info.targetId}`, documentGeneration: 1 }), ...options });
  }
}

test('related registration settling during its clear retains ownership until a later clear', async () => {
  const session = new Session(), started = deferred(), enable = deferred(); let related = false;
  session.handler = async method => {
    if (method === 'Target.autoAttachRelated') { started.resolve(); await enable.promise; related = true; }
    if (method === 'Target.setAutoAttach') {
      related = false; enable.resolve(); await turn();
    }
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {
    assert.fail('closing attachment cannot set up a child');
  }, timeoutMs: 30 });
  const watched = attachment.watch(request()).catch(error => error);
  await started.promise;
  const cleanup = await attachment.dispose(); await watched;
  assert.equal(related, true);
  assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  assert.equal(attachment.closed, false); assert.equal(attachment.roots.size, 1);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 1);
  session.emit('Target.attachedToTarget', child('late')); await attachment.drain();
  assert.equal(attachment.records.get('late').state, 'resumed');
  await attachment.dispose();
  assert.equal(related, false); assert.equal(attachment.closed, true);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});

test('recursive registration settling during its clear keeps the child release owner', async () => {
  const session = new Session(), started = deferred(), enable = deferred(); let enabled = false;
  session.handler = async (method, params, sessionId) => {
    if (method === 'Target.setAutoAttach' && sessionId === 'session-child') {
      if (params.autoAttach) { started.resolve(); await enable.promise; enabled = true; }
      else { enabled = false; enable.resolve(); await turn(); }
    }
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {}, timeoutMs: 30 });
  await attachment.watch(request()); session.emit('Target.attachedToTarget', child());
  await started.promise;
  const cleanup = await attachment.dispose();
  assert.equal(enabled, true);
  assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  assert.equal(attachment.closed, false); assert.equal(attachment.records.get('child').registration, true);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 1);
  session.emit('Target.attachedToTarget', child('grandchild', 'child')); await attachment.drain();
  assert.equal(attachment.records.get('grandchild').state, 'resumed');
  await attachment.dispose();
  assert.equal(enabled, false); assert.equal(attachment.closed, true);
  assert.equal(attachment.records.get('child').registration, false);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});

for (const heldGate of [1, 2, 3, 4]) test(`shutdown fences parent installation authorization gate ${heldGate}`, async () => {
  const session = new Session(), gate = deferred(); let gates = 0;
  session.handler = async method => method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'future' } : { result: { value: true } };
  const controller = new PopupController({ session, authorize: () => ++gates === heldGate ? gate.promise : true });
  const installed = controller.install(request(), { beforeScripts: true }); await turn();
  await controller.dispose(); const count = session.calls.length;
  gate.resolve(true); await installed;
  assert.equal(session.calls.length, count, 'late gate cannot dispatch a setup mutation');
  assert.equal(controller.hooks.size, 0);
});
test('shutdown fences pending watch authorization and future duplicate watches', async () => {
  const session = new Session(), gate = deferred();
  const attachment = new ScopedAttachment({ session, authorize: () => gate.promise, setup: async () => {} });
  const watched = attachment.watch(request()); await turn();
  await attachment.dispose(); gate.resolve(true); await watched;
  assert.equal(attachment.roots.size, 0); assert.equal(session.calls.length, 0);
  await assert.rejects(attachment.watch(request()));
});
test('pending add-script reply retains ownership and supplies its identifier for cleanup retry', async () => {
  const session = new Session(), response = deferred(); let scripts = 0;
  session.handler = async method => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') { const result = await response.promise; scripts++; return result; }
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') scripts--;
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence, timeoutMs: 20 });
  const installed = controller.install(request(), { beforeScripts: true }); await turn();
  const cleanup = await controller.dispose();
  assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  assert.equal(controller.hooks.size, 1); assert.equal(controller.attachment.closed, false);
  await installed; response.resolve({ identifier: 'late-script' }); await turn();
  await controller.dispose();
  assert.equal(scripts, 0); assert.equal(controller.hooks.size, 0);
  assert.equal(session.calls.some(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument' && c.params.identifier === 'late-script'), true);
});
test('pending current-hook reply cannot outlive proved cleanup', async () => {
  const session = new Session(), response = deferred(); let current = false, first = true;
  session.handler = async method => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'future' };
    if (method === 'Runtime.evaluate') {
      if (first) { first = false; await response.promise; current = true; }
      else current = false;
    }
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence, timeoutMs: 20 });
  const installed = controller.install(request(), { beforeScripts: true }); await turn();
  const cleanup = await controller.dispose(); assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  await installed; response.resolve(); await turn(); assert.equal(current, true);
  await controller.dispose(); assert.equal(current, false); assert.equal(controller.hooks.size, 0);
});
test('pending related-registration reply retains root and late-child release coverage', async () => {
  const session = new Session(), response = deferred(); let related = false, setup = 0;
  session.handler = async (method, params) => {
    if (method === 'Target.autoAttachRelated') { await response.promise; related = true; }
    if (method === 'Target.setAutoAttach' && !params.autoAttach) related = false;
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => { setup++; }, timeoutMs: 20 });
  const watched = attachment.watch(request()).catch(error => error); await turn();
  const cleanup = await attachment.dispose();
  assert.ok(cleanup.some(r => r.next === 'cleanup-required')); assert.equal(attachment.closed, false);
  assert.equal(attachment.roots.size, 1); assert.equal(session.listenerCount('Target.attachedToTarget'), 1);
  await watched; response.resolve(); await turn();
  session.emit('Target.attachedToTarget', child('late')); await attachment.drain();
  assert.equal(setup, 0); assert.ok(session.calls.some(c => c.method === 'Runtime.runIfWaitingForDebugger'));
  await attachment.dispose(); assert.equal(related, false); assert.equal(attachment.closed, true);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});
test('concurrent duplicate disposal shares exact cleanup instead of racing hook removal', async () => {
  const session = new Session(), response = deferred();
  session.handler = async method => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'future' };
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') await response.promise;
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  const first = controller.dispose(), second = controller.dispose(); await turn();
  response.resolve(); await Promise.all([first, second]);
  assert.equal(session.calls.filter(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument').length, 1);
  assert.equal(controller.hooks.size, 0);
});
test('pending recursive registration is cleared again after its late response', async () => {
  const session = new Session(), response = deferred(); let enabled = false;
  session.handler = async (method, params, sessionId) => {
    if (method === 'Target.setAutoAttach' && params.autoAttach && sessionId !== 'root') { await response.promise; enabled = true; }
    if (method === 'Target.setAutoAttach' && !params.autoAttach && sessionId !== 'root') enabled = false;
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {}, timeoutMs: 20 });
  await attachment.watch(request()); session.emit('Target.attachedToTarget', child()); await turn();
  await attachment.dispose();
  assert.equal(attachment.closed, false); assert.equal(attachment.records.get('child').registration, true);
  response.resolve(); await turn(); assert.equal(enabled, true);
  await attachment.dispose(); assert.equal(enabled, false); assert.equal(attachment.closed, true);
});
test('a child arriving at the final drain retains release coverage until collection', async () => {
  const session = new Session(), response = deferred();
  session.handler = async method => {
    if (method === 'Runtime.runIfWaitingForDebugger') await response.promise;
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {}, timeoutMs: 20 });
  await attachment.watch(request());
  const drain = attachment.drain.bind(attachment); let drains = 0;
  attachment.drain = async () => { await drain(); if (++drains === 2) session.emit('Target.attachedToTarget', child('late-drain')); };
  const cleanup = await attachment.dispose();
  assert.equal(attachment.closed, false); assert.equal(attachment.roots.size, 1);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 1);
  assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  response.resolve(); await attachment.drain(); await attachment.dispose();
  assert.equal(attachment.closed, true);
});

test('related attachment never enables root setAutoAttach; listeners precede registration', async () => {
  const session = new Session();
  let early = false;
  session.handler = async (method) => {
    if (method === 'Target.autoAttachRelated') {
      early = session.listenerCount('Target.attachedToTarget') === 1;
      session.emit('Target.attachedToTarget', child());
    }
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {}, timeoutMs: 50 });
  await attachment.watch(request());
  await attachment.drain();
  assert.equal(early, true);
  assert.equal(session.calls.some(c => c.method === 'Target.setAutoAttach' && c.sessionId === 'root'), false);
  assert.equal(attachment.records.get('child').state, 'resumed');
  await attachment.dispose();
});

test('unrelated pages receive zero pause, hook, read, input or close commands', async () => {
  const session = new Session();
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {} });
  await attachment.watch(request());
  const before = session.calls.length;
  session.emit('Target.attachedToTarget', { ...child('unrelated', 'other'), waitingForDebugger: false });
  await attachment.drain();
  assert.equal(session.calls.length, before);
  assert.equal(attachment.records.has('unrelated'), false);
  await attachment.dispose();
});

test('same and cross-origin multi-hop children are authorized before hooks and inherit identity, not grants', async () => {
  const session = new Session();
  const sequence = [];
  const attachment = new ScopedAttachment({ session,
    authorize: async (scope) => { sequence.push(`gate:${scope.targetId}:${scope.origin}`); return scope.origin === identity.origin; },
    setup: async (scope) => { sequence.push(`hook:${scope.targetId}`); assert.equal(scope.clientSession, identity.clientSession); },
  });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  await attachment.drain();
  session.emit('Target.attachedToTarget', child('grandchild', 'child'));
  session.emit('Target.attachedToTarget', { ...child('cross', 'child'), targetInfo: {
    ...child('cross', 'child').targetInfo, url: 'https://other.invalid/' } });
  await attachment.drain();
  assert.ok(sequence.indexOf('gate:child:https://fixture.invalid') < sequence.indexOf('hook:child'));
  assert.ok(sequence.includes('hook:grandchild'));
  assert.ok(!sequence.includes('hook:cross'));
  assert.equal(attachment.records.get('cross').state, 'resumed');
  assert.equal(attachment.records.get('cross').receipt.next, 'permission-required');
  await attachment.dispose();
});

test('iframe and worker targets resume without page hooks', async () => {
  const session = new Session();
  let hooks = 0;
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => { hooks++; } });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child('worker', 'parent', 'worker'));
  session.emit('Target.attachedToTarget', child('iframe', 'parent', 'iframe'));
  await attachment.drain();
  assert.equal(hooks, 0);
  assert.equal(attachment.records.get('worker').state, 'resumed');
  assert.equal(attachment.records.get('iframe').receipt.next, 'BACKGROUND_UNAVAILABLE');
  await attachment.dispose();
});

for (const failure of ['throw', 'hang']) test(`child setup ${failure} has bounded resume cleanup`, async () => {
  const session = new Session();
  const attachment = new ScopedAttachment({ session, authorize: fence, timeoutMs: 10,
    setup: async () => { if (failure === 'throw') throw Error('fixture secret'); return new Promise(() => {}); },
  });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  await attachment.drain();
  assert.equal(attachment.records.get('child').state, 'resumed');
  assert.equal(attachment.records.get('child').receipt.effect, 'unknown');
  assert.ok(!JSON.stringify(attachment.records.get('child').receipt).includes('fixture secret'));
  await attachment.dispose();
});

test('failed resume closes only proved owned child and retains unproved cleanup', async () => {
  const session = new Session();
  session.handler = async (method) => {
    if (method === 'Runtime.runIfWaitingForDebugger') throw Error('resume unavailable');
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {},
    proveOwned: async scope => scope.targetId === 'child', proveAbsent: async () => true });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  session.emit('Target.attachedToTarget', child('not-owned'));
  await attachment.drain();
  assert.equal(attachment.records.get('child').state, 'closed');
  assert.equal(attachment.records.get('not-owned').state, 'cleanup-unproved');
  assert.deepEqual(session.calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['child']);
  await attachment.dispose();
});

test('about:blank needs browser-validated creator scope; page-provided origin cannot authorize', async () => {
  const session = new Session();
  let hooks = 0;
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => { hooks++; } });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', { ...child(), targetInfo: { ...child().targetInfo, url: 'about:blank' } });
  await attachment.drain();
  assert.equal(hooks, 0);
  assert.equal(attachment.records.get('child').receipt.next, 'unattributed');
  await attachment.dispose();
});

test('hook keeps original window.open arguments and WindowProxy in observe mode', () => {
  const calls = [];
  const proxy = {};
  const window = { open(...args) { calls.push(args); return proxy; }, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, globalThis: window, Reflect, Symbol });
  vm.runInContext(`(${popupHook})('observe')`, context);
  assert.equal(window.open('', 'named', 'noreferrer,width=400'), proxy);
  assert.equal(window.open('about:blank', 'named', 'noopener'), proxy);
  assert.deepEqual(calls, [['', 'named', 'noreferrer,width=400'], ['about:blank', 'named', 'noopener']]);
});

test('strict hook blocks native opening with explicit unsupported result; restores only its own wrapper', () => {
  let opens = 0;
  const native = () => { opens++; };
  const window = { open: native, addEventListener() {}, removeEventListener() {} };
  vm.runInContext(`(${popupHook})('strict')`, vm.createContext({ window, globalThis: window, Reflect, Symbol }));
  assert.equal(window.open('/next', 'named'), null);
  assert.equal(opens, 0);
  const state = window[Symbol.for('sleight.popup2')];
  assert.equal(state.blocked, 'BACKGROUND_UNAVAILABLE');
  state.off();
  assert.equal(window.open, native);
});

test('parent hook installs future and current document templates before attachment', async () => {
  const session = new Session();
  session.handler = async method => method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'hook-1' } : { result: { value: true } };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  const methods = session.calls.map(c => c.method);
  assert.ok(methods.indexOf('Page.addScriptToEvaluateOnNewDocument') < methods.indexOf('Target.autoAttachRelated'));
  assert.ok(methods.indexOf('Runtime.evaluate') < methods.indexOf('Target.autoAttachRelated'));
  await controller.dispose();
});

test('late hook and opener-dependent strict requests hand off before opening', async () => {
  const session = new Session();
  const controller = new PopupController({ session, authorize: fence });
  assert.equal((await controller.install(request(), { beforeScripts: false })).next, 'BACKGROUND_UNAVAILABLE');
  for (const semantics of ['opener', 'named-window', 'POST', 'noreferrer', 'sandbox', 'OAuth', 'COOP', 'document.write']) {
    const receipt = await controller.openOwned(request(), { url: 'https://fixture.invalid/', semantics });
    assert.equal(receipt.phase, 'prepared');
    assert.equal(receipt.next, 'needs-opener-unqualified');
  }
  assert.equal(session.calls.length, 0);
  await controller.dispose();
});

test('owned independent navigation is fenced immediately before background target creation', async () => {
  const session = new Session();
  session.handler = async () => ({ targetId: 'owned' });
  let gates = 0;
  const controller = new PopupController({ session, authorize: async () => ++gates === 1 });
  const receipt = await controller.openOwned(request(), { url: 'https://fixture.invalid/path?secret=redacted', semantics: 'independent-navigation' });
  assert.equal(receipt.next, 'permission-required');
  assert.equal(session.calls.length, 0);
  await controller.dispose();
});

test('default-context observer never changes user policy; requires verified causal GUID attribution', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence, redactFilename: filename => filename });
  await observer.start();
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'operation-1' });
  observer.begin({ frameId: 'frame-1', guid: 'guid-1', url: 'https://fixture.invalid/file?private=1', suggestedFilename: '../same.txt' });
  assert.equal(observer.get('guid-1').next, 'unattributed');
  await observer.attribute('guid-1', request(), { causalToken: 'operation-1', trusted: true });
  assert.equal(observer.get('guid-1').phase, 'observed');
  assert.equal(observer.get('guid-1').filename, 'same.txt');
  assert.ok(!JSON.stringify(observer.get('guid-1')).includes('private=1'));
  assert.equal(session.calls.length, 0);
  observer.dispose();
});

test('child target without broker document reconciliation is resumed with unattributed handoff', async () => {
  const session = new Session();
  let hooks = 0;
  const attachment = new RealAttachment({ session, authorize: fence, setup: async () => { hooks++; } });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  await attachment.drain();
  assert.equal(hooks, 0);
  assert.equal(attachment.records.get('child').receipt.next, 'unattributed');
  assert.equal(attachment.records.get('child').state, 'resumed');
  await attachment.dispose();
});

test('late setup continuation cannot send after its deadline and resume', async () => {
  const session = new Session();
  let continueSetup;
  let lateError;
  const attachment = new ScopedAttachment({ session, authorize: fence, timeoutMs: 10,
    setup: async (_scope, { send }) => {
      await new Promise(resolve => { continueSetup = resolve; });
      try { await send('Page.enable', {}); } catch (error) { lateError = error.message; }
    } });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  await attachment.drain();
  const count = session.calls.length;
  continueSetup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateError, 'CANCELLED');
  assert.equal(session.calls.length, count);
  await attachment.dispose();
});

test('parent cleanup removes current and future hooks; failures retain exact cleanup identity', async () => {
  const session = new Session();
  session.handler = async method => method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'hook-1' } : { result: { value: true } };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  const cleanup = await controller.dispose();
  assert.equal(cleanup[0].phase, 'verified');
  assert.equal(controller.hooks.size, 0);
  assert.ok(session.calls.some(call => call.method === 'Page.removeScriptToEvaluateOnNewDocument' && call.params.identifier === 'hook-1'));
});

test('default download filenames stay redacted and unknown GUID metadata stays private', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence });
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'a' });
  observer.begin({ guid: 'one', frameId: 'frame-1', suggestedFilename: 'personal-secret.txt', url: 'https://fixture.invalid/?secret' });
  assert.equal(observer.get('one').filename, 'download');
  await observer.attribute('one', request(), { causalToken: 'a', trusted: true });
  assert.equal(observer.get('one').filename, 'download');
  observer.dispose();
});

test('matching filename, URL or frame never selects between concurrent operations', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence });
  await observer.start();
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'a' });
  await observer.arm({ ...request(), operationSequence: 2 }, { frameId: 'frame-1', causalToken: 'b' });
  for (const guid of ['one', 'two']) observer.begin({ frameId: 'frame-1', guid, url: 'https://fixture.invalid/file', suggestedFilename: 'same.txt' });
  assert.equal(observer.get('one').next, 'unattributed');
  assert.equal(observer.get('two').next, 'unattributed');
  assert.equal((await observer.attribute('one', request(), { causalToken: 'a', trusted: false })).next, 'unattributed');
  observer.dispose();
});

test('download terminal state alone never verifies a file; native Save is a handoff', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence });
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'a' });
  observer.begin({ frameId: 'frame-1', guid: 'one', url: 'https://fixture.invalid/file', suggestedFilename: 'same.txt' });
  await observer.attribute('one', request(), { causalToken: 'a', trusted: true });
  observer.progress({ guid: 'one', state: 'completed', receivedBytes: 20, totalBytes: 20, filePath: '/private/secret' });
  assert.equal(observer.get('one').phase, 'observed');
  assert.equal(observer.get('one').next, 'verify-artifact');
  assert.ok(!JSON.stringify(observer.get('one')).includes('/private/secret'));
  assert.equal(observer.nativeSave(request()).next, 'native-save-handoff');
  observer.dispose();
});

test('allowAndName requires owned non-default context; canceled downloads retain terminal state', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence });
  await assert.rejects(observer.start({ mode: 'allowAndName', contextId: '', downloadPath: '/tmp/owned', proveOwnedContext: async () => true }), /owned/);
  await assert.rejects(observer.start({ mode: 'allowAndName', contextId: 'context-1', downloadPath: '/tmp/owned', proveOwnedContext: async () => false }), /owned/);
  assert.equal(session.calls.length, 0);
  await observer.start({ mode: 'allowAndName', contextId: 'context-1', downloadPath: '/tmp/owned', proveOwnedContext: async () => true });
  assert.equal(session.calls[0].params.browserContextId, 'context-1');
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'cancel' });
  observer.begin({ guid: 'cancelled', frameId: 'frame-1', suggestedFilename: 'a.txt', url: 'https://fixture.invalid/file' });
  observer.progress({ guid: 'cancelled', state: 'canceled', receivedBytes: 0, totalBytes: 0 });
  assert.equal(observer.get('cancelled').state, 'canceled');
  observer.dispose();
});

test('revoked download operation cannot cancel or claim another session GUID', async () => {
  const session = new Session();
  let allowed = true;
  const observer = new DownloadObserver({ session, authorize: async () => allowed });
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'a' });
  observer.begin({ guid: 'one', frameId: 'frame-1', suggestedFilename: 'a.txt', url: 'https://fixture.invalid/file' });
  await observer.attribute('one', request(), { causalToken: 'a', trusted: true });
  assert.equal((await observer.cancel('one', { ...request(), clientSession: 'other' })).next, 'permission-required');
  allowed = false;
  assert.equal((await observer.cancel('one', request())).next, 'permission-required');
  assert.equal(session.calls.length, 0);
  observer.dispose();
});

test('truthy approval objects never substitute for an internal authorization verdict', async () => {
  const session = new Session();
  const forged = async () => ({ approved: true });
  const controller = new PopupController({ session, authorize: forged });
  const outcome = await controller.openOwned(request(), { url: 'https://fixture.invalid/', semantics: 'independent-navigation' });
  assert.equal(outcome.next, 'permission-required');
  assert.equal(session.calls.length, 0);
  const observer = new DownloadObserver({ session, authorize: forged });
  await assert.rejects(observer.arm(request(), { frameId: 'frame-1', causalToken: 'forged' }), /PERMISSION_REQUIRED/);
  observer.dispose();
  await controller.dispose();
});

test('unrelated download frame and changed origin are ignored before metadata storage', async () => {
  const session = new Session();
  const observer = new DownloadObserver({ session, authorize: fence });
  await observer.arm(request(), { frameId: 'frame-1', causalToken: 'one' });
  observer.begin({ guid: 'other', frameId: 'other', url: 'https://fixture.invalid/file', suggestedFilename: 'private.txt' });
  observer.begin({ guid: 'redirect', frameId: 'frame-1', url: 'https://other.invalid/file', suggestedFilename: 'private.txt' });
  assert.equal(observer.records.size, 0);
  observer.dispose();
});

test('all repeated script registrations retain exact session and operation ownership', async () => {
  const session = new Session();
  let scripts = 0;
  session.handler = async method => method === 'Page.addScriptToEvaluateOnNewDocument' ?
    { identifier: `hook-${++scripts}` } : { result: { value: true } };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true, sessionId: 'parent-session' });
  await controller.install({ ...request(), operationSequence: 2 }, { beforeScripts: true, sessionId: 'parent-session' });
  const cleanup = await controller.dispose();
  assert.equal(cleanup.filter(r => r.phase === 'verified').length, 2);
  assert.deepEqual(session.calls.filter(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument')
    .map(c => [c.params.identifier, c.sessionId]), [['hook-1', 'parent-session'], ['hook-2', 'parent-session']]);
  assert.equal(controller.hooks.size, 0);
});

test('unknown registration removal still cleans hooks and releases late children without setup', async () => {
  const session = new Session();
  let clearFails = true;
  session.handler = async (method, params) => {
    if (method === 'Target.setAutoAttach' && !params.autoAttach && clearFails) throw Error('clear failed');
    return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'hook-1' } : { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  const cleanup = await controller.dispose();
  assert.ok(cleanup.some(r => r.effect === 'unknown' && r.next === 'cleanup-required'));
  assert.ok(session.calls.some(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  const before = session.calls.length;
  session.emit('Target.attachedToTarget', child('late'));
  await controller.attachment.drain();
  assert.deepEqual(session.calls.slice(before).map(c => c.method), ['Runtime.runIfWaitingForDebugger']);
  assert.equal(session.listenerCount('Target.attachedToTarget'), 1);
  clearFails = false;
  const retried = await controller.dispose();
  assert.ok(retried.every(r => r.phase === 'verified'));
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});

test('future hook removal failure retains ownership while current cleanup and other hooks continue', async () => {
  const session = new Session();
  let scripts = 0;
  let fail = true;
  session.handler = async (method, params) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: `hook-${++scripts}` };
    if (method === 'Page.removeScriptToEvaluateOnNewDocument' && params.identifier === 'hook-1' && fail) throw Error('remove failed');
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  await controller.install({ ...request(), operationSequence: 2 }, { beforeScripts: true });
  const cleanup = await controller.dispose();
  assert.equal(cleanup.filter(r => r.next === 'cleanup-required').length, 1);
  assert.equal(controller.hooks.size, 1);
  assert.equal(session.calls.filter(c => c.method === 'Runtime.evaluate').length, 4);
  fail = false;
  assert.equal((await controller.dispose())[0].phase, 'verified');
  assert.equal(controller.hooks.size, 0);
});

test('hook owners cannot remove another registration or silently change its mode', () => {
  const native = () => 'native';
  const window = { open: native, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, Reflect, Symbol });
  assert.equal(vm.runInContext(`(${popupHook})('observe', 'owner-a')`, context), true);
  assert.equal(vm.runInContext(`(${popupHook})('observe', 'owner-b')`, context), true);
  assert.equal(vm.runInContext(`(${popupHook})('strict', 'owner-c')`, context), false);
  const state = window[Symbol.for('sleight.popup2')];
  state.off('unrelated');
  state.off('owner-a');
  assert.notEqual(window.open, native);
  state.off('owner-b');
  assert.equal(window.open, native);
});

test('setup exception retains its future registration for exact cleanup', async () => {
  const session = new Session();
  let fail = true;
  session.handler = async method => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'hook-1' };
    if (method === 'Runtime.evaluate' && fail) throw Error('current hook failed');
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence });
  assert.equal((await controller.install(request(), { beforeScripts: true })).effect, 'unknown');
  assert.equal(controller.hooks.size, 1);
  fail = false;
  assert.equal((await controller.dispose())[0].phase, 'verified');
});

test('duplicate attachment events never replace a pending child or strand another session', async () => {
  const session = new Session();
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {} });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  session.emit('Target.attachedToTarget', child());
  session.emit('Target.attachedToTarget', { ...child(), sessionId: 'second-child-session' });
  await attachment.drain();
  assert.deepEqual(session.calls.filter(c => c.method === 'Runtime.runIfWaitingForDebugger').map(c => c.sessionId).sort(),
    ['second-child-session', 'session-child']);
  await attachment.dispose();
});

test('recursive attachment cleanup failure retains release coverage and retries exact child session', async () => {
  const session = new Session();
  let fail = true;
  session.handler = async (method, params, sessionId) => {
    if (method === 'Target.setAutoAttach' && !params.autoAttach && sessionId === 'session-child' && fail) throw Error('child clear failed');
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {} });
  await attachment.watch(request());
  session.emit('Target.attachedToTarget', child());
  await attachment.drain();
  const cleanup = await attachment.dispose();
  assert.ok(cleanup.some(r => r.next === 'cleanup-required'));
  session.emit('Target.attachedToTarget', child('late-grandchild', 'child'), 'session-child');
  await attachment.drain();
  assert.equal(attachment.records.get('late-grandchild').state, 'resumed');
  fail = false;
  await attachment.dispose();
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});

test('lost script response keeps unknown future ownership and still removes the current hook', async () => {
  const session = new Session();
  session.handler = async method => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') throw Error('response lost');
    return { result: { value: true } };
  };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  const cleanup = await controller.dispose();
  assert.equal(cleanup[0].effect, 'unknown');
  assert.equal(controller.hooks.size, 1);
  assert.ok(session.calls.some(c => c.method === 'Runtime.evaluate'));
  assert.ok(!session.calls.some(c => c.method === 'Page.removeScriptToEvaluateOnNewDocument'));
});

test('retry cleans a hook that ran again in a new document after unproved future removal', async () => {
  const session = new Session();
  const native = () => 'native';
  const window = { open: native, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, Reflect, Symbol });
  let source;
  let fail = true;
  session.handler = async (method, params) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') { source = params.source; return { identifier: 'hook-1' }; }
    if (method === 'Page.removeScriptToEvaluateOnNewDocument' && fail) throw Error('remove failed');
    if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params.expression, context) } };
    return {};
  };
  const controller = new PopupController({ session, authorize: fence });
  await controller.install(request(), { beforeScripts: true });
  await controller.dispose();
  assert.equal(window.open, native);
  vm.runInContext(source, context);
  assert.notEqual(window.open, native);
  fail = false;
  assert.equal((await controller.dispose())[0].phase, 'verified');
  assert.equal(window.open, native);
});

test('duplicate root registration cannot overwrite its original cleanup scope', async () => {
  const session = new Session();
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => {} });
  await attachment.watch(request());
  await attachment.watch(request());
  await assert.rejects(attachment.watch({ ...request(), leaseGeneration: 2 }), /ATTACHMENT_UNKNOWN/);
  assert.equal(session.calls.filter(c => c.method === 'Target.autoAttachRelated').length, 1);
  assert.deepEqual(attachment.roots.get('parent'), request());
  await attachment.dispose();
});

test('child arriving while a registration clear is in flight is released before listener removal', async () => {
  const session = new Session();
  session.handler = async (method, params) => {
    if (method === 'Target.setAutoAttach' && !params.autoAttach) session.emit('Target.attachedToTarget', child('late'));
    return {};
  };
  const attachment = new ScopedAttachment({ session, authorize: fence, setup: async () => { assert.fail('cleanup must not set up children'); } });
  await attachment.watch(request());
  await attachment.dispose();
  assert.equal(attachment.records.get('late').state, 'resumed');
  assert.equal(session.listenerCount('Target.attachedToTarget'), 0);
});

for (const modes of [['owned-a', 'owned-b'], [undefined, 'owned-a'], ['owned-a', undefined]]) {
  test(`download cancellation retains operation context across ${modes.map(m => m ?? 'default').join(' to ')}`, async () => {
    const session = new Session();
    const observer = new DownloadObserver({ session, authorize: fence });
    const configure = contextId => observer.start(contextId ? { mode: 'allowAndName', contextId,
      downloadPath: '/tmp/fixture', proveOwnedContext: async () => true } : {});
    for (let index = 0; index < modes.length; index++) {
      await configure(modes[index]);
      const scope = { ...request(), operationSequence: index + 1 };
      await observer.arm(scope, { frameId: scope.frameId, causalToken: `op-${index}` });
      observer.begin({ guid: `guid-${index}`, frameId: scope.frameId, url: scope.origin + '/file', suggestedFilename: 'same.txt' });
      assert.equal((await observer.attribute(`guid-${index}`, { ...scope, documentGeneration: 2 },
        { causalToken: `op-${index}`, trusted: true })).next, 'unattributed');
      assert.equal((await observer.cancel(`guid-${index}`, scope)).phase, 'prepared');
      await observer.attribute(`guid-${index}`, scope, { causalToken: `op-${index}`, trusted: true });
    }
    for (let index = 0; index < modes.length; index++) await observer.cancel(`guid-${index}`, { ...request(), operationSequence: index + 1 });
    assert.deepEqual(session.calls.filter(c => c.method === 'Browser.cancelDownload').map(c => c.params),
      modes.map((contextId, index) => ({ guid: `guid-${index}`, ...(contextId ? { browserContextId: contextId } : {}) })));
    assert.equal(session.calls.filter(c => c.method === 'Browser.setDownloadBehavior').length, modes.filter(Boolean).length);
    observer.dispose();
  });
}
