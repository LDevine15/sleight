import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canonical, createAuthority, receiptPrefix } from '../contract.mjs';
import { verdict, CONSEQUENCES } from '../policy.mjs';

const scope = () => ({ browser: 'pid-start-root', broker: 'epoch-1', session: 's1', turn: 't1',
  target: 'tab1', lease: 1, frame: 'f1', document: 1, ref: 'r1', origin: 'https://fixture.test' });
const operation = (extra = {}) => ({ id: 'op1', kind: 'fill', args: { value: 'private fixture' },
  scope: scope(), consequence: 'ordinary', transmission: null, ...extra });
function fixture(options = {}) {
  let current = scope(), time = 100, sends = 0;
  const authority = createAuthority({ current: () => current, now: () => time,
    // One synthetic state record supplies the coherent terminal host snapshot.
    snapshot: () => ({ scope: structuredClone(current), time }),
    authenticate: event => event?.credential === 'fixture-user', classify: op => op, ...options });
  const user = (action, data) => authority.user({ credential: 'fixture-user' }, action, data);
  user('grant', { session: 's1', origin: current.origin, mode: 'session' });
  return { authority, user, change: key => { current = { ...current, [key]: 'changed' }; },
    expire: () => { time = 10000; }, dispatch: () => { sends++; }, sends: () => sends };
}

test('trusted authority is required; page and model approvals never grant access', () => {
  assert.throws(() => createAuthority({}), /trusted/);
  const f = fixture();
  assert.throws(() => f.authority.user({ approved: true }, 'grant', {}), /authority/);
  assert.equal(f.authority.prepare(operation({ approved: true })).verdict, 'deny');
  assert.equal(f.authority.prepare(operation({ scope: { ...scope(), session: 's2' } })).verdict, 'deny');
  f.change('session');
  assert.equal(f.authority.prepare(operation({ scope: { ...scope(), session: 'changed' } })).verdict, 'confirm');
});

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

for (const consequence of CONSEQUENCES) test(`${consequence} requires action-time confirmation`, () => {
  const f = fixture(), op = operation({ consequence });
  assert.equal(f.authority.prepare(op).verdict, 'confirm');
  f.user('confirm', { operation: op });
  const p = f.authority.prepare(op);
  assert.equal(p.verdict, 'allow');
  f.authority.dispatch(p.capability, op, f.dispatch);
  assert.equal(f.authority.prepare(operation({ id: 'op2', consequence })).verdict, 'confirm');
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
});

for (const kind of ['fill', 'paste', 'navigate', 'upload']) test(`${kind} gates transmission before input`, () => {
  const f = fixture(), args = { fill: { value: 'secret' }, paste: { text: 'secret' },
    navigate: { url: 'https://fixture.test/?q=secret' }, upload: { files: ['/fixture/file'] } }[kind];
  const op = operation({ kind, args, transmission: { destination: 'https://fixture.test/receive',
    data: kind === 'navigate' ? args.url : 'secret', ...(kind === 'upload' ? { files: ['/fixture/file'] } : {}) } });
  assert.equal(f.authority.prepare(op).verdict, 'confirm');
  f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
  assert.equal(f.authority.prepare(op).verdict, 'allow');
  assert.equal(f.authority.prepare({ ...op, transmission: { ...op.transmission, destination: 'https://other.test' } }).verdict,
    kind === 'navigate' ? 'deny' : 'confirm');
  assert.equal(f.sends(), 0);
});

test('specific exceptions and ordinary cookie, ToS and downloads preserve baseline', () => {
  const f = fixture();
  for (const consequence of ['login', 'permission', 'age', 'warning', 'move', 'rename', 'upload']) {
    const op = operation({ id: consequence, consequence, terms: { destination: 'fixture', scope: 'exact' } });
    assert.equal(f.authority.prepare(op).verdict, 'confirm');
    f.user('request', { session: 's1', consequence, terms: op.terms });
    assert.equal(f.authority.prepare(op).verdict, 'allow');
  }
  for (const consequence of ['ordinary', 'cookie', 'tos', 'download'])
    assert.equal(f.authority.prepare(operation({ id: consequence, consequence })).verdict, 'allow');
});

