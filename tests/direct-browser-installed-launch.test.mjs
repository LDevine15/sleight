import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInstalledStartup, turboState, createInstalledBrowserBridge } from '../plugins/sleight/lib/launch.mjs';
import { createInstalledFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

test('ordinary installed startup stays off without an operator setting', async () => {
  const value = await prepareInstalledStartup(() => null);
  assert.equal(value.directBrowser, undefined);
  assert.equal(value.directHost, undefined);
});
test('installed startup refuses a project supplied frontend or bridge', async () => {
  assert.throws(() => createInstalledFrontend({ browser: 'bfixture', call() {} }), /TRUSTED_ROUTE_REQUIRED/);
  const value=await prepareInstalledStartup(() => ({ browser: 'bfixture' }),()=>{});
  assert.equal(value.directBrowser,undefined);assert.equal(value.turboUnavailable,'TRUSTED_ROUTE_REQUIRED');
});
test('turbo discovery exposes only operator enablement and never receipt or profile data', () => {
  assert.deepEqual(turboState(() => null), { enabled: false });
  assert.deepEqual(turboState(() => ({ receipt: 'private', profileRoot: 'private', enabled: true })), { enabled: true });
  assert.deepEqual(turboState(() => { throw Error('unsafe'); }), { enabled: false });
});
test('unavailable selected connection keeps the ordinary engine route with a typed notice', async () => {
  const notices = [];
  const value = await prepareInstalledStartup(() => { throw Error('SELECTED_ENDPOINT_UNPROVED'); }, code => notices.push(code));
  assert.equal(value.directBrowser, undefined); assert.deepEqual(notices, ['SELECTED_ENDPOINT_UNPROVED']);
});
test('launcher stderr names the v2 turbo or engine route that actually started', async t => {
  const messages=[];t.mock.method(process.stderr,'write',text=>{messages.push(text);return true;});
  const bridge={};
  assert.equal(await createInstalledBrowserBridge({v3:async()=>{throw Error('V3_RUNTIME_UNAVAILABLE');},v2:async()=>bridge}),bridge);
  assert.match(messages.pop(),/using v2 turbo/);
  await prepareInstalledStartup(()=>{throw Error('INSTALLED_WORKER_UNAVAILABLE');});
  assert.match(messages.pop(),/using the engine/);
  assert.equal(await createInstalledBrowserBridge({v3:async()=>{throw Error('V3_WORKER_UNAVAILABLE');},v2:async()=>null}),null);
  assert.match(messages.pop(),/using the engine/);
});
for(const code of ['HOST_PACKAGE_MISMATCH','HOST_SOURCE_MISMATCH','HOST_CACHE_UNSAFE','INSTALLED_CONFIG_UNSAFE','UNEXPECTED_FAILURE']) test('startup disables turbo and preserves working engine tools on '+code,async t=>{
  const notices=[],value=await prepareInstalledStartup(()=>{throw Error(code);},message=>notices.push(message));
  assert.equal(value.directBrowser,undefined);assert.equal(value.turboUnavailable,code);assert.deepEqual(notices,[code]);
  await assert.rejects(createInstalledBrowserBridge({v3:async()=>{throw Error(code);},v2:async()=>assert.fail('unsafe fallback')}),new RegExp(code));
  const clientIn=new PassThrough(),clientOut=new PassThrough(),serverIn=new PassThrough(),serverOut=new PassThrough(),replies=[],sent=[];
  clientOut.on('data',bytes=>replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data',bytes=>sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay=createRelay({...value,clientIn,clientOut,serverIn,serverOut,changeReview:false});t.after(()=>relay.dispose());
  clientIn.write(JSON.stringify({id:1,method:'tools/list'})+'\n');
  serverOut.write(JSON.stringify({id:1,result:{tools:[{name:'js',description:'engine',inputSchema:{type:'object'}}]}})+'\n');
  assert.ok(replies.find(x=>x.id===1).result.tools.some(tool=>tool.name==='js'));
  clientIn.write(JSON.stringify({id:2,method:'tools/call',params:{name:'js',arguments:{code:'nodeRepl.write("engine available")'}}})+'\n');
  assert.ok(sent.some(x=>x.id===2));serverOut.write(JSON.stringify({id:2,result:{content:[{type:'text',text:'engine available'}]}})+'\n');
  assert.match(JSON.stringify(replies.find(x=>x.id===2)),/engine available/);
  clientIn.write(JSON.stringify({id:3,method:'tools/call',params:{name:'browser_tabs',arguments:{do:'list'}}})+'\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(JSON.stringify(replies.find(x=>x.id===3)),/Turbo is off.*engine browser path/);
  assert.ok(!sent.some(x=>x.id===3));
});
