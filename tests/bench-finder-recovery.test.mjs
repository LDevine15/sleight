import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as lifecycle from '../bench/real-run.mjs';
const { executeRealTask } = lifecycle;
const finderSetupRetryable = result => {
  assert.equal(typeof lifecycle.finderSetupRetryable, 'function', 'Finder infrastructure classifier is missing');
  return lifecycle.finderSetupRetryable(result);
};

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: v => v } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

function health({ codes = [-25204, -25204, -25204], recoveredAt = 0, bundle = 'com.apple.finder', force = true } = {}) {
  const s = source(), events = [];
  let time = 0, probes = 0, terminations = 0, forcedAt;
  const old = { processIdentifier: 42, bundleIdentifier: bundle,
    get forceTerminate() { terminations++; forcedAt = time; return force; } };
  const successor = { processIdentifier: 43, bundleIdentifier: 'com.apple.finder' };
  const api = {
    application: () => forcedAt === undefined ? old : time - forcedAt >= recoveredAt ? successor : null,
    probe: () => { time += 500; return forcedAt === undefined ? codes[Math.min(probes++, codes.length - 1)] : time - forcedAt >= recoveredAt ? 0 : -25204; },
  };
  const clock = { now: () => time, check() {}, wait: ms => { time += ms; }, emit: e => events.push(e) };
  return { run: () => s.ensureFinderAX(api, clock), events,
    get time() { return time; }, get probes() { return probes; }, get terminations() { return terminations; } };
}

test('Finder probes twice after its first failure, then force-terminates only the hung Finder and waits for its successor', () => {
  const f = health({ recoveredAt: 1600 });
  assert.equal(f.run().processIdentifier, 43);
  assert.equal(f.probes, 3);
  assert.equal(f.terminations, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].stage, 'finder-relaunch');
  assert.match(f.events[0].finderRelaunch.reason, /AX.*timeout/i);
});

for (const codes of [[0], [-25204, 0], [-25204, -25204, 0]]) test(`responsive Finder is never terminated (${codes})`, () => {
  const f = health({ codes });
  assert.equal(f.run().processIdentifier, 42);
  assert.equal(f.terminations, 0);
  assert.equal(f.events.length, 0);
});

test('non-timeout AX errors fail without terminating Finder', () => {
  const f = health({ codes: [-25205] });
  assert.throws(f.run, /Finder AX/);
  assert.equal(f.probes, 3);
  assert.equal(f.terminations, 0);
});

test('immediate CannotComplete errors do not prove a hung main thread', () => {
  const s = source(); let terminations = 0, time = 0;
  const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', get forceTerminate() { terminations++; return true; } };
  assert.throws(() => s.ensureFinderAX({ application: () => app, probe: () => -25204 }, {
    now: () => time, check() {}, wait: ms => { time += ms; }, emit() {},
  }), /probe failed/);
  assert.equal(terminations, 0);
});

test('timeouts across changing Finder processes never authorize termination', () => {
  const s = source(); let pid = 40, terminations = 0, time = 0;
  const app = () => ({ processIdentifier: pid++, bundleIdentifier: 'com.apple.finder', get forceTerminate() { terminations++; return true; } });
  assert.throws(() => s.ensureFinderAX({ application: app, probe: () => { time += 500; return -25204; } }, {
    now: () => time, check() {}, wait: ms => { time += ms; }, emit() {},
  }), /process changed/);
  assert.equal(terminations, 0);
  assert.equal(pid, 42, 'fail at the first changed process');
});

test('raw Finder probe sets a short timeout and accepts an empty AXWindows response', () => {
  const s = source(), calls = [], native = v => v;
  Object.assign(native, {
    AXUIElementCreateApplication: pid => ({ pid }),
    AXUIElementSetMessagingTimeout: (app, seconds) => { calls.push([app.pid, seconds]); return 0; },
    AXUIElementCopyAttributeValue: (_app, name, output) => { assert.equal(name, 'AXWindows'); output[0] = { count: 0 }; return 0; },
  });
  s.$ = native; s.Ref = () => []; s.ObjC.castRefToObject = v => v;
  assert.equal(s.probeFinderAX({ processIdentifier: 42 }, 0.5), 0);
  assert.deepEqual(calls, [[42, 0.5]]);
});

