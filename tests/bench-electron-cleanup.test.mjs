const MAC_TMP = '/' + 'private/tmp';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArmConfig } from '../bench/electron-arm-server.mjs';
import { APPS } from '../bench/electron-qualification.mjs';
import { CONTRACT, createRunRoot, listProcesses, liveDriver, liveRuntime, qualificationWorker } from '../bench/electron-qualification-live.mjs';
import { createRunReaper, resolveRunPython } from '../bench/electron-run-cleanup.mjs';
import { createPythonAdapter } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function world(t, { stuckWorker = false, stuckApp = false, reused = false, throws = false, host = false, stuckHost = false, observeLaunch = false, missingWindow = false, connectedBirth, lifecycle, signal, onSleep, nativeTable } = {}) {
  const root = createRunRoot('eqcl-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = { path: '/fixture/Code.app', executable: '/fixture/Code.app/Contents/MacOS/Code' };
  const events = [], app = { pid: 501, bundle: APPS.vscode.bundleId, path: found.path, launchedAtMs: 1234000, pidBirth: '1234.000000' };
  let config, running = true, workerRunning = true, hostRunning = host, tableRead = false;
  const w = { child: { pid: 101 }, lost: false, kill() { events.push('kill'); }, async stop() { events.push('worker-stop'); workerRunning = stuckWorker; w.lost = !workerRunning; return !workerRunning; },
    async send(op, msg) { if (op === 'start') { config = msg; if (throws) throw Error('IPC_LOST');
      if (connectedBirth) return { ok: true, identity: { pid: 501, pidBirth: connectedBirth }, card: { shown: true, status: 'granted' }, launch: {}, connectMs: 1 };
      return { ok: false, error: 'ELECTRON_UNQUALIFIED', stage: 'app-select', card: { shown: true, status: 'granted' } }; } return op === 'end' ? { ok: true, ended: true, cleanup: [] } : { ok: true }; } };
  const deps = {
    inspectBundle: async () => ({ found, build: {}, recipe: { build: 'fixture' }, appSecret: 'fixture' }),
    list: async () => [...(workerRunning ? [{ pid: 101, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: `${process.execPath} worker.mjs` }] : []), ...(config && running ? [
      { pid: 501, startedAtMs: reused && tableRead ? 5678000 : 1234000, args: `${found.executable} --user-data-dir=${config.tempRoot}/owned/user-data` },
      { pid: 600, startedAtMs: 1000, args: `${found.executable} --user-data-dir=/owner/profile` },
    ] : []), ...(config && hostRunning ? [{ pid: 701, uid: process.getuid(), startedAtMs: 1200000, args: `${process.execPath} --state-dir ${config.stateDir}` }] : [])],
    electron: async request => {
      if (request.mode === 'table') { tableRead = true; return nativeTable ? nativeTable(app) : { processes: running ? [app] : [] }; }
      events.push(request);
      assert.equal(request.pid, 501);
      assert.equal(request.appPath, found.path);
      assert.equal(request.pidBirth, app.pidBirth);
      if (!stuckApp) running = false;
      return { reason: stuckApp ? 'deadline' : 'exited' };
    },
    exited: async () => !running,
    signal: (pid, signal) => { assert.equal(pid, 701); assert.equal(signal, 'SIGTERM'); events.push('host-stop'); if (!stuckHost) hostRunning = false; },
    now: () => 1234500,
    sleep: async ms => { events.push({ sleep: ms }); await onSleep?.(ms); },
  };
  const exec = async () => ({ stdout: '{"front":90,"bundle":"fixture.other"}', stderr: '' });
  const observer = observeLaunch ? { firstWindowMs: (pid, since) => {
    assert.equal(pid, app.pid); assert.equal(since, app.launchedAtMs); return missingWindow ? null : 1234200;
  } } : {};
  const driver = liveDriver(APPS.vscode, { root, exec, observer, forkWorker: () => w, python: '/run/python3', qualificationDiagnosticPath: '/run/diagnostic', lifecycle, signal, deps });
  driver.frontApp = async () => { events.push('restore-front'); return { pid: 90, bundle: 'com.apple.Terminal' }; };
  return { root, driver, events, deps, app, w, observer };
}

function workerWorld(t, { endReply = { ok: true, ended: true, cleanup: [] }, loseEnd = false, delayedKillExit = false } = {}) {
  const root = createRunRoot('eqcw-'), children = [], events = [], lifecycle = { cleanupAllowed: true };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = { path: '/fixture/Code.app', executable: '/fixture/Code.app/Contents/MacOS/Code' };
  const identity = { pid: 501, pidBirth: '1234.000000' };
  let config, running = true;
  const forkWorker = options => {
    let killed = false;
    const worker = qualificationWorker({ ...options, exitWaitMs: 100, forkProcess: () => {
      const child = new EventEmitter(); child.pid = 101 + children.length;
      child.kill = signal => {
        killed = true;
        events.push({ pid: child.pid, signal });
        // An exit event, rather than just a sent signal, is the worker's exit proof.
        const exit = () => { events.push({ pid: child.pid, exit: true }); child.signalCode = signal; child.emit('exit', null, signal); };
        if (delayedKillExit && child.pid === 101) setImmediate(() => { child.emit('disconnect'); exit(); });
        else queueMicrotask(exit);
      };
      child.send = msg => {
        events.push({ pid: child.pid, op: msg.op });
        if (delayedKillExit && child.pid === 101 && killed) return;
        if (msg.op === 'start') config = msg;
        if (msg.op === 'end' && loseEnd) { queueMicrotask(() => child.emit('disconnect')); return; }
        const reply = msg.op === 'start' ? { ok: true, identity, launch: {}, card: { status: 'granted' } }
          : msg.op === 'end' ? endReply : { ok: true, status: { hostPid: null } };
        queueMicrotask(() => child.emit('message', { id: msg.id, ...reply }));
      };
      children.push(child); return child;
    } });
    const stop = worker.stop.bind(worker);
    worker.stop = () => { events.push({ pid: worker.child.pid, stop: true }); return stop(); };
    return worker;
  };
  const driver = liveDriver(APPS.vscode, { root, observer: {}, forkWorker, lifecycle, python: '/run/python3',
    exec: async file => ({ stdout: file === '/usr/sbin/lsof' ? '' : '{"front":90,"bundle":"fixture.other"}' }),
    deps: {
      inspectBundle: async () => ({ found, recipe: { build: 'fixture' }, build: {}, appSecret: 'fixture' }),
      list: async () => [
        ...children.filter(child => child.signalCode == null).map(child => ({ pid: child.pid, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: `${process.execPath} worker.mjs` })),
        ...(config && running ? [{ pid: 501, startedAtMs: 1234000, args: `${found.executable} --user-data-dir=${config.tempRoot}/owned/user-data` }] : []),
      ],
      electron: async request => {
        if (request.mode === 'table') return { processes: running ? [{ ...identity, path: found.path, bundle: APPS.vscode.bundleId }] : [] };
        assert.equal(request.mode, 'quit'); running = false; return { reason: 'exited' };
      },
      exited: async () => !running,
      admin: async () => ({ quit: async () => { events.push('admin-quit'); running = false; return { requested: true }; },
        collect: async () => ({ cleanup: 'removed' }), close: async () => {} }),
      sleep: async () => {}, signal: () => assert.fail('worker exits must be collected before reaping'),
    } });
  return { driver, lifecycle, children, events };
}

test('Quit waits for intentional worker termination when disconnect and exit arrive after reconnect', async t => {
  const { driver, lifecycle, children, events } = workerWorld(t, { delayedKillExit: true });
  await driver.connect({});
  await driver.killWorker();
  assert.equal((await driver.reconnect({})).status, 'granted');
  const quit = await driver.quit();
  assert.equal(quit.exited, true);
  assert.equal(lifecycle.cleanupAllowed, true);
  assert.deepEqual(events.filter(row => row.op === 'end').map(row => row.pid), [102]);
  assert.ok(children.every(child => child.signalCode === 'SIGKILL'));
  const stopIndex = events.findIndex(row => row.pid === 101 && row.stop);
  assert.ok(stopIndex >= 0 && stopIndex < events.findIndex(row => row.pid === 101 && row.exit));
  assert.ok(events.findIndex(row => row.pid === 101 && row.exit) < events.indexOf('admin-quit'));
  assert.equal((await driver.cleanup()).confirmed, true);
});

for (const endReply of [{ ok: false, error: 'END_FAILED' }, { ok: true }, { ok: true, ended: false }]) {
  test(`Quit refuses an unconfirmed worker end (${JSON.stringify(endReply)}) after collecting exit`, async t => {
    const { driver, lifecycle, children, events } = workerWorld(t, { endReply });
    await driver.connect({});
    await assert.rejects(driver.quit(), /WORKER_END_UNCONFIRMED/);
    assert.equal(lifecycle.cleanupAllowed, true, 'a known end refusal has no unknown dispatched effect');
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(events.includes('admin-quit'), false);
    assert.equal((await driver.cleanup()).confirmed, true);
  });
}

test('losing a dispatched worker end keeps Quit and cleanup blocked as effect unknown', async t => {
  const { driver, lifecycle, events } = workerWorld(t, { loseEnd: true });
  await driver.connect({});
  await assert.rejects(driver.quit(), /RUN_CANCELLATION_UNSETTLED/);
  assert.equal(lifecycle.cleanupAllowed, false);
  assert.equal(events.includes('admin-quit'), false);
  assert.equal((await driver.cleanup()).confirmed, false);
});

test('cancellation during preparation prevents the later worker start', async t => {
  const controller = new AbortController(), { driver, deps, w } = world(t, { signal: controller.signal });
  const inspect = deps.inspectBundle;
  deps.inspectBundle = async () => { controller.abort(); return inspect(); };
  w.send = () => assert.fail('no worker request after cancellation');
  await assert.rejects(driver.connect({}), /RUN_INTERRUPTED/);
});
test('an accepted tool error after cancellation retains the app and pipe owners as effect unknown', async t => {
  const controller = new AbortController(), lifecycle = { cleanupAllowed: true }, { driver, w, events } = world(t,
    { connectedBirth: '1234.000000', signal: controller.signal, lifecycle, host: true });
  await driver.connect({});
  w.send = async () => { controller.abort(); return { ok: true, result: { text: 'Turbo is unavailable for this turn.', isError: true } }; };
  await driver.tool('browser_act', {});
  assert.equal(lifecycle.effectUnknown, true);
  assert.equal((await driver.cleanup()).confirmed, false);
  assert.equal(events.some(row => row.mode === 'quit'), false); assert.equal(events.includes('host-stop'), false);
});

test('an expired lifecycle during app identity lookup prevents native Quit and all later cleanup', async t => {
  const lifecycle = { cleanupAllowed: true }, { driver, deps, events } = world(t, { lifecycle, host: true });
  await driver.connect({});
  const list = deps.list;
  deps.list = async () => { lifecycle.cleanupAllowed = false; return list(); };
  const receipt = await driver.cleanup();
  assert.equal(receipt.confirmed, false);
  assert.equal(events.some(e => e.mode === 'quit'), false);
  assert.equal(events.includes('worker-stop'), false);
  assert.equal(events.includes('host-stop'), false);
});

test('the host-loss census preserves ownership files for host reconciliation', async t => {
  const { driver } = world(t);
  const root = driver.armConfig().tempRoot;
  const lock = join(root, 'sleight-ep2-lock-fixture');
  mkdirSync(lock);
  writeFileSync(join(lock, 'OWNER.json'), '{"owner":"original"}');
  assert.equal((await driver.collect()).absent, true);
  assert.equal(existsSync(join(lock, 'OWNER.json')), true, 'only the host can recover and collect its original inodes');
});

test('failed selection still records the exec-to-window interval and waits its remaining two seconds', async t => {
  const { driver, events } = world(t, { observeLaunch: true });
  const reply = await driver.connect({});
  assert.equal(reply.error, 'ELECTRON_UNQUALIFIED');
  assert.deepEqual(driver.launchWindows(), [{ pid: 501, execMs: 1234000, firstWindowMs: 1234200, endMs: 1236200 }]);
  assert.ok(events.some(event => event.sleep === 1700));
  assert.ok(events.indexOf('restore-front') < events.findIndex(event => event.sleep === 1700));
  assert.equal((await driver.cleanup()).confirmed, true);
});

function holdStart(w) {
  const send = w.send.bind(w);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  w.send = async (...args) => {
    const reply = await send(...args);
    if (args[0] === 'start') await held;
    return reply;
  };
  return release;
}

test('owned launch restores foreground while a slow worker start still awaits qualification', async t => {
  const { driver, events, w } = world(t, { observeLaunch: true });
  const release = holdStart(w);
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.ok(events.includes('restore-front'), 'restoration must not wait for the worker reply');
    assert.equal(settled, false);
    assert.deepEqual(driver.launchWindows(), [{ pid: 501, execMs: 1234000, firstWindowMs: 1234200, endMs: 1236200 }]);
    assert.equal(events.filter(event => event === 'restore-front').length, 1);
    assert.ok(events.some(event => event.sleep === 1700), 'the fixed two-second allowance is unchanged');
  } finally { release(); }
  assert.equal((await connected).error, 'ELECTRON_UNQUALIFIED');
  assert.equal(events.filter(event => event === 'restore-front').length, 1);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('pending startup revisits a stable unadopted process until its native row arrives before restoring', async t => {
  let reads = 0;
  const { driver, events, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: ++reads <= 2 ? [{ ...app, pid: 999 }] : [app] }) });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  try {
    await new Promise(setImmediate);
    assert.ok(reads >= 3, 'empty exact-PID candidate sets must be revisited while startup is pending');
    assert.equal(driver.identity().pid, 501);
    assert.deepEqual(driver.fixturePids(), [501]);
    assert.equal(events.filter(event => event === 'restore-front').length, 1);
    assert.deepEqual(driver.launchWindows(), [{ pid: 501, execMs: 1234000, firstWindowMs: 1234200, endMs: 1236200 }]);
  } finally { release(); await connected; }
  assert.equal((await connected).value.error, 'ELECTRON_UNQUALIFIED');
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('a pending absent native row remains owned but unadopted and fails strictly when startup settles', async t => {
  let reads = 0, release;
  const { driver, events, w } = world(t, { observeLaunch: true,
    nativeTable: () => { reads++; return { processes: [] }; },
    onSleep: ms => { if (ms === 50 && reads >= 2) release(); } });
  release = holdStart(w);
  const connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  release();
  const { error } = await connected;
  assert.ok(reads >= 3, 'settlement requires a final strict native census');
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  assert.deepEqual(error.detail.adoption, { process: { pid: 501, startedAtMs: 1234000 }, stable: true, native: [] });
  assert.deepEqual(driver.fixturePids(), [501]);
  assert.equal(driver.identity(), null);
  assert.equal(events.includes('restore-front'), false);
  assert.deepEqual(driver.launchWindows(), []);
  assert.equal((await driver.cleanup()).confirmed, false);
});

test('ordinary adoption stays strict while the startup monitor is waiting for native registration', async t => {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const { driver, events, w } = world(t, { observeLaunch: true, nativeTable: () => ({ processes: [] }),
    onSleep: ms => ms === 50 ? paused : undefined });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  try {
    await new Promise(setImmediate);
    assert.deepEqual(driver.fixturePids(), [501]);
    assert.equal(driver.identity(), null);
    await assert.rejects(driver.adoptRunning(), error => {
      assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
      assert.deepEqual(error.detail.adoption.native, []);
      return true;
    });
    assert.equal(events.includes('restore-front'), false);
  } finally { release(); resume(); await connected; }
});

for (const [name, nativeTable, reused] of [
  ['foreign bundle', app => ({ processes: [{ ...app, bundle: 'fixture.other' }] })],
  ['foreign path', app => ({ processes: [{ ...app, path: '/fixture/Other.app' }] })],
  ['mismatched birth', app => ({ processes: [{ ...app, pidBirth: '5678.000000' }] })],
  ['multiple candidates', app => ({ processes: [app, app] })],
  ['missing processes field', () => ({})],
  ['null processes field', () => ({ processes: null })],
  ['malformed native entry', () => ({ processes: [{}] })],
  ['null native entry', () => ({ processes: [null] })],
  ['invalid unrelated PID', app => ({ processes: [{ ...app, pid: -1 }] })],
  ['unproved unrelated birth', app => ({ processes: [{ ...app, pid: 999, pidBirth: null }] })],
  ['unstable process with absent native row', () => ({ processes: [] }), true],
  ['native read failure', () => { throw Error('NATIVE_TABLE_FAILED'); }],
]) test(`pending native absence tolerance never swallows ${name}`, async t => {
  let reads = 0;
  const { driver, events, w } = world(t, { observeLaunch: true, reused,
    nativeTable: app => { reads++; return nativeTable(app); } });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(reads, 1, 'a non-absence refusal stops monitoring immediately');
  assert.equal(events.includes('restore-front'), false);
  release();
  const { error } = await connected;
  assert.equal(error.message, name === 'native read failure' ? 'NATIVE_TABLE_FAILED' : 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  if (name !== 'native read failure') assert.ok(error.detail.adoption);
});

test('pending absence rechecks run cancellation after the native census and before deferring', async t => {
  const controller = new AbortController(); let reads = 0;
  const { driver, events, w } = world(t, { observeLaunch: true, signal: controller.signal,
    nativeTable: () => { reads++; controller.abort(); return { processes: [] }; } });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(events.includes('restore-front'), false);
  release();
  assert.match((await connected).error.message, /RUN_INTERRUPTED/);
});

test('native absence is not deferred if startup settles while the native census is awaiting', async t => {
  let reads = 0, release;
  const { driver, events, w } = world(t, { observeLaunch: true,
    nativeTable: async () => { reads++; release(); await new Promise(setImmediate); return { processes: [] }; } });
  release = holdStart(w);
  const error = await driver.connect({}).then(() => null, error => error);
  assert.equal(reads, 1);
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  assert.deepEqual(error.detail.adoption.native, []);
  assert.equal(events.includes('restore-front'), false);
});

test('pending registration pins the original executable/profile argument vector across fresh censuses', async t => {
  let reads = 0, changed = false;
  const { driver, events, deps, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: ++reads === 1 ? [] : [app] }),
    onSleep: ms => { if (ms === 50) changed = true; } });
  const list = deps.list;
  deps.list = async () => (await list()).map(row => changed && row.pid === 501 ? { ...row, args: row.args + ' --changed-argv' } : row);
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  release();
  const { error } = await connected;
  assert.equal(reads, 2);
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  assert.equal(error.detail.adoption.stable, false);
  assert.equal(events.includes('restore-front'), false);
});

