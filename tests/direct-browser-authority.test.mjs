import test from 'node:test';

import assert from 'node:assert/strict';

import { performance } from 'node:perf_hooks';

import { canonical, createAuthority, receiptPrefix } from '../plugins/sleight/lib/direct-browser/authority.mjs';

import { verdict } from '../plugins/sleight/lib/direct-browser/policy.mjs';

const scope = () => ({ browser: 'pid-start-root', broker: 'epoch-1', session: 's1', turn: 't1',
  target: 'tab1', lease: 1, frame: 'f1', document: 1, ref: 'r1', origin: 'https://fixture.test' });

const operation = (extra = {}) => ({ id: 'op1', kind: 'fill', args: { value: 'private fixture' },
  scope: scope(), consequence: 'ordinary', ...extra });

function fixture(options = {}) {
  let current = scope(), time = 100, sends = 0;
  const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), current: () => current, now: () => time,
    // One synthetic state record supplies the coherent terminal host snapshot.
    snapshot: () => ({ scope: structuredClone(current), time }),
    authenticate: event => event?.credential === 'fixture-user', classify: op => op, ...options });
  const user = (action, data) => authority.user({ credential: 'fixture-user' }, action, data);
  return { authority, user, change: key => { current = { ...current, [key]: 'changed' }; },
    expire: () => { time = 10000; }, dispatch: () => { sends++; }, sends: () => sends };
}

test('closed operations reject raw CDP, evaluate, unexpected keys and implicit submit', () => {
  const f = fixture();
  for (const op of [operation({ kind: 'Runtime.evaluate' }), operation({ kind: 'evaluate' }),
    operation({ args: { value: 'x', submit: true } }), operation({ arbitrary: true })]) {
    assert.equal(f.authority.prepare(op).verdict, 'deny');
  }
});

test('ordinary capability is exact, expiring, single use and arguments never enter receipts', () => {
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  assert.equal(p.verdict, 'allow');
  assert.throws(() => f.authority.dispatch(p.capability, operation({ args: { value: 'other' } }), f.dispatch), /capability/);
  // A failed binding consumes nothing; the exact request can still be dispatched once.
  const r = f.authority.dispatch(p.capability, op, f.dispatch);
  assert.equal(r.phase, 'dispatched');
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /capability/);
  assert.equal(f.sends(), 1);
  assert.ok(!JSON.stringify(r).includes('private fixture'));
  const other = fixture(), q = other.authority.prepare(op);
  other.expire();
  assert.throws(() => other.authority.dispatch(q.capability, op, other.dispatch), /capability/);
});

for (const key of Object.keys(scope())) test(`dispatch repeats the ${key} fence`, () => {
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  f.change(key);
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0);
});

test('specific payment request covers identical terms and same-transaction dialog only', () => {
  const f = fixture(), terms = { item: 'fixture', payee: 'shop', amount: '12.00', currency: 'USD',
    plan: 'one-time', method: 'user card' };
  f.user('request', { session: 's1', consequence: 'payment', terms });
  for (const kind of ['click', 'dialog']) {
    const op = operation({ id: kind, kind, args: kind === 'click' ? {} : { action: 'accept' }, consequence: 'payment', terms });
    assert.equal(f.authority.prepare(op).verdict, 'allow');
  }
  for (const key of Object.keys(terms)) assert.equal(f.authority.prepare(operation({ consequence: 'payment',
    id: key, terms: { ...terms, [key]: 'other' } })).verdict, 'confirm');
  const always = fixture({ confirmPayments: 'always' });
  always.user('request', { session: 's1', consequence: 'payment', terms });
  assert.equal(always.authority.prepare(operation({ consequence: 'payment', terms })).verdict, 'confirm');
  // 'never' acts as 'requested' here: an exact request goes through, anything else asks.
  const never = fixture({ confirmPayments: 'never' });
  never.user('request', { session: 's1', consequence: 'payment', terms });
  assert.equal(never.authority.prepare(operation({ consequence: 'payment', id: 'exact', terms })).verdict, 'allow');
  assert.equal(never.authority.prepare(operation({ consequence: 'payment', id: 'other', terms: { ...terms, amount: 'other' } })).verdict, 'confirm');
  assert.equal(fixture({ confirmPayments: 'never' }).authority.prepare(operation({ consequence: 'payment', terms })).verdict, 'confirm');
});

