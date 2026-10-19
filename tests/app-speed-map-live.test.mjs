import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { liveSpeedRuntime, speedOutput, setupDiagnosis, editorProfileArgs, attentionTracker } from '../bench/app-speed-map-live.mjs';
import { speedPlan } from '../bench/app-speed-map.mjs';

async function setup(t, { confirmed = true, focusChanged = false, startupFailure = false, details, id = 'textedit', hostError, hosts, base = tmpdir(), samples } = {}) {
  const root = mkdtempSync(join(base, 'sleight-am1-test-'));
  t.after(() => removeTemp(root));
  const bank = join(root, 'bank'), calls = []; let unlocks = 0, approver;
  const plan = speedPlan({ ids: [id], runs: 1 });
  const runtime = await liveSpeedRuntime(plan, {}, {
    platform:'darwin', repositoryRoot:root,
    takeLock:async()=>{calls.push('lock');return async()=>{unlocks++;};},
    makeBank:()=>{mkdirSync(bank);return bank;},
    startFixtureHost:async(task, fixture)=>{
      assert.equal(task.bundle, plan.apps[0].bundle); assert.ok(fixture.target.startsWith(bank));
      assert.ok(existsSync(fixture.target));
      if (id === 'textedit') { assert.equal(fixture.path,fixture.target); assert.match(readFileSync(fixture.target,'utf8'),/^AM1-/); }
      calls.push('host'); hosts?.push({ task, fixture });
      if (hostError) throw hostError;
      for (const sample of samples ?? [{ front: 'org.example.owner', stage: 'baseline', atMs: 0 },
        ...(focusChanged ? [{ front: 'org.example.third', stage: 'retain', atMs: 400, focusChanged: true }] : [])]) fixture.onSample(sample);
      return {startup:{waitMs:2500,relaunches:0},finish:async()=>({confirmed,details,samples:[{focusChanged}]})};
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
test('a folder fixture gives the host its window marker and the read its unique row name', async t => {
  const h = await setup(t, { id: 'finder' });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['finder'], runs: 1 }).apps[0]);
  assert.equal(fixture.windowMarker, fixture.marker);
  assert.equal(fixture.scrollMarker, fixture.marker + '-row');
  assert.equal(fixture.requiredText, fixture.scrollMarker);
  assert.equal(readFileSync(join(fixture.target, fixture.scrollMarker), 'utf8').split('\n')[0], fixture.marker);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed, true);
  await h.runtime.close();
  assert.equal(h.unlocks, 1);
});
test('cleanup failure retains the owned bank and live-lock receipt', async t=>{
  const h=await setup(t,{confirmed:false});
  const fixture=await h.runtime.prepare(speedPlan({ids:['textedit'],runs:1}).apps[0]);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed,false);
  await assert.rejects(h.runtime.close(),/CLEANUP_UNCONFIRMED/);
  assert.equal(h.unlocks,0); assert.equal(existsSync(h.bank),true);
});
test('unconfirmed cleanup retains fixed host reasons without document paths or arbitrary text', async t => {
  const h = await setup(t, { confirmed: false, details: { reasons: ['CLEANUP_FAILED', 'PRIVATE_ACCOUNT_TOKEN'], error: 'private account',
    windows: [{ document: 'file:///private/private.txt', reasons: ['DOCUMENT_NOT_MATCHED', 'WINDOW_NOT_RETAINED'] }] } });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['textedit'], runs: 1 }).apps[0]);
  const cleanup = await h.runtime.closeFixture(fixture);
  assert.deepEqual(cleanup.reasons, ['CLEANUP_FAILED', 'DOCUMENT_NOT_MATCHED', 'WINDOW_NOT_RETAINED']);
  assert.doesNotMatch(JSON.stringify(cleanup), /PRIVATE|private/);
  await assert.rejects(h.runtime.close(), /CLEANUP_UNCONFIRMED/);
  assert.equal(h.unlocks, 0);
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

// AM1 setup fixes (1.4.0): VS Code and Word failed setup on 2026-10-14 (ledger claims/_evidence-AM1-live).
test('a document fixture names its window by the file stem and withholds AppleScript from cleanup', async t => {
  const hosts = [], h = await setup(t, { id: 'word', hosts });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['word'], runs: 1 }).apps[0]);
  assert.match(fixture.target, /\/AM1-[0-9a-f-]{36}\.docx$/);
  assert.equal(fixture.marker, fixture.target.split('/').at(-1).replace(/\.docx$/, ''));
  assert.equal(fixture.windowMarker, fixture.marker);
  assert.equal(hosts[0].task.fixtureKind, 'doc-file');
  assert.equal(hosts[0].task.noScripting, true);
  assert.equal(fixture.launchArgs, undefined);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed, true);
  await h.runtime.close();
});

