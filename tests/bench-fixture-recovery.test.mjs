import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openFixture } from '../bench/real-fixture.mjs';
import { runInNewContext } from 'node:vm';

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

function saveFixture({ label = "Don't Save", preexisting = false } = {}) {
  const sandbox = source(), app = {}, button = { AXRole: 'AXButton', AXTitle: label };
  const sheet = { AXRole: 'AXSheet', AXChildren: [button, { AXRole: 'AXButton', AXTitle: 'Save' }, { AXRole: 'AXButton', AXTitle: 'Cancel' }] };
  const window = { AXRole: 'AXWindow', AXTitle: 'Report-nonce', AXDocument: 'file:///run/Report-nonce.docx', AXSheets: preexisting ? [sheet] : [] };
  const presses = [];
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => { const value = element[attribute] ?? null; output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value; return 0; };
  native.AXUIElementPerformAction = element => {
    presses.push(element);
    if (element === button) window.AXRole = '';
    else window.AXSheets = [sheet];
    return 0;
  };
  native.CFEqual = (a, b) => a === b;
  native.NSThread = { sleepForTimeInterval() {} };
  native.NSURL = {
    URLWithString: value => ({ isNil: () => false, isFileURL: value.startsWith('file://'), URLByResolvingSymlinksInPath: { path: value.slice(7) } }),
    fileURLWithPath: value => ({ absoluteString: `file://${value}` }),
  };
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  window.AXCloseButton = {};
  app.AXFocusedWindow = window;
  const api = sandbox.nativeAX({ cleanup: true, setupCase: 'cold-launch' }, { now: () => 1, check() {}, emit() {}, wait() {}, cleanupRequested: () => true });
  const request = { mode: 'document', target: '/run/Report-nonce.docx', token: 'nonce', refuseDialogs: true };
  return { sandbox, native, app, button, sheet, window, presses, api, request };
}

for (const label of ["Don't Save", 'Don’t Save']) for (const preexisting of [false, true]) {
  test(`strict cleanup discards ${preexisting ? 'an existing' : 'a close-created'} owned ${label} sheet`, () => {
    const f = saveFixture({ label, preexisting });
    f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api);
    assert.equal(f.window.AXRole, '');
    assert.equal(f.presses.at(-1), f.button);
    assert.equal(f.presses.length, preexisting ? 1 : 2);
  });
}

for (const kind of ['foreign path', 'absent path', 'foreign title', 'two sheets', 'permission', 'other button', 'other dialog']) {
  test(`strict cleanup preserves a ${kind} despite a discard button`, () => {
    const f = saveFixture({ preexisting: true });
    if (kind === 'foreign path') f.window.AXDocument = 'file:///owner/Report-nonce.docx';
    if (kind === 'absent path') delete f.window.AXDocument;
    if (kind === 'foreign title') f.window.AXTitle = 'Owner document';
    if (kind === 'two sheets') f.window.AXSheets.push({ AXRole: 'AXSheet' });
    if (kind === 'permission') f.sheet.AXChildren.push({ AXRole: 'AXStaticText', AXValue: 'Would like to access your files' });
    if (kind === 'other button') f.sheet.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Allow' });
    if (kind === 'other dialog') f.app.AXFocusedWindow = { AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Sign in' };
    assert.throws(() => f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api));
    assert.deepEqual(f.presses, []);
  });
}

test('observation ignores only the safe sheet attached to the identified fixture', () => {
  const f = saveFixture({ preexisting: true });
  assert.equal(f.api.dialog(f.app, f.window, f.request).length, 0);
  f.app.AXFocusedWindow = f.sheet;
  assert.equal(f.api.dialog(f.app, f.window, f.request).length, 0, 'a focused attached sheet is the same safe sheet');
  f.window.AXDocument = 'file:///owner/Report-nonce.docx';
  assert.ok(f.api.dialog(f.app, f.window, f.request).length > 0);
});

function processes() {
  const sandbox = source(), events = [];
  const date = ms => ({ isNil: () => false, timeIntervalSince1970: ms / 1000 });
  const apps = [42, 43].map(pid => ({ processIdentifier: pid, bundleIdentifier: 'test.editor', launchDate: date(200), windows: [
    { id: pid, path: `/run/File-${pid}-nonce.txt`, title: `File-${pid}-nonce.txt` },
  ] }));
  const api = {
    applications: () => apps.filter(app => !app.exited),
    application: pid => apps.find(app => app.processIdentifier === pid && !app.exited),
    windows: app => app.windows,
    app: target => target,
    path: value => value.startsWith('file://') ? value.slice(7) : value.startsWith('/') ? value : null,
    text: (window, attribute) => attribute === 'AXDocument' ? `file://${window.path}` : window.title,
    equal: (a, b) => a === b,
    dialog: () => [],
    exists: window => apps.some(app => app.windows.includes(window)),
    matches: (window, request) => window.path === request.target,
    closeButton: (window, validate) => { validate(); events.push(`close:${window.id}`); apps.find(app => app.windows.includes(window)).windows = []; },
    wait() {},
  };
  for (const app of apps) Object.defineProperty(app, 'terminate', { get() { events.push(`quit:${app.processIdentifier}`); app.exited = true; return true; } });
  const request = { bundle: 'test.editor', fixtureDir: '/run', startedAtMs: 100, runToken: 'nonce', launched: true, running: false, refuseDialogs: true };
  const clock = { now: () => 300, check() {}, emit() {}, wait() {} };
  return { sandbox, apps, api, request, clock, events,
    recover() { return sandbox.recoverFixtureApplications(request, api, clock); } };
}

