// Four Word runs that ended without saving left the fixture's own Save/Don't Save sheet outside AXSheets, cleanup refused it
// as an app dialog, and the pass stopped (claim run 2026-10-18T01-06Z). sleight-arch answered it by hand: AX press of
// Don't Save on the sheet of "Report-<nonce>  -  Compatibility Mode", terminate (ignored with no windows), forceTerminate.
// These fakes cover that path and the refusals around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { openFixture, closeFixtures } from '../bench/real-fixture.mjs';
import { executeRealTask, cleanupContained } from '../bench/real-run.mjs';

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

// where: 'focused sheet' (Word: AXSheets unsupported, the sheet is the focused window), 'children', or 'alert'.
function wordFixture({ where = 'focused sheet', preexisting = true, label = 'Don’t Save' } = {}) {
  const sandbox = source(), app = {}, events = [], presses = [];
  const button = { AXRole: 'AXButton', AXTitle: label };
  const prompt = { AXRole: where === 'alert' ? 'AXWindow' : 'AXSheet', ...(where === 'alert' && { AXSubrole: 'AXDialog' }),
    AXChildren: [{ AXRole: 'AXStaticText', AXValue: 'Do you want to save the changes you made to Report-nonce.docx?' },
      button, { AXRole: 'AXButton', AXTitle: 'Cancel' }, { AXRole: 'AXButton', AXTitle: 'Save' }] };
  const window = { AXRole: 'AXWindow', AXTitle: 'Report-nonce  -  Compatibility Mode', AXDocument: 'file:///run/Report-nonce.docx',
    AXChildren: [], AXCloseButton: { AXRole: 'AXButton' } };
  if (where !== 'alert') prompt.AXParent = window;
  const show = () => {
    if (where === 'children') window.AXChildren = [prompt];
    else app.AXFocusedWindow = prompt;
  };
  app.AXFocusedWindow = window;
  if (preexisting) show();
  const native = value => value;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === window && attribute === 'AXSheets') return -25205;
    const value = element[attribute] ?? null;
    output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
    return 0;
  };
  native.AXUIElementPerformAction = element => {
    presses.push(element);
    if (element === window.AXCloseButton) show();
    else { window.AXRole = ''; window.AXChildren = []; app.AXFocusedWindow = null; }
    return 0;
  };
  native.CFEqual = (a, b) => a === b;
  native.NSThread = { sleepForTimeInterval() {} };
  native.NSURL = {
    URLWithString: value => ({ isNil: () => false, isFileURL: value.startsWith('file://'), URLByResolvingSymlinksInPath: { path: value.slice(7) } }),
    fileURLWithPath: value => ({ absoluteString: `file://${value}` }),
  };
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  const api = sandbox.nativeAX({ cleanup: true, setupCase: 'cold-launch' },
    { now: () => 1, check() {}, emit: event => events.push(event), wait() {}, cleanupRequested: () => true });
  const request = { mode: 'document', target: '/run/Report-nonce.docx', token: 'Report-nonce.docx', runToken: 'nonce', stopOnAppDialog: true };
  return { sandbox, app, button, prompt, window, presses, events, api, request,
    close() { return sandbox.closeOwnedWindow(window, request, app, api); } };
}

for (const where of ['focused sheet', 'children', 'alert']) for (const preexisting of [true, false]) {
  test(`cleanup answers the fixture's own Don't Save ${where} ${preexisting ? 'left open by the task' : 'shown on close'}`, () => {
    const f = wordFixture({ where, preexisting });
    f.close();
    assert.equal(f.window.AXRole, '');
    assert.equal(f.presses.at(-1), f.button);
    assert.equal(f.presses.length, preexisting ? 1 : 2);
    const pressed = f.events.filter(event => event.stage === 'fixture-sheet');
    assert.equal(pressed.length, 1);
    const source = { 'focused sheet': 'focused sheet', children: 'AXChildren', alert: 'focused alert' }[where];
    assert.deepEqual(JSON.parse(JSON.stringify(pressed[0].fixtureSheet)), { pressed: 'Don’t Save', source,
      windowTitle: 'Report-nonce  -  Compatibility Mode', buttons: ['Don’t Save', 'Cancel', 'Save'] });
  });
}

