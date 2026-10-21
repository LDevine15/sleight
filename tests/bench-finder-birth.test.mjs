import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { finderDiagnostic } from '../bench/real-fixture.mjs';

function nativeBirth() {
  const bound = [], queries = [];
  const s = { ObjC: { import() {}, unwrap: value => value, bindFunction: (...args) => bound.push(args) } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const state = { length: 136, pid: 42, status: 2, seconds: 1792453448n, micros: 42n };
  s.$ = {
    NSMutableData: { dataWithLength: size => {
      assert.equal(size, 136);
      const bytes = Buffer.alloc(size);
      return { mutableBytes: bytes, base64EncodedStringWithOptions: () => state.encoded ?? bytes.toString('base64') };
    } },
    proc_pidinfo: (pid, flavor, arg, bytes, size) => {
      queries.push([pid, flavor, arg, size]);
      if (state.error) throw new Error('private-native-error');
      bytes.writeUInt32LE(state.status, 4); bytes.writeUInt32LE(state.pid, 12);
      bytes.writeBigUInt64LE(state.seconds, 120); bytes.writeBigUInt64LE(state.micros, 128);
      return state.length;
    },
  };
  const birth = pid => {
    assert.equal(typeof s.finderProcessBirth, 'function', 'Finder kernel birth reader is missing');
    return s.finderProcessBirth(pid);
  };
  return { s, state, bound, queries, birth };
}

test('Finder kernel birth decodes exact microseconds and binds only on first Finder query', () => {
  const f = nativeBirth();
  assert.deepEqual(f.bound, [], 'ordinary fixture source loading cannot bind a new native function');
  assert.equal(f.birth(42), '1792453448.000042');
  f.state.micros = 43n;
  assert.equal(f.birth(42), '1792453448.000043');
  assert.equal(JSON.stringify(f.bound), '[["proc_pidinfo",["int",["int","int","unsigned long long","void *","int"]]]]');
  assert.deepEqual(f.queries, [[42, 3, 0, 136], [42, 3, 0, 136]]);
});

for (const [name, fields] of [
  ['short response', { length: 135 }], ['oversized response', { length: 137 }], ['missing response', { length: 0 }],
  ['wrong PID', { pid: 43 }], ['zombie', { status: 5 }], ['zero seconds', { seconds: 0n }],
  ['unsafe seconds', { seconds: 9007199254740992n }], ['out of range micros', { micros: 1000000n }],
  ['unsafe micros', { micros: 9007199254740992n }], ['native exception', { error: true }],
  ['malformed byte encoding', { encoded: 'owner-private-text' }],
  ['wrong encoding size', { encoded: 'A'.repeat(178) + '==' }],
]) test(`Finder kernel birth refuses ${name}`, () => {
  const f = nativeBirth(); Object.assign(f.state, fields);
  assert.equal(f.birth(42), null);
});

for (const pid of [null, 0, -1, 1.5, NaN, Infinity, '42']) test(`Finder kernel birth refuses invalid PID ${String(pid)} without a query`, () => {
  const f = nativeBirth();
  assert.equal(f.birth(pid), null);
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.bound, []);
});

function recovery({ nextBirth = '1792453448.000043', responsive = false, change = () => {} } = {}) {
  const f = nativeBirth(), events = [];
  let time = 0, probes = 0, forces = 0;
  const old = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: null,
    get isTerminated() { return forces > 0; }, get forceTerminate() { forces++; return true; } };
  const next = { processIdentifier: 43, bundleIdentifier: 'com.apple.finder', launchDate: null, isTerminated: false };
  const api = { application: () => forces ? next : old,
    birth: pid => {
      if (pid === 42) return f.birth(pid);
      return nextBirth;
    }, probe: () => { probes++; time += 500; change({ f, old, next, probes, forces, events }); return responsive || forces ? 0 : -25204; } };
  f.s.$.NSRunningApplication = { runningApplicationWithProcessIdentifier: () => forces ? null : old };
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; }, emit: event => events.push(event) };
  return { ...f, old, next, api, clock, events, run: () => f.s.ensureFinderAX(api, clock),
    get probes() { return probes; }, get forces() { return forces; } };
}

test('Finder with no AppKit launch date and a valid kernel birth probes successfully without relaunch', () => {
  const f = recovery({ responsive: true });
  assert.equal(f.run(), f.old);
  assert.equal(f.probes, 1); assert.equal(f.forces, 0);
  assert.deepEqual(f.events, []);
});

for (const [name, fields] of [
  ['short reply', { length: 135 }], ['wrong PID', { pid: 43 }], ['zombie', { status: 5 }],
  ['zero birth', { seconds: 0n }], ['invalid micros', { micros: 1000000n }], ['native error', { error: true }],
]) test(`Finder rejects ${name} before probing even when AppKit launchDate exists`, () => {
  const f = recovery({ responsive: true }); Object.assign(f.state, fields);
  f.old.launchDate = { timeIntervalSince1970: 1234 };
  assert.throws(f.run, error => {
    assert.equal(error.identityReason, 'start-unavailable');
    assert.doesNotMatch(error.message, /private-native-error/);
    return true;
  });
  assert.equal(f.probes, 0); assert.equal(f.forces, 0);
  assert.deepEqual(f.events, []);
});

