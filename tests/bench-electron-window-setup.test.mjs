import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { APPS } from '../bench/electron-qualification.mjs';
import * as live from '../bench/electron-qualification-live.mjs';
const { createRunRoot, liveDriver } = live;
const fakeProfileRoot = join(tmpdir(), 'owned', 'profiles');

function nativeWorld({ windows = [11], after = [11, 12], changedAt, trusted = true, files = [{}], items = [{}], accepted = true } = {}) {
  const sandbox = { ObjC: { import() {}, bindFunction() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-electron.js', import.meta.url), 'utf8'), sandbox);
  let now = 0, reads = 0;
  const events = [], request = { pid: 501, pidBirth: '1234.000000', bundle: 'com.microsoft.VSCode', appPath: '/Applications/Fixture.app',
    profileRoot: fakeProfileRoot, profile: join(fakeProfileRoot, 'vscode', 'user-data'), waitMs: 300 };
  const api = {
    trusted: () => trusted,
    running: () => { reads++; return { pid: 501, pidBirth: changedAt <= reads ? '1234.000001' : request.pidBirth, bundle: request.bundle, path: request.appPath }; },
    windowIds: () => events.includes('new-window') ? after : windows,
    fileMenus: () => files,
    newWindowItems: () => items,
    press: item => { events.push(item === files[0] ? 'file' : 'new-window'); return accepted; },
    cancelMenu: () => events.push('cancel-menu'),
  };
  const clock = { now: () => now, wait: ms => { now += ms; }, emit: value => events.push(value) };
  return { run: () => sandbox.newWindow(request, api, clock), api, request, events, advance: ms => { now += ms; } };
}

test('native window setup presses only the owned File/New Window route and waits for two stable IDs', () => {
  const w = nativeWorld();
  const result = w.run();
  assert.equal(result.stage, 'new-window');
  assert.equal(result.created, true);
  assert.deepEqual(Array.from(result.windows), [11, 12]);
  assert.deepEqual(w.events.filter(event => typeof event === 'string'), ['file', 'new-window', 'cancel-menu']);
});
test('two existing owned native windows make setup idempotent', () => {
  const w = nativeWorld({ windows: [11, 12] });
  assert.equal(w.run().created, false);
  assert.deepEqual(w.events.filter(event => typeof event === 'string'), []);
});
test('native setup waits briefly for the owned File menu to expose its New Window item', () => {
  const w = nativeWorld(); let polls = 0;
  w.api.newWindowItems = () => ++polls < 3 ? [] : [{}];
  assert.equal(w.run().created, true);
  assert.equal(polls, 3);
});
for (const [name, options, code] of [
  ['accessibility', { trusted: false }, 'WINDOW_SETUP_ACCESSIBILITY'],
  ['ambiguous File menu', { files: [{}, {}] }, 'WINDOW_SETUP_MENU_AMBIGUOUS'],
  ['ambiguous New Window', { items: [{}, {}] }, 'WINDOW_SETUP_MENU_AMBIGUOUS'],
  ['failed AX press', { accepted: false }, 'WINDOW_SETUP_PRESS_FAILED'],
  ['timeout', { after: [11] }, 'WINDOW_SETUP_TIMEOUT'],
  ['third window', { after: [11, 12, 13] }, 'WINDOW_SETUP_WINDOW_CHANGED'],
  ['replacement window', { after: [12, 13] }, 'WINDOW_SETUP_WINDOW_CHANGED'],
  ['duplicate IDs', { windows: [11, 11] }, 'WINDOW_SETUP_WINDOW_CHANGED'],
]) test(`native window setup refuses ${name}`, () => {
  const w = nativeWorld(options);
  assert.throws(w.run, new RegExp(code));
});
for (const changedAt of [1, 2, 3, 4]) test(`native window setup revalidates the exact birth at boundary ${changedAt}`, () => {
  const w = nativeWorld({ changedAt });
  assert.throws(w.run, /WINDOW_SETUP_IDENTITY_CHANGED/);
  if (changedAt <= 2) assert.equal(w.events.includes('file'), false);
  if (changedAt <= 3) assert.equal(w.events.includes('new-window'), false);
  assert.equal(w.events.includes('cancel-menu'), false, 'identity loss forbids cleanup actions against that PID too');
});
for (const changedAt of [5, 6]) test(`created-window success refuses same-second birth loss at final boundary ${changedAt}`, () => {
  const w = nativeWorld({ changedAt });
  assert.throws(w.run, /WINDOW_SETUP_IDENTITY_CHANGED/);
  assert.equal(w.events.some(event => typeof event === 'object' && event.stage === 'new-window'), false);
  if (changedAt === 5) assert.equal(w.events.includes('cancel-menu'), false);
});
test('existing-two-window success rechecks exact birth after reading window IDs', () => {
  const w = nativeWorld({ windows: [11, 12], changedAt: 2 });
  assert.throws(w.run, /WINDOW_SETUP_IDENTITY_CHANGED/);
  assert.deepEqual(w.events, []);
});
for (const [name, method, call, existing, noCreation] of [
  ['File menu lookup', 'fileMenus', 1, false, true],
  ['New Window lookup', 'newWindowItems', 1, false, true],
  ['File press', 'press', 1, false, true],
  ['New Window press', 'press', 2, false, false],
  ['initial window census', 'windowIds', 1, false, true],
  ['new window census', 'windowIds', 2, false, false],
  ['existing window census', 'windowIds', 1, true, true],
  ['pre-creation identity', 'running', 3, false, true],
  ['final identity', 'running', 6, false, false],
]) test(`native window setup enforces its shared deadline after slow ${name}`, () => {
  const w = nativeWorld(existing ? { windows: [11, 12] } : {}), original = w.api[method];
  let calls = 0;
  w.api[method] = (...args) => { const result = original(...args); if (++calls === call) w.advance(w.request.waitMs); return result; };
  assert.throws(w.run, /WINDOW_SETUP_TIMEOUT/);
  assert.equal(w.events.some(event => typeof event === 'object' && event.stage === 'new-window'), false);
  if (noCreation) assert.equal(w.events.includes('new-window'), false);
});
test('native setup refuses a different bundle/path and a profile outside the temporary run', () => {
  for (const change of [{ bundle: 'org.owner.App' }, { path: '/Applications/Owner.app' }, { pid: 700 }]) {
    const w = nativeWorld(), original = w.api.running;
    w.api.running = () => ({ ...original(), ...change });
    assert.throws(w.run, /WINDOW_SETUP_IDENTITY_CHANGED/);
    assert.equal(w.events.includes('file'), false);
  }
  for (const profile of ['/owner/profile', `${fakeProfileRoot}/../owner`, fakeProfileRoot]) {
    const w = nativeWorld(); w.request.profile = profile;
    assert.throws(w.run, /WINDOW_SETUP_REQUEST/);
    assert.equal(w.events.includes('file'), false);
  }
});

function liveWorld(t, { ownedHelper, helperCollected = true } = {}) {
  const root = createRunRoot('eqws-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = { path: '/Applications/Fixture Code.app', executable: '/Applications/Fixture Code.app/Contents/MacOS/Code' };
  const app = { pid: 501, bundle: APPS.vscode.bundleId, path: found.path, pidBirth: '1234.000000' };
  const events = []; let config, row, profile;
  const worker = { child: { pid: 101 }, lost: false, kill() {}, async stop() { return true; }, async send(op, data) {
    if (op === 'start') {
      config = data; profile = join(config.tempRoot, 'owned', 'user-data'); mkdirSync(profile, { recursive: true });
      row = { pid: 501, uid: process.getuid(), startedAtMs: 1234000, args: `${found.executable} --user-data-dir=${profile}` };
      return { ok: true, identity: { pid: app.pid, pidBirth: app.pidBirth }, card: { status: 'granted' }, launch: {} };
    }
    return { ok: true };
  } };
  const deps = {
    inspectBundle: async () => ({ found, recipe: { build: 'fixture' }, build: {}, appSecret: 'fixture' }),
    list: async () => [{ pid: 101, ppid: process.pid, uid: process.getuid(), startedAtMs: 1000, args: `${process.execPath} worker.mjs` }, ...(row ? [row] : [])],
    electron: async request => {
      if (request.mode === 'table') return { processes: [app] };
      assert.equal(request.mode, 'new-window'); events.push(request);
      deps.afterNative?.();
      return { stage: 'new-window', created: true, windows: [11, 12] };
    },
  };
  if (ownedHelper) {
    assert.equal(typeof live.fixtureHelper, 'function', 'the collector seam must exist before constructing a driver');
    deps.electron = live.fixtureHelper(APPS.vscode.bundleId, async (command, args, options) => {
      assert.equal(command, '/usr/bin/osascript');
      assert.equal(args[0], '-l'); assert.equal(args[1], 'JavaScript');
      assert.ok(args[2].endsWith('/bench/real-electron.js'));
      assert.equal(options.timeoutMs, 45000);
      const request = JSON.parse(args[3]);
      if (request.mode === 'table') return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ stage: 'table', processes: [app] }) };
      events.push({ collected: helperCollected, request });
      return { groupClean: helperCollected, exit: { code: 0 }, stdout: JSON.stringify({ stage: 'new-window', created: true, windows: [11, 12] }) };
    });
  }
  const driver = liveDriver(APPS.vscode, { root, observer: {}, forkWorker: () => worker, python: '/run/python3', deps,
    exec: async () => ({ stdout: '{"front":90,"bundle":"com.apple.Terminal"}', stderr: '' }) });
  driver.frontApp = async options => { events.push({ restored: options?.bundle }); };
  return { driver, events, deps, get row() { return row; }, set row(value) { row = value; }, get profile() { return profile; }, get config() { return config; } };
}
test('live setup binds the native request to recorded birth and canonical run profile, then restores Terminal', async t => {
  const w = liveWorld(t); await w.driver.connect({});
  const result = await w.driver.nativeSecondWindow();
  assert.deepEqual(result.windows, [11, 12]);
  const sent = w.events[0];
  assert.equal(sent.pid, 501); assert.equal(sent.pidBirth, '1234.000000');
  assert.equal(sent.bundle, APPS.vscode.bundleId); assert.equal(sent.appPath, '/Applications/Fixture Code.app');
  assert.equal(sent.profile, w.profile); assert.equal(sent.profileRoot, w.config.tempRoot);
  assert.equal(sent.waitMs, 10000);
  assert.deepEqual(w.events.at(-1), { restored: 'com.apple.Terminal' });
});
for (const variant of ['pid', 'birth', 'uid', 'executable', 'owner-profile', 'traversal', 'duplicate-profile', 'space-profile'])
  test(`live native setup refuses ${variant} before a native helper call`, async t => {
    const w = liveWorld(t); await w.driver.connect({});
    if (variant === 'pid') w.row.pid = 502;
    if (variant === 'birth') w.row.startedAtMs++;
    if (variant === 'uid') w.row.uid++;
    if (variant === 'executable') w.row.args = '/other/Code --user-data-dir=' + w.profile;
    if (variant === 'owner-profile') w.row.args = w.row.args.replace(w.profile, '/owner/profile');
    if (variant === 'traversal') w.row.args = w.row.args.replace(w.profile, w.config.tempRoot + '/../owner');
    if (variant === 'duplicate-profile') w.row.args += ' --user-data-dir=/owner/profile';
    if (variant === 'space-profile') w.row.args += ' --user-data-dir /owner/profile';
    await assert.rejects(w.driver.nativeSecondWindow(), /WINDOW_SETUP_IDENTITY_CHANGED/);
    assert.deepEqual(w.events, []);
  });
test('native setup rechecks the profile after its helper and restores Terminal on failure', async t => {
  const w = liveWorld(t); await w.driver.connect({});
  w.deps.afterNative = () => { w.row.args = w.row.args.replace(w.profile, '/owner/profile'); };
  await assert.rejects(w.driver.nativeSecondWindow(), /WINDOW_SETUP_IDENTITY_CHANGED/);
  assert.deepEqual(w.events.at(-1), { restored: 'com.apple.Terminal' });
});
test('the native setup helper is owned and collected before success; unproved collection refuses setup', async t => {
  for (const helperCollected of [true, false]) {
    const w = liveWorld(t, { ownedHelper: true, helperCollected });
    await w.driver.connect({});
    if (helperCollected) assert.deepEqual((await w.driver.nativeSecondWindow()).windows, [11, 12]);
    else await assert.rejects(w.driver.nativeSecondWindow(), /FIXTURE_HELPER_UNCONFIRMED/);
    assert.equal(w.events[0].collected, helperCollected);
    assert.deepEqual(w.events.at(-1), { restored: 'com.apple.Terminal' });
  }
});
