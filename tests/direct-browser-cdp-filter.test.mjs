import test from 'node:test';
import assert from 'node:assert/strict';

const moduleURL = new URL('../plugins/sleight/lib/direct-browser/cdp-filter.mjs', import.meta.url);
async function factory() {
  let module;
  try { module = await import(moduleURL); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  assert.equal(typeof module?.createCDPFilter, 'function', 'v3 must provide the owned-target CDP filter');
  return module.createCDPFilter;
}
function fixture() {
  const listeners = new Set(), calls = [], targets = new Map([
    ['owned', { targetId: 'owned', type: 'page', title: 'Owned fixture', url: 'about:blank', browserContextId: 'default' }],
    ['foreign', { targetId: 'foreign', type: 'page', title: 'Private fixture', url: 'https://private.invalid/', browserContextId: 'default' }],
  ]);
  let attachment = 0, browserAttachment = 0;
  const emit = event => { for (const fn of listeners) fn(event); };
  const session = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
      if (method === 'Browser.getVersion') return { product: 'Chrome/145.0', revision: 'fixture', userAgent: 'HeadlessChrome/145.0', jsVersion: 'fixture', protocolVersion: '1.3' };
      if (method === 'Target.getTargets') return { targetInfos: [...targets.values()] };
      if (method === 'Target.getTargetInfo') { const targetInfo = targets.get(params.targetId); if (!targetInfo) throw Error('missing target'); return { targetInfo }; }
      if (method === 'Target.createTarget') { targets.set('new', { ...targets.get('owned'), targetId: 'new' }); return { targetId: 'new' }; }
      if (method === 'Target.attachToBrowserTarget') return { sessionId: 'monitor-' + ++browserAttachment };
      if (method === 'Target.autoAttachRelated') {
        const sessionId = 's-' + params.targetId + (++attachment === 1 ? '' : '-' + attachment);
        emit({ method: 'Target.attachedToTarget', sessionId: route, params: { sessionId, targetInfo: targets.get(params.targetId), waitingForDebugger: false } });
        return {};
      }
      if (method === 'Target.attachToTarget') {
        const sessionId = 's-' + params.targetId + (++attachment === 1 ? '' : '-' + attachment);
        emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: targets.get(params.targetId), waitingForDebugger: false } });
        return { sessionId };
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: route.replace(/^s-/, '').replace(/-\d+$/, ''), url: 'about:blank', securityOrigin: '://', mimeType: 'text/html', loaderId: 'loader' } } };
      if (/^(Page|Runtime|Network|Fetch|Log|Emulation|Inspector|DOM|Target)\./.test(method)) return {};
      throw Error('fake has no CDP method: ' + method);
    } };
  return { session, calls, emit, targets, listeners };
}
test('only explicitly owned targets appear in enumeration, metadata and events', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] });
  t.after(() => filter.dispose());
  assert.deepEqual((await filter.session.send('Target.getTargets')).targetInfos.map(v => v.targetId), ['owned']);
  await assert.rejects(filter.session.send('Target.getTargetInfo', { targetId: 'foreign' }), /CDP_TARGET_NOT_OWNED/);
  const events = []; filter.session.on('event', event => events.push(event));
  f.emit({ method: 'Target.targetCreated', params: { targetInfo: f.targets.get('foreign') } });
  f.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: f.targets.get('owned') } });
  f.emit({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 'foreign-session' });
  assert.equal(events.length, 1); assert.equal(events[0].params.targetInfo.targetId, 'owned');
  assert.doesNotMatch(JSON.stringify(events), /Private fixture|private.invalid/);
});
test('selected-port guard precedes page exposure, fails private requests and survives Fetch changes',async t=>{
  const f=fixture(),filter=(await factory())({session:f.session,ownedTargets:['owned'],protectedPort:9222});t.after(()=>filter.dispose());
  const events=[];filter.session.on('event',frame=>events.push(frame));
  await filter.session.send('Target.attachToTarget',{targetId:'owned',flatten:true});
  assert.deepEqual(f.calls.find(row=>row.method==='Fetch.enable')?.params.patterns,[{urlPattern:'*://*:9222/*',requestStage:'Request'}]);
  assert.equal(events[0].method,'Target.attachedToTarget');
  for(const url of ['http://127.0.0.1:9222/json/list','http://foo.localhost:9222/json/close/a','http://[::ffff:127.0.0.1]:9222/json'])
    f.emit({method:'Fetch.requestPaused',sessionId:'s-owned',params:{requestId:url,request:{url}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(row=>row.method==='Fetch.failRequest'&&row.params.errorReason==='BlockedByClient').length,3);
  assert.equal(events.length,1);
  await filter.session.send('Fetch.enable',{patterns:[{urlPattern:'https://fixture.invalid/*'}]},'s-owned');
  assert.ok(f.calls.at(-1).params.patterns.some(row=>row.urlPattern==='*://*:9222/*'));
  await filter.session.send('Fetch.disable',{},'s-owned');assert.equal(f.calls.at(-1).method,'Fetch.enable');
  await assert.rejects(filter.session.send('Target.createTarget',{url:'http://fixture.invalid/redirect'}),/CDP_COMMAND_REFUSED/);
  await assert.rejects(filter.session.send('Fetch.continueRequest',{requestId:'x',url:'http://0.0.0.0:9222/json/list'},'s-owned'),/CDP_COMMAND_REFUSED/);
  f.emit({method:'Target.attachedToTarget',sessionId:'s-owned',params:{sessionId:'child',targetInfo:{targetId:'iframe',type:'iframe'},waitingForDebugger:true}});
  await filter.session.send('Runtime.runIfWaitingForDebugger',{},'child');
  assert.ok(f.calls.some(row=>row.method==='Fetch.enable'&&row.route==='child'));
  assert.ok(!f.calls.some(row=>row.method==='Fetch.enable'&&row.route==='foreign'));
});
for (const method of ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds', 'Browser.setContentsSize',
  'Browser.close', 'Browser.crash', 'Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission',
  'Target.sendMessageToTarget', 'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Target.exposeDevToolsProtocol']) {
  test('refuses ' + method + ' on every route before forwarding', async t => {
    const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
    await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
    f.calls.length = 0;
    for (const route of [undefined, 's-owned']) await assert.rejects(filter.session.send(method, { targetId: 'owned' }, route), /CDP_COMMAND_REFUSED/);
    assert.deepEqual(f.calls, []);
  });
}
test('root auto-attach attaches owned pages individually and never installs browser-wide auto-attach', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  const events = []; filter.session.on('event', event => events.push(event));
  await filter.session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.deepEqual(f.calls.filter(v => v.method === 'Target.attachToTarget').map(v => v.params.targetId), ['owned']);
  assert.equal(f.calls.some(v => v.method === 'Target.setAutoAttach'), false);
  assert.equal(events.filter(v => v.method === 'Target.attachedToTarget').length, 1);
  await assert.rejects(filter.session.send('Runtime.enable', {}, 'forged'), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(filter.session.send('Runtime.evaluate', { expression: 'secret' }), /CDP_COMMAND_REFUSED/);
});
test('owned child frames route their events and are revoked with their top-level page', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  const events = []; filter.session.on('event', event => events.push(event));
  f.emit({ method: 'Target.attachedToTarget', sessionId: 's-owned', params: {
    sessionId: 'child', targetInfo: { targetId: 'iframe', type: 'iframe', url: 'https://frame.invalid/' }, waitingForDebugger: true } });
  await filter.session.send('Runtime.enable', {}, 'child');
  assert.equal(events[0].params.sessionId, 'child');
  f.emit({ method: 'Target.attachedToTarget', sessionId: 'forged', params: {
    sessionId: 'intruder', targetInfo: f.targets.get('foreign'), waitingForDebugger: false } });
  await assert.rejects(filter.session.send('Runtime.enable', {}, 'intruder'), /CDP_SESSION_NOT_OWNED/);
  filter.release('owned');
  await assert.rejects(filter.session.send('Runtime.enable', {}, 'child'), /CDP_SESSION_NOT_OWNED/);
  f.emit({ method: 'Runtime.consoleAPICalled', sessionId: 'child', params: {} });
  assert.equal(events.length, 1);
});
test('creation forces background disposition and publishes no foreign targets', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session }); t.after(() => filter.dispose());
  for (const params of [{ url: 'about:blank', background: false }, { url: 'about:blank', newWindow: true }, { url: 'about:blank', browserContextId: 'foreign' }])
    await assert.rejects(filter.session.send('Target.createTarget', params), /CDP_COMMAND_REFUSED/);
  const { targetId } = await filter.session.send('Target.createTarget', { url: 'about:blank' });
  assert.equal(targetId, 'new'); assert.equal(filter.owns('new'), true);
  assert.deepEqual(f.calls.find(v => v.method === 'Target.createTarget').params, { url: 'about:blank', background: true });
  await assert.rejects(filter.session.send('Target.closeTarget', { targetId: 'foreign' }), /CDP_TARGET_NOT_OWNED/);
});
test('dispose removes raw listeners, rejects commands and never closes the approved connection', async () => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] });
  filter.dispose(); filter.dispose(); assert.equal(f.listeners.size, 0);
  await assert.rejects(filter.session.send('Target.getTargets'), /CDP_FILTER_CLOSED/);
  assert.deepEqual(f.calls, []);
});
test('bundled Playwright connects to a fake CDP browser through the filter and sees only owned pages', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const bridge = await filter.listen(); t.after(() => bridge.close());
  const browser = await chromium.connectOverCDP(bridge.endpoint, { timeout: 5000, noDefaults: true }); t.after(() => browser.close());
  assert.equal(browser.contexts().length, 1);
  assert.deepEqual(browser.contexts()[0].pages().map(page => page.url()), ['about:blank']);
  assert.equal(f.calls.some(v => v.method === 'Page.bringToFront' || v.method === 'Target.activateTarget'), false);
  await filter.session.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 's-owned');
  assert.equal(f.calls.some(v => v.method === 'Emulation.setFocusEmulationEnabled'), true);
});
test('released ownership during an attachment refuses the late reply and detaches its exact session', async t => {
  const f = fixture(); let finish;
  f.session.send = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'Target.attachToTarget') return new Promise(resolve => { finish = resolve; });
    return {};
  };
  const filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  const pending = filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  filter.release('owned'); finish({ sessionId: 'late' });
  await assert.rejects(pending, /CDP_TARGET_NOT_OWNED/);
  assert.ok(f.calls.some(v => v.method === 'Target.detachFromTarget' && v.params.sessionId === 'late'));
});
test('detaching a child frame revokes every nested descendant', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  for (const [parent, child] of [['s-owned', 'child'], ['child', 'grandchild'], ['grandchild', 'greatgrandchild']])
    f.emit({ method: 'Target.attachedToTarget', sessionId: parent, params: { sessionId: child,
      targetInfo: { targetId: child, type: 'iframe', url: 'about:blank' }, waitingForDebugger: false } });
  f.emit({ method: 'Target.detachedFromTarget', sessionId: 's-owned', params: { sessionId: 'child', targetId: 'child' } });
  await assert.rejects(filter.session.send('Runtime.enable', {}, 'greatgrandchild'), /CDP_SESSION_NOT_OWNED/);
});
test('disposing the filter detaches its own routes while leaving the approved connection open', async () => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] });
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true }); f.calls.length = 0;
  await filter.dispose();
  assert.deepEqual(f.calls.map(v => [v.method, v.params.sessionId]), [['Target.detachFromTarget', 's-owned']]);
});
test('Playwright raw CDP sessions keep the same ownership and activation boundary', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'] }); t.after(() => filter.dispose());
  const { chromium } = await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const bridge = await filter.listen(); t.after(() => bridge.close());
  const browser = await chromium.connectOverCDP(bridge.endpoint, { timeout: 5000, noDefaults: true }); t.after(() => browser.close());
  const browserCDP = await browser.newBrowserCDPSession();
  assert.deepEqual((await browserCDP.send('Target.getTargets')).targetInfos.map(v => v.targetId), ['owned']);
  await assert.rejects(browserCDP.send('Target.attachToTarget', { targetId: 'foreign', flatten: true }), /CDP_TARGET_NOT_OWNED/);
  const pageCDP = await browser.contexts()[0].newCDPSession(browser.contexts()[0].pages()[0]);
  assert.equal((await pageCDP.send('Page.getFrameTree')).frameTree.frame.id, 'owned');
  await assert.rejects(pageCDP.send('Page.bringToFront'), /CDP_COMMAND_REFUSED/);
  assert.equal(browser.contexts()[0].pages().length, 1);
  await pageCDP.detach(); await browserCDP.detach();
});
test('disposal during listener startup closes the pending private server', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session });
  const before = new Set(process._getActiveHandles());
  const opening = filter.listen(), disposal = filter.dispose();
  await assert.rejects(opening, /CDP_FILTER_CLOSED/); await disposal;
  await new Promise(resolve => setImmediate(resolve));
  const leaked = process._getActiveHandles().filter(handle => !before.has(handle) && handle.listening === true);
  t.after(() => Promise.all(leaked.map(server => new Promise(resolve => server.close(resolve)))));
  assert.equal(leaked.length, 0, 'a listener must not outlive disposal while its bind is pending');
});