test('settlement strict adoption preserves the deferred candidate argument provenance', async t => {
  let reads = 0, changed = false, release;
  const { driver, events, deps, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: ++reads === 1 ? [] : [app] }),
    onSleep: ms => { if (ms === 50) { changed = true; release(); } } });
  const list = deps.list;
  deps.list = async () => (await list()).map(row => changed && row.pid === 501 ? { ...row, args: row.args + ' --changed-at-settlement' } : row);
  release = holdStart(w);
  const error = await driver.connect({}).then(() => null, error => error);
  assert.equal(reads, 2);
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  assert.equal(error.detail.adoption.stable, false);
  assert.equal(events.includes('restore-front'), false);
});

for (const change of ['executable', 'profile', 'pid']) test(`pending registration never adopts a replacement ${change} as a fresh baseline`, async t => {
  let reads = 0, changed = false;
  const { driver, events, deps, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: ++reads === 1 ? [] : [app] }),
    onSleep: ms => { if (ms === 50) changed = true; } });
  const list = deps.list;
  deps.list = async () => (await list()).map(row => {
    if (!changed || row.pid !== 501) return row;
    return change === 'pid' ? { ...row, pid: 502 } : { ...row, args: change === 'executable'
      ? row.args.replace('/fixture/Code.app/Contents/MacOS/Code', '/fixture/Other.app/Contents/MacOS/Other')
      : row.args.replace('--user-data-dir=', '--unowned-profile=') };
  });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  release();
  const { error } = await connected;
  assert.equal(reads, 1, 'replacement must be refused before another native query');
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_CHANGED');
  assert.equal(error.detail.adoption.process.pid, 501);
  assert.equal(error.detail.adoption.stable, false);
  assert.equal(events.includes('restore-front'), false);
});

