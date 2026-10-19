import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openFixture, retryFixtureCleanup } from '../bench/real-fixture.mjs';
import { runInNewContext } from 'node:vm';

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value } };
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

test('cleanup ignores only the safe sheet attached to the identified fixture', () => {
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
  api.cgWindowCount = pid => apps.find(app => app.processIdentifier === pid).windows.length;
  const request = { bundle: 'test.editor', fixtureMode: 'document', pids: [42, 43], fixtureDir: '/run', startedAtMs: 100, runToken: 'nonce', launched: true, running: false, refuseDialogs: true };
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
  f.native.CGWindowListCopyWindowInfo = options => {
    assert.equal(options, 0, 'include off-screen windows');
    return apps.flatMap(app => app.exited ? [] : app.AXWindows.map(() => ({ kCGWindowOwnerPID: app.processIdentifier, kCGWindowLayer: 0 })));
  };
  f.native.kCGWindowListOptionAll = 0; f.native.kCGNullWindowID = 0;
  f.sandbox.$ = Object.assign(value => ({ toString: () => value, dataUsingEncoding: () => value }), f.native);
  f.sandbox.run([JSON.stringify({ mode: 'recover', fixtureMode: 'document', pids: [42, 43], bundle, app: 'Editor', fixtureDir: '/run', runToken: 'nonce', startedAtMs: 100, running: false, launched: true })]);
  assert.equal(apps.every(app => app.exited), true);
  assert.deepEqual(events.at(-1), { stage: 'recovered', pids: [42, 43],
    processes: [{ pid: 42, processStartedAtMs: 200 }, { pid: 43, processStartedAtMs: 200 }] });
});

test('in-task observation reports the owned save sheet instead of hiding it', () => {
  const f = saveFixture({ preexisting: true });
  const state = { observation: {} };
  const api = f.sandbox.nativeAX(state, { check() {}, cleanupRequested: () => false });
  const found = api.dialog(f.app, f.window, { ...f.request, refuseDialogs: false, stopOnAppDialog: true });
  assert.equal(found.length, 1);
  assert.equal(found[0].category, 'application-result');
  assert.equal(found[0].stop, false);
});

test('the retained helper emits the owned save-sheet app-dialog event during the task', () => {
  const f = saveFixture(), events = [];
  let command = 'opened';
  Object.assign(f.app, { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Word', isFinishedLaunching: true });
  f.native.AXIsProcessTrusted = () => true;
  f.native.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => f.app }) };
  f.native.AXUIElementCreateApplication = () => f.app;
  f.native.AXUIElementSetMessagingTimeout = () => {};
  f.native.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  f.native.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command }) } };
  f.native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: value => {
    const event = JSON.parse(value); events.push(event);
    if (event.stage === 'ready') f.window.AXSheets = [f.sheet];
    if (event.stage === 'app-dialog') command = 'close';
  } } };
  let waits = 0;
  f.native.NSThread.sleepForTimeInterval = () => { assert.ok(++waits < 10, 'observation must record the sheet'); };
  f.sandbox.$ = Object.assign(value => ({ toString: () => value, dataUsingEncoding: () => value }), f.native);
  f.sandbox.run([JSON.stringify({ ...f.request, app: 'Editor', bundle: 'com.microsoft.Word', control: 'fake',
    refuseDialogs: false, stopOnAppDialog: true })]);
  assert.equal(events.find(event => event.stage === 'app-dialog')?.appDialog.category, 'application-result');
  assert.equal(events.find(event => event.stage === 'app-dialog')?.appDialog.stop, false);
  assert.equal(events.at(-1).stage, 'closed');
});

test('the native CG inventory counts all layer-zero windows for only the requested pid', () => {
  const f = saveFixture();
  f.native.kCGWindowListOptionAll = 0; f.native.kCGNullWindowID = 0;
  f.native.CGWindowListCopyWindowInfo = (options, relativeTo) => {
    assert.equal(options, 0); assert.equal(relativeTo, 0);
    return [{ kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowIsOnscreen: true },
      { kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowIsOnscreen: false },
      { kCGWindowOwnerPID: 42, kCGWindowLayer: 1 }, { kCGWindowOwnerPID: 43, kCGWindowLayer: 0 }];
  };
  assert.equal(f.api.cgWindowCount(42), 2);
  f.native.CGWindowListCopyWindowInfo = () => null;
  assert.throws(() => f.api.cgWindowCount(42), /unavailable/);
});

test('stopOnAppDialog cleanup also discards an existing owned curly save sheet', () => {
  const f = saveFixture({ preexisting: true, label: 'Don’t Save' });
  f.request.refuseDialogs = false; f.request.stopOnAppDialog = true;
  f.sandbox.closeOwnedWindow(f.window, f.request, f.app, f.api);
  assert.deepEqual(f.presses, [f.button], 'do not send Close again to an existing save sheet');
});