test('Finder recovery keeps original and successor exact microsecond births across three timeouts and one force', () => {
  const f = recovery();
  assert.equal(f.run(), f.next);
  assert.equal(f.probes, 4); assert.equal(f.forces, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.events)), [
    { stage: 'finder-relaunch', finderRelaunch: { reason: 'three AXWindows timeouts', pid: 42, pidBirth: '1792453448.000042' } },
    { stage: 'finder-recovered', finderRecovery: { originalExitConfirmed: true,
      fromPid: 42, fromPidBirth: '1792453448.000042', toPid: 43, toPidBirth: '1792453448.000043' } },
  ]);
});

for (const fault of ['microsecond-change', 'unavailable']) for (const boundary of ['after-first-probe', 'relaunch-receipt', 'final-check'])
  test(`Finder ${fault} birth refuses force at ${boundary}`, () => {
  const alter = f => { if (fault === 'microsecond-change') f.state.micros = 43n; else f.state.length = 0; };
  const f = recovery({ change: ({ f, probes }) => { if (boundary === 'after-first-probe' && probes === 1) alter(f); } });
  let emitted = false;
  f.clock.emit = event => { f.events.push(event); emitted = true; if (boundary === 'relaunch-receipt') alter(f); };
  f.clock.check = () => { if (emitted && boundary === 'final-check') alter(f); };
  assert.throws(f.run, error => { assert.equal(error.identityReason, fault === 'microsecond-change' ? 'start-changed' : 'start-unavailable'); return true; });
  assert.equal(f.forces, 0);
  assert.equal(f.probes, boundary === 'after-first-probe' ? 1 : 3);
});

test('Finder successor ordering compares numeric seconds before microseconds', () => {
  const f = recovery({ nextBirth: '10.000000' });
  f.state.seconds = 9n; f.state.micros = 999999n;
  assert.equal(f.run(), f.next);
  assert.equal(f.forces, 1);
});

for (const nextBirth of ['1792453448.000042', '1792453448.000041', '1792453447.999999', null, 'private-native-error'])
  test(`Finder successor birth must be valid and later: ${String(nextBirth)}`, () => {
    const f = recovery({ nextBirth });
    assert.throws(f.run, /Finder AX/);
    assert.equal(f.forces, 1); assert.equal(f.probes, 3);
    assert.equal(f.events.some(event => event.stage === 'finder-recovered'), false);
  });

for (const changed of [null, '1792453448.000044']) test(`Finder successor changing birth after probe refuses recovery (${String(changed)})`, () => {
  const f = recovery();
  let nextBirth = '1792453448.000043';
  f.api.birth = pid => pid === 42 ? f.birth(pid) : nextBirth;
  f.api.probe = () => { f.clock.wait(500); if (f.forces) nextBirth = changed; return f.forces ? 0 : -25204; };
  assert.throws(f.run, /Finder AX/);
  assert.equal(f.forces, 1);
  assert.equal(f.events.some(event => event.stage === 'finder-recovered'), false);
});

test('Finder exit proof requires retained termination and an independent original PID lookup', () => {
  const f = nativeBirth(), original = { isTerminated: false }, receipt = { pid: 42, pidBirth: '1792453448.000042' };
  let current = null, lookups = 0;
  f.s.$.NSRunningApplication = { runningApplicationWithProcessIdentifier: pid => { assert.equal(pid, 42); lookups++; return current; } };
  assert.equal(f.s.finderOriginalExited(original, receipt), false);
  assert.equal(lookups, 0);
  original.isTerminated = true;
  assert.equal(f.s.finderOriginalExited(original, receipt), true);
  current = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: null, isTerminated: false };
  assert.equal(f.s.finderOriginalExited(original, receipt), false);
  f.state.micros = 43n;
  assert.equal(f.s.finderOriginalExited(original, receipt), true);
  f.state.length = 0;
  assert.equal(f.s.finderOriginalExited(original, receipt), false, 'an unreadable kernel reply cannot prove original exit');
});

test('Finder birth receipt filtering accepts only explicit canonical exact birth fields', () => {
  const valid = { pidBirth: '1792453448.000042', fromPidBirth: '9.999999', toPidBirth: '10.000000' };
  assert.deepEqual(finderDiagnostic({ finderRecovery: { ...valid, otherBirth: 'owner-private-title' } }), { finderRecovery: valid });
  for (const value of ['owner-private-title', '0.000001', '01.000001', '1.1', '1.1000000', '9007199254740992.000000',
    '1.000001 /owner/private/path', '1.000001\n', 1.000001, null, {}, ['1.000001']]) {
    assert.deepEqual(finderDiagnostic({ finderRecovery: { pidBirth: value, fromPidBirth: value, toPidBirth: value } }), { finderRecovery: {} });
  }
});