test('an adopted identity losing its native row is never treated as pending registration', async t => {
  let reads = 0;
  const { driver, events, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: ++reads === 1 ? [app] : [] }) });
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(reads, 2, 'pre-restoration revalidation must refuse the known row loss');
  assert.equal(events.includes('restore-front'), false);
  release();
  const { error } = await connected;
  assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
  assert.deepEqual(error.detail.adoption.native, []);
});

for (const change of ['disappears', 'loses root match']) test(`a deferred second main that ${change} during first-window observation still requires final strict validation`, async t => {
  let waitingForWindow = false, changed = false;
  const { driver, events, deps, observer, w } = world(t, { observeLaunch: true,
    nativeTable: app => ({ processes: [app] }),
    onSleep: ms => { if (ms === 50 && waitingForWindow) changed = true; } });
  const list = deps.list;
  deps.list = async () => {
    const rows = await list(), first = rows.find(row => row.pid === 501);
    if (!first || changed && change === 'disappears') return rows;
    return [...rows, { ...first, pid: 502, startedAtMs: 1235000,
      args: changed ? first.args.replace('--user-data-dir=', '--unowned-profile=') : first.args.replace('/owned/', '/second/') }];
  };
  observer.firstWindowMs = () => { waitingForWindow = true; return changed ? 1234200 : null; };
  const release = holdStart(w), connected = driver.connect({}).then(value => ({ value }), error => ({ error }));
  try {
    await new Promise(setImmediate);
    assert.deepEqual(driver.fixturePids(), [501, 502], 'both root-owned mains were observed before the second main changed');
    assert.equal(events.filter(event => event === 'restore-front').length, 1, 'the first proved main completed observation');
  } finally { release(); }
  const { error } = await connected;
  assert.equal(error?.message, 'FIXTURE_LAUNCH_IDENTITY_CHANGED');
  assert.deepEqual(error.detail.adoption, { process: { pid: 502, startedAtMs: 1235000 }, stable: false, native: [] });
});