for (const kind of ['foreign path', 'foreign title', 'no Don\'t Save', 'unknown button', 'sign-in text', 'other window\'s sheet',
  'alert without the file', 'foreign dialog over the window']) {
  test(`cleanup still refuses ${kind} and presses nothing`, () => {
    const f = wordFixture();
    if (kind === 'foreign path') f.window.AXDocument = 'file:///owner/Report-nonce.docx';
    if (kind === 'foreign title') f.window.AXTitle = 'Owner report';
    if (kind === 'no Don\'t Save') f.button.AXTitle = 'Delete';
    if (kind === 'unknown button') f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Allow' });
    if (kind === 'sign-in text') f.prompt.AXChildren.push({ AXRole: 'AXStaticText', AXValue: 'Sign in to save to OneDrive' });
    if (kind === 'other window\'s sheet') f.prompt.AXParent = { AXRole: 'AXWindow', AXTitle: 'Owner document' };
    if (kind === 'alert without the file') {
      Object.assign(f.prompt, { AXRole: 'AXWindow', AXSubrole: 'AXDialog' }); delete f.prompt.AXParent;
      f.prompt.AXChildren[0].AXValue = 'Do you want to save the changes you made to Notes?';
    }
    if (kind === 'foreign dialog over the window') {
      f.window.AXChildren = [f.prompt];
      f.app.AXFocusedWindow = { AXRole: 'AXWindow', AXSubrole: 'AXDialog', AXTitle: 'Sign in',
        AXChildren: [{ AXRole: 'AXButton', AXTitle: 'Sign In' }] };
    }
    assert.throws(() => f.close(), /cleanup refused|focus|identity changed/);
    assert.deepEqual(f.presses, []);
    assert.equal(f.events.some(event => event.stage === 'fixture-sheet'), false);
  });
}

test('the refusal names the dialog it saw', () => {
  const f = wordFixture();
  f.prompt.AXChildren.push({ AXRole: 'AXButton', AXTitle: 'Allow' });
  assert.throws(() => f.close(), /fixture cleanup refused \(application-result "" \[Don’t Save, Cancel, Save, Allow\]\)/);
});

test('the retained Word helper answers its own sheet at cleanup and reports the press', () => {
  const f = wordFixture({ preexisting: false }), out = [];
  let command = 'opened';
  Object.assign(f.app, { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Word', isFinishedLaunching: true });
  const native = f.sandbox.$;
  native.AXIsProcessTrusted = () => true;
  native.NSRunningApplication = {
    runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => f.app }),
    runningApplicationWithProcessIdentifier: () => f.app,
  };
  f.app.isNil = () => false;
  native.AXUIElementCreateApplication = () => f.app;
  native.AXUIElementSetMessagingTimeout = () => {};
  native.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  native.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command }) } };
  native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: value => {
    const event = JSON.parse(value); out.push(event);
    // The task typed and never saved: Word shows its sheet as the focused window, then the harness asks for cleanup.
    if (event.stage === 'ready') { f.app.AXFocusedWindow = f.prompt; command = 'close'; }
  } } };
  f.sandbox.$ = Object.assign(value => ({ toString: () => value, dataUsingEncoding: () => value }), native);
  f.sandbox.run([JSON.stringify({ ...f.request, app: 'Microsoft Word', bundle: 'com.microsoft.Word', control: 'fake' })]);
  assert.equal(out.at(-1).stage, 'closed');
  assert.equal(out.find(event => event.stage === 'fixture-sheet')?.fixtureSheet.pressed, 'Don’t Save');
  assert.deepEqual(f.presses, [f.button]);
});