test('Finder relaunch has a thirty-second deadline and never force-terminates twice', () => {
  const f = health({ recoveredAt: Infinity });
  assert.throws(f.run, /Finder AX.*thirty seconds/);
  assert.ok(f.time <= 32000, String(f.time));
  assert.equal(f.terminations, 1);
});

for (const options of [{ bundle: 'com.apple.TextEdit' }, { force: false }]) test(`Finder recovery refuses unsafe or rejected termination ${JSON.stringify(options)}`, () => {
  const f = health(options);
  assert.throws(f.run, /Finder/);
  assert.equal(f.terminations, options.bundle ? 0 : 1);
});

test('folder setup refuses a focus switch to another pre-existing owner window', () => {
  const s = source(), previous = { id: 'owner-window-1' }, foreign = { id: 'owner-window-2' };
  const navigations = [], retained = [];
  let time = 0;
  const api = {
    fileMenu() {}, focused: () => foreign, equal: (a, b) => a === b,
    windows: () => [previous, foreign], menu() {}, folderSheet: () => ({}),
    exists: () => true, finderFolderGuard() {},
    submitFolder: (window, _sheet, target) => navigations.push({ window, target }),
  };
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; } };
  let failure;
  try { s.openFinderFolder({ target: '/fixture/Collections-review' }, {}, previous, api, clock, w => retained.push(w)); }
  catch (error) { failure = error; }
  assert.deepEqual(navigations, [], 'never navigate an owner window');
  assert.deepEqual(retained, [], 'never adopt an owner window for cleanup');
  assert.match(failure?.message ?? '', /New Finder fixture window unconfirmed/);
});

test('folder navigation creates a separate window and uses only its own AX Go to Folder sheet', () => {
  const s = source(), previous = {}, window = {}, sheet = {}, calls = [];
  let navigated = false, retained, created = false;
  const api = { fileMenu: (_app, titles, validate) => { validate(); calls.push(titles[0]); created = true; },
    focused: () => window, equal: (a, b) => a === b, exists: () => true,
    windows: () => created ? [previous, window] : [previous],
    finderFolderGuard: (_app, w) => { if (w) assert.equal(w, window); },
    menu: (_app, menu, titles, validate) => { validate(); calls.push(menu + ':' + titles[0]); },
    folderSheet: w => { assert.equal(w, window); return sheet; },
    submitFolder: (w, dialog, path) => { assert.equal(w, window); assert.equal(dialog, sheet); calls.push(path); navigated = true; },
    matches: w => w === window && navigated,
  };
  const clock = { check() {}, now: () => 0, wait: () => assert.fail('ready without polling') };
  assert.equal(s.openFinderFolder({ target: '/fixture/Collections-1' }, {}, previous, api, clock, w => { retained = w; }), window);
  assert.equal(retained, window);
  assert.deepEqual(calls, ['New Finder Window', 'Go:Go to Folder…', '/fixture/Collections-1']);
});

function folderTrial(change = () => {}) {
  const s = source(), previous = { id: 'owner-1' }, foreign = { id: 'owner-2' }, window = { id: 'fixture' }, sheet = {};
  const f = { previous, foreign, window, sheet, current: [previous, foreign], focused: previous, dialog: null,
    retained: [], navigations: [], commands: [], time: 0 };
  const api = {
    windows: () => f.current, exists: w => f.current?.includes(w), equal: (a, b) => !!a && a === b,
    focused: () => f.focused,
    fileMenu: (_app, _titles, validate) => {
      validate(); f.commands.push('new'); f.current = [previous, foreign, window]; f.focused = window;
    },
    finderFolderGuard: (_app, w, dialog) => {
      if (f.dialog && f.dialog !== dialog) throw new Error('Foreign Finder dialog');
      if (w && f.focused !== w && (!dialog || f.focused !== dialog)) throw new Error('Finder folder window lost focus');
    },
    menu: (_app, _name, _titles, validate) => { validate(); f.commands.push('go'); },
    folderSheet: () => sheet,
    submitFolder: (w, dialog, target, validate) => { validate(); f.navigations.push({ window: w, sheet: dialog, target }); },
  };
  const clock = { check() {}, now: () => f.time, wait: ms => { f.time += ms; } };
  change(f, api, clock);
  return Object.assign(f, { api, run: () => s.openFinderFolder({ target: '/fixture/Collections-review' }, {}, previous, api, clock, w => f.retained.push(w)) });
}