test('recovery forces dialog inspection even when the outer request has no dialog flags', () => {
  const f = processes();
  f.apps[1].windows = [];
  delete f.request.refuseDialogs;
  f.api.dialog = (app, _window, request) => app === f.apps[1] && request.refuseDialogs ? [{}] : [];
  assert.throws(() => f.recover(), /dialog/);
  assert.deepEqual(f.events, []);
});

test('recovery refuses an empty unrecorded process despite its recent launch', () => {
  const f = processes();
  f.apps[1].windows = []; f.request.pids = [42];
  assert.throws(() => f.recover(), /ownership|recorded/i);
  assert.deepEqual(f.events, []);
});

test('recovery permits an empty process only with its recorded lease pid', () => {
  const f = processes(); f.apps[1].windows = [];
  f.recover();
  assert.deepEqual(f.events, ['close:42', 'quit:42', 'quit:43']);
});

for (const phase of ['inventory', 'quit']) test(`recovery refuses an AX-invisible CG window at ${phase}`, () => {
  const f = processes();
  f.api.cgWindowCount = pid => {
    const app = f.apps.find(app => app.processIdentifier === pid);
    return app.windows.length + (pid === 43 && (phase === 'inventory' || f.events.length === 2) ? 1 : 0);
  };
  assert.throws(() => f.recover(), /window.*inventory|extra.*window/i);
  assert.equal(f.events.some(event => event.startsWith('quit')), false);
});

for (const fixtureMode of ['window', 'folder', 'inherit', undefined]) test(`native recovery refuses ${fixtureMode} fixtures`, () => {
  const f = processes(); f.request.fixtureMode = fixtureMode;
  assert.throws(() => f.recover(), /document|identity/);
  assert.deepEqual(f.events, []);
});

test('each parent recovery sends its own lease start and all recorded handoff pids', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now++);
  const dir = mkdtempSync(join(tmpdir(), 'fc2r-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, nonce: 'nonce', fixtureStartedAtMs: 1 }, started = [], recovered = [];
  const options = {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'recover') {
        recovered.push(request);
        return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"recovered"}\n' };
      }
      started.push(request.startedAtMs);
      options.onStdout('{"stage":"armed","running":false,"pid":40,"pids":[39,40]}\n' +
        '{"stage":"process-handoff","pid":42,"pids":[40,42],"processHandoff":{"fromPid":40,"toPid":42}}\n{"stage":"ready"}\n');
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ groupClean: true, exit: { code: 1 } }), { once: true }));
    },
  };
  const request = { app: 'Editor', bundle: 'test.editor', mode: 'document', target: join(dir, 'File-nonce.txt'), token: 'nonce' };
  const first = await openFixture(ctx, request, options);
  const second = await openFixture(ctx, request, options);
  await first.recover(); await second.recover();
  assert.notEqual(started[0], started[1]);
  assert.deepEqual(recovered.map(request => request.startedAtMs), started);
  for (const request of recovered) {
    assert.equal(request.fixtureMode, 'document');
    assert.deepEqual(request.pids.toSorted(), [39, 40, 42]);
  }
});

for (const mode of ['window', 'folder', 'inherit']) test(`parent refuses recovery of ${mode} fixtures before collecting the helper`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fc2r-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let collected = false;
  const lease = await openFixture({ dir }, { app: 'Viewer', bundle: 'test.viewer', mode }, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: async (_command, args, options) => {
      if (JSON.parse(args.at(-1)).mode === 'recover') return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"recovered"}\n' };
      options.onStdout('{"stage":"armed","running":false,"pid":42}\n{"stage":"ready"}\n');
      return new Promise(resolve => options.signal.addEventListener('abort', () => {
        collected = true; resolve({ groupClean: true, exit: { code: 0 } });
      }, { once: true }));
    },
  });
  try {
    await assert.rejects(lease.recover(), /document/);
    assert.equal(collected, false);
  } finally { await lease.dispose(); }
});

