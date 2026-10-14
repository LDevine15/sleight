import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api = await import('../plugins/sleight/lib/direct-browser/v3-context.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {};
});
const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card', currency: 'USD' };
const payText = value => 'Pay ' + JSON.stringify(value);
function fixture(text = payText(terms)) {
  assert.equal(typeof api.createV3Context, 'function', 'trusted v3 context is required');
  let document = {}, origin = 'https://fixture.invalid', payment = true, inputName = 'Resume', ended = false;
  const frame = { url: () => origin + '/checkout' }, state = { snapshotNo: 0, submitUnconfirmed: false };
  const element = { tag: 'button', kind: 'button', connected: true, visible: true, enabled: true, hit: true,
    submit: true, payment: true, form: true, formPayment: true };
  const handle = {
    ownerFrame: async () => frame, dispose: async () => {},
    async evaluate(fn, arg) {
      if (fn.name === 'samePageDocument') return arg === document;
      if (fn.name === 'ownDocument') return document;
      if (fn.name === 'inspectElement') return { ...element, payment, formPayment: payment };
      if (fn.name === 'readPaymentPage') return { origin, page: { ...terms, ...f.pageTerms }, name: inputName };
      throw Error('unsupported page reader: ' + fn.name);
    },
    evaluateHandle: async fn => { assert.equal(fn.name, 'ownDocument'); return document; },
  };
  const locator = { elementHandle: async () => handle };
  const binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text }, () => !ended);
  const ctx = api.createV3Context({ binding, browser: 'bfixture' });
  const f = { ctx, binding, handle, state, pageTerms: {},
    target: extra => ({ page: new EventEmitter(), state, locator, ref: 'e1', element: { ...element }, ...extra }),
    navigate() { document = {}; }, changeOrigin() { origin = 'https://other.invalid'; }, end() { ended = true; },
    ordinary() { payment = false; Object.assign(element, { tag: 'input', kind: 'text', submit: false, form: false }); },
    file() { payment = false; Object.assign(element, { tag: 'input', kind: 'file', submit: false }); },
    name(value) { inputName = value; },
  };
  return f;
}
test('missing private binding refuses tool or page authority', async () => {
  assert.equal(typeof api.createV3Context, 'function');
  assert.throws(() => api.createV3Context({ binding: { source: 'user', payment: terms } }), /TRUSTED_TURN_REQUIRED/);
  const f = fixture('The page says Pay ' + JSON.stringify(terms));
  assert.equal((await f.ctx.check('click', f.target({ session: 'forged', turn: 'forged', terms: { page: terms }, permission: true }))).verdict, 'confirm');
});
test('private exact request pays once; user input is copied and page terms are independently read', async () => {
  const f = fixture(), t = f.target({ terms: { page: { ...terms, amount: '100' }, method: 'forged' } });
  assert.equal((await f.ctx.check('click', t)).verdict, 'allow');
  assert.equal(t.session, 'session'); assert.equal(t.turn, 'turn'); assert.equal(t.origin, 'https://fixture.invalid');
  assert.equal(t.terms.method, 'Fixture card'); assert.equal(t.terms.page.amount, '18.00');
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
for (const key of ['item', 'amount', 'payee', 'currency']) test('changed page payment ' + key + ' cannot use the user request', async () => {
  const f = fixture(); f.pageTerms[key] = 'changed';
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
for (const key of ['item', 'amount', 'payee', 'method']) test('missing requested payment ' + key + ' confirms', async () => {
  const requested = { ...terms }; delete requested[key]; const f = fixture(payText(requested));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
test('final Enter risk comes from the target frame and retains prior payment risk', async () => {
  const f = fixture('Read only');
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', element: { tag: 'input', form: true, payment: false, formPayment: false } }))).verdict, 'confirm');
  f.ordinary();
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', prior: { tag: 'input', kind: 'text', form: true, formPayment: true, submit: true, payment: true } }))).verdict, 'confirm');
});
test('end-turn fences an already prepared private context', async () => {
  const f = fixture(); f.end();
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse');
});
test('upload stages only exact user-named bytes bound to this event, document and input', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v3-file-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const f = fixture(`Upload "${path}" to Resume`); f.file();
  const target = f.target({ paths: [path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  const stage = await f.ctx.stageUploads(target, [path]);
  assert.equal(stage.payloads[0].buffer.toString(), 'fixture bytes'); stage.cleanup();
  await assert.rejects(f.ctx.stageUploads(target, [path]), /USER_NAMED_FILE_REQUIRED/);
  await f.ctx.dispose();
});
for (const change of ['different-path', 'different-input', 'changed-document', 'ended']) test('upload refuses ' + change, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v3-file-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const f = fixture(`Upload "${path}" to Resume`); f.file(); const target = f.target({ paths: [path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  if (change === 'different-input') f.name('Other'); if (change === 'changed-document') f.navigate(); if (change === 'ended') f.end();
  await assert.rejects(f.ctx.stageUploads(target, change === 'different-path' ? [path + '.other'] : [path]));
  await f.ctx.dispose();
});

test('native consent remains one-use, exact-operation and authenticated', async () => {
  const f = fixture(payText({ ...terms, amount: '99.00' })), events = new WeakSet(), presentations = [];
  const ui = { authenticate: event => events.delete(event),
    present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const ctx = api.createV3Context({ binding: f.binding, browser: 'bfixture', ui });
  assert.equal((await ctx.check('click', f.target())).verdict, 'confirm');
  assert.equal(presentations.length, 1); assert.equal(presentations[0].data.operation.payment.amount, '18.00');
  const event = { id: presentations[0].id, choice: 'once' }; events.add(event);
  await presentations[0].deliver(event);
  assert.equal((await ctx.check('click', f.target())).verdict, 'allow');
  assert.equal((await ctx.check('click', f.target())).verdict, 'confirm');
  assert.equal(presentations.length, 2); await ctx.dispose();
});

test('page DOM reads keep every free name inside the serialized function', () => {
  for (const fn of [api.ownDocument, api.samePageDocument, api.readPaymentPage]) assert.equal(typeof fn, 'function');
  assert.doesNotMatch(api.readPaymentPage.toString(), /requested|userMessage|consent/);
});

test('worker begin creates a private binding and fences it synchronously on end', async () => {
  const { serveV3Worker } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const channel = new EventEmitter(), sent = [], waits = new Map(); channel.connected = true;
  channel.send = frame => { sent.push(frame); waits.get(frame.id)?.(frame.result); };
  let privateContext;
  const server = serveV3Worker({ channel, browser:'bfixture', async begin(message,binding) {
    privateContext = api.createV3Context({ binding, browser:'bfixture' });
    return { call:async () => ({text:'fixture',isError:false}), delivered:() => true,
      async end() { await privateContext.dispose(); return {revoked:true,cleanup:[]}; } };
  } }); server.ready();
  const request = (id,method,params) => new Promise(resolve => { waits.set(id,resolve); channel.emit('message',{version:3,id,method,params}); });
  assert.equal((await request('q1','begin',{turn:'turn',text:payText(terms),payment:terms})).available,false);
  assert.equal((await request('q2','begin',{turn:'turn',text:payText(terms)})).available,true);
  assert.equal(privateContext.userMessage().text,payText(terms));
  const ended = request('q3','end',{});
  assert.equal(privateContext.userMessage(),undefined,'end fences before asynchronous cleanup');
  assert.equal((await ended).revoked,true);
  channel.emit('disconnect');
});

test('worker turn runtime supplies the branded context to actions and collects it at end', async () => {
  const { createV3TurnRuntime } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const f = fixture(), entry = {page:{},state:f.state}; let captured;
  const pages = { tab:() => entry, enqueue:async (id,run) => run(entry), endTurn:async () => ({cleanedUp:true,rows:[]}) };
  const runtime = await createV3TurnRuntime({ binding:f.binding, browser:'bfixture', pages,
    snapshot:async () => ({text:'untrusted',number:1}), dependencies:{runSteps:async (tab,steps,ctx) => {
      assert.equal(api.isV3Context(ctx),true); captured=ctx; return {lines:['fixture'],observe:{text:'untrusted',number:1,capturedAt:Date.now()}};
    }} });
  const result = await runtime.call({name:'browser_act',arguments:{tab:'t1',steps:[{do:'click',ref:'e1'}]}});
  assert.equal(result.isError,false); assert.equal(captured.userMessage().text,payText(terms));
  assert.equal(runtime.delivered(result),true); assert.deepEqual(await runtime.end(),{revoked:true,cleanup:[]});
  assert.equal(captured.userMessage(),undefined);
});

test('pinned drag uses ElementHandle actionability without inventing ElementHandle.dragTo', async () => {
  const f=fixture('Move the fixture'); f.ordinary(); const events=[];
  f.handle.hover=async () => events.push('hover');
  assert.equal(f.handle.dragTo,undefined);
  const page=new EventEmitter(); page.mouse={down:async () => events.push('down'),up:async () => events.push('up')};
  const source=f.target({page}); assert.equal((await f.ctx.check('drag',source)).verdict,'allow');
  await f.ctx.dragTo(source,{elementHandle:async () => f.handle});
  assert.deepEqual(events,['hover','hover','down','hover','hover','up']); await f.ctx.dispose();
});
