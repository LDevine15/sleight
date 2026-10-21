import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { finderDiagnostic, finderFailureDiagnostic, openFixture } from '../bench/real-fixture.mjs';

function roleRead({ code = 0, value = null } = {}) {
  const queries = [], unwrapped = [], actions = [], events = [];
  const s = { ObjC: { import() {}, unwrap: value => { unwrapped.push(value); return value; }, castRefToObject: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const window = {}, native = value => value;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    assert.equal(element, window); queries.push(attribute);
    assert.equal(attribute, 'AXRole', 'diagnosis cannot ask another AX attribute');
    output[0] = value; return code;
  };
  native.CFEqual = (a, b) => a === b;
  s.$ = native; s.Ref = () => [];
  const clock = { check() {}, now: () => 0, wait: () => assert.fail('diagnosis cannot add a retry'), emit: event => events.push(event) };
  const api = { ...s.nativeAX({ setup: true, bundle: 'com.apple.finder' }, clock),
    windows: () => [window], focused: () => window, dialog: () => [], finderFolderGuard() {},
    fileMenu: () => actions.push('new-window'), menu: () => actions.push('menu'),
  };
  const run = () => s.openFinderFolder({ target: '/fixture/Folder' }, {}, window, api, clock, () => actions.push('retain'));
  return { s, native, window, api, clock, run, queries, unwrapped, actions, events };
}

const refused = [
  ['nil', { value: null }, { axCode: 0, roleReadCode: 0, roleState: 'nil' }],
  ['empty', { value: '' }, { axCode: 0, roleReadCode: 0, roleState: 'empty' }],
  ['known nonwindow', { value: 'AXSheet' }, { role: 'AXSheet', axCode: 0, roleReadCode: 0, roleState: 'known-nonwindow' }],
  ['unknown role', { value: 'AXOwnerPrivateRole' }, { axCode: 0, roleReadCode: 0, roleState: 'other-string' }],
  ['private text', { value: 'owner-private-title /owner/private/path' }, { axCode: 0, roleReadCode: 0, roleState: 'other-string' }],
  ['numeric zero', { value: 0 }, { axCode: 0, roleReadCode: 0, roleState: 'nonstring' }],
  ['boolean', { value: true }, { axCode: 0, roleReadCode: 0, roleState: 'nonstring' }],
  ['no value code', { code: -25212, value: 'owner-private-title' }, { axCode: -25212, roleReadCode: -25212, roleState: 'nil' }],
  ['invalid element', { code: -25202 }, { axCode: -25202, roleReadCode: -25202 }],
  ['other error', { code: -25203 }, { axCode: -25203, roleReadCode: 'other' }],
];
const unavailableValue = { roleNativeType: 'unavailable', roleNativeWindowEqual: 'unavailable', roleDeepWindowEqual: 'unavailable' };

for (const [name, input, detail] of refused) test(`Finder role failure classifies ${name} from one existing read`, () => {
  const f = roleRead(input);
  assert.throws(f.run, error => {
    const diagnostic = finderFailureDiagnostic(error);
    assert.deepEqual(diagnostic, name === 'other error' ? { ...detail, ...unavailableValue } : {
      reason: 'non-window-or-stale', count: 1, index: 0, ...detail, ...unavailableValue,
    });
    if (name === 'other error') assert.equal(error.code, -25203, 'the original error still escapes');
    assert.doesNotMatch(error.message, /AXOwnerPrivateRole|owner-private-title|\/owner\/private/);
    return true;
  });
  assert.deepEqual(f.queries, ['AXRole']);
  assert.equal(f.unwrapped.length, input.code || !input.value ? 0 : 1);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.events, []);
});

function valueProbe(f, { shallow = 'owner-private-role', type = 'cf-string', equal = false, deep = 'owner-private-role' } = {}) {
  const calls = [], value = f.value;
  const unwrap = f.s.ObjC.unwrap;
  f.s.ObjC.unwrap = item => item === value ? (f.unwrapped.push(item), shallow) : unwrap(item);
  f.native.CFGetTypeID = item => {
    assert.equal(item, value); calls.push('native-type');
    if (type === 'unavailable') throw new Error('private-native-type-error');
    return type === 'cf-string' ? 7 : 8;
  };
  f.native.CFStringGetTypeID = () => 7;
  f.native.CFEqual = (item, expected) => {
    if (item === value) {
      assert.equal(expected, 'AXWindow'); calls.push('native-equal');
      if (equal === 'unavailable') throw new Error('private-native-equality-error');
      return equal;
    }
    return item === expected;
  };
  f.s.ObjC.deepUnwrap = item => {
    assert.equal(item, value); calls.push('deep-equal');
    if (deep === 'unavailable') throw new Error('private-deep-error');
    return deep;
  };
  return calls;
}

