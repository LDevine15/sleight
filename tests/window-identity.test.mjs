import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';
// Header shape from the published TextEdit tree; native fields model AX observations.
const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'Untitled', url: null };
const observed = { status: 'ok', appId: target.appId, title: target.title, url: null,
  epoch: 'helper-a', window: 1, pid: 123, processStart: 1000, matches: 1 };
test('an unsaved window needs one native match and retains its AX reference identity', () => {
  assert.deepEqual(verifyWindowIdentity(target, observed), observed);
  for (const reply of [{ ...observed, matches: 2 }, { ...observed, matches: 0 },
    { status: 'unknown' }, { ...observed, title: 'Other' }, { ...observed, appId: 'another.app' }]) {
    assert.throws(() => verifyWindowIdentity(target, reply), /Input lease:/);
  }
});
test('same-title replacement, app restart or helper replacement cannot reuse a lease identity', () => {
  const leased = { ...target, nativeIdentity: observed };
  for (const key of ['epoch', 'window', 'pid', 'processStart']) {
    const changed = typeof observed[key] === 'number' ? observed[key] + 1 : 'changed';
    assert.throws(() => verifyWindowIdentity(leased, { ...observed, [key]: changed }), /changed/);
  }
  assert.deepEqual(verifyWindowIdentity(leased, observed), observed);
});
const source = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
function inspect(request, numbers, focused = 1, cg = false, events = [], setup = () => {}) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const windows = numbers.map((AXWindowNumber, i) => ({ AXTitle: 'Untitled', AXDocument: null, AXWindowNumber,
    AXPosition: { x: i * 400, y: 20 }, AXSize: { width: 300, height: 200 } }));
  const app = { AXWindows: list(windows), AXFocusedWindow: windows[focused] };
  setup(app, windows, list);
  const $ = value => value;
  Object.assign($, { NSUUID: { UUID: { UUIDString: 'epoch' } }, AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 123, launchDate: { timeIntervalSince1970: 1 } }]) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, value) => { events.push('ax'); if (element.missing?.includes(name)) return -25212; value[0] = element[name] ?? null; return 0; },
    CFEqual: (a, b) => a === b, AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    CGEventSourceSecondsSinceLastEventType: (source, type) => { events.push('hid'); assert.equal(source, 1); assert.equal(type, 0xFFFFFFFF); return 12.5; },
    CGWindowListCopyWindowInfo: () => list(cg ? windows.map((window, i) => ({ kCGWindowOwnerPID: 123, kCGWindowLayer: 0,
      kCGWindowNumber: 11 + i, kCGWindowBounds: { X: window.AXPosition.x, Y: 20, Width: 300, Height: 200 } })) : []) });
  return JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request, Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value } }));
}
test('native duplicate-title identity uses the focused window number or an explicit selection', () => {
  const current = inspect(target, [11, 22]);
  assert.equal(current.matches, 1); assert.equal(current.windowNumber, 22);
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).windowNumber, 22);
  assert.notEqual(inspect({ ...target, windowNumber: 11 }, [11, 22]).status, 'ok');
  assert.notEqual(inspect(target, [null, null]).matches, 1, 'missing numbers remain inconclusive');
});
test('LW1: native identity reports how many windows had the header before focus narrowed them', () => {
  assert.equal(inspect(target, [11, 22]).headerMatches, 2);
  assert.equal(inspect({ ...target, windowNumber: 22 }, [11, 22]).headerMatches, 2);
  assert.equal(inspect(target, [11], 0).headerMatches, 1);
  assert.equal(inspect(target, [11, 22, 33], 2).headerMatches, 3);
});
test('native identity maps AX geometry to CG numbers and detects a known number disappearing', () => {
  const selected = inspect({ ...target, windowNumber: 12 }, [null, null], 1, true);
  assert.equal(selected.matches, 1); assert.equal(selected.windowNumber, 12);
  assert.equal(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [11, 22]).status, 'mismatch');
  assert.notEqual(inspect({ ...target, nativeIdentity: { windowNumber: 99 } }, [null, null]).status, 'mismatch');
});