for (const [name, change, detail] of [
  ['malformed list', f => { f.current = { title: 'private-owner-title' }; }, 'reason=malformed-list'],
  ['missing element', f => { f.current[1] = null; }, 'reason=missing-element count=2 index=1'],
  ['failed self identity', (f, api) => { api.equal = (a, b) => a !== f.foreign && a === b; }, 'reason=failed-self-identity count=2 index=1'],
  ['non-window or stale element', (f, api) => { api.exists = w => w !== f.foreign; }, 'reason=non-window-or-stale count=2 index=1'],
  ['duplicate identity', f => { f.current.push(f.previous); }, 'reason=duplicate-identity count=3 index=2 duplicateIndex=0'],
]) test(`inventory diagnostic identifies ${name} without acting or exposing content`, () => {
  const f = folderTrial((f, api) => {
    f.previous.AXTitle = 'private-owner-title'; f.previous.AXDocument = '/private/owner/document';
    change(f, api);
  });
  assert.throws(f.run, error => {
    assert.ok(error.message.includes(`Finder fixture window inventory unconfirmed [${detail}]`), error.message);
    assert.doesNotMatch(error.message, /private-owner-title|\/private\/owner|Collections-review/);
    assert.equal(error.finderWindowRequested, undefined);
    return true;
  });
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.time, 0, 'no retry on an unconfirmed inventory');
});

test('Finder smoke keeps retention and navigation receipts before a later refusal', () => {
  const events = [];
  const f = folderTrial((_f, _api, clock) => { clock.emit = event => events.push(event); });
  f.run();
  assert.deepEqual(events.map(event => event.stage), ['finder-window-retained', 'finder-folder-submitted']);
  assert.equal(events[0].referenceExported, false);
  assert.equal(events[1].target, '/fixture/Collections-review');
  const refused = [];
  const g = folderTrial((_f, api, clock) => {
    clock.emit = event => refused.push(event);
    api.menu = () => { throw new Error('late focus refusal'); };
  });
  assert.throws(g.run, /late focus refusal/);
  assert.deepEqual(refused.map(event => event.stage), ['finder-window-retained']);
});

test('delayed creation polls the inventory without adopting the focused owner window', () => {
  const f = folderTrial((f, api, clock) => {
    api.fileMenu = () => { f.focused = f.foreign; };
    clock.wait = ms => { f.time += ms; f.current = [f.previous, f.foreign, f.window]; f.focused = f.window; };
  });
  assert.equal(f.run(), f.window);
  assert.equal(f.time, 100);
  assert.deepEqual(f.retained, [f.window]);
  assert.equal(f.navigations[0].window, f.window);
});

for (const [name, change, pattern] of [
  ['unknown baseline', (f) => { f.current = null; }, /inventory/],
  ['unknown identity', (_f, api) => { api.equal = () => false; }, /inventory/],
  ['duplicate baseline', f => { f.current.push(f.previous); }, /inventory/],
  ['stale previous', f => { f.current = [f.foreign]; }, /previous window/],
  ['window appears while New menu opens', (f, api) => { api.fileMenu = (_a, _t, validate) => { f.current.push(f.window); validate(); }; }, /before New/],
  ['unknown post-action inventory', (f, api) => { api.fileMenu = () => { f.current = undefined; }; }, /inventory/],
  ['multiple new windows', (f, api) => { api.fileMenu = () => { f.current.push(f.window, {}); }; }, /ambiguous/],
  ['vanished candidate', (f, api) => { api.exists = w => w !== f.window; }, /inventory/],
  ['owner window closes during creation', (f, api) => { api.fileMenu = () => { f.current = [f.foreign, f.window]; }; }, /pre-action/],
  ['new window has no focus', (f, api) => { const create = api.fileMenu; api.fileMenu = (...args) => { create(...args); f.focused = f.foreign; }; }, /lost focus/],
  ['missing focus', (f, api) => { const create = api.fileMenu; api.fileMenu = (...args) => { create(...args); f.focused = null; }; }, /lost focus/],
  ['foreign dialog before creation', f => { f.dialog = {}; }, /Foreign/],
]) test(`folder ownership refuses ${name} before retention or navigation`, () => {
  const f = folderTrial(change);
  assert.throws(f.run, pattern);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
});