test('a workspace fixture launches the editor on a throwaway profile inside the private fixture folder', async t => {
  // A live bank is /private/tmp/sleight-battery-am1-XXXXXX; the default macOS tmpdir is too long for the editor's socket.
  const hosts = [], h = await setup(t, { id: 'vscode', hosts, base: '/private/tmp' });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['vscode'], runs: 1 }).apps[0]);
  assert.equal(fixture.requireStopped, true);
  assert.equal(fixture.windowMarker, fixture.marker);
  assert.equal(fixture.scrollMarker, fixture.marker + '-row');
  assert.equal(fixture.requiredText, undefined);
  assert.ok(existsSync(join(fixture.target, fixture.scrollMarker)));
  const profile = fixture.launchArgs.find(arg => arg.startsWith('--user-data-dir='))?.slice(16);
  const extensions = fixture.launchArgs.find(arg => arg.startsWith('--extensions-dir='))?.slice(17);
  assert.ok(profile.startsWith(fixture.dir + '/') && extensions.startsWith(fixture.dir + '/'));
  for (const flag of ['--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-add-to-recently-opened'])
    assert.ok(fixture.launchArgs.includes(flag), flag);
  const settings = JSON.parse(readFileSync(join(profile, 'User', 'settings.json'), 'utf8'));
  assert.equal(settings['security.workspace.trust.enabled'], false);
  assert.equal(settings['window.restoreWindows'], 'none');
  // The editor's main IPC socket lives in the profile folder; macOS caps socket paths at 103 characters.
  assert.ok(join('/private/tmp/sleight-battery-am1-XXXXXX', 'a'.repeat(36), profile.slice(fixture.dir.length + 1), '0000-shared.sock').length <= 103);
  assert.equal((await h.runtime.closeFixture(fixture)).confirmed, true);
  await h.runtime.close();
});

test('a failed setup keeps a sanitized diagnosis and the cleanup reason codes', async t => {
  const hostError = Object.assign(Error('FIXTURE_WINDOW_UNIDENTIFIED'), { hostCleanup: { confirmed: true, details: {
    reasons: ['FIXTURE_WINDOW_NOT_RETAINED', 'PRIVATE_TOKEN'], windows: [{ document: 'file:///private/x', reasons: ['WINDOW_NOT_RETAINED'] }],
    startError: { message: 'FIXTURE_WINDOW_UNIDENTIFIED', stage: 'retain', windowCount: 1, axStatus: -25204,
      startWait: { budgetMs: 60000, elapsedMs: 60200, polls: 301, pending: 1, pendingDocumentStatus: -25205, finishedLaunching: true,
        windowsStatus: { 0: 280, '-25204': 21, private: 3 }, title: 'private title' } } } } });
  const h = await setup(t, { id: 'word', hostError });
  await assert.rejects(h.runtime.prepare(speedPlan({ ids: ['word'], runs: 1 }).apps[0]), error => {
    assert.equal(error.message, 'FIXTURE_SETUP_FAILED');
    assert.equal(error.cleanupConfirmed, true);
    assert.deepEqual(error.setup, { message: 'FIXTURE_WINDOW_UNIDENTIFIED', stage: 'retain', windowCount: 1, axStatus: -25204,
      startWait: { budgetMs: 60000, elapsedMs: 60200, polls: 301, pending: 1, pendingDocumentStatus: -25205, finishedLaunching: true,
        windowsStatus: { 0: 280, '-25204': 21 } } });
    assert.deepEqual(error.cleanupReasons, ['FIXTURE_WINDOW_NOT_RETAINED', 'WINDOW_NOT_RETAINED']);
    assert.doesNotMatch(JSON.stringify(error.setup), /private/);
    return true;
  });
  await h.runtime.close();
  assert.equal(h.unlocks, 1);
});

test('setup diagnosis replaces unknown messages and stages with fixed words', () => {
  assert.deepEqual(setupDiagnosis({ message: 'execution error at ~/private', stage: 'somewhere', windowCount: 'x' }),
    { message: 'OTHER', stage: 'other', windowCount: null });
  assert.equal(setupDiagnosis(undefined), undefined);
});

test('an editor profile that would exceed the socket path limit refuses before writing it', t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-am1-long-')); t.after(() => removeTemp(root));
  const dir = join(root, 'd'.repeat(80));
  assert.throws(() => editorProfileArgs(dir), /FIXTURE_SETUP_FAILED/);
  assert.equal(existsSync(join(dir, 'p')), false);
});