test('a window without a title (Finder\'s desktop) is skipped instead of failing the identity', () => {
  const finder = { appId: 'com.apple.finder', title: 'rename-abc123', url: 'file:///private/tmp/x/rename-abc123/' };
  const result = inspect(finder, [11, 22], 1, false, [], (app, windows) => {
    windows[0].missing = ['AXTitle', 'AXDocument'];
    Object.assign(windows[1], { AXTitle: finder.title, AXDocument: finder.url });
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.matches, 1);
  assert.equal(inspect({ ...target, title: null }, [11], 0, false, [], (app, windows) => { windows[0].missing = ['AXTitle']; }).matches, 0);
});

test('OT2: native identity reports the matched window\'s subrole for the parent lease', () => {
  assert.equal(inspect(target, [11, 22], 1, false, [], (app, windows) => { windows[1].AXSubrole = 'AXStandardWindow'; }).windowSubrole, 'AXStandardWindow');
  assert.equal(inspect(target, [11, 22]).windowSubrole, null);
});

test('native identity includes the HID system idle duration without requesting trust', () => {
  assert.equal(inspect(target, [11, 22]).hidIdleSeconds, 12.5);
});

test('HID idle is sampled after the native reads so input during AX inspection cannot be missed', () => {
  const events = [];
  assert.equal(inspect(target, [11, 22], 1, false, events).status, 'ok');
  assert.equal(events.at(-1), 'hid');
  assert.equal(events.filter(event => event === 'hid').length, 1);
});

test('the light check after Return gets sheets and the focused element only when it asks', () => {
  const field = (window, owner = true) => owner ? { AXRole: 'AXTextField', AXWindow: window } : { AXRole: 'AXLayoutArea', AXParent: { AXRole: 'AXGroup', AXParent: window } };
  const focusOf = (request, setup) => inspect(request, [11], 0, false, [], setup).focus;
  assert.equal(focusOf(target, (app, windows) => { app.AXFocusedUIElement = field(windows[0]); }), undefined);
  const request = { ...target, focus: true };
  assert.deepEqual(focusOf(request, (app, windows, list) => { app.AXFocusedUIElement = field(windows[0]); windows[0].AXChildren = list([{ AXRole: 'AXGroup' }]); }),
    { sheets: 0, role: 'AXTextField', subrole: null, inWindow: true, inPage: false });
  assert.deepEqual(focusOf(request, (app, windows, list) => { app.AXFocusedUIElement = field(windows[0], false); windows[0].AXChildren = list([{ AXRole: 'AXSheet' }]); }),
    { sheets: 1, role: 'AXLayoutArea', subrole: null, inWindow: true, inPage: false });
  assert.deepEqual(focusOf(request, app => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXWindow: { AXRole: 'AXWindow' } }; }),
    { sheets: 0, role: 'AXTextField', subrole: null, inWindow: false, inPage: false });
  assert.deepEqual(focusOf(request, () => {}), { sheets: 0, role: null, subrole: null, inWindow: false, inPage: false });
  assert.deepEqual(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', AXWindow: windows[0] }; }),
    { sheets: 0, role: 'AXTextField', subrole: 'AXSecureTextField', inWindow: true, inPage: false });
  // AB1 review: a page's own field, under a web area or Gecko's HTML content, is in a page; an address field above it isn't.
  for (const page of [{ AXRole: 'AXWebArea' }, { AXRole: 'AXGroup', AXRoleDescription: 'HTML Content' }]) {
    assert.equal(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXTextField', AXWindow: windows[0],
      AXParent: { AXRole: 'AXGroup', AXParent: { ...page, AXParent: windows[0] } } }; }).inPage, true, JSON.stringify(page));
  }
  assert.equal(focusOf(request, (app, windows) => { app.AXFocusedUIElement = { AXRole: 'AXComboBox', AXWindow: windows[0],
    AXParent: { AXRole: 'AXToolbar', AXParent: windows[0] } }; windows[0].AXParent = { AXRole: 'AXWebArea' }; }).inPage, false);
});