test('guard-only false matches continue privately while client Fetch patterns keep their events', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'], protectedPort: 9222 });
  t.after(() => filter.dispose());
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  const events = []; filter.session.on('event', frame => events.push(frame));
  const pause = (requestId, url, extra = {}) => f.emit({ method: 'Fetch.requestPaused', sessionId: 's-owned',
    params: { requestId, request: { url }, resourceType: 'Document', ...extra } });
  pause('path', 'http://fixture.invalid:8000/a:9222/b');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(row => row.method === 'Fetch.continueRequest' && row.params.requestId === 'path'));
  assert.deepEqual(events, []);
  await filter.session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://fixture.invalid/*.js', resourceType: 'Script' }] }, 's-owned');
  pause('query', 'https://fixture.invalid/?next=http://x:9222/y');
  pause('client', 'https://fixture.invalid/app.js', { resourceType: 'Script' });
  pause('protected', 'http://elsewhere.invalid:9222/json/list');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(frame => frame.params.requestId), ['client']);
  assert.ok(f.calls.some(row => row.method === 'Fetch.continueRequest' && row.params.requestId === 'query'));
  await filter.session.send('Fetch.disable', {}, 's-owned');
  pause('disabled', 'https://fixture.invalid/app.js');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(row => row.method === 'Fetch.continueRequest' && row.params.requestId === 'disabled'));
  assert.deepEqual(events.map(frame => frame.params.requestId), ['client']);
});