test('observed is not verified; timeout and revoke after dispatch preserve unknown', () => {
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  f.authority.dispatch(p.capability, op, f.dispatch);
  assert.equal(f.authority.observe(op.id).phase, 'observed');
  assert.equal(f.authority.verify(op.id, 'protected').phase, 'verified');
  assert.deepEqual(f.authority.receipt(op.id).result, 'protected');
  assert.throws(() => f.authority.verify(op.id, 'raw secret'), /proof/);
  const q = fixture(), r = q.authority.prepare(op);
  q.authority.dispatch(r.capability, op, q.dispatch);
  q.user('disconnect', {});
  assert.equal(q.authority.receipt(op.id).phase, 'unknown');
});

test('a batch reports its completed prefix and untouched suffix', () => {
  assert.deepEqual(receiptPrefix([{ id: 'a', phase: 'verified' }, { id: 'b', phase: 'unknown' }], ['a', 'b', 'c']),
    { completed: ['a'], pending: ['b'], untouched: ['c'] });
  assert.throws(() => receiptPrefix([{ id: 'b', phase: 'verified' }], ['a', 'b']), /prefix/);
});

test('inherited schemes use creator authority; internal schemes deny', () => {
  for (const origin of ['file:///fixture', 'chrome://settings', 'chrome-extension://x', 'null'])
    assert.equal(verdict(operation({ scope: { ...scope(), origin } }), { site: true }).verdict, 'deny');
});

test('queued work is fenced at each lifecycle boundary and late proof cannot clear unknown', () => {
  for (const action of ['pause', 'disconnect', 'detach', 'setting-off', 'takeover', 'end-session']) {
    const f = fixture(), op = operation(), p = f.authority.prepare(op);
    f.user(action, { session: 's1' });
    assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence|capability/);
    assert.equal(f.sends(), 0);
  }
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  f.authority.dispatch(p.capability, op, f.dispatch);
  f.authority.timeout(op.id);
  assert.equal(f.authority.receipt(op.id).effect, 'unknown');
  assert.throws(() => f.authority.observe(op.id), /phase/);
  assert.throws(() => f.authority.verify(op.id, 'verified'), /phase/);
});

test('target creation is closed navigation intent; expiry during classification still fences dispatch', () => {
  const f = fixture();
  assert.equal(f.authority.prepare(operation({ kind: 'open', args: { url: 'https://fixture.test/' } })).verdict, 'allow');
  let expire = false;
  const q = fixture({ classify: op => { if (expire) q.expire(); return op; } }), op = operation();
  const p = q.authority.prepare(op); expire = true;
  assert.throws(() => q.authority.dispatch(p.capability, op, q.dispatch), /fence/);
  assert.equal(q.sends(), 0);
});

test('named offline policy workload reports all raw samples and percentiles', t => {
  const f = fixture(), samples = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    const op = operation({ id: `measured-${i}` }), p = f.authority.prepare(op);
    f.authority.dispatch(p.capability, op, f.dispatch);
    f.authority.observe(op.id); f.authority.verify(op.id, 'verified');
    samples.push(performance.now() - start);
  }
  const sorted = samples.toSorted((a, b) => a - b);
  t.diagnostic(JSON.stringify({ workload: 'bp2-authority-fill-v1', node: process.version, n: samples.length,
    p50: sorted[99], p90: sorted[179], samples }));
});

const paymentTerms = { item: 'fixture', payee: 'shop', amount: '12', currency: 'USD', plan: 'once', method: 'card' };