test('mandatory handoffs and uncertain semantics cannot be confirmed away', () => {
  const f = fixture();
  for (const consequence of ['password-change', 'safety-barrier', 'paywall']) {
    const op = operation({ consequence });
    f.user('confirm', { operation: op });
    assert.equal(f.authority.prepare(op).verdict, 'handoff');
  }
  assert.equal(f.authority.prepare(operation({ consequence: 'not-classified' })).verdict, 'deny');
});

test('declines are not cached; Always allow requires a direct authenticated user event', () => {
  const f = fixture(), op = operation({ consequence: 'deletion' });
  f.user('decline', { operation: op });
  assert.equal(f.authority.prepare(op).verdict, 'confirm');
  assert.throws(() => f.authority.user({ credential: 'model' }, 'always', { origin: scope().origin }), /authority/);
  assert.throws(() => f.user('always', { origin: scope().origin }), /permanent/);
  let writes = 0;
  const q = fixture({ persistAlways: () => writes++ });
  q.user('always', { origin: scope().origin });
  assert.equal(writes, 1);
});

test('once site grant authorizes one dispatch, session grant ends at revoke', () => {
  const f = fixture();
  f.user('grant', { session: 's1', origin: scope().origin, mode: 'once' });
  const op = operation(), p = f.authority.prepare(op);
  f.authority.dispatch(p.capability, op, f.dispatch);
  assert.equal(f.authority.prepare(operation({ id: 'op2' })).verdict, 'confirm');
  const q = fixture(), r = q.authority.prepare(op);
  q.user('revoke', { session: 's1' });
  assert.throws(() => q.authority.dispatch(r.capability, op, q.dispatch), /capability|fence/);
});