for (const [name, options, want, calls] of [
  ['native and deep window disagreement with shallow conversion', { equal: true, deep: 'AXWindow' },
    { roleNativeType: 'cf-string', roleNativeWindowEqual: 'yes', roleDeepWindowEqual: 'yes' }, ['native-type', 'native-equal', 'deep-equal']],
  ['native window with nonwindow deep conversion', { equal: true },
    { roleNativeType: 'cf-string', roleNativeWindowEqual: 'yes', roleDeepWindowEqual: 'no' }, ['native-type', 'native-equal', 'deep-equal']],
  ['deep window with nonwindow native equality', { deep: 'AXWindow' },
    { roleNativeType: 'cf-string', roleNativeWindowEqual: 'no', roleDeepWindowEqual: 'yes' }, ['native-type', 'native-equal', 'deep-equal']],
  ['native nonstring type', { type: 'other', deep: {} },
    { roleNativeType: 'other', roleNativeWindowEqual: 'unavailable', roleDeepWindowEqual: 'unavailable' }, ['native-type', 'deep-equal']],
  ['unavailable native type', { type: 'unavailable', deep: 'AXWindow' },
    { roleNativeType: 'unavailable', roleNativeWindowEqual: 'unavailable', roleDeepWindowEqual: 'yes' }, ['native-type', 'deep-equal']],
  ['unavailable native equality', { equal: 'unavailable', deep: 'AXWindow' },
    { roleNativeType: 'cf-string', roleNativeWindowEqual: 'unavailable', roleDeepWindowEqual: 'yes' }, ['native-type', 'native-equal', 'deep-equal']],
  ['unavailable deep conversion', { deep: 'unavailable' },
    { roleNativeType: 'cf-string', roleNativeWindowEqual: 'no', roleDeepWindowEqual: 'unavailable' }, ['native-type', 'native-equal', 'deep-equal']],
]) test(`Finder refused role probes the already-returned value: ${name}`, () => {
  const value = { toString: () => 'owner-private-role' }, f = roleRead({ value });
  f.value = value;
  const observed = valueProbe(f, options);
  assert.throws(f.run, error => {
    assert.deepEqual(finderFailureDiagnostic(error), { reason: 'non-window-or-stale', count: 1, index: 0,
      axCode: 0, roleReadCode: 0, roleState: 'other-string', ...want });
    assert.doesNotMatch(error.message, /owner-private-role|private-native|private-deep/);
    return true;
  });
  assert.deepEqual(observed, calls);
  assert.deepEqual(f.queries, ['AXRole']);
  assert.equal(f.unwrapped.length, 1);
  assert.deepEqual(f.actions, []);
});

test('Finder accepted AXWindow never runs native type, equality or deep probes', () => {
  const value = {}, f = roleRead({ value }); f.value = value;
  const calls = valueProbe(f, { shallow: 'AXWindow', equal: true, deep: 'AXWindow' }), detail = {};
  assert.equal(f.api.exists(f.window, detail), true);
  assert.deepEqual(detail, { role: 'AXWindow' });
  assert.deepEqual(calls, []);
  assert.deepEqual(f.queries, ['AXRole']);
});

