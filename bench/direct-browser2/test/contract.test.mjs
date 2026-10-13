import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createAuthority, receiptPrefix } from '../contract.mjs';
import { verdict, CONSEQUENCES } from '../policy.mjs';

const scope = () => ({ browser: 'pid-start-root', broker: 'epoch-1', session: 's1', turn: 't1',
  target: 'tab1', lease: 1, frame: 'f1', document: 1, ref: 'r1', origin: 'https://fixture.test' });
const operation = (extra = {}) => ({ id: 'op1', kind: 'fill', args: { value: 'private fixture' },
  scope: scope(), consequence: 'ordinary', transmission: null, ...extra });
function fixture(options = {}) {
  let current = scope(), time = 100, sends = 0;
  const authority = createAuthority({ current: () => current, now: () => time,
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
    data: 'secret', ...(kind === 'upload' ? { files: ['/fixture/file'] } : {}) } });
  assert.equal(f.authority.prepare(op).verdict, 'confirm');
  f.user('request', { session: 's1', consequence: 'transmission', transmission: op.transmission });
  assert.equal(f.authority.prepare(op).verdict, 'allow');
  assert.equal(f.authority.prepare({ ...op, transmission: { ...op.transmission, destination: 'https://other.test' } }).verdict, 'confirm');
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
  const f = fixture({ current: () => current });
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
  const f = fixture({ current: () => current });
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