for (const [name, change, pattern] of [
  ['focus switch while Go menu opens', (f, api) => { api.menu = (_a, _n, _t, validate, refuse) => {
    assert.equal(refuse, true); f.focused = f.foreign; validate(); f.commands.push('go');
  }; }, /lost focus/],
  ['vanished retained window', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current.pop(); validate(); }; }, /identity changed/],
  ['replacement candidate', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current[2] = {}; validate(); }; }, /identity changed/],
  ['extra candidate', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current.push({}); validate(); }; }, /identity changed/],
  ['foreign dialog while Go menu opens', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.dialog = {}; validate(); }; }, /Foreign/],
  ['focus switch while sheet appears', (f, api) => { api.folderSheet = () => { f.focused = f.foreign; return f.sheet; }; }, /lost focus/],
  ['foreign sheet', (f, api) => { api.folderSheet = () => { f.dialog = {}; return f.sheet; }; }, /Foreign/],
]) test(`folder navigation refuses ${name} and keeps only the proven window`, () => {
  const f = folderTrial(change);
  assert.throws(f.run, pattern);
  assert.deepEqual(f.retained, [f.window]);
  assert.deepEqual(f.navigations, []);
});

function nativeFolderTrial(clockChanges = {}) {
  const s = source(), writes = [], presses = [], native = v => v;
  const field = { AXRole: 'AXTextField', AXChildren: [] }, button = { AXRole: 'AXButton', AXTitle: 'Go', AXChildren: [] };
  const window = { AXRole: 'AXWindow' }, sheet = { AXRole: 'AXSheet', AXParent: window, AXChildren: [field, button] };
  window.AXSheets = [sheet];
  const app = { AXWindows: [window], AXFocusedWindow: window, AXChildren: [] };
  Object.assign(native, {
    CFEqual: (a, b) => a === b,
    AXUIElementGetPid: (_window, ref) => { ref[0] = 42; return 0; },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (el, name, output) => {
      const value = el[name];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return 0;
    },
    AXUIElementSetAttributeValue: (el, name, value) => { writes.push([el, name, value]); return 0; },
    AXUIElementPerformAction: (el, action) => { presses.push([el, action]); return 0; },
  });
  s.$ = native; s.Ref = () => []; s.ObjC.castRefToObject = v => v;
  const api = s.nativeAX({ setup: true }, { check() {}, emit() {}, ...clockChanges });
  return { s, api, app, window, sheet, field, button, writes, presses, native };
}

test('native folder submission refuses a foreign sheet and writes only the owned path field', () => {
  const { api, window, sheet, field, button, writes, presses } = nativeFolderTrial();
  api.submitFolder(window, sheet, '/fixture/Collections-1');
  assert.deepEqual(writes, [[field, 'AXValue', '/fixture/Collections-1']]);
  assert.deepEqual(presses, [[button, 'AXPress']]);
  sheet.AXParent = { AXRole: 'AXWindow' };
  assert.throws(() => api.submitFolder(window, sheet, '/foreign'), /sheet identity changed/);
  assert.equal(writes.length, 1);
});

