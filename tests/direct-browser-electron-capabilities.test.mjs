import test from 'node:test';
import assert from 'node:assert/strict';

// EPV3-6: qualification is a dry run of the real path on an already connected app (list, one read, the
// geometry-to-window delta, one background Escape) under one deadline, producing a receipt. It never launches or
// focuses, and a receipt never authorizes anything. A missing module is the expected failure before the build.
const api = await import('../plugins/sleight/lib/direct-browser/electron-capabilities.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const recipe = Object.freeze({ build: 'invalid.fixture.app@1.2.3', bundleId: 'invalid.fixture.app', sha256: 'a'.repeat(64), joinTolerance: 2 });
const identity = Object.freeze({ host: 'h', pid: 4100, birth: '1700000000.000001', epoch: 3, instance: 'i1' });

// Strict fakes: reading any property a fake does not model throws, so a launch, focus or close call fails the test.
const strict = (name, value) => new Proxy(value, { get(target, key) {
  if (key === 'then' || typeof key === 'symbol') return target[key];
  if (!(key in target)) throw Error(`fake ${name} has no ${String(key)}`);
  return target[key];
} });
function world({ verified = true, members = [{ targetId: 'T1', epoch: 1 }], rows, geometry = { x: 10, y: 30, width: 800, height: 600, scale: 2, visible: true },
  windows = [{ id: 11, epoch: 1, pid: 4100, pidBirth: identity.birth, frame: { x: 10, y: 30, width: 800, height: 600 }, scale: 2, onScreen: true, minimized: false, modal: false }],
  read, guard, overlay = () => false, clock } = {}) {
  const log = [];
  const state = { snapshotNo: 0, submitUnconfirmed: false, readJoinNo: undefined, readEpoch: undefined };
  const page = strict('page', {
    async evaluate(fn) { assert.equal(fn, api.blockingDialog, 'only the generic modal probe runs in the page'); log.push('evaluate'); return overlay(log); },
    keyboard: strict('keyboard', { async press(key) { log.push('press ' + key); } }),
  });
  const entry = { tab: 't' + '1'.repeat(32), targetId: 'T1', epoch: 1, window: { id: 11, epoch: 1 }, page, joinNo: 1, state };
  const listed = rows ?? [{ tab: entry.tab, targetId: 'T1', url: 'fixture://main/index.html', window: { id: 11, epoch: 1 }, status: 'joined', joinNo: 1 }];
  const pages = strict('pages', {
    async list() { log.push('list'); return listed; },
    tab(id) { assert.equal(id, entry.tab); return entry; },
    async guard(target, prepare) { assert.equal(target, entry); log.push('guard'); if (guard) return guard(prepare, target); return prepare(target); },
  });
  const provider = strict('provider', { identity, session: { sessionId: 'root' }, async verifyConnection(session) { log.push('verify'); assert.equal(session, provider.session); return verified; } });
  const targets = strict('targets', { members: () => members, async geometry(id) { log.push('geometry ' + id); return geometry; } });
  const join = strict('join', { parked: () => undefined });
  const reader = strict('windows', { async read() { log.push('windows'); return { observedAt: 1, windows }; } });
  const readFn = read ?? (async (target, options) => { log.push('read'); assert.equal(target, page); assert.deepEqual(options, { maxChars: 8000 });
    entry.state.readJoinNo = entry.joinNo; entry.state.readEpoch = entry.epoch; return { text: '# Fixture App\n- button "Run" [ref=e1]', number: 1 }; });
  let t = 1000;
  const now = clock ?? (() => (t += 5));
  return { log, entry, args: { provider, targets, join, pages, read: readFn, windows: reader, recipe, now } };
}

test('a passing dry run: handshake, targets, one list, one 8000-character read, the delta and one background Escape', async () => {
  assert.equal(typeof api.qualify, 'function', 'EPV3-6 must provide qualify');
  const w = world();
  const receipt = await api.qualify(w.args);
  assert.equal(receipt.qualified, true);
  assert.equal(receipt.failed, undefined);
  assert.deepEqual({ build: receipt.build, bundleId: receipt.bundleId, sha256: receipt.sha256, instance: receipt.instance },
    { build: recipe.build, bundleId: recipe.bundleId, sha256: recipe.sha256, instance: { pid: 4100, pidBirth: identity.birth, epoch: 3, instance: 'i1' } });
  assert.equal(receipt.at, 1005);
  assert.ok(receipt.ms > 0);
  assert.equal(receipt.cells.handshake, true); assert.equal(receipt.cells.targets, 1); assert.equal(receipt.cells.joined, 1);
  assert.equal(receipt.cells.read.bytes, Buffer.byteLength('# Fixture App\n- button "Run" [ref=e1]'));
  assert.ok(receipt.cells.read.ms > 0);
  assert.deepEqual(receipt.cells.delta, { width: 0, height: 0 });
  assert.deepEqual(receipt.cells.overlay, { before: false, after: false });
  assert.equal(receipt.cells.escape.sent, true);
  assert.deepEqual(w.log, ['verify', 'list', 'geometry T1', 'windows', 'read', 'evaluate', 'guard', 'press Escape']);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.cells));
  assert.deepEqual([w.entry.state.readJoinNo, w.entry.state.readEpoch], [undefined, undefined], 'the dry-run read does not stand in for the model\'s read');
});

