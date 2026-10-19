import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
function fixture() {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const node = (AXRole, more = {}) => ({ AXRole, AXChildren: list([]), ...more });
  const window = node('AXWindow', { AXTitle: 'Before', AXSubrole: 'AXStandardWindow', AXWindowNumber: 22 });
  const tab = node('AXRadioButton', { AXValue: 1 });
  const tabs = node('AXTabGroup', { AXChildren: list([tab]) });
  const field = node('AXComboBox', { AXIdentifier: 'urlbar-input', AXEnabled: true, settable: true });
  const toolbar = node('AXToolbar', { AXChildren: list([field]) });
  const page = node('AXWebArea');
  window.AXChildren = list([tabs, toolbar, page]);
  for (const child of [tabs, toolbar, page]) child.AXParent = window;
  tab.AXParent = tabs; field.AXParent = toolbar;
  const menu = node('AXMenuBar');
  const app = { AXWindows: list([window]), AXFocusedWindow: window, AXFocusedUIElement: field, AXMenuBar: menu };
  const reads = [];
  const $ = value => value;
  Object.assign($, { NSUUID: { UUID: { UUIDString: 'epoch' } }, AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 123, launchDate: { timeIntervalSince1970: 1 } }]) },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, ref) => {
      reads.push([element, name]);
      assert.ok(element !== page || ['AXRole', 'AXRoleDescription'].includes(name), 'no document content or children');
      assert.ok(name !== 'AXValue' || element.AXRole === 'AXRadioButton', 'no field values');
      if (element.failure === name) return -25204;
      if (!(name in element)) return -25212;
      ref[0] = element[name]; return 0;
    },
    AXUIElementIsAttributeSettable: (element, name, ref) => { assert.equal(name, 'AXValue'); ref[0] = !!element.settable; return 0; },
    CFEqual: (a, b) => a === b, CGEventSourceSecondsSinceLastEventType: () => 1000 });
  const context = { $, Ref: () => [], ObjC: { import() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x } };
  runInNewContext(source, context);
  const request = { appId: 'org.test.browser', app: 'Fixture Browser', title: 'Before', url: null, windowNumber: 22, focus: true, tabCertificate: true };
  const read = (extra = {}) => { context.request = { ...request, ...extra }; return JSON.parse(runInNewContext('run([JSON.stringify(request)])', context)); };
  return { list, node, window, tab, tabs, field, toolbar, page, app, menu, reads, read };
}

test('CK3 native certificate retains tab and group references without reading document content', () => {
  const f = fixture(), before = f.read();
  assert.equal(before.chrome?.complete, true);
  assert.equal(before.chrome.tabCount, 1);
  assert.equal(before.chrome.childCount, 1);
  assert.equal(before.chrome.addressField, before.chrome.focused);
  assert.equal(before.chrome.tabs.filter(t => t.selected).length, 1);
  const second = f.read();
  assert.deepEqual(second.chrome, before.chrome);
  const added = f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs });
  f.tab.AXValue = 0; f.tabs.AXChildren = f.list([f.tab, added]); f.window.AXTitle = 'New Tab';
  const after = f.read({ followTab: true, nativeIdentity: before });
  assert.equal(after.status, 'ok');
  assert.equal(after.title, 'New Tab');
  assert.equal(after.window, before.window);
  assert.equal(after.chrome.group, before.chrome.group);
  assert.equal(after.chrome.tabCount, 2);
  assert.equal(after.chrome.childCount, 2);
  assert.equal(after.chrome.tabs[0].ref, before.chrome.tabs[0].ref);
  assert.notEqual(after.chrome.tabs[1].ref, before.chrome.tabs[0].ref);
});

for (const [name, change] of [
  ['nested sheet', f => { f.toolbar.AXChildren = f.list([f.field, f.node('AXGroup', { AXChildren: f.list([f.node('AXSheet')]) })]); }],
  ['dialog', f => { f.window.AXChildren = f.list([f.tabs, f.toolbar, f.page, f.node('AXDialog')]); }],
  ['menu trap', f => { f.menu.AXChildren = f.list([f.node('AXMenuBarItem', { AXSelected: true })]); }],
  ['popover', f => { f.toolbar.AXChildren = f.list([f.field, f.node('AXPopover')]); }],
  ['secure field', f => { f.field.AXSubrole = 'AXSecureTextField'; }],
  ['page focus', f => { f.app.AXFocusedUIElement = f.node('AXTextField', { AXParent: f.page }); }],
  ['ordinary chrome search field', f => { f.field.AXIdentifier = 'search-input'; }],
  ['noneditable field', f => { f.field.settable = false; }],
  ['disabled field', f => { f.field.AXEnabled = false; }],
  ['missing tab selection', f => { delete f.tab.AXValue; }],
  ['two selected tabs', f => { f.tabs.AXChildren = f.list([f.tab, f.node('AXRadioButton', { AXValue: 1, AXParent: f.tabs })]); }],
  ['ambiguous group', f => { f.window.AXChildren = f.list([f.tabs, f.toolbar, f.page, f.node('AXTabGroup')]); }],
  ['truncated children', f => { f.toolbar.AXChildren = { count: 257 }; }],
  ['missing children', f => { delete f.toolbar.AXChildren; }],
  ['failed AX query', f => { f.field.failure = 'AXIdentifier'; }],
  ['ancestry cycle', f => { f.field.AXParent = f.field; }],
]) test(`CK3 native certificate refuses ${name}`, () => {
  const f = fixture(); change(f);
  assert.notEqual(f.read().chrome?.complete, true);
});

test('CK3 following a retitled window requires the same retained native window, pid, process and helper', () => {
  const f = fixture(), before = f.read(); f.window.AXTitle = 'New Tab';
  for (const [key, value] of [['epoch', 'other'], ['window', 999], ['pid', 456], ['processStart', 2]]) {
    const now = f.read({ followTab: true, nativeIdentity: { ...before, [key]: value } });
    assert.notEqual(now.status, 'ok');
  }
  assert.notEqual(f.read({ followTab: true }).status, 'ok');
});

test('CK3 certificate off performs no chrome enumeration', () => {
  const f = fixture();
  assert.equal(f.read({ tabCertificate: false, focus: false }).chrome, undefined);
  assert.equal(f.reads.some(([element]) => element === f.field || element === f.tabs || element === f.page), false);
});
