import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const file = new URL('../plugins/sleight/lib/settle-text-write.js', import.meta.url);
const source = readFileSync(file, 'utf8');
function settle(options = {}) {
  const posted = [], waits = [], events = [];
  const request = { appId: 'org.test.editor', pid: 321, processStart: 42, lease: { path: '/lease', token: 'owned' } };
  const running = { processIdentifier: options.pid ?? 321, launchDate: { timeIntervalSince1970: options.processStart ?? 42 } };
  const $ = value => value;
  Object.assign($, {
    NSUTF8StringEncoding: 4,
    NSString: { stringWithContentsOfFileEncodingError: () => ({ isNil: () => false,
      raw: JSON.stringify({ token: options.token ?? 'owned', expires: options.expired ? 0 : Date.now() + 30000,
        window: { appId: options.appId ?? request.appId } }) }) },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => {
      assert.equal(id, request.appId); return { count: options.count ?? 1, objectAtIndex: () => running };
    } },
    kCGEventFlagMaskShift: 2, kCGEventFlagsChanged: 12,
    CGEventCreateKeyboardEvent: (_source, key, down) => { const e = { key, down }; events.push(e); return e; },
    CGEventSetFlags: (event, flags) => { event.flags = flags; },
    CGEventSetType: (event, type) => { event.type = type; },
    CGEventPostToPid: (pid, event) => { posted.push([pid, event.down]); },
  });
  const result = JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request,
    ObjC: { import() {}, unwrap: value => value.raw ?? value }, delay: seconds => waits.push(seconds) }));
  return { result, posted, waits, events };
}
test('settle posts one Shift press and release to the verified pid, never the HID stream', () => {
  const h = settle();
  assert.equal(h.result.ok, true); assert.deepEqual(h.posted, [[321, true], [321, false]]);
  assert.deepEqual(h.events.map(e => [e.key, e.flags, e.type]), [[56, 2, 12], [56, 0, 12]]);
  assert.deepEqual(h.waits, [0.05, 0.05]);
});
test('settle sends no event for a changed process, ambiguous app, expired or replaced lease', () => {
  for (const options of [{ pid: 99 }, { processStart: 99 }, { count: 2 }, { expired: true }, { token: 'other' }, { appId: 'org.test.other' }]) {
    const h = settle(options); assert.equal(h.result.ok, false); assert.deepEqual(h.posted, []);
  }
});