test('the deadline stops the run and nothing is pressed after it', async () => {
  const w = world({ read: () => new Promise(() => {}), clock: Date.now });
  const started = Date.now();
  const receipt = await api.qualify({ ...w.args, deadlineMs: 40 });
  assert.equal(receipt.qualified, false); assert.equal(receipt.failed, 'ELECTRON_QUALIFY_DEADLINE');
  assert.ok(Date.now() - started < 1000);
  assert.ok(!w.log.some(line => line.startsWith('press')));
  let prepared;
  const late = world({ clock: Date.now, guard: async prepare => { await new Promise(resolve => setTimeout(resolve, 60)); prepared = prepare().then(() => 'pressed', error => error.message); return prepared; } });
  const second = await api.qualify({ ...late.args, deadlineMs: 30 });
  assert.equal(second.failed, 'ELECTRON_QUALIFY_DEADLINE');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await prepared, 'ELECTRON_QUALIFY_DEADLINE', 'a guard that reaches its dispatch after the deadline does not press');
  assert.ok(!late.log.includes('press Escape'));
});

test('zero joined windows is a qualification state with the parked reasons and the measured delta, not a crash', async () => {
  const w = world({ rows: [{ tab: 't' + '1'.repeat(32), targetId: 'T1', url: 'fixture://main/', window: { id: 11, epoch: 1 }, status: 'parked', reason: 'native-modal', joinNo: 1 }],
    geometry: { x: 10, y: 2, width: 800, height: 628, scale: 2, visible: true } });
  const receipt = await api.qualify(w.args);
  assert.equal(receipt.qualified, false); assert.equal(receipt.failed, 'ELECTRON_QUALIFY_NO_JOIN');
  assert.equal(receipt.cells.joined, 0);
  assert.deepEqual(receipt.cells.parked, ['native-modal']);
  assert.deepEqual(receipt.cells.delta, { width: 0, height: 28 }, 'one member and one usable window: the title-bar delta is still measured');
  assert.ok(!w.log.includes('read') && !w.log.some(line => line.startsWith('press')));
});

test('the delta is recorded for the joined window', async () => {
  const receipt = await api.qualify(world({ geometry: { x: 10, y: 29, width: 801, height: 602, scale: 2, visible: true } }).args);
  assert.deepEqual(receipt.cells.delta, { width: 1, height: 2 });
  assert.equal(receipt.qualified, true);
});

test('an Escape refused by a park fails qualification with the park\'s code', async () => {
  const w = world({ guard: async () => { throw Error('ELECTRON_PARKED: native-modal. The app window needs native handling or a fresh read; nothing was sent.'); } });
  const receipt = await api.qualify(w.args);
  assert.equal(receipt.qualified, false); assert.equal(receipt.failed, 'ELECTRON_PARKED');
  assert.equal(receipt.cells.escape.sent, false);
  assert.ok(!w.log.includes('press Escape'));
});