test('native window inventory refuses a malformed AX array', () => {
  const { api, app, writes, presses } = nativeFolderTrial();
  for (const count of [undefined, null, NaN, -1, 1.5, Infinity]) {
    app.AXWindows = { count };
    assert.throws(() => api.windows(app), /inventory malformed/);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

test('native malformed inventory diagnostics include only a finite known count', () => {
  const { api, app } = nativeFolderTrial();
  for (const count of [undefined, null, NaN, -1, 1.5, Infinity, 'private-owner-title']) {
    app.AXWindows = { count };
    assert.throws(() => api.windows(app), error => {
      const known = count != null && Number.isFinite(Number(count));
      assert.equal(error.message, `Fixture window inventory malformed [reason=malformed-list${known ? ` count=${Number(count)}` : ''}]`);
      return true;
    });
  }
  app.AXWindows = null;
  assert.throws(() => api.windows(app), /inventory unavailable \[reason=malformed-list\]/);
});

for (const role of ['AXSheet', 'AXDialog', '', 'private-owner-title']) test(`inventory refuses role ${JSON.stringify(role)} using only the existing role read`, () => {
  const { api: nativeApi, native } = nativeFolderTrial(), reads = [];
  const read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (el, name, output) => { reads.push(name); return read(el, name, output); };
  const f = folderTrial((f, api) => {
    f.previous.AXRole = 'AXWindow'; f.foreign.AXRole = role;
    api.exists = nativeApi.exists;
  });
  assert.throws(f.run, error => {
    const detail = /^AX[A-Za-z][A-Za-z0-9]*$/.test(role) ? ` role=${role}` : '';
    assert.equal(error.message, `Finder fixture window inventory unconfirmed [reason=non-window-or-stale count=2 index=1${detail}]`);
    return true;
  });
  assert.deepEqual(reads, ['AXRole', 'AXRole']);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
});

test('inventory reports a stale element from the existing failed role read without retrying', () => {
  const { api: nativeApi, native } = nativeFolderTrial(), reads = [];
  const read = native.AXUIElementCopyAttributeValue;
  const f = folderTrial((f, api) => {
    f.previous.AXRole = 'AXWindow';
    api.exists = nativeApi.exists;
    native.AXUIElementCopyAttributeValue = (el, name, output) => {
      reads.push(name);
      return el === f.foreign ? -25202 : read(el, name, output);
    };
  });
  assert.throws(f.run, /reason=non-window-or-stale count=2 index=1 axCode=-25202/);
  assert.deepEqual(reads, ['AXRole', 'AXRole']);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.time, 0);
});

for (const when of ['before-value', 'after-value']) test(`native submission stops a focus switch ${when}`, () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  if (when === 'before-value') app.AXFocusedWindow = { AXRole: 'AXWindow' };
  else {
    const write = native.AXUIElementSetAttributeValue;
    native.AXUIElementSetAttributeValue = (...args) => { const result = write(...args); app.AXFocusedWindow = { AXRole: 'AXWindow' }; return result; };
  }
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /lost focus/);
  assert.equal(writes.length, when === 'before-value' ? 0 : 1);
  assert.deepEqual(presses, []);
});

for (const location of ['AXWindows', 'AXChildren', 'AXSheets', 'window-children', 'focused-element']) test(`native guard refuses a foreign dialog in ${location}`, () => {
  const { api, app, window, sheet, writes, presses } = nativeFolderTrial();
  const foreign = { AXRole: 'AXWindow', AXSubrole: 'AXDialog' };
  if (location === 'AXSheets') app.AXWindows.push({ AXRole: 'AXWindow', AXSheets: [foreign] });
  else if (location === 'window-children') window.AXChildren = [foreign];
  else if (location === 'focused-element') app.AXFocusedUIElement = { AXRole: 'AXTextField', AXParent: foreign };
  else app[location].push(foreign);
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /Foreign Finder/);
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

test('native submission refuses a foreign sheet appearing after the path write', () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  const write = native.AXUIElementSetAttributeValue;
  native.AXUIElementSetAttributeValue = (...args) => {
    const result = write(...args);
    app.AXChildren.push({ AXRole: 'AXSheet' });
    return result;
  };
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /Foreign Finder/);
  assert.equal(writes.length, 1);
  assert.deepEqual(presses, []);
});

test('native Go press rechecks focus after action bookkeeping', () => {
  let app;
  const f = nativeFolderTrial({ emit: () => { app.AXFocusedWindow = { AXRole: 'AXWindow' }; } });
  app = f.app;
  assert.throws(() => f.api.submitFolder(f.window, f.sheet, '/fixture/Collections-review'), /lost focus/);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.presses, []);
});

