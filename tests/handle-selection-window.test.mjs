import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../plugins/sleight/lib/handle-selection-window.js', import.meta.url), 'utf8');
function census(lengths, options = {}) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const text = length => ({ AXRole: 'AXTextArea', AXSelectedTextRange: length == null ? undefined : { description: `location:0 length:${length}` } });
  const windows = lengths.map((length, index) => ({ AXRole: 'AXWindow', AXTitle: `${index}.txt`, AXDocument: `file:///tmp/${index}.txt`, AXWindowNumber: 11 + index,
    AXChildren: list(Array.isArray(length) ? length.map(text) : [text(length)]) }));
  if (options.sameFile) for (const window of windows) { window.AXTitle = 'same.txt'; window.AXDocument = 'file:///tmp/same.txt'; }
  if (options.missingNumber) delete windows[0].AXWindowNumber;
  const app = { AXWindows: list(windows) };
  const reads = [];
  const $ = Object.assign(value => value, {
    NSWorkspace: { sharedWorkspace: { runningApplications: list([{ bundleIdentifier: 'org.example.Editor', processIdentifier: options.pid ?? 7 }]) } },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0, CFEqual: (a, b) => a === b,
    AXUIElementCopyAttributeValue: (el, key, out) => {
      assert.ok(!['AXValue', 'AXSelectedText'].includes(key), 'document content must never be read');
      reads.push(key);
      if (options.timeout && key === 'AXChildren') return -25204;
      if (el[key] === undefined) return -25205;
      out[0] = el[key]; return 0;
    },
  });
  const context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value } });
  vm.runInContext(script, context);
  return { result: JSON.parse(context.run([JSON.stringify({ appId: 'org.example.Editor', app: 'Editor', pid: 7 })])), reads };
}

test('a single selected Source among two windows is found from range metadata', () => {
  const { result, reads } = census([5, 0]);
  assert.deepEqual(result, { ok: true, pid: 7, target: { appId: 'org.example.Editor', app: 'Editor', title: '0.txt', url: 'file:///tmp/0.txt', windowNumber: 11 } });
  assert.ok(reads.includes('AXSelectedTextRange'));
});

test('multiple selected controls in one window still identify one window', () => {
  assert.equal(census([[3, 5], 0]).result.ok, true);
});

for (const lengths of [[0, 0], [3, 5], [3, null], [null, 0]]) test(`empty, duplicate or unavailable selections refuse: ${JSON.stringify(lengths)}`, () => {
  assert.deepEqual(census(lengths).result, { ok: false });
});

test('a changed process or incomplete AX read refuses', () => {
  assert.deepEqual(census([3, 0], { pid: 99 }).result, { ok: false });
  assert.deepEqual(census([3, 0], { timeout: true }).result, { ok: false });
});


test('two windows for one file retain the selected window number', () => {
  assert.deepEqual(census([5, 0], { sameFile: true }).result.target,
    { appId: 'org.example.Editor', app: 'Editor', title: 'same.txt', url: 'file:///tmp/same.txt', windowNumber: 11 });
});

test('a selected window without a native number remains unconfirmed', () => {
  assert.deepEqual(census([5, 0], { missingNumber: true }).result, { ok: false });
});