test('a prepared fixture keeps the host startup wait for the report', async t => {
  const h = await setup(t);
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['textedit'], runs: 1 }).apps[0]);
  assert.equal(fixture.setupWaitMs, 2500);
  assert.equal(fixture.setupRelaunches, 0);
  await h.runtime.closeFixture(fixture); await h.runtime.close();
});

// AM1 qualification, 2026-10-19 04:41Z: Word's first cell stopped on FOCUS_CHANGED during setup, before any engine call.
test('attention events name the phase, host stage, time and the frontmost bundle before and after', () => {
  const tracker = attentionTracker({ bundle: 'com.microsoft.Word' });
  assert.equal(tracker.observe({ front: 'org.example.owner', stage: 'baseline', atMs: 0 }), false);
  assert.equal(tracker.observe({ front: 'com.microsoft.Word', stage: 'retain', atMs: 900, focusChanged: true }), false);
  tracker.setPhase('measure');
  assert.equal(tracker.observe({ front: 'com.microsoft.Word', stage: 'ready', atMs: 1700, focusChanged: true }), false);
  assert.equal(tracker.observe({ front: 'org.example.third', stage: 'ready', atMs: 2500, focusChanged: true }), true);
  assert.deepEqual(tracker.events, [
    { phase: 'setup', hostStage: 'retain', atMs: 900, kind: 'focus', from: 'org.example.owner', to: 'com.microsoft.Word', class: 'launch-activation' },
    { phase: 'measure', hostStage: 'ready', atMs: 2500, kind: 'focus', from: 'com.microsoft.Word', to: 'org.example.third', class: 'focus-change' },
  ]);
  assert.equal(tracker.stopped, true);
});

test('only the fixture app activating itself or covering during setup is classified rather than stopped', () => {
  const third = attentionTracker({ bundle: 'com.microsoft.Word' });
  third.observe({ front: 'org.example.owner', atMs: 0 });
  assert.equal(third.observe({ front: 'org.example.third', stage: 'retain', atMs: 300 }), true);
  assert.equal(third.events[0].class, 'focus-change');
  const cover = attentionTracker({ bundle: 'com.microsoft.Word' });
  cover.observe({ front: 'org.example.owner', atMs: 0 });
  assert.equal(cover.observe({ front: 'org.example.owner', stage: 'retain', atMs: 300, targetOverOwner: true }), false);
  assert.equal(cover.events[0].class, 'launch-cover');
  cover.setPhase('measure');
  assert.equal(cover.observe({ front: 'org.example.owner', atMs: 600, targetOverOwner: true }), false, 'a cover that started in setup is one event');
  assert.equal(cover.observe({ front: 'org.example.owner', atMs: 900, targetOverOwner: false }), false);
  assert.equal(cover.observe({ front: 'org.example.owner', atMs: 1200, targetOverOwner: true }), true);
  assert.equal(cover.events.at(-1).class, 'cover');
  assert.equal(cover.events.length, 2);
});

test('focus returning to the owner app is recorded and does not stop; cleanup changes still stop', () => {
  const tracker = attentionTracker({ bundle: 'com.microsoft.Word' });
  tracker.observe({ front: 'org.example.owner', atMs: 0 });
  tracker.observe({ front: 'com.microsoft.Word', stage: 'retain', atMs: 500 });
  tracker.setPhase('cleanup');
  assert.equal(tracker.observe({ front: 'org.example.owner', stage: 'cleanup', atMs: 9000 }), false);
  assert.equal(tracker.events.at(-1).class, 'focus-restored');
  assert.equal(tracker.observe({ front: 'com.microsoft.Word', stage: 'cleanup', atMs: 9200 }), true);
  assert.equal(tracker.events.at(-1).class, 'focus-change');
});

test('attention events keep bundle ids only and stay bounded', () => {
  const tracker = attentionTracker({ bundle: 'com.microsoft.Word' });
  tracker.observe({ front: 'org.example.owner', atMs: 0 });
  tracker.observe({ front: 'Private window title!', stage: 'retain', atMs: 1 });
  assert.equal(tracker.events[0].to, 'other');
  for (let n = 0; n < 50; n++) tracker.observe({ front: n % 2 ? 'org.example.owner' : 'org.example.third', atMs: n + 2 });
  assert.ok(tracker.events.length <= 20);
  assert.ok(tracker.count > 20);
  assert.doesNotMatch(JSON.stringify(tracker.events), /Private/);
});