function officeQuit({ windows = { none: true, axWindows: 0, onScreen: 0 }, launchMs = 5000, startedAtMs = 5000, pid = 42 } = {}) {
  const { quitFixtureApplication } = source();
  let forced = false, time = 0;
  const events = [], seen = [];
  const app = { processIdentifier: pid, bundleIdentifier: 'com.microsoft.Word', terminate: true, isFinishedLaunching: true,
    launchDate: { isNil: () => false, timeIntervalSince1970: launchMs / 1000 }, get forceTerminate() { forced = true; return true; } };
  const clock = { now: () => time, wait: ms => { time += ms; }, emit: e => events.push(e), startedAtMs,
    windowless: target => { seen.push(target.processIdentifier); return windows; } };
  return { run: () => quitFixtureApplication(42, 'com.microsoft.Word', () => forced ? null : app, clock),
    events, seen, get forced() { return forced; }, get time() { return time; } };
}

test('Word that ignores a quit with no windows is force-terminated after ten seconds', () => {
  const q = officeQuit();
  assert.equal(q.run(), true);
  assert.equal(q.forced, true);
  assert.ok(q.time >= 10000 && q.time < 11000, `forced at ${q.time} ms`);
  assert.deepEqual(JSON.parse(JSON.stringify(q.events.at(-1).quitWait)), { reason: 'force-terminated-windowless', accepted: true,
    elapsedMs: q.time, finishedLaunching: true, windowless: { none: true, axWindows: 0, onScreen: 0 } });
  assert.ok(q.seen.every(pid => pid === 42));
});

for (const [kind, options] of [
  ['a window still open', { windows: { none: false, axWindows: 1, onScreen: 1 } }],
  ['an on-screen sheet the AX list misses', { windows: { none: false, axWindows: 0, onScreen: 1 } }],
  ['an unreadable window list', { windows: { none: false, axWindows: -1, onScreen: 0 } }],
  ['another launch time on the same pid', { launchMs: 9000 }],
  ['no recorded launch time', { startedAtMs: 0 }],
]) test(`Word with ${kind} keeps the quit stop and is never force-terminated`, () => {
  const q = officeQuit(options);
  assert.throws(q.run, /quit unconfirmed after thirty seconds/);
  assert.equal(q.forced, false);
});

test('Word under another pid is refused before any force', () => {
  const q = officeQuit({ pid: 43 });
  assert.throws(q.run, /identity changed/);
  assert.equal(q.forced, false);
});

test('the native window count reads AXWindows and on-screen layer-zero windows of only that pid', () => {
  const sandbox = source(), calls = [];
  let axWindows = [], cg = [{ kCGWindowOwnerPID: 43, kCGWindowLayer: 0 }, { kCGWindowOwnerPID: 42, kCGWindowLayer: 25 }];
  const native = value => value;
  Object.assign(native, {
    kCGWindowListOptionOnScreenOnly: 1, kCGNullWindowID: 0,
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (app, attribute, output) => {
      calls.push([app.pid, attribute]);
      if (!axWindows) return -25204;
      output[0] = { count: axWindows.length }; return 0;
    },
    CGWindowListCopyWindowInfo: options => { assert.equal(options, 1, 'on-screen windows only'); return cg; },
  });
  sandbox.$ = native; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  assert.equal(sandbox.windowlessProcess(42).none, true);
  cg.push({ kCGWindowOwnerPID: 42, kCGWindowLayer: 0 });
  assert.equal(sandbox.windowlessProcess(42).none, false, 'an on-screen sheet or window');
  cg.pop(); axWindows = [{}];
  assert.equal(sandbox.windowlessProcess(42).none, false, 'a listed window');
  axWindows = null;
  assert.equal(sandbox.windowlessProcess(42).none, false, 'an unreadable list');
  assert.ok(calls.every(([pid, attribute]) => pid === 42 && attribute === 'AXWindows'));
});