for (const clock of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) test(`invalid issuance clock ${clock} cannot mint a capability`, () => {
  const f = fixture({ now: () => clock });
  assert.equal(f.authority.prepare(operation()).verdict, 'deny');
});

for (const clock of [NaN, Infinity, -1]) test(`invalid dispatch clock ${clock} cannot send input`, () => {
  let time = 0; const f = fixture({ now: () => time });
  const op = operation(), prepared = f.authority.prepare(op); time = clock;
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch));
  assert.equal(f.sends(), 0);
});

for (const clock of [2, NaN]) test(`final current callback advancing clock to ${clock} fences dispatch`, () => {
  let time = 0, finishing = false;
  const f = fixture({ now: () => time, ttl: 1, current: () => { if (finishing) time = clock; return scope(); } });
  const op = operation(), prepared = f.authority.prepare(op); finishing = true;
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /capability|fence/);
  assert.equal(f.sends(), 0);
});

test('a clock rollback below issuance cannot extend capability authority', () => {
  let time = 100; const f = fixture({ now: () => time });
  const op = operation(), prepared = f.authority.prepare(op); time = 99;
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /capability|fence/);
  assert.equal(f.sends(), 0);
});

for (const proof of ['verified', 'protected', 'unchanged']) test(`late transport rejection preserves independently accepted ${proof} proof`, async () => {
  const f = fixture(), op = operation(), prepared = f.authority.prepare(op); let reject;
  f.authority.dispatch(prepared.capability, op, () => new Promise((_, fail) => { reject = fail; }));
  f.authority.observe(op.id); const verified = f.authority.verify(op.id, proof);
  reject(Error('fixture transport loss')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.authority.receipt(op.id), verified);
  assert.equal(f.authority.prepare(operation({ id: 'next' })).verdict, 'allow');
});

test('policy rejects unsupported navigation targets even with a granted current page', () => {
  for (const url of ['file:///fixture', 'chrome://settings', 'https://user:pass@fixture.test/', 'invalid'])
    assert.equal(verdict(operation({ kind: 'navigate', args: { url } }), { site: true }).verdict, 'deny');
});

test('capability serialization rejects hidden array data, holes and accessors without reading getters', () => {
  let reads = 0;
  const getter = Object.defineProperty([], '0', { get: () => { reads++; return 'fixture'; }, enumerable: true });
  for (const value of [Object.assign([], { url: 'https://fixture.test/private-fixture' }), Array(1), getter])
    assert.throws(() => canonical(value), /data/);
  assert.equal(reads, 0);
  assert.equal(canonical(['fixture', false]), '["fixture",false]');
});

for (const key of ['document', 'lease', 'target', 'frame']) {
  test(`navigation rechecks ${key} identity after the final clock callback`, () => {
    let actual = scope(), finishing = false, ticks = 0, sends = 0;
    const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), current: () => structuredClone(actual), classify: op => op,
      snapshot: () => ({ scope: structuredClone(actual), time: 100 }),
      authenticate: () => true, now: () => {
        if (finishing && ++ticks === 2)
          actual = { ...actual, [key]: typeof actual[key] === 'number' ? 2 : 'replacement' };
        return 100;
      } });

    const op = operation({ kind: 'navigate', args: { url: `${actual.origin}/` } });
    const prepared = authority.prepare(op);
    assert.equal(prepared.verdict, 'allow');
    finishing = true;
    let refused = false;
    try { authority.dispatch(prepared.capability, op, () => { sends++; }); } catch { refused = true; }
    assert.equal(sends, 0);
    assert.equal(refused, true);
    assert.equal(authority.receipt(op.id).phase, 'prepared');
  });
}