test('a startup overlay (an open modal dialog on an empty profile) is a state: Escape clears it, or qualification fails', async () => {
  let open = true;
  const cleared = world({ overlay: () => open });
  const pass = await api.qualify({ ...cleared.args, pages: { ...cleared.args.pages, list: cleared.args.pages.list, tab: cleared.args.pages.tab,
    guard: async (target, prepare) => { const value = await prepare(target); open = false; return value; } } });
  assert.deepEqual(pass.cells.overlay, { before: true, after: false });
  assert.equal(pass.qualified, true);
  const stuck = await api.qualify(world({ overlay: () => true }).args);
  assert.deepEqual(stuck.cells.overlay, { before: true, after: true });
  assert.equal(stuck.qualified, false); assert.equal(stuck.failed, 'ELECTRON_STARTUP_OVERLAY');
});

test('handshake, targets, read and recipe failures each end in a receipt with a code', async () => {
  assert.equal((await api.qualify(world({ verified: false }).args)).failed, 'ELECTRON_QUALIFY_HANDSHAKE');
  const noIdentity = world();
  assert.equal((await api.qualify({ ...noIdentity.args, provider: { identity: undefined, session: {}, verifyConnection: async () => true } })).failed, 'ELECTRON_QUALIFY_HANDSHAKE');
  assert.equal((await api.qualify(world({ members: [] }).args)).failed, 'ELECTRON_QUALIFY_NO_TARGETS');
  const broken = await api.qualify(world({ read: async () => { throw Error('ELECTRON_PAGE_UNKNOWN'); } }).args);
  assert.equal(broken.failed, 'ELECTRON_PAGE_UNKNOWN'); assert.equal(broken.qualified, false);
  assert.ok(broken.cells.delta, 'native geometry remains measured when the first snapshot fails');
  assert.equal(broken.failedStage, 'read');
  assert.equal((await api.qualify(world({ read: async () => { throw Error('something odd'); } }).args)).failed, 'ELECTRON_QUALIFY_FAILED');
  assert.equal((await api.qualify({ ...world().args, recipe: { ...recipe, sha256: null } })).failed, 'RECIPE_UNFILLED');
  await assert.rejects(api.qualify({ ...world().args, pages: undefined }), /^Error: ELECTRON_QUALIFY_REQUIRED$/);
});

test('receiptCurrent: only the same hash, process, instance and epoch within the TTL; a copy never counts', async () => {
  let t = 1000;
  const receipt = await api.qualify({ ...world().args, now: () => t });
  const at = () => t;
  assert.equal(api.receiptCurrent(receipt, identity, recipe, at), true);
  for (const changed of [{ pid: 4101 }, { birth: '1700000000.000002' }, { instance: 'i2' }, { epoch: 4 }])
    assert.equal(api.receiptCurrent(receipt, { ...identity, ...changed }, recipe, at), false, JSON.stringify(changed));
  assert.equal(api.receiptCurrent(receipt, identity, { ...recipe, sha256: 'b'.repeat(64) }, at), false);
  assert.equal(api.receiptCurrent(receipt, identity, { ...recipe, build: 'invalid.fixture.app@1.2.4' }, at), false);
  t = 1000 + 29999; assert.equal(api.receiptCurrent(receipt, identity, recipe, at), true);
  t = 1000 + 30000; assert.equal(api.receiptCurrent(receipt, identity, recipe, at), false);
  t = 999; assert.equal(api.receiptCurrent(receipt, identity, recipe, at), false, 'a receipt from the future');
  t = 1000;
  assert.equal(api.receiptCurrent(structuredClone(receipt), identity, recipe, at), false);
  assert.equal(api.receiptCurrent(receipt, identity, recipe, at, 10), true);
  assert.equal(api.UNQUALIFIED, 'ELECTRON_UNQUALIFIED');
});