test('recovery closes each owned process window by its button before quitting every process', () => {
  const f = processes();
  f.recover();
  assert.deepEqual(f.events, ['close:42', 'close:43', 'quit:42', 'quit:43']);
  assert.equal(f.apps.every(app => app.exited), true);
});

for (const kind of ['old process', 'unknown launch', 'foreign bundle', 'foreign window', 'sibling prefix', 'missing document', 'foreign title', 'dialog', 'preexisting app', 'not launched']) {
  test(`multi-process recovery refuses ${kind} before touching any process`, () => {
    const f = processes(), second = f.apps[1];
    if (kind === 'old process') second.launchDate.timeIntervalSince1970 = 0;
    if (kind === 'unknown launch') second.launchDate = null;
    if (kind === 'foreign bundle') second.bundleIdentifier = 'owner.app';
    if (kind === 'foreign window') second.windows[0].path = '/owner/File-nonce.txt';
    if (kind === 'sibling prefix') second.windows[0].path = '/run-other/File-nonce.txt';
    if (kind === 'missing document') f.api.text = () => '';
    if (kind === 'foreign title') second.windows[0].title = 'Owner document';
    if (kind === 'dialog') f.api.dialog = app => app === second ? [{}] : [];
    if (kind === 'preexisting app') f.request.running = true;
    if (kind === 'not launched') f.request.launched = false;
    assert.throws(() => f.recover(), /ownership|outside|dialog|identity/i);
    assert.deepEqual(f.events, []);
  });
}

test('recovery revalidates all processes after a close exposes an owner window', () => {
  const f = processes(), close = f.api.closeButton;
  f.api.closeButton = (window, validate) => { close(window, validate); f.apps[1].windows[0].path = '/owner/File-nonce.txt'; };
  assert.throws(() => f.recover(), /identity|outside|owned/i);
  assert.deepEqual(f.events, ['close:42']);
});

test('strict discard uses the run nonce when the app omits the filename extension', () => {
  const f = saveFixture({ preexisting: true });
  f.request.token = 'Report-nonce.docx'; f.request.runToken = 'nonce';
  f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api);
  assert.equal(f.window.AXRole, '');
});

test('an existing save sheet cannot bypass a document focus change', () => {
  const f = saveFixture({ preexisting: true });
  f.app.AXFocusedWindow = { AXRole: 'AXWindow', AXTitle: 'Owner file', AXDocument: 'file:///owner/file.txt' };
  assert.throws(() => f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api), /focus/);
  assert.deepEqual(f.presses, []);
});

test('strict discard never presses a button from a replaced attached sheet', () => {
  const f = saveFixture({ preexisting: true });
  const replacement = { ...f.sheet, AXChildren: f.sheet.AXChildren.map(button => ({ ...button })) };
  assert.throws(() => f.api.discard(f.window, () => { f.window.AXSheets = [replacement]; }, f.request), /identity changed/);
  assert.deepEqual(f.presses, []);
});

test('recovery refuses a new process appearing between window closes', () => {
  const f = processes(), close = f.api.closeButton;
  f.api.closeButton = (window, validate) => { close(window, validate); f.apps.push({ ...f.apps[1], processIdentifier: 44, windows: [] }); };
  assert.throws(() => f.recover(), /identity changed/);
  assert.deepEqual(f.events, ['close:42']);
});

test('a waited inventory read repeats earlier process ownership checks before the next close', () => {
  const f = processes(), windows = f.api.windows;
  let epoch = 0;
  f.api.readEpoch = () => epoch;
  f.api.windows = app => {
    if (app === f.apps[1] && f.events.length && epoch === 0) {
      epoch++;
      f.apps[0].windows = [{ id: 99, path: '/owner/File-nonce.txt', title: 'Owner' }];
    }
    return windows(app);
  };
  assert.throws(() => f.recover(), /outside owned/);
  assert.deepEqual(f.events, ['close:42']);
});

test('strict discard normalizes a fixture path containing spaces and a URL fragment character', () => {
  const f = saveFixture({ preexisting: true });
  f.request.target = '/run/Report #nonce.docx';
  f.window.AXDocument = 'file:///run/Report%20%23nonce.docx';
  f.native.NSURL.URLWithString = value => ({ isNil: () => false, isFileURL: true,
    URLByResolvingSymlinksInPath: { path: decodeURIComponent(new URL(value).pathname) } });
  f.native.NSURL.fileURLWithPath = value => ({ absoluteString: pathToFileURL(value).href });
  f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api);
  assert.equal(f.window.AXRole, '');
});