test('final current-scope callback cannot outlive capability expiry before transport', () => {
  let time = 100, finishing = false, snapshots = 0, sends = 0;
  const actual = scope();
  const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), now: () => time, classify: op => op, authenticate: () => true,
    snapshot: () => ({ scope: structuredClone(actual), time }),
    current: () => {
      if (finishing && ++snapshots === 2) time = 10000;
      return structuredClone(actual);
    } });

  const op = operation({ kind: 'navigate', args: { url: actual.origin + '/' } });
  const prepared = authority.prepare(op); assert.equal(prepared.verdict, 'allow');
  finishing = true;
  let refused = false;
  try { authority.dispatch(prepared.capability, op, () => { sends++; }); } catch { refused = true; }
  assert.equal(sends, 0); assert.equal(refused, true);
  assert.equal(authority.receipt(op.id).phase, 'prepared');
});

test('missing coherent terminal snapshot refuses before transport', () => {
  const f = fixture({ snapshot: undefined }), op = operation(), p = f.authority.prepare(op);
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0); assert.equal(f.authority.receipt(op.id).phase, 'prepared');
});

for (const time of [NaN, Infinity, -1, 99, 10000]) test(`terminal snapshot time ${time} refuses transport`, () => {
  const f = fixture({ snapshot: () => ({ scope: scope(), time }) }), op = operation(), p = f.authority.prepare(op);
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0);
});

for (const key of Object.keys(scope())) test(`coherent terminal snapshot fences ${key}`, () => {
  const f = fixture({ snapshot: () => ({ scope: { ...scope(), [key]: 'replacement' }, time: 100 }) });
  const op = operation(), p = f.authority.prepare(op);
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0);
});

test('terminal snapshot must be synchronous plain data and never reads accessor state', () => {
  let reads = 0;
  for (const snapshot of [() => Promise.resolve({ scope: scope(), time: 100 }), () => Promise.reject(Error('fixture private error')), () => null,
    () => ({ scope: scope(), time: 100, approved: true }),
    () => Object.defineProperty({ scope: scope() }, 'time', { enumerable: true, get() { reads++; return 100; } })]) {
    const f = fixture({ snapshot }), op = operation(), p = f.authority.prepare(op);
    assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
    assert.equal(f.sends(), 0);
  }
  assert.equal(reads, 0);
});

test('dispatch performs no current or clock callback after its terminal snapshot', () => {
  let terminal = false, sends = 0;
  const f = fixture({ current: () => { assert.equal(terminal, false); return scope(); },
    now: () => { assert.equal(terminal, false); return 100; },
    snapshot: () => { terminal = true; return { scope: scope(), time: 100 }; } });
  const op = operation(), p = f.authority.prepare(op);
  assert.equal(f.authority.dispatch(p.capability, op, () => { sends++; }).phase, 'dispatched');
  assert.equal(terminal, true); assert.equal(sends, 1);
});

test('terminal snapshot rejects proxy traps without reading them', () => {
  let reads = 0;
  const traps = { getPrototypeOf() { reads++; return Object.prototype; }, ownKeys(target) { reads++; return Reflect.ownKeys(target); } };
  for (const snapshot of [() => new Proxy({ scope: scope(), time: 100 }, traps),
    () => ({ scope: new Proxy(scope(), traps), time: 100 })]) {
    const f = fixture({ snapshot }), op = operation(), p = f.authority.prepare(op);
    assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
    assert.equal(f.sends(), 0);
  }
  assert.equal(reads, 0);
});

test('legacy scope serialization finishes before the coherent terminal snapshot', () => {
  let terminal = false;
  const f = fixture({ current: () => new Proxy(scope(), { getPrototypeOf() {
    assert.equal(terminal, false); return Object.prototype;
  } }), snapshot: () => { terminal = true; return { scope: scope(), time: 100 }; } });
  const op = operation(), p = f.authority.prepare(op);
  assert.equal(f.authority.dispatch(p.capability, op, f.dispatch).phase, 'dispatched');
  assert.equal(terminal, true); assert.equal(f.sends(), 1);
});