// The parent side: the helper's close receipt and press event, then a quit the helper force-terminated by the exact pid.
function wordLease(t, { close, quit, exited = async () => true }) {
  const dir = mkdtempSync(join(tmpdir(), 'save-sheet-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), nonce: 'nonce' }, quits = [];
  const options = {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {}, exited,
    run: async (_command, args, runOptions) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') { quits.push(request); return quit; }
      if (request.mode === 'recover') return { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'Application dialog present; fixture recovery refused' };
      runOptions.onStdout('{"stage":"armed","running":false,"pid":42,"processStartedAtMs":5000}\n{"stage":"ready"}\n');
      return new Promise(resolve => {
        const poll = setInterval(() => {
          try { if (JSON.parse(readFileSync(request.control, 'utf8')).command !== 'close') return; } catch { return; }
          clearInterval(poll);
          runOptions.onStdout(close.events);
          resolve(close.result);
        }, 5);
        runOptions.signal.addEventListener('abort', () => { clearInterval(poll); resolve({ groupClean: true, exit: { code: 0 }, stdout: '' }); }, { once: true });
      });
    },
  };
  const task = {
    setup: async c => { c.word = await openFixture(c, { app: 'Microsoft Word', bundle: 'com.microsoft.Word', mode: 'document',
      target: join(c.dir, 'Report-nonce.docx'), token: 'Report-nonce.docx', stopOnAppDialog: true }, options); },
    prompt: () => 'edit', check: () => 'the report was not saved', cleanup: closeFixtures,
  };
  return { ctx, task, quits };
}

const sheetEvent = '{"stage":"fixture-sheet","fixtureSheet":{"pressed":"Don’t Save","source":"focused sheet","windowTitle":"Report-nonce  -  Compatibility Mode","buttons":["Don’t Save","Cancel","Save"]}}\n';
const forcedQuit = { groupClean: true, exit: { code: 0 },
  stdout: '{"stage":"quit","quitWait":{"reason":"force-terminated-windowless","accepted":true,"elapsedMs":10000,"windowless":{"none":true,"axWindows":0,"onScreen":0}}}\n' };

test('an answered fixture sheet is a clean cleanup and the pass continues on the task verdict', async t => {
  const { ctx, task, quits } = wordLease(t, { close: { events: sheetEvent, result: { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' } }, quit: forcedQuit });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, out: { result: '' } }) });
  assert.equal(result.cleanupError, undefined);
  assert.equal(result.passed, false, 'the task failed on its own merits');
  assert.equal(result.reason, 'the report was not saved');
  const [diagnostics] = result.fixtureDiagnostics;
  assert.equal(diagnostics.fixtureSheets[0].pressed, 'Don’t Save');
  assert.equal(diagnostics.quitWait.reason, 'force-terminated-windowless');
  assert.equal(diagnostics.appQuit, true);
  assert.equal(quits[0].pid, 42);
  assert.equal(quits[0].processStartedAtMs, 5000, 'the helper checks the launch time before any force');
});

test('a forced Word exit the kernel does not confirm keeps the stop', async t => {
  const { ctx, task } = wordLease(t, { close: { events: sheetEvent, result: { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' } },
    quit: forcedQuit, exited: async () => false });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, out: { result: '' } }) });
  assert.match(result.cleanupError, /exit disagreement after quit/);
  assert.equal(result.fixtureDiagnostics[0].appQuit, undefined);
});

test('a foreign dialog still refuses cleanup and stops the pass', async t => {
  const refused = 'Error: Application dialog present; fixture cleanup refused (sign-in "Sign in" [Sign In])';
  const { ctx, task, quits } = wordLease(t, {
    close: { events: '', result: { groupClean: true, exit: { code: 1 }, stdout: '', stderr: refused } },
    quit: { groupClean: true, exit: { code: 1 }, stdout: '{"stage":"quit","quitWait":{"reason":"deadline"}}\n', stderr: 'Launched app quit unconfirmed after thirty seconds' },
  });
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: async () => ({ code: 0, groupClean: true, out: { result: '' } }) });
  assert.match(result.cleanupError, /^Owned Microsoft Word fixture window cleanup unconfirmed: .*fixture cleanup refused \(sign-in/);
  assert.equal(result.fixtureDiagnostics[0].fixtureSheets, undefined);
  assert.equal(result.fixtureDiagnostics[0].appQuit, false);
  assert.equal(cleanupContained(result), false);
  assert.match(result.cleanupError, /fixture recovery refused/);
  assert.equal(quits.length, 1);
});