for (const receipt of [true, false]) test(`parent recovery ${receipt ? 'confirms all app exits' : 'refuses a missing native receipt'}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fc2-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [], ctx = { dir, nonce: 'nonce', beforeFixtureCleanup: async () => calls.push('observe') };
  let collected = false;
  const lease = await openFixture(ctx, { app: 'Editor', bundle: 'com.apple.TextEdit', target: join(dir, 'File-nonce.txt'), token: 'File-nonce.txt', mode: 'document', refuseDialogs: true }, {
    open: async () => {},
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'recover') {
        assert.equal(collected, true);
        assert.equal(request.fixtureDir, dir);
        assert.equal(request.runToken, 'nonce');
        assert.equal(request.launched, true);
        assert.equal(request.running, false);
        assert.ok(request.startedAtMs > 0);
        assert.deepEqual(calls, ['collect', 'observe']);
        calls.push('recover');
        return { groupClean: true, exit: { code: 0 }, stdout: receipt ? '{"stage":"recovered","pids":[42,43]}\n' : '' };
      }
      assert.equal(request.runToken, 'nonce');
      options.onStdout('{"stage":"armed","running":false,"pid":42}\n{"stage":"ready"}\n');
      return new Promise(resolve => options.signal.addEventListener('abort', () => {
        collected = true; calls.push('collect');
        resolve({ groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'Ambiguous fixture process' });
      }, { once: true }));
    },
  });
  ctx.fixtureDiagnostics[0].appQuit = true;
  if (receipt) await lease.recover();
  else await assert.rejects(lease.recover(), /recovery unconfirmed/);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, receipt, 'an old single-PID quit must not survive failed recovery');
  assert.equal(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, receipt ? true : undefined);
  assert.equal(ctx.fixtureDiagnostics[0].helperCollectionConfirmed, true);
  assert.deepEqual(calls, ['collect', 'observe', 'recover']);
});

test('dialog observation tolerates an already-closed fixture with an absolute target path', () => {
  const f = saveFixture();
  f.app.AXFocusedWindow = null;
  const read = f.native.AXUIElementCopyAttributeValue;
  f.native.AXUIElementCopyAttributeValue = (element, ...args) => element === f.window ? -25202 : read(element, ...args);
  assert.equal(f.api.dialog(f.app, f.window, f.request).length, 0);
});

test('strict discard refuses a sheet removed during final validation', () => {
  const f = saveFixture({ preexisting: true });
  f.native.CFEqual = (a, b) => { assert.ok(a && b, 'never compare a removed native sheet'); return a === b; };
  assert.throws(() => f.api.discard(f.window, () => { f.window.AXSheets = []; }, f.request), /identity changed/);
  assert.deepEqual(f.presses, []);
});

test('the native recovery entrypoint uses app inventory and emits a receipt after both processes exit', () => {
  const f = saveFixture(), events = [];
  const bundle = 'com.apple.TextEdit';
  const date = { isNil: () => false, timeIntervalSince1970: 0.2 };
  const apps = [42, 43].map(pid => ({ processIdentifier: pid, bundleIdentifier: bundle, launchDate: date, isFinishedLaunching: true,
    AXWindows: [{ ...f.window, AXDocument: `file:///run/File-${pid}-nonce.txt`, AXTitle: `File-${pid}-nonce.txt`, AXSheets: [] }],
  }));
  for (const app of apps) {
    const window = app.AXWindows[0]; window.AXCloseButton = { app, window };
    Object.defineProperty(app, 'terminate', { get() { assert.equal(app.AXWindows.length, 0); app.exited = true; return true; } });
  }
  f.native.AXIsProcessTrusted = () => true;
  f.native.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: actual => {
      assert.equal(actual, bundle);
      const live = apps.filter(app => !app.exited);
      return { count: live.length, objectAtIndex: i => live[i] };
    },
    runningApplicationWithProcessIdentifier: pid => apps.find(app => app.processIdentifier === pid && !app.exited) ?? { isNil: () => true },
  };
  for (const app of apps) app.isNil = () => false;
  f.native.AXUIElementCreateApplication = pid => apps.find(app => app.processIdentifier === pid);
  f.native.AXUIElementSetMessagingTimeout = () => {};
  f.native.AXUIElementPerformAction = button => { button.app.AXWindows = []; button.window.AXRole = ''; return 0; };
  f.native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: value => events.push(JSON.parse(value)) } };
  f.sandbox.$ = Object.assign(value => ({ toString: () => value, dataUsingEncoding: () => value }), f.native);
  f.sandbox.run([JSON.stringify({ mode: 'recover', bundle, app: 'Editor', fixtureDir: '/run', runToken: 'nonce', startedAtMs: 100, running: false, launched: true })]);
  assert.equal(apps.every(app => app.exited), true);
  assert.deepEqual(events.at(-1), { stage: 'recovered', pids: [42, 43] });
});
