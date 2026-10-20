import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArmConfig } from '../bench/electron-arm-server.mjs';
import { APPS } from '../bench/electron-qualification.mjs';
import { CONTRACT, createRunRoot, listProcesses, liveDriver, liveRuntime } from '../bench/electron-qualification-live.mjs';
import { createRunReaper } from '../bench/electron-run-cleanup.mjs';

function world(t, { stuckWorker = false, stuckApp = false, reused = false, throws = false, host = false, stuckHost = false, observeLaunch = false, missingWindow = false, connectedBirth } = {}) {
  const root = createRunRoot('eqcl-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = { path: '/fixture/Code.app', executable: '/fixture/Code.app/Contents/MacOS/Code' };
  const events = [], app = { pid: 501, bundle: APPS.vscode.bundleId, path: found.path, launchedAtMs: 1234000, pidBirth: '1234.000000' };
  let config, running = true, workerRunning = true, hostRunning = host, tableRead = false;
  const w = { child: { pid: 101 }, lost: false, kill() { events.push('kill'); }, async stop() { events.push('worker-stop'); workerRunning = stuckWorker; w.lost = !workerRunning; return !workerRunning; },
    async send(op, msg) { if (op === 'start') { config = msg; if (throws) throw Error('IPC_LOST');
      if (connectedBirth) return { ok: true, identity: { pid: 501, pidBirth: connectedBirth }, card: { shown: true, status: 'granted' }, launch: {}, connectMs: 1 };
      return { ok: false, error: 'ELECTRON_UNQUALIFIED', stage: 'app-select', card: { shown: true, status: 'granted' } }; } return { ok: true }; } };
  const deps = {
    inspectBundle: async () => ({ found, build: {}, recipe: { build: 'fixture' }, appSecret: 'fixture' }),
    list: async () => [...(workerRunning ? [{ pid: 101, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: `${process.execPath} worker.mjs` }] : []), ...(config && running ? [
      { pid: 501, startedAtMs: reused && tableRead ? 5678000 : 1234000, args: `${found.executable} --user-data-dir=${config.tempRoot}/owned/user-data` },
      { pid: 600, startedAtMs: 1000, args: `${found.executable} --user-data-dir=/owner/profile` },
    ] : []), ...(config && hostRunning ? [{ pid: 701, uid: process.getuid(), startedAtMs: 1200000, args: `${process.execPath} --state-dir ${config.stateDir}` }] : [])],
    electron: async request => {
      if (request.mode === 'table') { tableRead = true; return { processes: running ? [app] : [] }; }
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
    sleep: async ms => { events.push({ sleep: ms }); },
  };
  const exec = async () => ({ stdout: '{"front":90,"bundle":"fixture.other"}', stderr: '' });
  const observer = observeLaunch ? { firstWindowMs: (pid, since) => {
    assert.equal(pid, app.pid); assert.equal(since, app.launchedAtMs); return missingWindow ? null : 1234200;
  } } : {};
  const driver = liveDriver(APPS.vscode, { root, exec, observer, forkWorker: () => w, python: '/run/python3', qualificationDiagnosticPath: '/run/diagnostic', deps });
  driver.frontApp = async () => { events.push('restore-front'); return { pid: 90, bundle: 'com.apple.Terminal' }; };
  return { root, driver, events, deps, app, w };
}

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
  let rows = [{ pid: 701, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: `${process.execPath} --state-dir /private/tmp/run/state` },
    { pid: 702, ppid: 701, uid: process.getuid(), startedAtMs: 2, args: 'adapter' }];
  const signals = [];
  const reaper = createRunReaper('/private/tmp/run', { list: async () => rows, sleep: async () => {},
    signal(pid, kind) { signals.push([pid, kind]); if (kind === 'SIGKILL') rows = []; } });
  await reaper.scan();
  rows = [{ ...rows[1], ppid: 1 }];
  assert.equal((await reaper.reap()).confirmed, true);
  assert.deepEqual(signals, [[702, 'SIGTERM'], [702, 'SIGKILL']]);
});

test('a recycled recorded PID is never signalled', async () => {
  let row = { pid: 701, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: `${process.execPath} --state-dir /private/tmp/run/state` };
  const reaper = createRunReaper('/private/tmp/run', { list: async () => [row], sleep: async () => {}, signal: () => assert.fail('recycled PID') });
  await reaper.scan();
  row = { ...row, startedAtMs: 2, args: 'owner process' };
  assert.equal((await reaper.reap()).confirmed, true);
});

test('the process census preserves parent identity and refuses malformed output', async () => {
  const rows = await listProcesses(async (_file, args) => {
    assert.ok(args.includes('ppid='));
    assert.ok(args.includes('uid='));
    return { stdout: ' 701 1 501 Mon Oct 19 20:00:00 2026 node --state-dir /private/tmp/run/state\n' };
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
  const reaper = createRunReaper('/private/tmp/run', { list: async () => [row], pids: () => [{ pid: 123, startedAtMs: 1000 }],
    sleep: async () => {}, signal: () => assert.fail('recycled worker PID') });
  assert.deepEqual(await reaper.scan(), []);
  assert.equal((await reaper.reap()).confirmed, true);
});

test('a live recorded worker is adopted only with its spawn-time birth', async () => {
  const row = { pid: 123, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: 'worker-without-root' };
  const reaper = createRunReaper('/private/tmp/run', { list: async () => [row], pids: () => [{ pid: 123, startedAtMs: 1000 }] });
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
  const root = '/private/tmp/run', uid = process.getuid();
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
  const reaper = createRunReaper(root, { list: async () => rows });
  assert.deepEqual((await reaper.scan()).map(row => row.pid), [701]);
});

test('an orphan adapter uses the run-selected Python binary, including a path with spaces', async () => {
  const python = '/private/tmp/custom Python/bin/python3', root = '/private/tmp/run', uid = process.getuid();
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

test('run startup resolves Python offline and the reaper recognizes its expanded interpreter path', async t => {
  const root = createRunRoot('eqpy-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = join(root, 'Python interpreter'), alias = join(root, 'python3');
  writeFileSync(actual, 'not executed'); symlinkSync(actual, alias);
  const commands = [];
  const exec = async (file, args) => {
    commands.push([file, args]);
    assert.equal(file, '/usr/bin/which'); assert.deepEqual(args, ['python3']);
    return { stdout: alias + '\n' };
  };
  const runtime = await liveRuntime({}, { root, io: { permission: async () => false } }, {
    exec, load: async file => Object.fromEntries(CONTRACT.find(([name]) => name === file)[1].map(name => [name, () => {}])),
  });
  let rows = [];
  const signalled = [];
  const driver = runtime.driverFor(APPS.vscode, { deps: { list: async () => rows, sleep: async () => {},
    signal: pid => { signalled.push(pid); rows = rows.filter(row => row.pid !== pid); } } });
  const config = driver.armConfig();
  assert.equal(config.python, 'python3', 'resolution does not change the launch option');
  assert.equal(commands.length, 1);
  rows = [actual, 'python3'].map((python, index) => ({ pid: 701 + index, ppid: 1, uid: process.getuid(), startedAtMs: 1,
    args: `${python} launch.py --temp-root ${config.stateDir}/adapter` }));
  assert.equal((await driver.cleanup()).confirmed, true);
  assert.deepEqual(signalled, [701, 702]);
});
