import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness({ timeoutError = 0 } = {}) {
  const deadlines = [], reads = [];
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const $ = value => value;
  Object.assign($, {
    AXUIElementCreateApplication: () => app,
    AXUIElementSetMessagingTimeout: (el, seconds) => { deadlines.push([el, seconds]); return timeoutError; },
    AXUIElementCopyAttributeValue: (el, name, out) => {
      reads.push(name);
      if (el[name]?.error) return el[name].error;
      if (!(name in el)) return -25205;
      out[0] = Array.isArray(el[name]) ? list(el[name]) : el[name]; return 0;
    },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    AXUIElementSetAttributeValue: (el, name, value) => { el[name] = value; return 0; },
    AXUIElementPerformAction: (el, name) => { el.action = name; return 0; },
  });
  const element = (role, x, y, width, height, children = []) => ({ AXRole: role,
    AXPosition: { x, y }, AXSize: { width, height }, AXChildren: children });
  const area = { ...element('AXTextArea', 105, 130, 590, 365), AXValue: 'alpha beta', AXSelectedText: 'alpha' };
  const toolbar = element('AXToolbar', 100, 120, 600, 10);
  const win = { ...element('AXWindow', 100, 100, 600, 400, [toolbar, area]), AXWindowNumber: 11, AXTitle: 'document' };
  const app = { AXWindows: [win] };
  const context = vm.createContext({ $, Ref: () => [], Application: () => assert.fail('no Apple events'),
    ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const bounds = { X: 100, Y: 100, Width: 600, Height: 400 };
  const window = () => context.axWindow(7, { id: 11, title: 'document', bounds });
  return { context, window, app, win, area, toolbar, element, bounds, deadlines, reads };
}

test('native content scan keeps text and toolbar guards without Apple events', () => {
  const h = harness(), win = h.window();
  const info = h.context.content(win, h.bounds);
  assert.equal(info.areas.length, 1); assert.equal(info.areas[0].role, 'AXTextArea');
  assert.deepEqual(JSON.parse(JSON.stringify(info.toolbars)), [{ X: 100, Y: 120, Width: 600, Height: 10 }]);
  const points = h.context.validatePoints(info, h.bounds, [20, 40], [200, 40], 'Editor');
  assert.equal(points.text.text, 'alpha beta'); assert.equal(points.text.selected, 'alpha');
  assert.throws(() => h.context.validatePoints(info, h.bounds, [20, 25], [200, 40], 'Editor'), /outside the window content/);
  points.text.el.attributes.byName('AXSelectedText').value = 'beta';
  assert.equal(h.area.AXSelectedText, 'beta');
  h.context.raiseWindow(win); assert.equal(h.win.AXMain, true); assert.equal(h.win.action, 'AXRaise');
  assert.ok(h.deadlines.length >= 1); assert.ok(h.deadlines.every(([, seconds]) => seconds === 0.5));
  assert.ok(h.reads.includes('AXChildren'));
});

test('native window match falls back to unique geometry and title, refusing ambiguity', () => {
  const h = harness(); delete h.win.AXWindowNumber;
  assert.equal(h.window().name(), 'document');
  h.app.AXWindows.push({ ...h.win });
  assert.throws(h.window, /cannot match window 11/);
});

test('native deadline failure prevents scanning and unreadable geometry prevents a match', () => {
  assert.throws(harness({ timeoutError: -25202 }).window, /deadline/);
  const h = harness(); delete h.win.AXWindowNumber; delete h.win.AXPosition;
  assert.throws(h.window, /cannot match window 11/);
});

test('native content scan preserves clipping, excluded chrome and the element limit', () => {
  const h = harness();
  h.win.AXChildren.push({ ...h.element('AXTextArea', 100, 100, 600, 400), AXSubrole: 'AXCloseButton' });
  h.area.AXPosition.y = 90;
  const info = h.context.content(h.window(), h.bounds);
  assert.equal(info.areas.length, 1); assert.equal(info.areas[0].bounds.Y, 100);
  h.win.AXChildren = Array.from({ length: 301 }, () => h.element('AXButton', 110, 140, 10, 10));
  assert.throws(() => h.context.content(h.window(), h.bounds), /300-element limit/);
});

test('native content timeouts refuse rather than hiding toolbar role or geometry', () => {
  for (const name of ['AXRole', 'AXPosition']) {
    const h = harness(); h.toolbar[name] = { error: -25204 };
    assert.throws(() => h.context.content(h.window(), h.bounds), error => error.axCode === -25204);
  }
});

test('unsupported and no-value attributes are still skipped during native scanning', () => {
  for (const code of [-25205, -25212]) {
    const h = harness(); h.toolbar.AXSubrole = { error: code };
    const info = h.context.content(h.window(), h.bounds);
    assert.equal(info.areas.length, 1); assert.equal(info.toolbars.length, 1);
  }
});
