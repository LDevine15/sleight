import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startInstalledV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';

function fixture() {
  const channel = new EventEmitter(), frames = [], events = [];
  channel.connected = true; channel.send = frame => frames.push(frame);
  const upstream = { sessionId: 'root' };
  const selected = { selectedBrowser: 'bfixture', session: upstream,
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
    createUi: () => ui, loadPlaywright: () => ({ chromium: { async connectOverCDP(endpoint, options) {
      assert.equal(endpoint, 'private'); assert.equal(options.noDefaults,true);
      return { newBrowserCDPSession: async () => ({}), async close() { events.push('browser-close'); } };
    } } }), createPages: () => pages,
    snapshot: async () => ({ text:'untrusted fixture',number:1 }),
  };
  return { channel, frames, events, selected, ui, dependencies };
}
const settle = async () => { for (let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve)); };
test('installed join is lazy until a private begin and collects turn resources before its connection', async () => {
  const f = fixture(), host = await startInstalledV3Worker({ channel:f.channel }, f.dependencies);
  assert.equal(f.frames[0].version,3); assert.deepEqual(f.events,[]);
  f.channel.emit('message',{ version:3,id:'q1',method:'begin',params:{turn:'turn1',text:'read fixture'} });
  await settle(); assert.equal(f.frames.find(x=>x.id==='q1').result.available,true);
  assert.deepEqual(f.events,['connect','filter']);
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
  f.channel.emit('message',{version:3,id:'q1',method:'begin',params:{turn:'one',text:'read'}});await settle();
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
  assert.deepEqual(events,['V3_RUNTIME_UNAVAILABLE','v2']);
  await assert.rejects(createInstalledBrowserBridge({v3:async()=>{throw Error('HOST_PACKAGE_MISMATCH');},v2:async()=>assert.fail('unsafe fallback') }),/HOST_PACKAGE_MISMATCH/);
});