test('Finder bridged nil role never passes a nil reference into native type or equality probes', () => {
  const value = { isNil: () => true }, f = roleRead({ value }); f.value = value;
  const calls = valueProbe(f, { shallow: null, equal: true, deep: 'AXWindow' });
  assert.throws(f.run, error => {
    assert.deepEqual(finderFailureDiagnostic(error), { reason: 'non-window-or-stale', count: 1, index: 0,
      axCode: 0, roleReadCode: 0, roleState: 'nil', ...unavailableValue });
    return true;
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(f.queries, ['AXRole']);
});

for (const value of ['AXWindow', { toString: () => 'AXWindow' }]) test(`Finder accepted window retains text coercion and emits no failure metadata (${typeof value})`, () => {
  const f = roleRead({ value }), detail = {};
  assert.equal(f.api.exists(f.window, detail), true);
  assert.deepEqual(detail, { role: 'AXWindow' });
  assert.deepEqual(f.queries, ['AXRole']);
  assert.equal(f.unwrapped.length, 1);
});

test('Finder role diagnostic schema rejects arbitrary codes, states and owner text', () => {
  for (const [roleReadCode, roleState] of [[0, 'nil'], [-25212, 'empty'], [-25202, 'known-nonwindow'], ['other', 'other-string'], [0, 'nonstring']]) {
    assert.deepEqual(finderDiagnostic({ diagnostic: { roleReadCode, roleState, axCode: -25203, role: 'AXOwnerPrivateRole', rawRole: 'owner-private-title' } }),
      { diagnostic: { roleReadCode, roleState, axCode: -25203 } });
  }
  for (const bad of ['owner-private-title', -25203, null, true, {}, ['nil']]) {
    assert.deepEqual(finderDiagnostic({ roleReadCode: bad, roleState: bad }), {});
  }
  assert.deepEqual(finderFailureDiagnostic('private roleReadCode=0suffix roleState=nil-secret axCode=NaN'), {});
  for (const roleNativeType of ['cf-string', 'other', 'unavailable']) for (const equal of ['yes', 'no', 'unavailable']) {
    assert.deepEqual(finderDiagnostic({ roleNativeType, roleNativeWindowEqual: equal, roleDeepWindowEqual: equal }),
      { roleNativeType, roleNativeWindowEqual: equal, roleDeepWindowEqual: equal });
  }
  for (const bad of ['owner-private-role', 'yes owner-private-role', true, {}, ['yes']]) {
    assert.deepEqual(finderDiagnostic({ roleNativeType: bad, roleNativeWindowEqual: bad, roleDeepWindowEqual: bad }), {});
  }
  assert.deepEqual(finderFailureDiagnostic('roleNativeType=cf-string-secret roleNativeWindowEqual=yes-secret roleDeepWindowEqual=yes-secret'), {});
});

for (const name of ['nil', 'no value code', 'invalid element', 'other error', 'native-window-disagreement']) test(`serialized Finder helper failure retains ${name} metadata through real-fixture`, async t => {
  const [, input, detail] = refused.find(item => item[0] === name) ?? [name, { value: {} }, { axCode: 0, roleReadCode: 0, roleState: 'other-string' }];
  const f = roleRead(input), nativeWindow = name === 'native-window-disagreement';
  let expectedValue = unavailableValue, valueCalls;
  if (nativeWindow) {
    f.value = input.value; valueCalls = valueProbe(f, { equal: true, deep: 'AXWindow' });
    expectedValue = { roleNativeType: 'cf-string', roleNativeWindowEqual: 'yes', roleDeepWindowEqual: 'yes' };
  }
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-role-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const process = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: { isNil: () => false, timeIntervalSince1970: 1 } };
  f.native.AXIsProcessTrusted = () => true;
  f.native.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => process }) };
  f.native.AXUIElementCreateApplication = () => ({}); f.native.AXUIElementSetMessagingTimeout = () => {};
  f.native.NSData = { dataWithContentsOfFile: () => ({ isNil: () => false }) };
  f.native.NSString = { alloc: { initWithDataEncoding: () => JSON.stringify({ command: 'opened', launched: false }) } };
  f.native.NSFileHandle = { fileHandleWithStandardOutput: { writeData: value => f.events.push(JSON.parse(value)) } };
  f.s.$ = Object.assign(value => typeof value === 'string' && value.startsWith('{') ? { dataUsingEncoding: () => value } : value, f.native);
  f.s.finderProcessBirth = () => '1.000000'; f.s.probeFinderAX = () => 0; f.s.nativeAX = () => f.api;
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  await assert.rejects(openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }), open: () => assert.fail('refusal cannot launch Finder'),
    run: async (_command, args, options) => {
      let error;
      try { f.s.run([args.at(-1)]); } catch (failure) { error = failure; }
      assert.ok(error, 'the JXA fixture must refuse the inventory');
      const stdout = f.events.map(event => JSON.stringify(event)).join('\n') + '\n';
      options.onStdout(stdout);
      return { groupClean: true, exit: { code: 1 }, stdout, stderr: error.message + ' owner-private-title' };
    },
  }), error => {
    const diagnostic = finderFailureDiagnostic(error);
    assert.deepEqual(diagnostic, name === 'other error' ? { ...detail, ...expectedValue } : {
      reason: 'non-window-or-stale', count: 1, index: 0, ...detail, ...expectedValue,
    }, error.message);
    assert.doesNotMatch(error.message, /owner-private-title|\/owner\/private/);
    return true;
  });
  assert.deepEqual(f.queries, ['AXRole']);
  assert.deepEqual(f.actions, []);
  assert.equal(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, true);
  assert.equal(await ctx.windowLeases[0].dispose(), true);
  if (nativeWindow) assert.deepEqual(valueCalls, ['native-type', 'native-equal', 'deep-equal']);
});
