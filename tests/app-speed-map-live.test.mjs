import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { liveSpeedRuntime, speedOutput } from '../bench/app-speed-map-live.mjs';
import { speedPlan } from '../bench/app-speed-map.mjs';

async function setup(t, { confirmed = true, focusChanged = false, startupFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sleight-am1-test-'));
  t.after(() => removeTemp(root));
  const bank = join(root, 'bank'), calls = []; let unlocks = 0, approver;
  const runtime = await liveSpeedRuntime(speedPlan({ids:['textedit'],runs:1}), {}, {
    platform:'darwin', repositoryRoot:root,
    takeLock:async()=>{calls.push('lock');return async()=>{unlocks++;};},
    makeBank:()=>{mkdirSync(bank);return bank;},
    startFixtureHost:async(task, fixture)=>{
      assert.equal(task.bundle,'com.apple.TextEdit'); assert.ok(fixture.target.startsWith(bank));
      assert.ok(existsSync(fixture.target)); assert.equal(fixture.path,fixture.target);
      assert.match(readFileSync(fixture.target,'utf8'),/^AM1-/);
      calls.push('host'); fixture.onSample({focusChanged,targetOverOwner:false});
      return {finish:async()=>({confirmed,samples:[{focusChanged}]})};
    },
    makeClient:async(server, options)=>{
      if (startupFailure) throw Error('private startup detail');
      assert.equal(server.command,join(root,'plugins/sleight/bin/sleight-mcp'));
      assert.equal(server.inheritEnvironment,false); assert.ok(Object.keys(server.env).every(k=>!k.startsWith('CLAUDE')));
      assert.equal(options.relay,false); approver = options.approve; calls.push('client');
      return {call:async(name,args)=>{assert.equal(name,'js');calls.push(args.code);return {content:[]};},close:async()=>{calls.push('client-close');}};
    },
  });
  return {runtime,root,bank,calls,get unlocks(){return unlocks;}, get approver(){return approver;}};
}

test('real runtime composes private document setup, launcher client and retained host cleanup with fakes', async t=>{
  const h=await setup(t),task=speedPlan({ids:['textedit'],runs:1}).apps[0];
  const fixture=await h.runtime.prepare(task);
  const session=await h.runtime.openSession(task,fixture);
  await session.js('1'); await session.close();
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed,true);
  await h.runtime.publish({rows:[],summary:[]}); await h.runtime.close();
  assert.equal(h.unlocks,1); assert.equal(existsSync(h.bank),false);
  const output=join(h.root,'bench/results'); assert.ok(existsSync(output));
  assert.deepEqual(h.calls,['lock','host','client','1','client-close']);
});
test('cleanup failure retains the owned bank and live-lock receipt', async t=>{
  const h=await setup(t,{confirmed:false});
  const fixture=await h.runtime.prepare(speedPlan({ids:['textedit'],runs:1}).apps[0]);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed,false);
  await assert.rejects(h.runtime.close(),/CLEANUP_UNCONFIRMED/);
  assert.equal(h.unlocks,0); assert.equal(existsSync(h.bank),true);
});
test('an observed focus change latches the boundary before session creation', async t=>{
  const h=await setup(t,{focusChanged:true});
  const fixture=await h.runtime.prepare(speedPlan({ids:['textedit'],runs:1}).apps[0]);
  assert.equal(h.runtime.held(),true);
  await assert.rejects(h.runtime.openSession(fixture.task,fixture),/HOLD/);
  assert.equal(h.calls.includes('client'),false);
  assert.equal((await h.runtime.closeFixture(fixture)).focusChanged,true);
  await h.runtime.close(); assert.equal(h.unlocks,1);
});

test('unconfirmed launcher startup retains the lock even after fixture cleanup succeeds', async t=>{
  const h=await setup(t,{startupFailure:true});
  const fixture=await h.runtime.prepare(speedPlan({ids:['textedit'],runs:1}).apps[0]);
  await assert.rejects(h.runtime.openSession(fixture.task,fixture),/private startup detail/);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed,true);
  await assert.rejects(h.runtime.close(),/CLEANUP_UNCONFIRMED/);
  assert.equal(h.unlocks,0); assert.equal(existsSync(h.bank),true);
});

test('report output refuses external paths, symlink parents and prior evidence files', t=>{
  const root=mkdtempSync(join(tmpdir(),'sleight-am1-output-'));t.after(()=>removeTemp(root));
  assert.throws(()=>speedOutput(root,join(root,'outside')),/OUTPUT_OUTSIDE/);
  mkdirSync(join(root,'bench'));symlinkSync(root,join(root,'bench/results'));
  assert.throws(()=>speedOutput(root,join(root,'bench/results/run')),/OUTPUT_SYMLINK/);
  const plain=mkdtempSync(join(tmpdir(),'sleight-am1-output-'));t.after(()=>removeTemp(plain));
  mkdirSync(join(plain,'bench/results'),{recursive:true});
  writeFileSync(join(plain,'bench/results/prior.json'),'{}');
  assert.throws(()=>speedOutput(plain,join(plain,'bench/results/prior')),/OUTPUT_ALREADY_EXISTS/);
});

test('an unsupported approval stops subsequent work without recording its text', async t=>{
  const h=await setup(t),fixture=await h.runtime.prepare(speedPlan({ids:['textedit'],runs:1}).apps[0]);
  const session=await h.runtime.openSession(fixture.task,fixture);
  assert.equal((await h.approver({message:'PRIVATE approval request',requestedSchema:{}})).action,'decline');
  assert.equal(h.runtime.held(),true);
  await session.close();await h.runtime.closeFixture(fixture);await h.runtime.close();
  assert.doesNotMatch(JSON.stringify(h.calls),/PRIVATE approval/);
});
test('the benchmark approval policy can be reused without executing its CLI', async()=>{
  const source=readFileSync(new URL('../bench/approve.mjs',import.meta.url),'utf8');
  assert.match(source,/export function benchmarkDecision/);
  const {benchmarkDecision}=await import('../bench/approve.mjs');
  const reply=benchmarkDecision({mcp_server_name:'plugin:sleight:computer',message:'Allow Computer Use to use "TextEdit"?',requested_schema:{}},{BENCH_SUITE:'app-speed-map',BENCH_ARM_SERVERS:'["plugin:sleight:computer"]'});
  assert.equal(reply.hookSpecificOutput.action,'accept');
});

test('unqualified local-container live plans refuse before locks, banks, hosts or clients', async () => {
  for (const id of ['notes', 'calendar']) {
    const calls = [];
    await assert.rejects(liveSpeedRuntime(speedPlan({ ids: [id], runs: 1 }), {}, {
      platform: 'darwin', takeLock: async () => { calls.push('lock'); },
      makeBank: () => { calls.push('bank'); },
      startFixtureHost: async () => { calls.push('host'); },
      makeClient: async () => { calls.push('client'); },
    }), /LOCAL_CONTAINER_UNQUALIFIED/);
    assert.deepEqual(calls, []);
  }
});

test('local-container runtime entry points cannot bypass the plan preflight', async t => {
  const h = await setup(t);
  const task = speedPlan({ ids: ['notes'], runs: 1 }).apps[0];
  await assert.rejects(h.runtime.prepare(task), /LOCAL_CONTAINER_UNQUALIFIED/);
  await assert.rejects(h.runtime.openSession(task, { containerId: 'local-A', requiredText: 'sidebar-marker' }),
    /LOCAL_CONTAINER_UNQUALIFIED/);
  assert.deepEqual(h.calls, ['lock']);
  await h.runtime.close();
  assert.equal(h.unlocks, 1);
});