test('a fixture app activating itself before the first engine call is classified; a later change still holds the run', async t => {
  const h = await setup(t, { id: 'word', samples: [{ front: 'org.example.owner', stage: 'baseline', atMs: 0 },
    { front: 'com.microsoft.Word', stage: 'retain', atMs: 1200, focusChanged: true }] });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['word'], runs: 1 }).apps[0]);
  assert.equal(h.runtime.held(), false);
  const session = await h.runtime.openSession(fixture.task, fixture);
  // Client startup is still before the first engine call; the fixture app finishing its own activation then is the launch.
  fixture.onSample({ front: 'org.example.owner', stage: 'ready', atMs: 1600 });
  fixture.onSample({ front: 'com.microsoft.Word', stage: 'ready', atMs: 2400 });
  assert.equal(h.runtime.held(), false);
  await session.js('1');
  fixture.onSample({ front: 'org.example.third', stage: 'ready', atMs: 3000 });
  assert.equal(h.runtime.held(), true, 'after the first engine call a change to another app stops the run');
  await session.close();
  const cleanup = await h.runtime.closeFixture(fixture);
  assert.equal(cleanup.focusChanged, true);
  assert.deepEqual(cleanup.attention.map(event => [event.phase, event.class]),
    [['setup', 'launch-activation'], ['setup', 'focus-restored'], ['setup', 'launch-activation'], ['measure', 'focus-change']]);
  await h.runtime.close();
  assert.equal(h.unlocks, 1);
});

test('a document fixture scrolls the area around its own text, and cleanup window rows keep codes only', async t => {
  const h = await setup(t, { id: 'word', confirmed: false, details: { reasons: [], windows: [
    { retained: false, present: true, matched: false, document: 'file:///private/x.docx', expectedURL: 'file:///private/y.docx', documentStatus: -25204,
      sheetStatus: -25204, documentReads: [{ document: 'file:///private/x.docx', status: 0 }], reasons: ['WINDOW_NOT_RETAINED', 'PRIVATE'], scriptingPath: '/private/y' }] } });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['word'], runs: 1 }).apps[0]);
  assert.equal(fixture.scrollMarker, fixture.marker);
  assert.equal(fixture.requiredText, undefined);
  const cleanup = await h.runtime.closeFixture(fixture);
  assert.deepEqual(cleanup.windows, [{ retained: false, present: true, matched: false, documentStatus: -25204, sheetStatus: -25204, reasons: ['WINDOW_NOT_RETAINED'] }]);
  assert.doesNotMatch(JSON.stringify(cleanup.windows), /private/);
  await assert.rejects(h.runtime.close(), /CLEANUP_UNCONFIRMED/);
});

// AM1 qualification 3 (2026-10-19 08:50Z): every phase measured, then Word's window covered Terminal while its document
// closed (phase cleanup, 4631 ms) and the cell was marked unsafe, which hid its timings from the summary.
test('a cover by the fixture app during its own cleanup is recorded as cleanup-cover and does not stop the run', () => {
  const tracker = attentionTracker({ bundle: 'com.microsoft.Word' });
  tracker.observe({ front: 'com.apple.Terminal', atMs: 0 });
  assert.equal(tracker.observe({ front: 'com.apple.Terminal', stage: 'ready', atMs: 1161, targetOverOwner: true }), false);
  tracker.setPhase('measure');
  assert.equal(tracker.observe({ front: 'com.apple.Terminal', stage: 'ready', atMs: 2000, targetOverOwner: false }), false);
  tracker.setPhase('cleanup');
  assert.equal(tracker.observe({ front: 'com.apple.Terminal', stage: 'cleanup', atMs: 4631, targetOverOwner: true }), false);
  assert.deepEqual(tracker.events.map(event => [event.phase, event.class]), [['setup', 'launch-cover'], ['cleanup', 'cleanup-cover']]);
  assert.equal(tracker.stopped, false);
  // Focus taken during cleanup is still a stop: only the window cover is the app's own close behaviour.
  assert.equal(tracker.observe({ front: 'com.microsoft.Word', stage: 'cleanup', atMs: 4800 }), true);
});

test('a workspace fixture passes its folder as a launch argument and names the profile that proves ownership', async t => {
  // VS Code 1.141 with --new-window and no path in argv opens an empty window and ignores the folder sent as a document.
  const h = await setup(t, { id: 'vscode', base: '/private/tmp' });
  const fixture = await h.runtime.prepare(speedPlan({ ids: ['vscode'], runs: 1 }).apps[0]);
  assert.equal(fixture.launchArgs.at(-1), fixture.target);
  assert.equal(fixture.targetInArgs, true);
  assert.equal(fixture.ownedArg, fixture.launchArgs.find(arg => arg.startsWith('--user-data-dir=')));
  assert.ok(fixture.ownedArg.slice(16).startsWith(fixture.dir + '/'));
  await h.runtime.closeFixture(fixture); await h.runtime.close();
});