test('native Go menu rechecks focus after command bookkeeping and cancels only its menu', () => {
  let app, events = 0;
  const f = nativeFolderTrial({ emit: e => {
    if (e.stage === 'action' && ++events === 2) app.AXFocusedWindow = { AXRole: 'AXWindow' };
  } });
  app = f.app;
  const item = { AXRole: 'AXMenuItem', AXTitle: 'Go to Folder…', AXEnabled: 1 };
  const menu = { AXRole: 'AXMenu', AXChildren: [item] };
  const go = { AXRole: 'AXMenuBarItem', AXTitle: 'Go', AXChildren: [menu] };
  app.AXMenuBar = { AXChildren: [go] };
  let cancelled = 0;
  const press = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (el, action) => {
    if (action === 'AXCancel') { assert.equal(el, menu); cancelled++; return 0; }
    assert.notEqual(el, item, 'the app-wide command must not act after focus changes');
    return press(el, action);
  };
  assert.throws(() => f.api.menu(app, 'Go', ['Go to Folder…'], () => f.api.finderFolderGuard(app, f.window, f.sheet), true), /lost focus/);
  assert.deepEqual(f.presses, [[go, 'AXPress']]);
  assert.equal(cancelled, 1);
  assert.deepEqual(f.writes, []);
});

test('native guard accepts focus on the owned sheet and refuses a focus change during inspection', () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  app.AXFocusedWindow = sheet;
  api.finderFolderGuard(app, window, sheet);
  const read = native.AXUIElementCopyAttributeValue;
  let focusReads = 0;
  native.AXUIElementCopyAttributeValue = (el, name, output) => {
    if (el === app && name === 'AXFocusedWindow' && ++focusReads === 2) app.AXFocusedWindow = { AXRole: 'AXWindow' };
    return read(el, name, output);
  };
  assert.throws(() => api.finderFolderGuard(app, window, sheet), /focus changed during validation/);
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

function finderRun(change = () => {}) {
  const s = source(), events = [], calls = []; let time = 0, forced = false, armed = false, ready = false, navigated = false;
  const old = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', get forceTerminate() { calls.push('force'); forced = true; return true; } };
  const successor = { processIdentifier: 43, bundleIdentifier: 'com.apple.finder' };
  const previous = {}, window = {}, sheet = {}, native = value => ({ dataUsingEncoding: () => value });
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: bundle => {
      assert.equal(bundle, 'com.apple.finder'); return { count: 1, objectAtIndex: () => forced ? successor : old };
    } },
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout() {},
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: data => {
      const e = JSON.parse(data); events.push(e); if (e.stage === 'armed') armed = true; if (e.stage === 'ready') ready = true;
    } } },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => JSON.stringify({ command: ready ? 'close' : armed ? 'opened' : 'launching', launched: false }) } },
  });
  s.$ = native; s.Date = { now: () => time };
  s.waitForLaunch = seconds => { time += (seconds ?? 0.1) * 1000; };
  s.probeFinderAX = () => { calls.push('probe'); time += 500; return forced ? 0 : -25204; };
  const api = {
    focused: app => { assert.equal(app.pid, 43, 'never read the hung process'); calls.push('focused'); return navigated ? window : previous; },
    dialog: () => [], fileMenu: () => { navigated = true; calls.push('new-window'); },
    menu: () => calls.push('go-menu'), folderSheet: () => sheet, submitFolder: () => calls.push('submit'),
    windows: () => navigated ? [previous, window] : [previous], exists: () => true, finderFolderGuard() {},
    equal: (a, b) => a === b, readiness: () => ({}), matches: () => true, wait: () => { time += 100; },
  };
  s.nativeAX = () => api;
  s.closeOwnedWindow = (owned, _request, app) => { assert.equal(owned, window); assert.equal(app.pid, 43); calls.push('close'); };
  change({ s, api, previous, window, sheet, calls });
  const run = () => s.run([JSON.stringify({ app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', control: 'fake', target: '/fixture/Collections-1', token: 'Collections-1' })]);
  return { run, events, calls };
}

test('JXA setup probes and recovers before any Finder read, then opens and closes one new window', () => {
  const { run, events, calls } = finderRun();
  run();
  assert.equal(events.filter(e => e.stage === 'finder-relaunch').length, 1);
  assert.equal(events.find(e => e.stage === 'ready').pid, 43);
  assert.deepEqual(calls.slice(0, 6), ['probe', 'probe', 'probe', 'force', 'probe', 'focused']);
  assert.equal(calls.filter(c => c === 'submit').length, 1);
  assert.equal(calls.at(-1), 'close');
});

test('setup refusal after New Window keeps cleanup unconfirmed and never adopts or closes an owner window', () => {
  const { run, events, calls } = finderRun(({ api, previous, s }) => {
    api.fileMenu = () => {};
    api.windows = () => [previous];
    api.matches = () => assert.fail('no unowned match probe');
    s.closeOwnedWindow = () => assert.fail('no owner close');
  });
  assert.throws(run, /New Finder fixture window unconfirmed/);
  const failure = events.find(e => e.stage === 'setup-failure');
  assert.equal(failure.cleanup, 'unconfirmed');
  assert.equal(failure.actionTaken, false, 'even without an AX action receipt, a delayed creation stays uncertain');
  assert.equal(events.some(e => e.stage === 'ready'), false);
  assert.equal(calls.includes('go-menu'), false);
  assert.equal(calls.includes('submit'), false);
});

test('setup refusal before New Window can confirm nothing created', () => {
  const { run, events } = finderRun(({ api }) => {
    api.windows = () => { throw new Error('inventory unavailable'); };
    api.fileMenu = () => assert.fail('no creation after failed inventory');
  });
  assert.throws(run, /inventory unavailable/);
  assert.equal(events.find(e => e.stage === 'setup-failure').cleanup, 'nothing created');
});

test('setup refusal after retaining a new window leaves its unrelated folder and owner windows untouched', () => {
  const { run, events } = finderRun(({ api, window }) => {
    api.menu = () => { throw new Error('Finder folder window lost focus'); };
    api.matches = w => { assert.equal(w, window); return false; };
    api.closeButton = () => assert.fail('no close before folder identity is confirmed');
  });
  assert.throws(run, /lost focus/);
  assert.equal(events.find(e => e.stage === 'setup-failure').cleanup, 'unconfirmed');
});

test('Finder folder launch never calls open or a custom launcher with its folder', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1-open-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir }, diagnostics = [], logs = [];
  const run = async (_cmd, _args, { onStdout }) => {
    onStdout('{"stage":"finder-relaunch","finderRelaunch":{"reason":"three AXWindows timeouts","pid":41}}\n');
    onStdout('{"stage":"armed","running":true,"pid":42}\n');
    onStdout('{"stage":"ready","pid":42}\n');
    return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' };
  };
  const lease = await openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Collections-1' }, {
    run, helper: async () => ({ command: 'fake', args: [] }), log: line => logs.push(line),
    open: () => assert.fail('open delivers an Apple Event'), launch: () => assert.fail('custom launch must not deliver an Apple Event'),
  });
  diagnostics.push(lease.diagnostics);
  assert.equal(lease.launched, false);
  assert.equal(diagnostics[0].launched, false);
  assert.deepEqual(logs, ['FINDER_RELAUNCH: three AXWindows timeouts (pid 41)']);
});

