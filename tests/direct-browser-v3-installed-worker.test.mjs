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
  f.channel.emit('message', { version:3, id:'begin', method:'begin', params:{ turn:'one', text:'read' } });
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
test('a connected browser loss fences this turn and permits one new attempt next turn',async()=>{
  const f=fixture();let selections=0;
  f.dependencies.selectConnection=async()=>{selections++;return f.selected;};
  const host=await startInstalledV3Worker({channel:f.channel},f.dependencies);
  try {
    await begin(f);f.selected.loss();await settle();
    f.channel.emit('message',{version:3,id:'lost',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.match(f.frames.find(x=>x.id==='lost').result.result.text,/Turbo is unavailable/);
    f.channel.emit('message',{version:3,id:'again',method:'begin',params:{turn:'two',text:'read'}});await settle();
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
  f.channel.emit('message',{version:3,id:'begin',method:'begin',params:{turn:'one',text:'read'}});
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
  f.channel.emit('message',{ version:3,id:'q1',method:'begin',params:{turn:'turn1',text:'read fixture'} });
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
  f.channel.emit('message',{version:3,id:'q3',method:'begin',params:{turn:'two',text:'read'}});await settle();
  assert.equal(f.frames.find(x=>x.id==='q3').result.available,false);
  assert.ok((await host.close()).cleanup.some(x=>x.status==='retained'));
  assert.ok(!f.events.includes('ui-close'));
});

test('installed launcher selects v3 first and keeps v2 as a typed fallback', async () => {
  const { createInstalledBrowserBridge } = await import('../plugins/sleight/lib/launch.mjs');
  const events = [];
  const chosen = {};
  assert.equal(await createInstalledBrowserBridge({ v3:async()=>chosen, v2:async()=>assert.fail('v2 after v3 success') }), chosen);
  assert.equal(await createInstalledBrowserBridge({ v3:async()=>null, v2:async()=>assert.fail('v2 when turbo off') }), null);
  assert.equal(await createInstalledBrowserBridge({ v3:async()=>{throw Error('V3_RUNTIME_UNAVAILABLE');},
    v2:async()=>{events.push('v2');return null;} },code=>events.push(code)),null);
  assert.deepEqual(events,['v2','V3_RUNTIME_UNAVAILABLE']);
  await assert.rejects(createInstalledBrowserBridge({v3:async()=>{throw Error('HOST_PACKAGE_MISMATCH');},v2:async()=>assert.fail('unsafe fallback') }),/HOST_PACKAGE_MISMATCH/);
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
      f.channel.emit('message', { version: 3, id: 'paused', method: 'begin', params: { turn: 'one', text: 'read' } });
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
    f.channel.emit('message',{version:3,id:'q3',method:'begin',params:{turn:'two',text:'read'}});await settle();
    assert.equal(f.frames.find(x=>x.id==='q3').result.available,true);
    f.channel.emit('message',{version:3,id:'q4',method:'call',params:{name:'browser_tabs',arguments:{do:'list'}}});await settle();
    assert.equal(f.frames.find(x=>x.id==='q4').result.result.text,'No owned tabs.');assert.equal(attempts,2);assert.equal(selections,2);
  } finally {await host.close();}
});
