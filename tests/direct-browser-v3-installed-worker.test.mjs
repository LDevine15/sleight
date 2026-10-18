import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { startInstalledV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';

function fixture() {
  const channel = new EventEmitter(), frames = [], events = [];
  channel.connected = true; channel.send = frame => frames.push(frame);
  const upstream = { sessionId: 'root' };
  const selected = { selectedBrowser: 'bfixture', session: upstream,
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture',
    async connect() { events.push('connect'); return upstream; },
    async verifyConnection(value) { return value === upstream; },
    async disconnect() { events.push('disconnect'); return true; },
    onConnectionLoss(fn) { selected.loss = fn; return () => events.push('unsubscribe'); },
    createFilter() { events.push('filter'); return { session: {}, own() {}, release() {},
      async listen() { return { endpoint: 'private', async close() { events.push('listener-close'); } }; },
      async dispose() { events.push('filter-close'); return true; } }; },
  };
  const ui = { present(_id, _view, _choices, deliver) { ui.deliver = deliver; }, authenticate: () => true,
    close() { events.push('ui-close'); } };
  const pages = { endTurn: async () => { events.push('pages-end'); return { cleanedUp:true }; },
    list: async () => [] };
  const dependencies = { schedule: () => undefined, readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    prepareHelpers: async () => ({ status:'ready', receipt:{} }), selectConnection: async () => selected,
    createUi: (_receipt, onLoss) => { ui.loss = onLoss; return ui; }, loadPlaywright: () => ({ inprocess: { playwright: { chromium: { async connectOverCDP(endpoint, options) {
      assert.equal(endpoint, 'private'); assert.equal(options.noDefaults,true);
      return { newBrowserCDPSession: async () => ({}), async close() { events.push('browser-close'); } };
    } } } } }), createPages: () => pages,
    snapshot: async () => ({ text:'untrusted fixture',number:1 }),
  };
  return { channel, frames, events, selected, ui, dependencies };
}
const settle = async () => { for (let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve)); };
const begin = async (f, use = true) => {
  f.channel.emit('message', { version:3, id:'begin', method:'begin', params:{ turn:'one', text:'read', apps:[] } });
  await settle(); assert.equal(f.frames.find(x=>x.id==='begin').result.available,true);
  if(use){f.channel.emit('message',{version:3,id:'first-call',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();}
};
test('installed open refuses the selected DevTools listener before any page creation', async () => {
  const f = fixture(); let opens = 0;
  f.dependencies.createPages = () => ({ endTurn:async()=>({cleanedUp:true}), openTab:async()=>{opens++;throw Error('unexpected open');} });
  const host = await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try {
    await begin(f);
    for (const [i,url] of ['http://127.0.0.1:9222/json/activate/foreign','http://localhost:9222/json/close/foreign',
      'http://127.1:9222/json/list','http://2130706433:9222/','http://localhost:9222/',
      'http://[::ffff:127.0.0.1]:9222/json','http://0.0.0.0:9222/json',
      'http://127.0.0.2:9222/json','http://foo.localhost:9222/json'].entries()) {
      f.channel.emit('message',{version:3,id:'open'+i,method:'call',params:{name:'browser_open',arguments:{url}}});
      await settle(); const result=f.frames.find(x=>x.id==='open'+i).result.result;
      assert.equal(result.isError,true); assert.match(result.text,/DevTools/);
    }
    assert.equal(opens,0);
  } finally { await host.close(); }
});
test('a connection loss is traced with a sanitized reason code and still reports unavailable', async () => {
  const f=fixture(),traced=[];
  f.dependencies.traceLoss=code=>traced.push(code);
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try {
    await begin(f);f.selected.loss('REPLY_ROUTE_MISMATCH');await settle();
    f.channel.emit('message',{version:3,id:'lost',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.match(f.frames.find(x=>x.id==='lost').result.result.text,/Turbo is unavailable/);
    assert.deepEqual(traced,['REPLY_ROUTE_MISMATCH']);
  } finally {await host.close();}
});
test('a loss reason that is not a code is traced as UNKNOWN', async () => {
  const f=fixture(),traced=[];
  f.dependencies.traceLoss=code=>traced.push(code);
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try { await begin(f);f.selected.loss('<h1>Page text</h1>');await settle();assert.deepEqual(traced,['UNKNOWN']); } finally {await host.close();}
});
test('a connected browser loss fences this turn and permits one new attempt next turn',async()=>{
  const f=fixture();let selections=0;
  f.dependencies.selectConnection=async()=>{selections++;return f.selected;};
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try {
    await begin(f);f.selected.loss();await settle();
    f.channel.emit('message',{version:3,id:'lost',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.match(f.frames.find(x=>x.id==='lost').result.result.text,/Turbo is unavailable/);
    f.channel.emit('message',{version:3,id:'again',method:'begin',params:{turn:'two',text:'read',apps:[]}});await settle();
    assert.equal(f.frames.find(x=>x.id==='again').result.available,true);
    f.channel.emit('message',{version:3,id:'retry',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.equal(f.frames.find(x=>x.id==='retry').result.result.text,'No owned tabs.');assert.equal(selections,2);
  } finally {await host.close();}
});
for (const cause of ['ui','parent']) test(`installed ${cause} loss releases the connection and panel after begin`, async () => {
  const f=fixture(); let timerCleared=false;
  const timer={}; f.dependencies.schedule=()=>timer;
  f.dependencies.clearSchedule=value=>{assert.equal(value,timer);timerCleared=true;};
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  await begin(f);
  if(cause==='ui') f.ui.loss(); else {f.channel.connected=false;f.channel.emit('disconnect');}
  await settle();
  assert.ok(f.events.includes('disconnect')); assert.ok(f.events.includes('ui-close'));
  assert.ok(f.events.includes('filter-close')); assert.ok(f.events.includes('listener-close'));
  assert.equal(timerCleared,true);
  assert.deepEqual(await host.close(),{revoked:true,cleanup:[]});
});
test('parent loss retains failed page cleanup evidence while collecting every transport',async()=>{
  const f=fixture();f.dependencies.createPages=()=>({endTurn:async()=>({cleanedUp:false}),list:async()=>[]});
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);await begin(f);
  f.channel.connected=false;f.channel.emit('disconnect');await settle();
  for(const event of ['disconnect','ui-close','filter-close','browser-close','listener-close']) assert.ok(f.events.includes(event),event);
  assert.ok((await host.closed).cleanup.some(row=>row.resource==='owned-tabs'&&row.status==='retained'));
});
test('installed close during begin waits for the owned startup before disconnecting', async () => {
  const f=fixture(); let release;
  f.selected.connect=()=>new Promise(resolve=>{release=()=>{f.events.push('connect');resolve(f.selected.session);};});
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  f.channel.emit('message',{version:3,id:'begin',method:'begin',params:{turn:'one',text:'read',apps:[]}});
  await settle();f.channel.emit('message',{version:3,id:'first-call',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});
  await settle(); const closing=host.close(); await settle();
  assert.ok(!f.events.includes('disconnect'));
  release(); assert.deepEqual(await closing,{revoked:true,cleanup:[]});await settle();
  assert.match(f.frames.find(x=>x.id==='first-call').result.result.text,/Read state before retrying/);
  assert.ok(f.events.indexOf('connect')<f.events.indexOf('disconnect'));
  assert.ok(!f.events.includes('filter'));
});
test('retained uploads still collect transport resources and clear on the next cleanup', async () => {
  const f=fixture(); let retained=true;
  f.dependencies.createRuntime=async()=>({call:async()=>({text:'fixture',isError:false}),delivered:()=>false,
    end:async()=>({revoked:true,cleanup:retained?[{resource:'uploads',status:'retained',code:'CLEANUP_UNPROVED'}]:[]})});
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);await begin(f);
  const first=await host.close();assert.ok(first.cleanup.some(row=>row.resource==='uploads'));
  for(const event of ['filter-close','browser-close','listener-close']) assert.ok(f.events.includes(event),event);
  assert.ok(!f.events.includes('disconnect'));retained=false;
  assert.deepEqual(await host.close(),{revoked:true,cleanup:[]});assert.ok(f.events.includes('disconnect'));
});
test('installed join connects on its first browser call and collects turn resources before its connection', async () => {
  const f = fixture(), host = await startInstalledV3Worker({ channel:f.channel }, f.dependencies);
  assert.equal(f.frames[0].version,3); assert.deepEqual(f.events,[]);
  f.channel.emit('message',{ version:3,id:'q1',method:'begin',params:{turn:'turn1',text:'read fixture',apps:[]} });
  await settle(); assert.equal(f.frames.find(x=>x.id==='q1').result.available,true);
  assert.deepEqual(f.events,[]);
  f.channel.emit('message',{ version:3,id:'q2',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}} });
  await settle(); assert.equal(f.frames.find(x=>x.id==='q2').result.result.text,'No owned tabs.');
  f.channel.emit('message',{ version:3,id:'q3',method:'end',params:{} });
  await settle(); assert.ok(f.events.includes('pages-end')); assert.ok(!f.events.includes('disconnect'));
  assert.deepEqual(await host.close(),{revoked:true,cleanup:[]});
  assert.ok(f.events.indexOf('pages-end')<f.events.indexOf('disconnect'));
  assert.ok(f.events.includes('filter-close')); assert.ok(f.events.includes('ui-close'));
});
test('parent loss during helper startup prevents selected connection and UI creation', async () => {
  const f = fixture(); let finish;
  f.dependencies.prepareHelpers = () => new Promise(resolve=>{finish=resolve;});
  const starting = startInstalledV3Worker({channel:f.channel},f.dependencies);
  await settle(); f.channel.connected=false; f.channel.emit('disconnect'); finish({status:'ready',receipt:{}});
  await assert.rejects(starting,/PARENT_GONE/); assert.deepEqual(f.events,[]);
});
test('failed turn cleanup is retained and blocks a replacement turn', async () => {
  const f = fixture(); f.dependencies.createPages = () => ({ endTurn: async()=>({cleanedUp:false}),list:async()=>[] });
  const host = await startInstalledV3Worker({channel:f.channel},f.dependencies);
  await begin(f);
  f.channel.emit('message',{version:3,id:'q2',method:'end',params:{}});await settle();
  f.channel.emit('message',{version:3,id:'q3',method:'begin',params:{turn:'two',text:'read',apps:[]}});await settle();
  assert.equal(f.frames.find(x=>x.id==='q3').result.available,false);
  assert.ok((await host.close()).cleanup.some(x=>x.status==='retained'));
  assert.ok(!f.events.includes('ui-close'));
});

test('v3 unavailability returns the engine route without constructing v2', async () => {
  const { createInstalledBrowserBridge, prepareInstalledStartup } = await import('../plugins/sleight/lib/launch.mjs');
  for (const code of ['V3_RUNTIME_UNAVAILABLE', 'V3_WORKER_UNAVAILABLE']) {
    const notices = [];
    const prepared = await prepareInstalledStartup(() => createInstalledBrowserBridge({
      v3: async () => { throw Error(code); },
      v2: async () => assert.fail('retired v2 factory was called'),
    }), value => notices.push(value));
    assert.equal(prepared.directBrowser, undefined);
    assert.equal(prepared.directHost, undefined);
    assert.deepEqual(notices, [code]);
  }
  assert.equal(await createInstalledBrowserBridge({ v3: async () => null }), null);
  await assert.rejects(createInstalledBrowserBridge({ v3: async () => { throw Error('HOST_PACKAGE_MISMATCH'); } }), /HOST_PACKAGE_MISMATCH/);
});

async function controls(t) {
  const f = fixture(), read = new PassThrough(), write = new PassThrough(), views = [];
  let clock = 1000, lost = false, refresh, interval;
  t.mock.method(Date, 'now', () => clock);
  write.on('data', data => views.push(JSON.parse(data.toString())));
  f.dependencies.createUi = (_receipt, onLoss) => {
    const channel = createUiChannel({ read, write, onLoss() { lost = true; onLoss(); } });
    return { ...channel, close() { f.events.push('ui-close'); channel.close(); } };
  };
  f.dependencies.schedule = (callback, ms) => { refresh = callback; interval = ms; return undefined; };
  const host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  t.after(() => host.close());
  return { ...f, views, interval, refresh: () => refresh(), lost: () => lost,
    advance: ms => { clock += ms; },
    async choose(view, choice, nonce = view.nonce) {
      read.write(JSON.stringify({ id: view.id, nonce, choice }) + '\n'); await settle();
    } };
}
for (const choice of ['pause', 'disconnect']) {
  test(`installed ${choice} remains authenticated between status refreshes`, async t => {
    const f = await controls(t), control = f.views[0];
    assert.equal(f.interval, 60000);
    f.advance(35000); await f.choose(control, choice);
    if (choice === 'disconnect') assert.ok(f.events.includes('disconnect'));
    else {
      assert.equal(f.lost(), false);
      assert.equal(f.views.at(-1).data.status, 'paused');
      f.channel.emit('message', { version: 3, id: 'paused', method: 'begin', params: { turn: 'one', text: 'read', apps: [] } });
      await settle(); assert.equal(f.frames.find(frame => frame.id === 'paused').result.available, false);
      assert.ok(!f.events.includes('connect'));
    }
  });
}
test('installed delayed cleanup retains ownership until collection succeeds', async t => {
  const f = await controls(t); let cleanedUp = false;
  f.dependencies.createPages = () => ({ endTurn: async () => ({ cleanedUp }), list: async () => [] });
  await begin(f);
  f.advance(35000); await f.choose(f.views[0], 'pause');
  assert.equal(f.lost(), false);
  const control = f.views.at(-1);
  assert.equal(control.data.status, 'cleanup-required'); assert.deepEqual(control.choices, ['cleanup']);
  assert.ok(!f.events.includes('disconnect'));
  cleanedUp = true; f.advance(35000); await f.choose(control, 'cleanup');
  assert.ok(f.events.includes('disconnect'));
});
test('installed refreshed control replaces its previous authenticated envelope', async t => {
  const f = await controls(t), old = f.views[0];
  f.advance(60000); f.refresh(); const current = f.views.at(-1);
  assert.notEqual(current.id, old.id);
  assert.equal(current.nonce, old.nonce);
  await f.choose(old, 'disconnect');
  assert.equal(f.lost(), true); assert.ok(f.events.includes('disconnect'));
  assert.ok(f.events.includes('ui-close'));
});
test('installed current control accepts delayed disconnect after replacement', async t => {
  const f = await controls(t); f.advance(60000); f.refresh();
  f.advance(35000); await f.choose(f.views.at(-1), 'disconnect');
  assert.ok(f.events.includes('disconnect'));
});
test('installed controls retain finite expiry', async t => {
  const f = await controls(t), control = f.views[0];
  f.advance(300000); await f.choose(control, 'disconnect');
  assert.equal(f.lost(), true); assert.ok(f.events.includes('disconnect'));
  assert.ok(f.events.includes('ui-close'));
});
test('installed controls reject a wrong nonce before expiry', async t => {
  const f = await controls(t);
  await f.choose(f.views[0], 'disconnect', 'wrong');
  assert.equal(f.lost(), true); assert.ok(f.events.includes('disconnect'));
  assert.ok(f.events.includes('ui-close'));
});

test('installed controls reject a consumed envelope replay', async t => {
  const f = await controls(t), control = f.views[0];
  await f.choose(control, 'pause'); assert.equal(f.views.at(-1).data.status, 'paused');
  await f.choose(control, 'disconnect');
  assert.equal(f.lost(), true); assert.ok(f.events.includes('disconnect'));
  assert.ok(f.events.includes('ui-close'));
});

test('turns without browser calls never connect and a failed first call retries only on a later turn', async () => {
  const f=fixture();let attempts=0,selections=0;
  const original=f.selected.connect;
  f.selected.connect=async()=>{attempts++;if(attempts===1){f.selected.loss();throw Error('SELECTED_CONNECTION_TIMEOUT');}return original();};
  f.dependencies.selectConnection=async()=>{selections++;return f.selected;};
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try {
    await begin(f,false);assert.equal(attempts,0);
    f.channel.emit('message',{version:3,id:'q1',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.match(f.frames.find(x=>x.id==='q1').result.result.text,/Turbo is unavailable.*engine browser path/);
    f.channel.emit('message',{version:3,id:'q2',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();assert.equal(attempts,1);
    f.channel.emit('message',{version:3,id:'q3',method:'begin',params:{turn:'two',text:'read',apps:[]}});await settle();
    assert.equal(f.frames.find(x=>x.id==='q3').result.available,true);
    f.channel.emit('message',{version:3,id:'q4',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.equal(f.frames.find(x=>x.id==='q4').result.result.text,'No owned tabs.');assert.equal(attempts,2);assert.equal(selections,2);
  } finally {await host.close();}
});

// EPV3-7b: an opted-in Electron app the engine approved this session takes the turn's tools; Chrome is not touched.
const appId = 'invalid.fixture.app';
function appFixture({ optIns = { version: 1, apps: { [appId]: { enabled: true, build: appId + '@1.2.3' } } } } = {}) {
  const f = fixture(), admin = { calls: [], async revoke(args) { admin.calls.push(['revoke', args.session]); }, async close() { admin.calls.push(['close']); },
    async quit() { assert.fail('the worker never quits the app'); } };
  const consent = { calls: [], endTurn: (...args) => consent.calls.push(['endTurn', ...args]), revokeSession: name => consent.calls.push(['revokeSession', name]) };
  const app = { selections: [], runtimes: [] };
  const connection = () => ({ session: undefined, grant: { current: () => true },
    pages: { endTurn: async () => { f.events.push('app-pages-end'); return { cleanedUp: true }; } },
    filter: { dispose: async () => { f.events.push('app-filter-dispose'); return true; } },
    browser: { close: async () => { f.events.push('app-browser-close'); } },
    targets: { stop: () => f.events.push('app-targets-stop') }, reader: { close: () => f.events.push('app-reader-close') },
    provider: { session: 'app-upstream', verifyConnection: async value => value === 'app-upstream', disconnect: async value => { f.events.push('app-disconnect'); return value === 'app-upstream'; } } });
  const rows = [{ tab: 't1', targetId: 'a', url: 'vscode-file://vscode-app/workbench.html', window: { id: 11, epoch: 1 }, status: 'joined', joinNo: 1, label: 'Fixture App window 11' }];
  Object.assign(f.dependencies, {
    readAppOptIns: () => optIns,
    createConsent: async options => { app.approvedApps = options.approvedApps; return consent; },
    connectAppHost: async ({ bundleId }) => { assert.equal(bundleId, appId); return { admin, registry: 'registry', profile: { path: '/private/tmp/p', temporary: true } }; },
    selectAppConnection: async options => { app.selections.push(options); return connection(); },
    createAppTurn: async ({ connections }) => ({ pages: { list: async () => rows, endTurn: async () => ({ cleanedUp: true }), tab: () => ({}),
      enqueue: async () => { throw Error('unexpected'); } }, snapshot: async () => ({ text: 'x', number: 1 }), runSteps: async () => ({ lines: [] }),
      fillFields: async () => ({ rows: [] }), acknowledgeSnapshot: () => true, context: Object.assign(() => ({}), { dispose: async () => ({ retained: 0 }) }), connections }),
  });
  const real = f.dependencies.createRuntime;
  f.dependencies.createRuntime = async options => { app.runtimes.push(options); const { createV3TurnRuntime } = await import('../plugins/sleight/lib/direct-browser/worker.mjs'); return (real ?? createV3TurnRuntime)(options); };
  return { ...f, admin, consent, app };
}
const beginApps = async (f, apps, id = 'begin', turn = 'one') => {
  f.channel.emit('message', { version: 3, id, method: 'begin', params: { turn, text: 'edit the file', apps } }); await settle();
  return f.frames.find(x => x.id === id).result.available;
};
const callList = async (f, id) => { f.channel.emit('message', { version: 3, id, method: 'call', params: { name: 'browser_tabs', arguments: { do: 'list' } } }); await settle();
  return f.frames.find(x => x.id === id).result; };

test('a begin frame without apps is refused, and bad apps lists too', async () => {
  const f = fixture(), host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  try {
    for (const [i, params] of [{ turn: 'a', text: 'read' }, { turn: 'b', text: 'read', apps: ['not a bundle'] }, { turn: 'c', text: 'read', apps: [appId, appId] },
      { turn: 'd', text: 'read', apps: Array.from({ length: 65 }, (_, n) => 'invalid.app' + n) }].entries()) {
      f.channel.emit('message', { version: 3, id: 'b' + i, method: 'begin', params }); await settle();
      assert.equal(f.frames.find(x => x.id === 'b' + i).result.available, false, JSON.stringify(params));
    }
  } finally { await host.close(); }
});
for (const optIns of [null, { version: 1, apps: { [appId]: { enabled: false, build: 'x' } } }, 'throws']) {
  test(`opt-in ${optIns === null ? 'absent' : optIns === 'throws' ? 'unsafe' : 'off'}: the browser path is unchanged byte for byte`, async () => {
    const run = async (apps, readAppOptIns) => {
      const f = fixture(); if (readAppOptIns) f.dependencies.readAppOptIns = readAppOptIns;
      f.dependencies.selectAppConnection = () => assert.fail('no app path');
      const host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
      await beginApps(f, apps); await callList(f, 'list');
      f.channel.emit('message', { version: 3, id: 'end', method: 'end', params: {} }); await settle(); await host.close();
      return { frames: f.frames.slice(1).map(frame => JSON.stringify(frame)), events: f.events };
    };
    const before = await run([]);
    const after = await run([appId], () => { if (optIns === 'throws') throw Error('INSTALLED_CONFIG_UNSAFE'); return optIns; });
    assert.deepEqual(after, before); assert.ok(after.events.includes('connect'), 'Chrome connected as before');
  });
}
test('an opted-in, engine-approved app takes the turn: labeled list, no Chrome, no endpoint, and its end releases control without quitting', async () => {
  const f = appFixture(), host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  try {
    assert.equal(await beginApps(f, [appId, 'com.apple.calculator']), true);
    const list = await callList(f, 'list');
    assert.equal(list.result.text, 't1 Fixture App window 11');
    assert.ok(!f.events.includes('connect') && !f.events.includes('filter'), 'Chrome is never connected on an app turn');
    const [selection] = f.app.selections;
    assert.equal(selection.bundleId, appId); assert.deepEqual(selection.apps, [appId, 'com.apple.calculator']); assert.equal(selection.turn, 'one');
    assert.match(selection.session, /^v3[0-9a-f]{32}$/); assert.equal(selection.registry, 'registry');
    assert.deepEqual(f.app.approvedApps(), [appId, 'com.apple.calculator'], 'the engine approval comes from the begin frame');
    assert.equal(f.app.runtimes[0].endpoint, undefined, 'an app turn has no DevTools endpoint');
    f.channel.emit('message', { version: 3, id: 'end', method: 'end', params: {} }); await settle();
    assert.deepEqual(f.events.filter(event => event.startsWith('app-')), ['app-pages-end', 'app-filter-dispose', 'app-browser-close', 'app-targets-stop', 'app-reader-close', 'app-disconnect']);
    assert.deepEqual(f.consent.calls, [['endTurn', selection.session, 'one']]);
    assert.deepEqual(f.admin.calls, [], 'a turn end revokes nothing at the host');
    // A delivery acknowledgment from the ended turn is ignored.
    assert.equal(await beginApps(f, [appId], 'again', 'two'), true);
    f.channel.emit('message', { version: 3, id: 'stale', method: 'delivered', params: { resultId: 'list', hash: 'x' } }); await settle();
    assert.equal(f.frames.find(x => x.id === 'stale').result, false);
  } finally { await host.close(); }
  assert.deepEqual(f.admin.calls, [['revoke', f.app.selections[0].session], ['close']], 'closing the worker ends the session at the host');
  assert.ok(f.consent.calls.some(row => row[0] === 'revokeSession'));
});
test('the app host gets the server\'s admin secret from the begin frame, and a host it cannot administer names the window to quit', async () => {
  const secret = 'S'.repeat(43);
  const f = appFixture(), hosts = [];
  f.dependencies.connectAppHost = async options => { hosts.push(options);
    throw Object.assign(Error('ELECTRON_HOST_FOREIGN'), { appName: 'Fixture App' }); };
  const host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  try {
    f.channel.emit('message', { version: 3, id: 'begin', method: 'begin', params: { turn: 'one', text: 'edit', apps: [appId], appSecret: secret } }); await settle();
    const list = await callList(f, 'list');
    assert.equal(hosts[0].secret, secret, 'the secret the MCP server holds, not one this worker made');
    assert.equal(list.result.isError, true);
    assert.match(list.result.text, /Fixture App is held by an earlier sleight session.*Quit the Fixture App window sleight opened.*Nothing was sent/);
    assert.doesNotMatch(list.result.text, new RegExp(secret));
  } finally { await host.close(); }
});
test('an app the engine has not approved this session stays on the browser path', async () => {
  const f = appFixture(), host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  try {
    assert.equal(await beginApps(f, ['com.apple.calculator']), true);
    assert.equal((await callList(f, 'list')).result.text, 'No owned tabs.');
    assert.equal(f.app.selections.length, 0); assert.ok(f.events.includes('connect'));
  } finally { await host.close(); }
});
for (const cause of ['pause', 'parent']) test(`${cause} on an app turn revokes the session at the host and never quits the app`, async t => {
  const f = appFixture(), read = new PassThrough(), write = new PassThrough(), views = [];
  write.on('data', data => views.push(JSON.parse(data.toString())));
  f.dependencies.createUi = (_receipt, onLoss) => { const channel = createUiChannel({ read, write, onLoss }); return { ...channel, close() { f.events.push('ui-close'); channel.close(); } }; };
  const host = await startInstalledV3Worker({ channel: f.channel }, f.dependencies);
  t.after(() => host.close());
  assert.equal(await beginApps(f, [appId]), true); await callList(f, 'list');
  const session = f.app.selections[0].session;
  if (cause === 'pause') { read.write(JSON.stringify({ id: views[0].id, nonce: views[0].nonce, choice: 'pause' }) + '\n'); await settle(); }
  else { f.channel.connected = false; f.channel.emit('disconnect'); await settle(); }
  assert.ok(f.admin.calls.some(row => row[0] === 'revoke' && row[1] === session));
  assert.ok(f.events.includes('app-disconnect'), 'the worker channel goes; the host keeps the app pipe');
});