const finder = { app: 'Finder', bundle: 'com.apple.finder', launched: false,
  finderAXError: { code: -25204, attribute: 'AXWindows' }, helperCollectionConfirmed: true, windowCleanupConfirmed: true, cleanup: 'nothing created' };
const infrastructure = { passed: false, fixtureSetupFailure: 'finder-ax', groupClean: true, fixtureDiagnostics: [finder] };

test('parent keeps an unconfirmed Finder creation as a cleanup stop after helper collection', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1r-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir };
  let runs = 0;
  const run = async (_cmd, _args, { onStdout }) => {
    runs++;
    const stdout = '{"stage":"armed","running":true,"pid":42}\n' +
      '{"stage":"setup-failure","running":true,"pid":42,"actionTaken":true,"cleanup":"unconfirmed",' +
      '"finderAXError":{"code":-25204,"attribute":"AXWindows"}}\n';
    onStdout(stdout);
    return { groupClean: true, exit: { code: 1 }, stdout, stderr: 'New Finder fixture window unconfirmed' };
  };
  await assert.rejects(openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Collections-review' }, {
    run, helper: async () => ({ command: 'fake', args: [] }),
    open: () => assert.fail('no Apple Event'), launch: () => assert.fail('no launch fallback'),
  }), error => { assert.notEqual(error.noMutation, true); return true; });
  await assert.rejects(closeFixtures(ctx), /cleanup unconfirmed/);
  assert.notEqual(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, true);
  assert.equal(finderSetupRetryable({ ...infrastructure,
    fixtureDiagnostics: ctx.fixtureDiagnostics.map(d => ({ ...d, helperCollectionConfirmed: true })) }), false);
  assert.equal(runs, 1, 'no Finder quit or new helper');
});

