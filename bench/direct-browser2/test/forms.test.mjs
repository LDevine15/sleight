import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, renameSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as formAPI from '../forms.mjs';
const { fillForm, retryFormCleanup } = formAPI;
import { createFileAuthority } from '../files.mjs';

const identity = { browserIncarnation: 'b1', brokerEpoch: 1, clientSession: 's1', turn: 1,
  leaseGeneration: 1, target: 't1', frame: 'f1', document: 1, origin: 'https://fixture.invalid' };
const field = (kind = 'text', extra = {}) => ({ ...identity, ref: 'r1', node: 12, kind,
  visible: true, enabled: true, value: '', source: 'native', ...extra });
function harness(states, extra = {}) {
  const writes = [], calls = [], handlers = new Map();
  const session = new Proxy({ sessionId: 'cdp1', send: async (method, args) => { calls.push([method,args]); return {}; },
    on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) },
  { get(o, k) { if (!(k in o)) throw new Error(`Missing CDP method ${String(k)}`); return o[k]; } });
  const adapter = { session, observe: async ref => structuredClone(states[ref]),
    authorize: async () => ({ verdict: 'allow' }),
    dispatch: async (intent, fence) => { await fence(); writes.push(structuredClone(intent)); states[intent.ref].value = intent.value;
      return { phase: 'dispatched', effect: 'unknown' }; },
    waitForDependencies: async () => {}, ...extra };
  return { adapter, writes, calls, run: fields => fillForm(adapter, { operation: 'op1', identity, fields }) };
}
function manualClock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
    pending: () => timers.size,
    tick: ms => {
      time += ms;
      for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
  };
}
async function reach(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail('expected asynchronous fixture stage was not reached');
}
test('ordinary sequential fields verify and leave no implicit submit', async () => {
  const h = harness({ r1: field(), r2: field('checkbox', { ref: 'r2', value: false }) });
  const r = await h.run([{ ref: 'r1', value: 'Example' }, { ref: 'r2', value: true }]);
  assert.deepEqual(r.fields.map(x => x.status), ['verified','verified']);
  assert.equal(r.phase, 'verified'); assert.equal(r.completed, 2); assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes.map(x => x.action), ['fill','setChecked']);
});
for (const [name, patch] of Object.entries({ hidden: {visible:false}, disabled:{enabled:false}, stale:{document:2},
  replaced:{ref:'other'}, wrongOrigin:{origin:'https://other.invalid'}, unknown:{source:'unreadable'} })) {
  test(`${name} field stops before input and leaves untouched suffix`, async () => {
    const h = harness({ r1: field('text',patch), r2:field('text',{ref:'r2'}) });
    const r = await h.run([{ref:'r1',value:'private'},{ref:'r2',value:'later'}]);
    assert.equal(h.writes.length,0); assert.equal(r.fields[1].status,'notAttempted');
    assert.equal(r.effect,'none');
  });
}
test('autosave data authorization is checked before entering each value', async () => {
  const h = harness({r1:field(),r2:field('text',{ref:'r2'})}, {
    authorize:async intent => ({verdict:intent.ref==='r2'?'confirm':'allow'}) });
  const r = await h.run([{ref:'r1',value:'safe'},{ref:'r2',value:'secret'}]);
  assert.equal(r.completed,1); assert.equal(r.fields[1].status,'blocked'); assert.equal(h.writes.length,1);
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('queued revocation and replaced nodes fail the final dispatch fence', async () => {
  for (const mutation of [s => s.node++, s => s.leaseGeneration++]) {
    const states={r1:field()}; const h=harness(states,{dispatch:async (intent,fence)=>{
      mutation(states.r1); await fence(); assert.fail('dispatch must be fenced'); }});
    const r=await h.run([{ref:'r1',value:'x'}]); assert.equal(r.effect,'none'); assert.equal(r.completed,0);
  }
});
test('mid-form navigation preserves verified prefix and untouched suffix', async () => {
  const states={r1:field(),r2:field('text',{ref:'r2'})};
  const h=harness(states,{waitForDependencies:async()=>{states.r2.document++;}});
  const r=await h.run([{ref:'r1',value:'x'},{ref:'r2',value:'y'}]);
  assert.equal(r.completed,1); assert.equal(r.fields[1].status,'blocked'); assert.equal(h.writes.length,1);
});
test('dependent option controls are observed after the previous barrier', async () => {
  const states={r1:field(),r2:field('select',{ref:'r2',options:[]})};
  const h=harness(states,{waitForDependencies:async()=>{states.r2.options=[{value:'v',label:'Ready'}];}});
  const r=await h.run([{ref:'r1',value:'x'},{ref:'r2',value:'Ready'}]);
  assert.equal(r.completed,2); assert.equal(h.writes[1].value,'v');
});
test('multi-select arrays compare complete sets and reject ambiguous labels', async () => {
  const options=[{value:'a',label:'A'},{value:'b',label:'B'}];
  const h=harness({r1:field('select',{multiple:true,options,value:[]})});
  assert.equal((await h.run([{ref:'r1',value:['B','A']}])).completed,1);
  assert.deepEqual(h.writes[0].value,['b','a']);
  const bad=harness({r1:field('select',{options:[...options,{value:'c',label:'A'}]})});
  assert.equal((await bad.run([{ref:'r1',value:'A'}])).effect,'none');
});
for (const [kind,value] of [['number','1,25'],['number',Infinity],['date',{date:'2025-02-30'}],
  ['date',{date:'10/13/2026'}],['text',['a']],['checkbox','false']]) {
  test(`reject locale or type error: ${kind} ${String(value)}`, async () => {
    const h=harness({r1:field(kind)}); assert.equal((await h.run([{ref:'r1',value}])).effect,'none');
    assert.equal(h.writes.length,0);
  });
}
test('number constraints and date-only values preserve normalized intent', async () => {
  const h=harness({r1:field('number',{min:0,max:10,step:0.5})});
  assert.equal((await h.run([{ref:'r1',value:1.5}])).completed,1);
  assert.equal((await h.run([{ref:'r1',value:1.2}])).effect,'none');
  const d=harness({r1:field('date')}); await d.run([{ref:'r1',value:{date:'2026-10-13'}}]);
  assert.equal(d.writes[0].value,'2026-10-13');
});
test('readonly picker and custom listbox require observed strategies', async () => {
  const h=harness({r1:field('date',{readonly:true,strategies:['pickDate']})});
  assert.equal((await h.run([{ref:'r1',value:{date:'2026-10-13'}}])).completed,1);
  assert.equal(h.writes[0].action,'pickDate');
  const b=harness({r1:field('date',{readonly:true})}); assert.equal((await b.run([{ref:'r1',value:{date:'2026-10-13'}}])).effect,'none');
  const c=harness({r1:field('listbox',{strategies:['chooseOptions'],multiple:true,
    options:[{value:'a',label:'A'}],value:[]})});
  assert.equal((await c.run([{ref:'r1',value:['A']}])).completed,1); assert.equal(c.writes[0].action,'chooseOptions');
});
test('closed-root switch uses known state once and labels page-reported limits', async () => {
  const h=harness({r1:field('switch',{value:false,source:'page-reported',strategies:['setChecked']})});
  const r=await h.run([{ref:'r1',value:true}]);
  assert.equal(h.writes.length,1); assert.equal(r.fields[0].status,'unverifiable');
  assert.equal(r.phase,'observed');
});
test('unknown effect stops without a retry or rollback', async () => {
  let n=0; const h=harness({r1:field(),r2:field('text',{ref:'r2'})},
    {dispatch:async (_,fence)=>{await fence();n++;throw new Error('private error content');}});
  const r=await h.run([{ref:'r1',value:'secret'},{ref:'r2',value:'later'}]);
  assert.equal(n,1); assert.equal(r.effect,'unknown'); assert.equal(r.fields[1].status,'notAttempted');
  assert.ok(!JSON.stringify(r).includes('secret')); assert.ok(!JSON.stringify(r).includes('private error'));
});
test('protected write requires operation-bound proof and redacts all values', async () => {
  const h=harness({r1:field('text',{protected:true})},
    {proveProtected:async()=>({matched:true,source:'native'})});
  const r=await h.run([{ref:'r1',value:'fixture-secret'}]);
  assert.equal(r.fields[0].status,'protected'); assert.equal(r.completed,1);
  assert.ok(!JSON.stringify(r).includes('fixture-secret'));
  const u=harness({r1:field('text',{protected:true})});
  const unknown=await u.run([{ref:'r1',value:'fixture-secret'}]);
  assert.equal(unknown.fields[0].status,'unverifiable');
});
test('unchanged known values send no input', async()=>{
  const h=harness({r1:field('checkbox',{value:false})});
  const r=await h.run([{ref:'r1',value:false}]); assert.equal(r.fields[0].status,'unchanged');assert.equal(h.writes.length,0);
});
test('file capabilities bind exact operation, identity, file contents and reject replay', async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'bp2-7-files-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'fixture.txt');writeFileSync(path,'public fixture');
  const authority=createFileAuthority({ approve:async()=>true });
  const binding={...identity,operation:'op1:0',ref:'r1'};
  const token=await authority.issue([path],binding);
  assert.throws(()=>authority.consume(token,{...binding,origin:'https://evil.invalid'}));
  assert.deepEqual(authority.consume(token,binding),[path]);assert.throws(()=>authority.consume(token,binding));
  const changed=await authority.issue([path],binding);writeFileSync(path,'changed');
  assert.throws(()=>authority.consume(changed,binding));
  const replaced=await authority.issue([path],binding);renameSync(path,join(dir,'old'));writeFileSync(path,'changed');
  assert.throws(()=>authority.consume(replaced,binding));
  symlinkSync(path,join(dir,'link'));await assert.rejects(authority.issue([join(dir,'link')],binding));
  await assert.rejects(createFileAuthority().issue([path],binding));
});
test('untrusted file paths never reach CDP',async()=>{
  const h=harness({r1:field('file')});
  assert.equal((await h.run([{ref:'r1',value:{files:['/etc/passwd']}}])).effect,'none');
  assert.equal(h.calls.length,0);
});
test('changed options between preparation and dispatch stop the field',async()=>{
  const states={r1:field('select',{options:[{value:'a',label:'A'}]})};
  const h=harness(states,{dispatch:async(_,fence)=>{states.r1.options[0].value='b';await fence();assert.fail('fence');}});
  const r=await h.run([{ref:'r1',value:'A'}]); assert.equal(r.fields[0].reason,'field-changed'); assert.equal(r.effect,'none');
});
test('revoked authority at dispatch sends no input',async()=>{
  let checks=0;const h=harness({r1:field()},{authorize:async()=>({verdict:++checks===1?'allow':'deny'})});
  const r=await h.run([{ref:'r1',value:'x'}]);assert.equal(h.writes.length,0);assert.equal(r.fields[0].status,'blocked');
});
test('repeated names never substitute another observed ref',async()=>{
  const h=harness({r1:field('text',{name:'Repeated'}),r2:field('text',{ref:'r2',node:13,name:'Repeated'})});
  const r=await h.run([{ref:'r2',value:'second'}]);assert.equal(r.completed,1);assert.equal(h.writes[0].node,13);
});
test('hung observation is bounded, with no later dispatch',async()=>{
  const clock = manualClock(); let observing = false;
  const h=harness({r1:field()},{observe:async()=>{ observing = true; return new Promise(()=>{}); }});
  const pending=fillForm(h.adapter,{operation:'timeout',identity,timeoutMs:5,fields:[{ref:'r1',value:'x'}]},clock);
  await reach(() => observing);
  assert.equal(clock.pending(), 1);
  clock.tick(5);
  const r=await pending;
  assert.equal(r.effect,'none');assert.equal(h.writes.length,0);
  assert.equal(clock.pending(), 0);
});
test('dependency timeout retains verified prefix and untouched suffix',async()=>{
  const clock = manualClock(); let waiting = false;
  const h=harness({r1:field(),r2:field('text',{ref:'r2'})},{waitForDependencies:async()=>{
    waiting = true; return new Promise(()=>{});
  }});
  const pending=fillForm(h.adapter,{operation:'barrier',identity,timeoutMs:5,fields:[{ref:'r1',value:'x'},{ref:'r2',value:'y'}]},clock);
  await reach(() => waiting);
  assert.equal(clock.pending(), 1);
  clock.tick(5);
  const r=await pending;
  assert.equal(r.completed,1);assert.equal(r.fields[0].status,'verified');assert.equal(r.fields[1].status,'notAttempted');
  assert.equal(r.pending,'dependencies');
  assert.equal(clock.pending(), 0);
});
test('missing trusted adapter cannot be replaced with model approved:true',async()=>{
  const r=await fillForm({approved:true},{operation:'fake',identity,fields:[{ref:'r1',value:'x'}]});
  assert.equal(r.effect,'none');assert.equal(r.fields[0].reason,'adapter-missing');
});
test('canonical approved file dispatches once through fake CDP and verifies names/count/size',async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'bp2-7-upload-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'public.txt');writeFileSync(path,'public');
  const files=createFileAuthority({approve:async()=>true});
  const token=await files.issue([path],{...identity,operation:'op1:0',ref:'r1'});
  const states={r1:field('file')};let h,staged;
  h=harness(states,{files,dispatch:async(intent,fence)=>{await fence();
    staged=intent.paths[0];assert.notEqual(staged,path);
    writeFileSync(path,'replaced after approval');
    assert.equal(readFileSync(staged,'utf8'),'public');
    await h.adapter.session.send('DOM.setFileInputFiles',{backendNodeId:intent.node,files:intent.paths});
    states.r1.files=[{name:'public.txt',size:6}];}});
  const r=await h.run([{ref:'r1',value:{fileCapability:token}}]);
  assert.equal(r.completed,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'DOM.setFileInputFiles');
  assert.ok(!JSON.stringify(r).includes(path));
  assert.equal(existsSync(staged),false);
});
test('expired and forged file capabilities refuse',async t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'bp2-7-expire-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'public.txt');writeFileSync(path,'public');let clock=0;
  const files=createFileAuthority({approve:async()=>true,now:()=>clock,ttlMs:1});
  const binding={...identity,operation:'op1:0',ref:'r1'};const token=await files.issue([path],binding);clock=1;
  assert.throws(()=>files.consume(token,binding));assert.throws(()=>files.consume({approved:true},binding));
});
test('fake-session 1/4/13 matrix reports raw component timings and bytes',async()=>{
  for (const concurrency of [1,4,13]) {
    const samples=[];let calls=0,bytes=0;
    for (let trial=0;trial<10;trial++) await Promise.all(Array.from({length:concurrency},async()=>{
      const states={};const fields=Array.from({length:5},(_,i)=>{const ref=`r${i+1}`;states[ref]=field('text',{ref,node:i+1});return {ref,value:'public'};});
      const h=harness(states);const observe=h.adapter.observe;
      h.adapter.observe=async(...args)=>{calls++;return observe(...args);};
      const start=performance.now();const result=await h.run(fields);samples.push(performance.now()-start);
      assert.equal(result.completed,5);bytes+=Buffer.byteLength(JSON.stringify(fields))+Buffer.byteLength(JSON.stringify(result));
    }));
    const sorted=[...samples].sort((a,b)=>a-b);const rank=p=>sorted[Math.ceil(p*sorted.length)-1];
    console.log(JSON.stringify({workload:'five native fake fields',concurrency,trials:10,unit:'ms',samples,
      p50:rank(.5),p90:rank(.9),observations:calls,bytes,corrections:0}));
  }
});