test('guard installs recursive auto-attach before exposure and resumes related targets only after guarding', async t => {
  const f = fixture(), filter = (await factory())({ session: f.session, ownedTargets: ['owned'], protectedPort: 9222 });
  t.after(() => filter.dispose());
  const events = []; filter.session.on('event', frame => events.push(frame));
  await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
  assert.ok(f.calls.some(row => row.method === 'Target.setAutoAttach' && row.route === 's-owned' && row.params.waitForDebuggerOnStart === true));
  for (const type of ['page', 'iframe', 'worker', 'shared_worker', 'service_worker']) {
    f.emit({ method: 'Target.attachedToTarget', sessionId: 's-owned', params: { sessionId: 'child-' + type,
      targetInfo: { targetId: type, type, ...(type === 'page' ? { openerId: 'owned' } : {}) }, waitingForDebugger: true } });
    await new Promise(resolve => setImmediate(resolve));
    const calls = f.calls.filter(row => row.route === 'child-' + type).map(row => row.method);
    assert.ok(calls.indexOf('Fetch.enable') >= 0, type);
    assert.ok(calls.indexOf('Target.setAutoAttach') > calls.indexOf('Fetch.enable'), type);
    assert.ok(calls.indexOf('Runtime.runIfWaitingForDebugger') > calls.indexOf('Target.setAutoAttach'), type);
  }
  await filter.session.send('Target.setAutoAttach', { autoAttach: false, flatten: true }, 's-owned');
  assert.equal(f.calls.at(-1).params.autoAttach, true, 'client cannot remove guard auto-attach');
  f.emit({ method: 'Target.attachedToTarget', sessionId: 's-owned', params: { sessionId: 'wrong-opener',
    targetInfo: { targetId: 'foreign', type: 'page', openerId: 'foreign' }, waitingForDebugger: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!events.some(frame => frame.params.sessionId === 'wrong-opener'));
  assert.ok(!f.calls.some(row => row.route === 'wrong-opener' && row.method === 'Fetch.enable'));
});