for (const valid of [true, false]) test(`owned main appearing after 200 prelaunch polls ${valid ? 'restores before reply' : 'still requires exact native identity'}`, async t => {
  let polls = 0, visible = false;
  const { driver, events, deps, app, w } = world(t, { observeLaunch: true,
    onSleep: ms => { if (ms === 50 && ++polls === 205) visible = true; } });
  const list = deps.list;
  deps.list = async () => (await list()).filter(row => visible || row.pid !== 501);
  if (!valid) app.path = '/fixture/Other.app';
  const release = holdStart(w);
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  const refused = valid ? null : assert.rejects(connected, /FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED/);
  try {
    await new Promise(setImmediate);
    assert.equal(polls, 205, 'observation remains active throughout pending consent');
    assert.equal(settled, false);
    assert.equal(events.includes('restore-front'), valid);
    assert.equal(driver.launchWindows().length, valid ? 1 : 0);
  } finally { release(); }
  if (refused) { await refused; assert.equal((await driver.cleanup()).confirmed, false); }
  else { await connected; assert.equal((await driver.cleanup()).confirmed, true); }
});

test('first window appearing after 200 polls remains observed while worker startup is pending', async t => {
  let polls = 0;
  const { driver, events, deps, observer, w } = world(t, { observeLaunch: true,
    onSleep: ms => { if (ms === 50) polls++; } });
  deps.now = () => 1234500 + polls * 50;
  observer.firstWindowMs = () => polls >= 205 ? deps.now() : null;
  const release = holdStart(w);
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(polls, 205);
    assert.equal(settled, false);
    assert.equal(events.filter(event => event === 'restore-front').length, 1);
    assert.deepEqual(driver.launchWindows(), [{ pid: 501, execMs: 1234000, firstWindowMs: 1244750, endMs: 1246750 }]);
    assert.ok(events.some(event => event.sleep === 2000), 'allowance still starts at the actual first window');
  } finally { release(); }
  await connected;
  assert.equal(events.filter(event => event === 'restore-front').length, 1);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('a run interruption after 200 prelaunch polls stops monitoring and collects startup before return', async t => {
  let polls = 0;
  const controller = new AbortController();
  const { driver, events, deps, w } = world(t, { observeLaunch: true, signal: controller.signal,
    onSleep: ms => { if (ms === 50 && ++polls === 205) controller.abort(); } });
  const list = deps.list;
  deps.list = async () => (await list()).filter(row => row.pid !== 501);
  const release = holdStart(w);
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  const refused = assert.rejects(connected, /RUN_INTERRUPTED/);
  try {
    await new Promise(setImmediate);
    assert.equal(polls, 205);
    assert.equal(settled, false);
    assert.equal(events.includes('restore-front'), false);
  } finally { release(); }
  await refused;
  const stoppedAt = polls;
  await new Promise(setImmediate);
  assert.equal(polls, stoppedAt);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('launch monitoring waits for restoration after an early worker reply before returning', async t => {
  const { driver, events } = world(t, { observeLaunch: true });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  driver.frontApp = async () => { events.push('restore-front'); await held; };
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  let cleaned = false;
  let cleanup;
  try {
    await new Promise(setImmediate); assert.equal(settled, false);
    cleanup = driver.cleanup().then(result => { cleaned = true; return result; });
    await new Promise(setImmediate);
    assert.equal(cleaned, false, 'cleanup must also wait when final restoration follows worker settlement');
    assert.equal(events.some(event => event.mode === 'quit'), false);
  }
  finally { release(); }
  await connected;
  assert.equal((await cleanup).confirmed, true);
});

test('launch monitoring refuses unproved ownership before restoration and still collects the worker outcome', async t => {
  const { driver, events, app, w } = world(t, { observeLaunch: true });
  app.path = '/fixture/Other.app';
  const release = holdStart(w);
  let settled = false;
  const connected = driver.connect({}).finally(() => { settled = true; });
  const refused = assert.rejects(connected, /FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED/);
  try {
    await new Promise(setImmediate);
    assert.equal(events.includes('restore-front'), false);
    assert.equal(settled, false, 'an observer failure cannot abandon the dispatched worker start');
  } finally { release(); }
  await refused;
});

test('launch restoration rechecks native birth after the first-window evidence arrives', async t => {
  const { driver, events, app, w, observer } = world(t, { observeLaunch: true });
  const firstWindow = observer.firstWindowMs;
  observer.firstWindowMs = (...args) => { app.pidBirth = '1234.000001'; return firstWindow(...args); };
  const release = holdStart(w), connected = driver.connect({});
  const refused = assert.rejects(connected, /FIXTURE_LAUNCH_IDENTITY_CHANGED/);
  try {
    await new Promise(setImmediate);
    assert.equal(events.includes('restore-front'), false);
    assert.deepEqual(driver.launchWindows(), [], 'unproved birth gets no launch exemption');
  } finally { release(); }
  await refused;
});

test('without first-window observation enabled, start retains its existing sequential adoption path', async t => {
  const { driver, events, w } = world(t);
  const release = holdStart(w), connected = driver.connect({});
  try {
    await new Promise(setImmediate);
    assert.equal(driver.identity(), null);
    assert.equal(events.includes('restore-front'), false);
  } finally { release(); }
  await connected;
  assert.equal(driver.identity().pid, 501);
});

test('worker and launch-observer failures are both retained after both settle', async t => {
  const { driver, events, app, w } = world(t, { observeLaunch: true });
  app.path = '/fixture/Other.app';
  const send = w.send.bind(w);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const workerError = Object.assign(Error('IPC_LOST'), { detail: { start: 'dispatched' } });
  w.send = async (...args) => { await send(...args); await held; throw workerError; };
  const connected = driver.connect({});
  const refused = assert.rejects(connected, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ['IPC_LOST', 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED']);
    assert.equal(error.cause, workerError);
    assert.equal(error.detail, workerError.detail);
    return true;
  });
  await new Promise(setImmediate);
  assert.equal(events.includes('restore-front'), false);
  release();
  await refused;
});

test('cleanup waits for an outstanding worker start after its launch monitor finishes', async t => {
  const { driver, events, w } = world(t, { observeLaunch: true });
  const release = holdStart(w), connected = driver.connect({});
  await new Promise(setImmediate);
  assert.ok(events.includes('restore-front'));
  let cleaned = false;
  const cleanup = driver.cleanup().then(result => { cleaned = true; return result; });
  try {
    await new Promise(setImmediate);
    assert.equal(cleaned, false);
    assert.equal(events.some(event => event.mode === 'quit'), false);
    assert.equal(events.includes('worker-stop'), false);
  } finally { release(); }
  await connected;
  assert.equal((await cleanup).confirmed, true);
});

test('an uncertain dispatched start stops monitoring and retains cleanup ownership', async t => {
  const lifecycle = { cleanupAllowed: true }, { driver, deps, events, w } = world(t, { observeLaunch: true, lifecycle });
  const send = w.send.bind(w), list = deps.list;
  let released = false, listsAfterSettlement = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  deps.list = async () => { if (released) listsAfterSettlement++; return list(); };
  w.send = async (...args) => {
    await send(...args); await held;
    lifecycle.cleanupAllowed = false; lifecycle.unsettled = true;
    throw Error('IPC_LOST');
  };
  const connected = driver.connect({});
  const refused = assert.rejects(connected, /IPC_LOST/);
  await new Promise(setImmediate);
  release(); released = true;
  await refused;
  const observed = listsAfterSettlement;
  await new Promise(setImmediate);
  assert.equal(listsAfterSettlement, observed, 'monitor has no detached continuation');
  assert.equal(listsAfterSettlement, 0, 'uncertain start cannot begin a fresh process adoption');
  assert.equal((await driver.cleanup()).confirmed, false);
  assert.equal(events.some(event => event.mode === 'quit'), false);
  assert.equal(events.includes('worker-stop'), false);
});

test('missing first-window evidence never invents a launch exemption', async t => {
  const { driver } = world(t, { observeLaunch: true, missingWindow: true });
  await driver.connect({});
  assert.deepEqual(driver.launchWindows(), []);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('the host-kill fixture launch gets its own timeline and front-app restoration', async t => {
  const { driver, deps, app, events } = world(t, { observeLaunch: true });
  await driver.connect({});
  const list = deps.list;
  app.pid = 502;
  deps.list = async () => (await list()).map(row => row.pid === 501 ? { ...row, pid: 502 } : row);
  await driver.connect({});
  assert.deepEqual(driver.launchWindows().map(row => row.pid), [501, 502]);
  assert.equal(events.filter(event => event === 'restore-front').length, 2);
});

test('selection failure adopts the launched process before cleanup and confirms app and worker exits', async t => {
  const { driver, events } = world(t);
  const reply = await driver.connect({});
  assert.equal(reply.error, 'ELECTRON_UNQUALIFIED');
  assert.equal(driver.identity().pid, 501);
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, true, JSON.stringify(cleanup));
  assert.equal(cleanup.workersExited, true);
  assert.equal(cleanup.appExited, true);
  assert.equal(cleanup.profileRemoved, true);
  assert.ok(events.find(event => event.mode === 'quit'));
  assert.ok(events.includes('worker-stop'));
  assert.ok(events.findIndex(event => event.mode === 'quit') < events.indexOf('worker-stop'));
  assert.equal(events.find(event => event.mode === 'quit').allowForce, false);
});

test('an unconfirmed app Quit leaves worker and host infrastructure intact', async t => {
  const { driver, events } = world(t, { stuckApp: true, host: true });
  await driver.connect({}); const receipt = await driver.cleanup();
  assert.equal(receipt.confirmed, false);
  assert.equal(events.includes('worker-stop'), false);
  assert.equal(events.includes('host-stop'), false);
});

test('an expired cleanup lifecycle blocks reaper signals after its awaited identity check', async () => {
  const lifecycle = { cleanupAllowed: true }, signals = [], rows = [{ pid: 88, uid: process.getuid(), ppid: 1,
    startedAtMs: 1, args: `${process.execPath} /run/private/worker.mjs` }];
  let calls = 0, resume;
  const reaper = createRunReaper('/run/private', { python: '/run/python', lifecycle,
    list: async () => { if (++calls === 2) await new Promise(resolve => { resume = resolve; }); return rows; },
    signal: (...args) => signals.push(args), sleep: async () => {} });
  const work = reaper.reap();
  for (let attempt = 0; !resume && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resume, 'function'); lifecycle.cleanupAllowed = false; resume();
  const result = await work;
  assert.equal(result.confirmed, false);
  assert.deepEqual(signals, []);
});

test('the driver carries its Python and diagnostic options in worker and arm messages', async t => {
  const { driver, w } = world(t);
  const send = w.send, messages = [];
  w.send = async (op, msg) => { if (op === 'start') messages.push(msg); return send(op, msg); };
  await driver.connect({});
  for (const msg of [...messages, driver.armConfig()]) {
    assert.equal(msg.python, '/run/python3');
    assert.equal(msg.qualificationDiagnosticPath, '/run/diagnostic');
  }
  const config = driver.armConfig(), path = join(config.stateDir, 'arm.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(readArmConfig(path), config);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('Quit waits for kernel exit before collection and retains the host quit receipt', async t => {
  const { driver, deps, events } = world(t, { connectedBirth: '1234.000000' });
  await driver.connect({});
  let checks = 0;
  deps.exited = async (pid, birth) => {
    assert.equal(pid, 501); assert.equal(birth, 1234000);
    return ++checks >= 3;
  };
  deps.admin = async () => ({
    quit: async () => ({ cleanup: 'retained', reason: 'processes remain' }),
    collect: async () => { events.push('collected'); return { cleanup: 'removed' }; }, close: async () => {},
  });
  const result = await driver.quit();
  assert.equal(result.exited, true);
  assert.equal(result.quit.reason, 'processes remain');
  assert.equal(checks, 3);
  assert.ok(events.filter(event => event.sleep === 100).length >= 2);
});

test('Quit wraps an immutable admin while retaining its method receiver and receipts', async t => {
  const { driver, deps } = world(t, { connectedBirth: '1234.000000' }), calls = [];
  const admin = Object.freeze({ hostId: 'fixture-host', pid: 701, spawned: false,
    async quit() { assert.equal(this, admin); calls.push('quit'); return { cleanup: 'retained', reason: this.hostId }; },
    async collect() { assert.equal(this, admin); calls.push('collect'); return { cleanup: 'removed' }; },
    async close() { assert.equal(this, admin); calls.push('close'); return true; },
  });
  deps.admin = async () => admin;
  deps.exited = async () => true;
  await driver.connect({});
  const result = await driver.quit();
  assert.equal(result.exited, true);
  assert.equal(result.quit.reason, 'fixture-host');
  assert.equal(result.collected.cleanup, 'removed');
  assert.deepEqual(calls, ['quit', 'collect', 'close']);
  assert.equal(Object.isFrozen(admin), true);
});

for (const stage of ['quit', 'collect', 'close']) test(`immutable admin checks cleanup authority immediately before ${stage}`, async t => {
  const lifecycle = { cleanupAllowed: true }, calls = [];
  const { driver, deps } = world(t, { connectedBirth: '1234.000000', lifecycle });
  const admin = Object.freeze({ hostId: 'fixture-host',
    async quit() { assert.equal(this, admin); calls.push('quit'); return {}; },
    async collect() { assert.equal(this, admin); calls.push('collect'); if (stage === 'close') lifecycle.cleanupAllowed = false; return { cleanup: 'removed' }; },
    async close() { assert.equal(this, admin); calls.push('close'); return true; },
  });
  deps.admin = async () => { if (stage === 'quit') lifecycle.cleanupAllowed = false; return admin; };
  deps.exited = async () => { if (stage === 'collect') lifecycle.cleanupAllowed = false; return true; };
  await driver.connect({});
  await assert.rejects(driver.quit(), /RUN_CANCELLATION_UNSETTLED/);
  assert.deepEqual(calls, stage === 'quit' ? [] : stage === 'collect' ? ['quit'] : ['quit', 'collect']);
});

test('immutable admin close remains allowed after interruption while collect is blocked', async t => {
  const controller = new AbortController(), calls = [], lifecycle = { cleanupAllowed: true };
  const { driver, deps } = world(t, { connectedBirth: '1234.000000', lifecycle, signal: controller.signal });
  const admin = Object.freeze({ hostId: 'fixture-host',
    async quit() { assert.equal(this, admin); calls.push('quit'); controller.abort(); return {}; },
    async collect() { assert.fail('collect must recheck the interrupted run'); },
    async close() { assert.equal(this, admin); calls.push('close'); return true; },
  });
  deps.admin = async () => admin; deps.exited = async () => true;
  await driver.connect({});
  await assert.rejects(driver.quit(), /RUN_INTERRUPTED/);
  assert.deepEqual(calls, ['quit', 'close']);
  assert.equal(lifecycle.cleanupAllowed, true);
});

test('the driver admin carries the qualification flag when it must respawn a host', async t => {
  const { driver, deps } = world(t, { connectedBirth: '1234.000000' });
  await driver.connect({});
  const calls = [];
  deps.ensureHost = async options => {
    calls.push(options);
    return { quit: async () => ({}), collect: async () => ({ cleanup: 'removed' }), close: async () => {} };
  };
  await driver.quit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.SLEIGHT_TURBO_UNQUALIFIED, '1');
  assert.equal(calls[0].python, '/run/python3');
  assert.equal(calls[0].qualificationDiagnosticPath, '/run/diagnostic');
});

test('Quit remains unconfirmed at its deadline and never collects a live app', async t => {
  const { driver, deps } = world(t, { connectedBirth: '1234.000000' });
  await driver.connect({});
  deps.exited = async () => false;
  deps.admin = async () => ({ quit: async () => ({ cleanup: 'retained', reason: 'QUIT_REFUSED' }),
    collect: () => assert.fail('cannot collect while the parent is alive'), close: async () => {} });
  const result = await driver.quit();
  assert.equal(result.exited, false);
  assert.equal(result.quit.reason, 'QUIT_REFUSED');
  assert.equal(result.collected, undefined);
  assert.ok(result.censusLeft > 0);
});

test('cleanup discovers a launch when selection throws instead of returning a reply', async t => {
  const w = world(t, { throws: true });
  await assert.rejects(w.driver.connect({}), /IPC_LOST/);
  assert.equal((await w.driver.cleanup()).confirmed, true);
});

test('cleanup confirms the run-owned host exit as well as the worker and app', async t => {
  const { driver, events } = world(t, { host: true });
  await driver.connect({});
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, true, JSON.stringify(cleanup));
  assert.equal(cleanup.hostExited, true);
  assert.ok(events.includes('host-stop'));
});

test('a direct launch without an AppKit launch date still confirms early-failure cleanup by kernel birth', async t => {
  const { driver, events, app } = world(t, { host: true });
  app.launchedAtMs = null;
  const reply = await driver.connect({});
  assert.equal(reply.error, 'ELECTRON_UNQUALIFIED');
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, true, JSON.stringify(cleanup));
  assert.equal(cleanup.hostExited, true);
  assert.equal(events.find(event => event.mode === 'quit').pidBirth, '1234.000000');
});

test('an adoption refusal retains the census and native identity metadata', async t => {
  const { driver, app } = world(t, { host: true });
  app.path = '/fixture/Other.app';
  await assert.rejects(driver.connect({}), error => {
    assert.equal(error.message, 'FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
    assert.equal(error.detail.adoption.process.pid, 501);
    assert.equal(error.detail.adoption.native[0].path, '/fixture/Other.app');
    return true;
  });
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, false);
  assert.equal(cleanup.adoptionFailures.at(-1).process.pid, 501);
});

for (const birth of [null, '1234', '1234.12', '5678.000000']) test(`cleanup refuses unproved kernel birth ${birth}`, async t => {
  const { driver, app, events } = world(t);
  app.pidBirth = birth;
  await assert.rejects(driver.connect({}), /FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED/);
  assert.equal((await driver.cleanup()).confirmed, false);
  assert.equal(events.filter(event => event.mode === 'quit').length, 0);
});

test('a worker reply cannot replace the native kernel birth with another incarnation in the same second', async t => {
  const { driver } = world(t, { connectedBirth: '1234.000001' });
  await assert.rejects(driver.connect({}), /FIXTURE_LAUNCH_IDENTITY_CHANGED/);
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('a PID recycled after connection is never quit', async t => {
  const { driver, events, deps, app } = world(t);
  await driver.connect({});
  app.launchedAtMs = 5678000;
  app.pidBirth = '5678.000000';
  deps.list = async () => [{ pid: 501, startedAtMs: 5678000, args: '/fixture/Code.app/Contents/MacOS/Code --user-data-dir=/owner/profile' }];
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, false);
  assert.ok(cleanup.errors.includes('FIXTURE_LAUNCH_IDENTITY_CHANGED'));
  assert.equal(events.filter(event => event.mode === 'quit').length, 0);
});

for (const scenario of ['stuckWorker', 'stuckApp', 'reused', 'stuckHost']) test(`cleanup keeps evidence when ${scenario} prevents confirmation`, async t => {
  const { driver, events, root } = world(t, { [scenario]: true, ...(scenario === 'stuckHost' ? { host: true } : {}) });
  if (scenario === 'reused') await assert.rejects(driver.connect({}), /FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED/);
  else await driver.connect({});
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, false);
  assert.equal(cleanup.profileRemoved, false);
  assert.equal(existsSync(root), true);
  if (scenario === 'reused') assert.equal(events.filter(event => event.mode === 'quit').length, 0);
});

for (const stuck of [false, true]) test(`cleanup accounts for earlier orphan hosts and their adapters (stuck=${stuck})`, async t => {
  const { driver, deps, root } = world(t);
  await driver.connect({});
  const list = deps.list;
  const base = driver.armConfig().stateDir.replace(/\/state$/, '');
  let extras = [
    { pid: 801, ppid: 1, uid: process.getuid(), startedAtMs: 10, args: `${process.execPath} electron-host-run.mjs --state-dir ${base}/old/state` },
    { pid: 802, ppid: 801, uid: process.getuid(), startedAtMs: 11, args: `python3 launch.py --adapter --temp-root ${base}/old/profiles` },
    { pid: 803, ppid: 802, uid: process.getuid(), startedAtMs: 12, args: 'run-owned-helper' },
    { pid: 900, ppid: 1, uid: process.getuid(), startedAtMs: 13, args: `${process.execPath} --state-dir ${root}-other/state` },
  ];
  deps.list = async () => [...await list(), ...extras];
  const signalled = [];
  deps.signal = (pid, signal) => {
    assert.ok([801, 802, 803].includes(pid), 'only processes of this run');
    signalled.push([pid, signal]);
    if (!stuck) extras = extras.filter(row => row.pid !== pid);
  };
  const cleanup = await driver.cleanup();
  assert.equal(cleanup.confirmed, !stuck, JSON.stringify(cleanup));
  assert.equal(cleanup.runProcessesExited, !stuck);
  assert.ok(signalled.some(([pid]) => pid === 801));
  assert.ok(signalled.some(([pid]) => pid === 802));
  assert.ok(signalled.some(([pid]) => pid === 803));
  if (stuck) assert.ok(cleanup.left.includes(802));
});

test('recorded descendants remain owned after their parent exits and a stubborn adapter needs SIGKILL', async () => {
  let rows = [{ pid: 701, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: `${process.execPath} --state-dir ${MAC_TMP}/run/state` },
    { pid: 702, ppid: 701, uid: process.getuid(), startedAtMs: 2, args: 'adapter' }];
  const signals = [];
  const reaper = createRunReaper(`${MAC_TMP}/run`, { python: '/run/python3', list: async () => rows, sleep: async () => {},
    signal(pid, kind) { signals.push([pid, kind]); if (kind === 'SIGKILL') rows = []; } });
  await reaper.scan();
  rows = [{ ...rows[1], ppid: 1 }];
  assert.equal((await reaper.reap()).confirmed, true);
  assert.deepEqual(signals, [[702, 'SIGTERM'], [702, 'SIGKILL']]);
});

test('a recycled recorded PID is never signalled', async () => {
  let row = { pid: 701, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: `${process.execPath} --state-dir ${MAC_TMP}/run/state` };
  const reaper = createRunReaper(`${MAC_TMP}/run`, { python: '/run/python3', list: async () => [row], sleep: async () => {}, signal: () => assert.fail('recycled PID') });
  await reaper.scan();
  row = { ...row, startedAtMs: 2, args: 'owner process' };
  assert.equal((await reaper.reap()).confirmed, true);
});

test('the process census preserves parent identity and refuses malformed output', async () => {
  const rows = await listProcesses(async (_file, args) => {
    assert.ok(args.includes('ppid='));
    assert.ok(args.includes('uid='));
    return { stdout: ` 701 1 501 Mon Oct 19 20:00:00 2026 node --state-dir ${MAC_TMP}/run/state\n` };
  });
  assert.equal(rows[0].pid, 701);
  assert.equal(rows[0].ppid, 1);
  assert.equal(rows[0].uid, 501);
  assert.ok(Number.isFinite(rows[0].startedAtMs));
  assert.match(rows[0].args, /^node --state-dir/);
  await assert.rejects(listProcesses(async () => ({ stdout: 'malformed census\n' })), /PROCESS_CENSUS_INVALID/);
});

test('a worker PID recycled before the first scan is never adopted or signalled', async () => {
  const row = { pid: 123, ppid: 1, uid: process.getuid(), startedAtMs: 2000, args: 'owner-process' };
  const reaper = createRunReaper(`${MAC_TMP}/run`, { python: '/run/python3', list: async () => [row], pids: () => [{ pid: 123, startedAtMs: 1000 }],
    sleep: async () => {}, signal: () => assert.fail('recycled worker PID') });
  assert.deepEqual(await reaper.scan(), []);
  assert.equal((await reaper.reap()).confirmed, true);
});

test('a live recorded worker is adopted only with its spawn-time birth', async () => {
  const row = { pid: 123, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: 'worker-without-root' };
  const reaper = createRunReaper(`${MAC_TMP}/run`, { python: '/run/python3', list: async () => [row], pids: () => [{ pid: 123, startedAtMs: 1000 }] });
  assert.deepEqual((await reaper.scan()).map(row => row.pid), [123]);
});

for (const lost of [false, true]) test(`cleanup rejects a recycled worker before its first scan (exit observed=${lost})`, async t => {
  const { driver, w, deps } = world(t);
  const list = deps.list;
  const send = w.send;
  w.send = async (...args) => {
    const reply = await send(...args);
    w.lost = lost;
    deps.list = async () => [...(await list()).filter(row => row.pid !== 101),
      { pid: 101, ppid: 1, uid: process.getuid(), startedAtMs: 2000, args: 'owner-process' }];
    return reply;
  };
  await driver.connect({});
  const signal = deps.signal;
  deps.signal = (pid, kind) => { assert.notEqual(pid, 101, 'recycled worker is not owned'); signal(pid, kind); };
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('a dead worker is excluded even when a new child reuses its PID within the same census second', async t => {
  const { driver, w, deps } = world(t);
  const list = deps.list;
  const send = w.send;
  w.send = async (...args) => {
    const reply = await send(...args);
    w.lost = true;
    deps.list = async () => [...(await list()).filter(row => row.pid !== 101),
      { pid: 101, ppid: 1, uid: process.getuid(), startedAtMs: 1000, args: 'owner-process' }];
    return reply;
  };
  await driver.connect({});
  const signal = deps.signal;
  deps.signal = (pid, kind) => { assert.notEqual(pid, 101, 'exited child is not a live worker'); signal(pid, kind); };
  assert.equal((await driver.cleanup()).confirmed, true);
});

test('root text adopts only the run UID and a known binary in argv zero', async () => {
  const root = `${MAC_TMP}/run`, uid = process.getuid();
  const rows = [
    { pid: 701, ppid: 1, uid, startedAtMs: 1000, args: `${process.execPath} --state-dir ${root}/state` },
    { pid: 702, ppid: 1, uid: uid + 1, startedAtMs: 1000, args: `${process.execPath} --state-dir ${root}/other` },
    { pid: 703, ppid: 1, uid, startedAtMs: 1000, args: `rg ${process.execPath} ${root}/state` },
    { pid: 704, ppid: 1, uid, startedAtMs: 1000, args: `/owner/unknown --state-dir ${root}/state` },
    { pid: 705, ppid: 1, uid, startedAtMs: 1000, args: `${process.execPath} --state-dir ${root}-other/state` },
    { pid: 706, ppid: 701, uid: uid + 1, startedAtMs: 1000, args: 'foreign-child' },
    { pid: 707, ppid: 1, uid, startedAtMs: 1000, args: `${process.execPath} --state-dir /x${root}/state` },
    { pid: 708, ppid: 1, uid, startedAtMs: 1000, args: `${process.execPath} --data=${root}/state` },
  ];
  const reaper = createRunReaper(root, { python: '/run/python3', list: async () => rows });
  assert.deepEqual((await reaper.scan()).map(row => row.pid), [701]);
});

test('an orphan adapter uses the run-selected Python binary, including a path with spaces', async () => {
  const python = `${MAC_TMP}/custom Python/bin/python3`, root = `${MAC_TMP}/run`, uid = process.getuid();
  let rows = [
    { pid: 701, ppid: 1, uid, startedAtMs: 1, args: `${python} launch.py --temp-root ${root}/profiles` },
    { pid: 702, ppid: 1, uid, startedAtMs: 2, args: `/usr/bin/python3 launch.py --temp-root ${root}/profiles` },
  ];
  const signals = [];
  const reaper = createRunReaper(root, { python, list: async () => rows, sleep: async () => {},
    signal(pid, kind) { signals.push([pid, kind]); rows = rows.filter(row => row.pid !== pid); } });
  assert.equal((await reaper.reap()).confirmed, true);
  assert.deepEqual(signals, [[701, 'SIGTERM']]);
  assert.equal(rows[0].pid, 702);
});

test('run startup rejects unsupported hosts or resolves and reaps the expanded executable on macOS', async t => {
  const root = createRunRoot('eqpy-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = join(root, 'Python interpreter'), alias = join(root, 'python3');
  writeFileSync(actual, 'not executed'); symlinkSync(actual, alias);
  const commands = [], parentPath = process.env.PATH;
  process.env.PATH = '/runner/homebrew/bin:/usr/bin:/bin';
  t.after(() => { process.env.PATH = parentPath; });
  const exec = async (file, args, options) => {
    commands.push([file, args]);
    assert.equal(options.env.PATH, '/usr/bin:/bin', 'lookup and expansion use the host environment');
    if (file === '/usr/bin/which') {
      assert.deepEqual(args, ['python3']);
      return { stdout: '/usr/bin/python3\n' };
    }
    assert.equal(file, '/usr/bin/python3');
    assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']);
    assert.match(args[3], /sys.executable/);
    return { stdout: alias + '\n' }; // The supported system launcher expands to a different executable.
  };
  let permissionChecks = 0;
  const start = () => liveRuntime({}, { root, io: { permission: async () => { permissionChecks++; return false; } } }, {
    exec, load: async file => Object.fromEntries(CONTRACT.find(([name]) => name === file)[1].map(name => [name, () => {}])),
  });
  if (process.platform !== 'darwin') {
    await assert.rejects(start, { message: 'MACOS_REQUIRED' });
    assert.deepEqual(commands, [], 'unsupported hosts do not resolve or launch an interpreter');
    assert.equal(permissionChecks, 0, 'unsupported hosts do not request permission');
    return;
  }
  const runtime = await start();
  assert.equal(permissionChecks, 1);
  let rows = [];
  const signalled = [];
  const driver = runtime.driverFor(APPS.vscode, { deps: { list: async () => rows, sleep: async () => {},
    signal: pid => { signalled.push(pid); rows = rows.filter(row => row.pid !== pid); } } });
  const config = driver.armConfig();
  assert.equal(config.python, actual, 'launch gets the same absolute executable as cleanup');
  assert.equal(commands.length, 2);
  assert.equal(process.env.PATH, '/runner/homebrew/bin:/usr/bin:/bin');
  let spawned;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
  createPythonAdapter({ python: config.python, script: '/fixture/launch.py', registryPath: config.registryPath, tempRoot: config.tempRoot,
    spawn(file, _args, options) { spawned = file; assert.equal(options.env.PATH, '/usr/bin:/bin'); return child; } });
  assert.equal(spawned, actual);
  rows = [actual, '/runner/homebrew/python3', '/usr/bin/python3'].map((python, index) => ({ pid: 701 + index, ppid: 1, uid: process.getuid(), startedAtMs: 1,
    args: `${python} launch.py --temp-root ${config.stateDir}/adapter` }));
  assert.equal((await driver.cleanup()).confirmed, true);
  assert.deepEqual(signalled, [701], 'only the exact expanded executable is adopted without a parent');
});

for (const python of [undefined, 'python3', '', '/run/python3\n', '/run/../python3']) test(`unresolved interpreter refuses empty cleanup proof (${JSON.stringify(python)})`, async () => {
  const reaper = createRunReaper(`${MAC_TMP}/run`, { python, list: async () => [], signal: () => assert.fail('no signal') });
  const result = await reaper.reap();
  assert.equal(result.confirmed, false);
  assert.ok(result.errors.includes('RUN_PYTHON_UNRESOLVED'));
});

for (const stdout of ['', 'python3\n', '/one\n/two\n']) test(`interpreter expansion fails closed for ${JSON.stringify(stdout)}`, async () => {
  let count = 0;
  await assert.rejects(resolveRunPython('python3', { realpath: p => p, exec: async () => ({ stdout: ++count === 1 ? '/usr/bin/python3\n' : stdout }) }), /RUN_PYTHON_UNAVAILABLE/);
});


test('the immediate signal check refuses a changed incarnation or UID', async () => {
  for (const replacement of [{ startedAtMs: 2 }, { uid: process.getuid() + 1 }]) {
    const root = `${MAC_TMP}/run`, uid = process.getuid();
    let reads = 0;
    const row = { pid: 701, ppid: 1, uid, startedAtMs: 1, args: `/run/python3 launch.py --temp-root ${root}/profiles` };
    const reaper = createRunReaper(root, { python: '/run/python3', sleep: async () => {},
      list: async () => [{ ...row, ...(reads++ ? replacement : {}) }], signal: () => assert.fail('replacement is not owned') });
    assert.equal((await reaper.reap()).confirmed, true);
  }
});
