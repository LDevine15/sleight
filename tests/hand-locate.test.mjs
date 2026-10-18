import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// locate.js in a vm, over a fake AX tree: an element is { AXRole, AXTitle, AXPosition, AXSize, AXChildren }.
function locateContext() {
  const pair = v => ({ pointValue: { x: v[0], y: v[1] }, sizeValue: { width: v[0], height: v[1] } });
  const $ = name => name;
  Object.assign($, {
    AXUIElementCopyAttributeValue: (el, name, out) => {
      const value = el[name];
      if (value === undefined) return -25205;
      out[0] = Array.isArray(value) && name === 'AXChildren' ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return 0;
    },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { mutableBytes: bytes, bytes }; } },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return true; },
    NSValue: { valueWithBytesObjCType: bytes => pair(bytes.value) },
  });
  const context = vm.createContext({ ObjC: { import() {}, castRefToObject: x => x, deepUnwrap: x => x, unwrap: x => x }, $, Ref: () => [] });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hand/locate.js', import.meta.url), 'utf8'), context);
  return context;
}
const button = (title, x) => ({ AXRole: 'AXButton', AXTitle: title, AXPosition: [x, 10], AXSize: [20, 20] });

test('locate.js reports an element only when a whole walk found exactly one', () => {
  const { elements } = locateContext();
  const win = { AXRole: 'AXWindow', AXChildren: [button('Save', 100), button('Other', 200), button('Cancel', 300), button('Cancel', 400)] };
  const identities = { 1: { role: 'AXButton', title: 'Save' }, 2: { role: 'AXButton', title: 'Cancel' } };
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities))), { 1: { X: 100, Y: 10, Width: 20, Height: 20 } });
  // With room for the window and three buttons, the second Cancel is never seen: Cancel looks unique and Save
  // was found, but a cut-short walk proves neither.
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities, 4))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(elements(win, identities, 5))), { 1: { X: 100, Y: 10, Width: 20, Height: 20 } });
});

test('runScript stops hand/locate.js after 2.5 s, not the 30 s default', async () => {
  const { runScript } = await import('../plugins/sleight/lib/launch.mjs');
  let timeout;
  const run = (_command, args, options, callback) => {
    timeout = options.timeout;
    assert.match(args.at(-2), /hand\/locate\.js$/);
    return execFile(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ ok: true }))'], callback);
  };
  assert.deepEqual(await runScript('hand/locate.js', { app: 'Example' }, run), { ok: true });
  assert.equal(timeout, 2500);
});