// textedit-two-windows and textedit-window-drag on 2026-10-19 (results 15-28-26 and 15-34-10): the second document's
// cleanup failed, the first lease closed its window and quit the app this run launched, and recovery then refused the
// second lease as "not launched by this run", stopping the pass although every app the run launched had exited.
async function documentPair(t, { secondStart = 5000, firstQuits = true, recoverOk = true, alive = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nt1-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, nonce: 'nonce' }, recovered = [], checked = [];
  let opened = 0;
  const options = {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    exited: async (pid, start) => { checked.push([pid, start]); return !alive.includes(pid); },
    run: async (_command, args, runOptions) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'recover') {
        recovered.push(request);
        return recoverOk ? { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"recovered","pids":[]}\n' }
          : { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'Fixture process ownership unconfirmed' };
      }
      const first = opened++ === 0;
      runOptions.onStdout(JSON.stringify({ stage: 'identified', running: !first, pid: 42, bundle: 'com.apple.TextEdit',
        processStartedAtMs: first ? 5000 : secondStart, setupCase: first ? 'cold-launch' : 'already-running' }) + '\n' +
        '{"stage":"armed"}\n{"stage":"ready"}\n');
      return new Promise(resolve => runOptions.signal.addEventListener('abort', () => resolve({ groupClean: true, exit: { code: 1 } }), { once: true }));
    },
  };
  const request = name => ({ app: 'TextEdit', bundle: 'com.apple.TextEdit', mode: 'document', target: join(dir, name), token: name });
  await openFixture(ctx, request('Source-nonce.txt'), options);
  await openFixture(ctx, request('Target-nonce.txt'), options);
  // What closeFixtures left: the second close refused, the first lease closed and quit the app it launched.
  Object.assign(ctx.fixtureDiagnostics[1], { cleanup: 'unconfirmed', closeFailure: 'Owned document lost focus; cleanup refused' });
  if (firstQuits) Object.assign(ctx.fixtureDiagnostics[0], { windowCleanupConfirmed: true, appQuit: true, helperCollectionConfirmed: true });
  return { ctx, recovered, checked };
}

test('recovery of a second document in the app this run launched waits for that app to quit, then confirms its exit', async t => {
  const { ctx, recovered, checked } = await documentPair(t);
  assert.equal(ctx.windowLeases[1].ownerLease(), ctx.windowLeases[0]);
  await retryFixtureCleanup(ctx);
  assert.equal(recovered.length, 1, 'only the launching lease runs native recovery');
  assert.equal(recovered[0].running, false);
  assert.deepEqual(checked.at(-1), [42, 5000], 'the adopted lease confirms the exact process start with the kernel');
  assert.equal(ctx.fixtureDiagnostics[1].cleanup, 'closed with launched app');
  assert.equal(ctx.fixtureDiagnostics[1].appQuit, true);
  assert.equal(ctx.fixtureDiagnostics[1].helperCollectionConfirmed, true);
  assert.equal(ctx.fixtureDiagnostics.some(item => item.cleanup === 'unconfirmed'), false);
});

test('a second document in an app this run did not launch still refuses recovery', async t => {
  // A process start that differs from the launching lease's receipt is someone else's app (a leftover TextEdit, 2026-10-19 14:06Z).
  const { ctx, recovered } = await documentPair(t, { secondStart: 4000 });
  assert.equal(ctx.windowLeases[1].ownerLease(), undefined);
  await assert.rejects(retryFixtureCleanup(ctx), /requires an app launched by this run/);
  assert.equal(recovered.length, 0, 'the refusal comes before any native recovery');
});

test('when both closes failed, the launching lease recovers first and the second document follows it', async t => {
  const { ctx, recovered } = await documentPair(t, { firstQuits: false });
  await retryFixtureCleanup(ctx);
  assert.equal(recovered.length, 1);
  assert.deepEqual(ctx.fixtureDiagnostics.map(item => item.appQuit), [true, true]);
});

test('a second document keeps the stop when the launching lease cannot quit the app', async t => {
  const { ctx } = await documentPair(t, { firstQuits: false, recoverOk: false });
  await assert.rejects(retryFixtureCleanup(ctx), /recovery unconfirmed/);
  assert.equal(ctx.fixtureDiagnostics[1].cleanup, 'unconfirmed');
});

test('a second document keeps the stop and the live lock when the launched process is still running', async t => {
  const { ctx } = await documentPair(t, { alive: [42] });
  await assert.rejects(retryFixtureCleanup(ctx), /exit disagreement/);
  assert.equal(ctx.exitDisagreements.length, 1);
});

test('the parent records where the helper placed a fixture window', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nt1-placement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, nonce: 'nonce' }, placement = { slot: 1, count: 2, frame: { x: 752, y: 49, width: 720, height: 560 } };
  let sent;
  const lease = await openFixture(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', mode: 'document', target: join(dir, 'Target-nonce.txt'),
    token: 'Target-nonce.txt', placement: { slot: 1, count: 2 } }, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
    run: async (_command, args, options) => {
      sent = JSON.parse(args.at(-1));
      options.onStdout('{"stage":"armed","running":false,"pid":42}\n' + JSON.stringify({ stage: 'placement', placement }) + '\n{"stage":"ready"}\n');
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ groupClean: true, exit: { code: 0 } }), { once: true }));
    },
  });
  try {
    assert.deepEqual(sent.placement, { slot: 1, count: 2 });
    assert.deepEqual(ctx.fixtureDiagnostics[0].placement, placement);
  } finally { await lease.dispose(); }
});