test('Finder setup failures are retryable only after every launched app and helper exited', () => {
  assert.equal(finderSetupRetryable(infrastructure), true);
  const quit = { app: 'TextEdit', launched: true, appQuit: true, helperCollectionConfirmed: true, windowCleanupConfirmed: true };
  assert.equal(finderSetupRetryable({ ...infrastructure, fixtureDiagnostics: [finder, quit] }), true);
  for (const change of [{ appQuit: false }, { helperCollectionConfirmed: false }, { launched: undefined }])
    assert.equal(finderSetupRetryable({ ...infrastructure, fixtureDiagnostics: [finder, { ...quit, ...change }] }), false);
  for (const key of ['cleanupError', 'cleanupUnconfirmed', 'permissionPrompt', 'permissionRefusal', 'observerError', 'appDialog', 'approvalStop', 'cancelled', 'liveLockKept'])
    assert.equal(finderSetupRetryable({ ...infrastructure, [key]: true }), false, key);
  for (const change of [{ groupClean: false }, { taskPassed: false }, { fixtureSetupFailure: undefined }, { exitDisagreements: [{}] },
    { fixtureDiagnostics: [{ ...finder, windowCleanupConfirmed: false }] }])
    assert.equal(finderSetupRetryable({ ...infrastructure, ...change }), false);
});

test('an independent exit disagreement blocks the lifecycle infrastructure marker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fh1-disagreement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), exitDisagreements: [{ pid: 5 }] };
  const result = await executeRealTask({ setup(ctx) {
    ctx.fixtureDiagnostics = [finder];
    throw Object.assign(new Error('Finder AX failed'), { fixtureSetupFailure: 'finder-ax' });
  }, cleanup() {} }, ctx, { lockHeld: true });
  assert.equal(result.retryableInfrastructure, undefined);
});

test('lifecycle marks a pre-driver Finder AX failure only after collecting its helper', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fh1-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture') };
  const result = await executeRealTask({
    setup(ctx) {
      ctx.fixtureDiagnostics = [{ ...finder, helperCollectionConfirmed: false }];
      ctx.windowLeases = [{ dispose: async () => true, diagnostics: ctx.fixtureDiagnostics[0] }];
      throw Object.assign(new Error('Fixture setup failed: AX fixture read failed: -25204 (AXFocusedWindow)'), { fixtureSetupFailure: 'finder-ax' });
    }, cleanup() {}, prompt: () => assert.fail('no prompt after setup failure'),
  }, ctx, { lockHeld: true, drive: () => assert.fail('no driver after setup failure') });
  assert.equal(result.retryableInfrastructure, 'finder-ax');
  assert.equal(result.groupClean, true);
  assert.equal(result.passed, false);
});

test('the real 640-file world caller carries an AX setup refusal through acquisition and clean teardown', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const { ccHeldOutTasks } = await import('../bench/world/cc-held-out.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1-world-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), nonce: 'fh1' };
  const failure = { stage: 'setup-failure', running: true, setupCase: 'already-running', actionTaken: false,
    cleanup: 'nothing created', finderAXError: { code: -25204, attribute: 'AXFocusedWindow' } };
  const task = ccHeldOutTasks((ctx, request) => openFixture(ctx, request, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: async (_cmd, _args, { onStdout }) => {
      assert.equal(readdirSync(request.target).length, 640);
      const stdout = JSON.stringify(failure) + '\n'; onStdout(stdout);
      return { groupClean: true, exit: { code: 1 }, stdout, stderr: 'AX fixture read failed: -25204 (AXFocusedWindow) (-2700)' };
    }, open: () => assert.fail('no Finder Apple Events'),
  })).find(task => task.id === 'cc-list-native');
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: () => assert.fail('no model after fixture refusal') });
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(result.retryableInfrastructure, 'finder-ax');
  assert.match(result.reason, /-25204.*AXFocusedWindow/);
  assert.equal(result.fixtureDiagnostics[0].helperCollectionConfirmed, true);
});