for (const afterDispatch of [false, true]) for (const thrown of [null, undefined,
  Object.create(null), { get message() { assert.fail('must not read rejection getters'); } }]) {
  test(`arbitrary rejection ${String(afterDispatch)} ${thrown === null ? 'null' : typeof thrown} preserves prefix and suffix`, async () => {
    let inputs = 0;
    const states = { r1: field(), r2: field('text', { ref: 'r2' }), r3: field('text', { ref: 'r3' }) };
    const h = harness(states, { dispatch: async (intent, fence) => {
      if (intent.ref === 'r1') { await fence(); states.r1.value = intent.value; inputs++; return; }
      if (afterDispatch) { await fence(); inputs++; }
      throw thrown;
    } });
    const result = await h.run([{ ref: 'r1', value: 'public' }, { ref: 'r2', value: 'secret' }, { ref: 'r3', value: 'later' }]);
    assert.equal(result.completed, 1);
    assert.equal(result.fields[0].status, 'verified');
    assert.equal(result.fields[1].status, afterDispatch ? 'unverifiable' : 'blocked');
    assert.equal(result.fields[2].status, 'notAttempted');
    assert.equal(result.effect, afterDispatch ? 'unknown' : 'verified');
    assert.equal(inputs, afterDispatch ? 2 : 1);
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
}

test('failed upload cleanup retains proof and supports cleanup-only recovery', async () => {
  const states = { r1: field('file'), r2: field('text', { ref: 'r2' }) };
  let inputs = 0, cleanups = 0;
  const files = { unchanged: () => true, stage: () => ({ paths: ['/private-fixture/public.txt'],
    snapshot: [{ signature: '1:2:6' }], cleanup: async () => { if (++cleanups < 3) throw null; } }) };
  const h = harness(states, { files, dispatch: async (_, fence) => {
    await fence(); inputs++; states.r1.files = [{ name: 'public.txt', size: 6 }];
  } });
  const result = await h.run([{ ref: 'r1', value: { fileCapability: {} } }, { ref: 'r2', value: 'later' }]);
  assert.equal(result.completed, 1); assert.equal(result.fields[0].status, 'verified');
  assert.equal(result.fields[1].status, 'notAttempted'); assert.equal(result.cleanupRequired, true);
  assert.equal(result.pending, 'cleanup');
  assert.ok(!JSON.stringify(result).includes('/private-fixture'));
  assert.deepEqual(await retryFormCleanup(result.cleanupRecovery), { cleaned: false, cleanupRequired: true });
  assert.deepEqual(await retryFormCleanup(result.cleanupRecovery), { cleaned: true, cleanupRequired: false });
  assert.equal(inputs, 1); assert.equal(cleanups, 3);
  assert.deepEqual(await retryFormCleanup({}), { cleaned: false, cleanupRequired: true });
});

test('cleanup timeout keeps its in-flight recovery fenced until completion', async () => {
  let cleanups = 0, complete; const clock = manualClock();
  const h = harness({ r1: field('file') }, {
    files: { unchanged: () => true, stage: () => ({ paths: ['/fixture/public.txt'], snapshot: [{ signature: '1:2:6' }],
      cleanup: () => { if (++cleanups === 1) throw null; return new Promise(resolve => { complete = resolve; }); } }) },
    dispatch: async (_, fence) => { await fence(); } });
  const result = await h.run([{ ref: 'r1', value: { fileCapability: {} } }]);
  const pending = retryFormCleanup(result.cleanupRecovery, 1, clock);
  await reach(() => complete !== undefined);
  assert.equal(clock.pending(), 1);
  clock.tick(1);
  assert.equal((await pending).cleaned, false);
  assert.equal((await retryFormCleanup(result.cleanupRecovery, 1, clock)).cleaned, false);
  assert.equal(cleanups, 2);
  complete(); await Promise.resolve(); await Promise.resolve();
  assert.equal((await retryFormCleanup(result.cleanupRecovery)).cleaned, true);
  assert.equal(cleanups, 2);
});

test('upload cleanup failure after unknown input preserves unknown effect', async () => {
  let cleanups = 0;
  const h = harness({ r1: field('file'), r2: field('text', { ref: 'r2' }) }, {
    files: { stage: () => ({ paths: ['/private-fixture/public.txt'], snapshot: [],
      cleanup: () => { if (++cleanups === 1) throw { message: 'private failure' }; } }) },
    dispatch: async (_, fence) => { await fence(); throw undefined; } });
  const result = await h.run([{ ref: 'r1', value: { fileCapability: {} } }, { ref: 'r2', value: 'later' }]);
  assert.equal(result.effect, 'unknown'); assert.equal(result.completed, 0);
  assert.equal(result.fields[1].status, 'notAttempted');
  assert.equal(result.cleanupRequired, true);
  assert.ok(!JSON.stringify(result).includes('private failure'));
  assert.equal((await retryFormCleanup(result.cleanupRecovery)).cleaned, true);
});

for (const ttlMs of [NaN, Infinity, -Infinity, 0, -1, 30001]) test(`invalid TTL ${ttlMs} refuses before minting`, () => {
  assert.throws(() => createFileAuthority({ approve: async () => true, ttlMs }), /freshness/);
});

test('file issuance and both consuming fences refuse unreadable clock and expire/replay normally', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-7r-clock-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'public.txt'); writeFileSync(path, 'public');
  const binding = { ...identity, operation: 'op1:0', ref: 'r1' };
  for (const value of [NaN, Infinity, -Infinity, -1, '1']) {
    await assert.rejects(createFileAuthority({ approve: async () => true, now: () => value }).issue([path], binding));
    for (const method of ['consume', 'stage']) {
      let clock = 0;
      const files = createFileAuthority({ approve: async () => true, ttlMs: 1, now: () => clock });
      const token = await files.issue([path], binding); clock = value;
      let staged;
      try { assert.throws(() => { staged = files[method](token, binding); }, /freshness|capability/); }
      finally { staged?.cleanup(); }
      clock = 0;
      assert.throws(() => files.consume(token, binding), /capability/);
    }
  }
  let clock = 0;
  const files = createFileAuthority({ approve: async () => true, ttlMs: 1, now: () => clock });
  const expired = await files.issue([path], binding); clock = 1;
  assert.throws(() => files.stage(expired, binding)); clock = 0;
  const token = await files.issue([path], binding), staged = files.stage(token, binding);
  try { assert.throws(() => files.consume(token, binding)); } finally { staged.cleanup(); }
});