test('unknown effects survive reconnect and durable recovery without replay', () => {
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  f.authority.dispatch(p.capability, op, () => { throw new Error('secret transport detail'); });
  assert.equal(f.authority.receipt(op.id).phase, 'unknown');
  assert.equal(f.authority.prepare(operation({ id: 'op2' })).verdict, 'deny');
  const retained = f.authority.recovery();
  assert.ok(!JSON.stringify(retained).includes('secret'));
  const q = fixture({ recovery: retained });
  assert.equal(q.authority.receipt(op.id).phase, 'unknown');
  assert.equal(q.authority.prepare(operation({ id: 'op2' })).verdict, 'deny');
  f.user('reconnect', {});
  assert.equal(f.authority.receipt(op.id).phase, 'unknown');
  assert.equal(f.authority.prepare(op).verdict, 'deny');
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

test('changed classification or trusted payment terms revoke prepared authority', () => {
  let consequence = 'ordinary';
  const f = fixture({ classify: op => ({ ...op, consequence }) }), op = operation();
  const p = f.authority.prepare(op);
  consequence = 'deletion';
  assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0);
  const q = fixture(), terms = { item: 'fixture', payee: 'shop', amount: '12', currency: 'USD', plan: 'once', method: 'card' };
  const payment = operation({ consequence: 'payment', terms });
  q.user('request', { session: 's1', consequence: 'payment', terms });
  const r = q.authority.prepare(payment);
  q.user('request', { session: 's1', consequence: 'payment', terms: { ...terms, amount: '13' } });
  assert.throws(() => q.authority.dispatch(r.capability, payment, q.dispatch), /fence/);
});

test('transmission intent must name actual fill/paste payload and canonical file capability', () => {
  const f = fixture();
  for (const kind of ['fill', 'paste']) {
    const op = operation({ kind, args: kind === 'fill' ? { value: 'other' } : { text: 'other' },
      transmission: { destination: 'https://fixture.test', data: 'approved' } });
    f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
    assert.equal(f.authority.prepare(op).verdict, 'deny');
  }
  assert.equal(f.authority.prepare(operation({ kind: 'upload', args: { files: ['/fixture/../file'] },
    transmission: { destination: 'https://fixture.test', data: 'file', files: ['/fixture/../file'] } })).verdict, 'deny');
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

test('one payment request never authorizes a second Pay under a new ID', () => {
  const f = fixture(), terms = { item: 'fixture', payee: 'shop', amount: '12', currency: 'USD', plan: 'once', method: 'card' };
  f.user('request', { session: 's1', consequence: 'payment', terms });
  const op = operation({ kind: 'click', args: {}, consequence: 'payment', terms });
  const p = f.authority.prepare(op);
  f.authority.dispatch(p.capability, op, f.dispatch);
  f.authority.observe(op.id); f.authority.verify(op.id, 'verified');
  assert.equal(f.authority.prepare({ ...op, id: 'second-pay' }).verdict, 'confirm');
  const dialog = { ...op, id: 'same-dialog', kind: 'dialog', args: { action: 'accept' } };
  assert.equal(f.authority.prepare(dialog).verdict, 'allow');
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
for (const consequence of ['payment', 'login']) test(`decline retires ${consequence} request and its already prepared capability`, () => {
  const f = fixture(), op = operation({ kind: 'click', args: {}, consequence, terms: paymentTerms });
  f.user('request', { session: 's1', consequence, terms: paymentTerms });
  const prepared = f.authority.prepare(op); assert.equal(prepared.verdict, 'allow');
  f.user('decline', { operation: op });
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /capability|fence/);
  assert.equal(f.authority.prepare({ ...op, id: 'after-decline' }).verdict, 'confirm');
  f.user('request', { session: 's1', consequence, terms: paymentTerms });
  assert.equal(f.authority.prepare({ ...op, id: 'fresh-request' }).verdict, 'allow');
  assert.equal(f.sends(), 0);
});
test('transmission decline retires exact destination/data authority without caching refusal', () => {
  const f = fixture(), op = operation({ transmission: { destination: 'https://fixture.test/receive', data: 'private fixture' } });
  f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
  const prepared = f.authority.prepare(op);
  f.user('decline', { operation: op });
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /capability|fence/);
  assert.equal(f.authority.prepare({ ...op, id: 'after-decline' }).verdict, 'confirm');
  f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
  assert.equal(f.authority.prepare({ ...op, id: 'fresh-request' }).verdict, 'allow');
});
test('decline preserves unrelated terms, destination, session and prepared authority', () => {
  let current = scope();
  const f = fixture({ current: () => current, snapshot: () => ({ scope: structuredClone(current), time: 100 }) });
  const op = operation({ kind: 'click', args: {}, consequence: 'payment', terms: paymentTerms });
  f.user('request', { session: 's1', consequence: 'payment', terms: paymentTerms });
  f.user('decline', { operation: { ...op, terms: { ...paymentTerms, payee: 'other' } } });
  assert.equal(f.authority.prepare(op).verdict, 'allow');
  const ordinary = operation({ id: 'ordinary' }), prepared = f.authority.prepare(ordinary);
  const transmission = { destination: 'https://fixture.test/receive', data: 'private fixture' };
  f.user('request', { session: 's1', consequence: 'transmission', transmission });
  f.user('decline', { operation: operation({ id: 'foreign', transmission: { ...transmission, destination: 'https://other.test' } }) });
  assert.equal(f.authority.prepare(operation({ id: 'same-destination', transmission })).verdict, 'allow');
  current = { ...scope(), session: 's2', origin: 'https://other.test' };
  f.user('grant', { session: 's2', origin: current.origin, mode: 'session' });
  f.user('request', { session: 's2', consequence: 'payment', terms: paymentTerms });
  const other = { ...op, id: 'other-session', scope: current }, otherPrepared = f.authority.prepare(other);
  current = scope(); f.user('decline', { operation: { ...op, id: 'declined' } });
  assert.equal(f.authority.dispatch(prepared.capability, ordinary, f.dispatch).phase, 'dispatched');
  current = other.scope;
  assert.equal(f.authority.dispatch(otherPrepared.capability, other, f.dispatch).phase, 'dispatched');
  assert.equal(f.sends(), 2);
});
test('decline leaves another origin in the same session and its prepared capability intact', () => {
  let current = { ...scope(), origin: 'https://other.test' };
  const f = fixture({ current: () => current, snapshot: () => ({ scope: structuredClone(current), time: 100 }) });
  f.user('grant', { session: 's1', origin: current.origin, mode: 'session' });
  const other = operation({ id: 'other-origin', scope: current }), prepared = f.authority.prepare(other);
  current = scope();
  f.user('request', { session: 's1', consequence: 'payment', terms: paymentTerms });
  f.user('decline', { operation: operation({ kind: 'click', args: {}, consequence: 'payment', terms: paymentTerms }) });
  current = other.scope;
  assert.equal(f.authority.dispatch(prepared.capability, other, f.dispatch).phase, 'dispatched');
  assert.equal(f.sends(), 1);
});

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
for (const observed of [false, true]) test(`unproved ${observed ? 'observed' : 'dispatched'} transport failure retains unknown and quarantine`, async () => {
  const f = fixture(), op = operation(), prepared = f.authority.prepare(op); let reject;
  f.authority.dispatch(prepared.capability, op, () => new Promise((_, fail) => { reject = fail; }));
  if (observed) f.authority.observe(op.id);
  reject(Error('fixture transport loss')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.authority.receipt(op.id).phase, 'unknown');
  assert.equal(f.authority.prepare(operation({ id: 'no-retry' })).verdict, 'deny');
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /capability/);
});

for (const kind of ['navigate', 'open']) {
  for (const suffix of ['/private-fixture', '/?q=private-fixture', '/#private-fixture']) {
    test(`${kind} requires transmission authority for URL ${suffix}`, () => {
      const f = fixture(), op = operation({ kind, args: { url: `https://fixture.test${suffix}` } });
      assert.equal(f.authority.prepare(op).verdict, 'deny');
      assert.equal(f.sends(), 0);
    });
    for (const mismatch of ['destination', 'data']) test(`${kind} binds ${mismatch} for URL ${suffix}`, () => {
      const f = fixture(), url = `https://other.test${suffix}`;
      f.user('grant', { session: 's1', origin: 'https://other.test', mode: 'session' });
      const transmission = { destination: mismatch === 'destination' ? 'https://fixture.test' : 'https://other.test',
        data: mismatch === 'data' ? 'approved fixture' : url };
      f.user('request', { session: 's1', consequence: 'transmission', transmission });
      const op = operation({ kind, args: { url }, transmission });
      assert.equal(f.authority.prepare(op).verdict, 'deny');
      assert.equal(f.sends(), 0);
    });
  }
  for (const suffix of ['/private-fixture/..', '/%2e', '/?', '/#', '/\t']) {
    test(`${kind} does not normalize URL ${JSON.stringify(suffix)} out of transmission approval`, () => {
      const f = fixture(), op = operation({ kind, args: { url: `https://fixture.test${suffix}` } });
      assert.equal(f.authority.prepare(op).verdict, 'deny');
      assert.equal(f.sends(), 0);
    });
  }
  test(`${kind} requires the target site grant even after exact operation confirmation`, () => {
    const f = fixture(), op = operation({ kind, args: { url: 'https://other.test/' } });
    f.user('confirm', { operation: op });
    assert.deepEqual(f.authority.prepare(op), { verdict: 'confirm', reason: 'site' });
    f.user('grant', { session: 's1', origin: 'https://other.test', mode: 'session' });
    const prepared = f.authority.prepare(op);
    assert.equal(prepared.verdict, 'allow');
    assert.equal(f.authority.dispatch(prepared.capability, op, f.dispatch).phase, 'dispatched');
    assert.equal(f.sends(), 1);
  });
  test(`${kind} dispatch consumes only the target once grant without needing a current-page grant`, () => {
    const f = fixture(), op = operation({ kind, args: { url: 'https://other.test/' } });
    f.user('revoke', { session: 's1' });
    f.user('grant', { session: 's1', origin: 'https://other.test', mode: 'once' });
    const prepared = f.authority.prepare(op);
    assert.equal(prepared.verdict, 'allow');
    assert.equal(f.authority.dispatch(prepared.capability, op, f.dispatch).phase, 'dispatched');
    assert.deepEqual(f.authority.prepare({ ...op, id: 'second-navigation' }), { verdict: 'confirm', reason: 'site' });
    assert.equal(f.sends(), 1);
  });
  test(`${kind} keeps current-page authority after consuming a target once grant`, () => {
    const f = fixture(), op = operation({ kind, args: { url: 'https://other.test/' } });
    f.user('grant', { session: 's1', origin: 'https://fixture.test', mode: 'once' });
    f.user('grant', { session: 's1', origin: 'https://other.test', mode: 'once' });
    const prepared = f.authority.prepare(op);
    f.authority.dispatch(prepared.capability, op, f.dispatch);
    assert.equal(f.authority.prepare(operation({ id: 'current-page-input' })).verdict, 'allow');
    assert.deepEqual(f.authority.prepare({ ...op, id: 'target-again' }), { verdict: 'confirm', reason: 'site' });
  });
  test(`${kind} ordinary same-site bare origin remains usable and data URL needs exact approval`, () => {
    const f = fixture();
    for (const url of ['https://fixture.test', 'https://fixture.test/']) {
      const op = operation({ id: `bare-${url.endsWith('/')}`, kind, args: { url } });
      const prepared = f.authority.prepare(op);
      assert.equal(prepared.verdict, 'allow');
      f.authority.dispatch(prepared.capability, op, f.dispatch);
    }
    const url = 'https://fixture.test/path?q=fixture#fragment';
    const op = operation({ id: 'approved-url', kind, args: { url },
      transmission: { destination: 'https://fixture.test/receive', data: url } });
    assert.deepEqual(f.authority.prepare(op), { verdict: 'confirm', reason: 'transmission-before-input' });
    f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
    const prepared = f.authority.prepare(op);
    assert.equal(prepared.verdict, 'allow');
    f.authority.dispatch(prepared.capability, op, f.dispatch);
    assert.equal(f.sends(), 3);
  });
}

test('policy rejects unsupported navigation targets even with a granted current page', () => {
  for (const url of ['file:///fixture', 'chrome://settings', 'https://user:pass@fixture.test/', 'invalid'])
    assert.equal(verdict(operation({ kind: 'navigate', args: { url } }), { site: true }).verdict, 'deny');
});

for (const kind of ['navigate', 'open']) test(`${kind} cannot hide changed approved URL data in named array properties`, () => {
  const f = fixture(), url = 'https://fixture.test/private-fixture';
  assert.throws(() => f.user('request', { session: 's1', consequence: 'transmission',
    transmission: Object.assign([], { destination: 'https://fixture.test/receive', data: 'https://fixture.test/approved' }) }), /data/);
  f.user('request', { session: 's1', consequence: 'transmission',
    transmission: { destination: 'https://fixture.test/receive', data: 'https://fixture.test/approved' } });
  const op = operation({ kind, args: { url },
    transmission: Object.assign([], { destination: 'https://fixture.test/receive', data: url }) });
  assert.equal(f.authority.prepare(op).verdict, 'deny');
  assert.equal(f.sends(), 0);
});

test('capability serialization rejects hidden array data, holes and accessors without reading getters', () => {
  let reads = 0;
  const getter = Object.defineProperty([], '0', { get: () => { reads++; return 'fixture'; }, enumerable: true });
  for (const value of [Object.assign([], { url: 'https://fixture.test/private-fixture' }), Array(1), getter])
    assert.throws(() => canonical(value), /data/);
  assert.equal(reads, 0);
  assert.equal(canonical(['fixture', false]), '["fixture",false]');
});

test('operation confirmation cannot hide a different navigation in named root-array properties', () => {
  const f = fixture(), op = operation({ kind: 'navigate', args: { url: 'https://fixture.test/private-fixture' },
    transmission: { destination: 'https://fixture.test/receive', data: 'https://fixture.test/private-fixture' } });
  assert.throws(() => f.user('confirm', { operation: Object.assign([], op) }), /data/);
  assert.equal(f.authority.prepare(Object.assign([], op)).verdict, 'deny');
  assert.equal(f.sends(), 0);
});

for (const kind of ['navigate', 'open']) test(`${kind} rechecks exact transmission authority after the final clock callback`, () => {
  let finishing = false, ticks = 0;
  const f = fixture({ now: () => {
    if (finishing && ++ticks === 2) f.user('request', { session: 's1', consequence: 'transmission',
      transmission: { destination: 'https://fixture.test/receive', data: 'other fixture' } });
    return 100;
  } });
  const url = 'https://fixture.test/private-fixture';
  const op = operation({ kind, args: { url }, transmission: { destination: 'https://fixture.test/receive', data: url } });
  f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
  const prepared = f.authority.prepare(op); assert.equal(prepared.verdict, 'allow');
  finishing = true;
  assert.throws(() => f.authority.dispatch(prepared.capability, op, f.dispatch), /fence/);
  assert.equal(f.sends(), 0);
});

for (const key of ['document', 'lease', 'target', 'frame']) {
  test(`navigation rechecks ${key} identity after the final clock callback`, () => {
    let actual = scope(), finishing = false, ticks = 0, sends = 0;
    const authority = createAuthority({ current: () => structuredClone(actual), classify: op => op,
      snapshot: () => ({ scope: structuredClone(actual), time: 100 }),
      authenticate: () => true, now: () => {
        if (finishing && ++ticks === 2)
          actual = { ...actual, [key]: typeof actual[key] === 'number' ? 2 : 'replacement' };
        return 100;
      } });
    authority.user({}, 'grant', { session: 's1', origin: actual.origin, mode: 'session' });
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
  const authority = createAuthority({ now: () => time, classify: op => op, authenticate: () => true,
    snapshot: () => ({ scope: structuredClone(actual), time }),
    current: () => {
      if (finishing && ++snapshots === 2) time = 10000;
      return structuredClone(actual);
    } });
  authority.user({}, 'grant', { session: 's1', origin: actual.origin, mode: 'session' });
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

test('terminal snapshot rechecks revocation, transmission authority and quarantine', () => {
  for (const effect of ['revoke', 'transmission', 'quarantine']) {
    let nested = false;
    const f = fixture({ snapshot: () => {
      if (!nested) {
        nested = true;
        if (effect === 'revoke') f.user('revoke', { session: 's1' });
        if (effect === 'transmission') f.user('request', { session: 's1', consequence: 'transmission',
          transmission: { destination: 'https://fixture.test', data: 'different' } });
        if (effect === 'quarantine') {
          const other = operation({ id: 'other' }), prepared = f.authority.prepare(other);
          f.authority.dispatch(prepared.capability, other, () => { throw Error('fixture loss'); });
        }
      }
      return { scope: scope(), time: 100 };
    } });
    const url = 'https://fixture.test/private-fixture';
    const op = operation({ kind: 'navigate', args: { url },
      transmission: { destination: 'https://fixture.test', data: url } });
    f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
    const p = f.authority.prepare(op); assert.equal(p.verdict, 'allow');
    assert.throws(() => f.authority.dispatch(p.capability, op, f.dispatch), /fence/);
    assert.equal(f.sends(), 0); assert.equal(f.authority.receipt(op.id).phase, 'prepared');
  }
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
