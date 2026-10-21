import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { executeRealTask, releaseFixtureLock } from '../bench/real-run.mjs';

function trial({ windowCount = 1, cleanup = false } = {}) {
  const s = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const area = { role: 'AXScrollArea', document: '/fixture/target' };
  const baseline = [area, ...Array.from({ length: windowCount }, () => ({ role: 'AXWindow', document: '/fixture/target' }))];
  const owned = { role: 'AXWindow', document: '/fixture/target' }, sheet = {};
  const f = { area, baseline, owned, current: [...baseline, ...(cleanup ? [owned] : [])], actions: [], retained: [], hooks: {}, hits: [] };
  const hit = name => { f.hits.push(name); f.hooks[name]?.(); };
  const request = { target: '/fixture/target', fixtureRoot: '/fixture', token: 'fixture' };
  if (cleanup) request.finderOwnership = { schema: 'finder-role-baseline-v1', baseline: baseline.map(reference => ({ reference, role: reference.role })), created: [owned] };
  const api = {
    windows: () => { hit('inventory'); return f.current; }, equal: (a, b) => !!a && !a.stale && a === b,
    exists: w => w.role === 'AXWindow' && !w.stale,
    finderRole: w => { hit('role'); return w.stale ? null : w.role; },
    fileMenu: (_a, _t, validate) => { hit('new-menu'); validate(); f.actions.push(['new']); f.current.push(owned); },
    finderFolderGuard: (_a, w) => { hit(w ? 'owned-guard' : 'baseline-guard'); assert.ok(!w || w === owned); },
    menu: (_a, _n, _t, validate) => { hit('go-menu'); validate(); f.actions.push(['go', owned]); },
    folderSheet: w => { assert.equal(w, owned); hit('sheet'); return sheet; },
    submitFolder: (w, _sheet, _target, validate) => { hit('submit'); validate(); f.actions.push(['write', w]); },
    dialog: () => { hit('dialog'); return []; },
    text: (w, attr) => { hit('location'); return attr === 'AXDocument' ? w.document : ''; }, path: value => value,
    closeButton: (w, validate) => { hit('close-control'); validate(); f.actions.push(['close', w]); f.current = f.current.filter(item => item !== w); hit('after-close'); },
    wait() {},
  };
  f.api = api; f.request = request;
  f.open = () => s.openFinderFolder(request, {}, baseline[0], api, { check() {}, now: () => 0, wait: () => assert.fail('no polling') }, w => f.retained.push(w));
  f.close = () => s.closeFinderFixtureWindows(owned, request, {}, api);
  return f;
}

for (const windowCount of [0, 1, 3]) test(`stable baseline scroll area with ${windowCount} owner windows is retained without being acted on`, () => {
  const f = trial({ windowCount });
  let inventories = 0;
  f.api.windows = () => ++inventories % 2 ? f.current.slice().reverse() : f.current.slice();
  assert.equal(f.open(), f.owned);
  const ledger = f.request.finderOwnership;
  assert.equal(ledger.schema, 'finder-role-baseline-v1');
  assert.deepEqual(new Map(Array.from(ledger.baseline, item => [item.reference, item.role])), new Map(f.baseline.map(item => [item, item.role])));
  assert.deepEqual(Array.from(ledger.created), [f.owned]);
  f.current.reverse(); f.close();
  assert.deepEqual(f.retained, [f.owned]);
  assert.ok(f.actions.every(([, target]) => !target || target === f.owned));
  assert.deepEqual(new Set(f.current), new Set(f.baseline));
});

const mutations = {
  missing: f => { f.current = f.current.filter(item => item !== f.area); },
  replaced: f => { f.current[f.current.indexOf(f.area)] = { role: 'AXScrollArea' }; },
  role: f => { f.area.role = 'AXWindow'; },
  'window-role': f => { f.baseline[1].role = 'AXScrollArea'; },
  duplicate: f => { f.current.push(f.area); },
  stale: f => { f.area.stale = true; },
  nil: f => { f.current.push(null); },
  nonwindow: f => { f.current.push({ role: 'AXScrollArea' }); },
};

for (const boundary of ['new-menu', 'baseline-guard', 'owned-guard', 'go-menu', 'sheet', 'submit']) {
  for (const [name, mutate] of Object.entries(mutations)) test(`setup refuses ${name} baseline mutation at ${boundary}`, () => {
    const f = trial(); let changed = false;
    f.hooks[boundary] = () => { if (!changed) { changed = true; mutate(f); } };
    assert.throws(f.open, /inventory|identity|baseline/);
    assert.equal(changed, true, 'the requested nested boundary must be reached');
    assert.ok(f.actions.every(([, target]) => !target || target === f.owned));
    assert.equal(f.actions.some(([action]) => action === 'write'), false);
    assert.ok(f.retained.every(item => item === f.owned));
  });
}

for (const boundary of ['dialog', 'location', 'close-control', 'after-close']) {
  for (const [name, mutate] of Object.entries(mutations)) test(`cleanup refuses ${name} baseline mutation at ${boundary}`, () => {
    const f = trial({ cleanup: true }); let changed = false;
    f.hooks[boundary] = () => { if (!changed) { changed = true; mutate(f); } };
    assert.throws(f.close, /inventory|identity|baseline|ownership/);
    assert.equal(changed, true, 'the requested close boundary must be reached');
    assert.ok(f.actions.every(([, target]) => target === f.owned));
    if (boundary !== 'after-close') assert.deepEqual(f.actions, []);
  });
}

for (const schema of ['missing', 'old', 'entry-missing-role', 'bad-role']) test(`cleanup refuses ${schema} role ledger without guessing`, () => {
  const f = trial({ cleanup: true }), ledger = f.request.finderOwnership;
  if (schema === 'missing') delete ledger.schema;
  if (schema === 'old') ledger.baseline = [...f.baseline];
  if (schema === 'entry-missing-role') delete ledger.baseline[0].role;
  if (schema === 'bad-role') ledger.baseline[0].role = 'AXOwnerPrivateRole';
  assert.throws(f.close, /ledger|ownership/);
  assert.deepEqual(f.actions, []);
});

for (const lockHeld of [false, true]) test(`baseline failure during actual cleanup keeps the owning ${lockHeld ? 'outer' : 'task'} lock`, async t => {
  const f = trial({ cleanup: true });
  f.hooks.dialog = () => { f.area.role = 'AXWindow'; };
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-baseline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') }; let releases = 0;
  const diagnostics = { bundle: 'com.apple.finder', launched: false, cleanup: 'unconfirmed', windowCleanupConfirmed: false };
  const task = { setup() {
    ctx.windowLeases = [{ diagnostics, dispose: async () => { try { f.close(); return true; } catch { return false; } } }];
    ctx.fixtureDiagnostics = [diagnostics];
  }, prompt: () => 'offline', cleanup: () => f.close() };
  const release = async () => { releases++; };
  const result = await executeRealTask(task, ctx, { lockHeld, setupOnly: true, lock: async () => release });
  if (lockHeld) assert.equal(await releaseFixtureLock([ctx], release), false);
  assert.equal(releases, 0);
  assert.equal(ctx.fixtureLockUnconfirmed, true);
  assert.ok(result.liveLockKept);
  assert.deepEqual(f.actions, []);
});

test('native close revalidates baseline when press bookkeeping changes it before AXPress', () => {
  const s = { ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const area = { AXRole: 'AXScrollArea' }, window = { AXRole: 'AXWindow', AXCloseButton: {} }, app = { AXWindows: [area, window] };
  const ledger = { schema: 'finder-role-baseline-v1', baseline: [{ reference: area, role: 'AXScrollArea' }], created: [window] };
  let validations = 0, presses = 0;
  const native = value => value;
  native.CFEqual = (a, b) => a === b;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    const value = element[attribute]; output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value; return 0;
  };
  native.AXUIElementPerformAction = () => { presses++; return 0; };
  s.$ = native; s.Ref = () => [];
  const api = s.nativeAX({ cleanup: true }, { check() { if (validations === 1) area.AXRole = 'AXWindow'; } });
  const validate = () => { s.finderRoleInventory(app, api, ledger); validations++; };
  assert.throws(() => api.closeButton(window, validate, true), /baseline/);
  assert.equal(presses, 0);
});

test('ordinary native close preserves its existing single validation callback', () => {
  const s = { ObjC: { import() {}, castRefToObject: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const native = value => value; let validations = 0, presses = 0;
  native.AXUIElementCopyAttributeValue = (_element, _attribute, output) => { output[0] = {}; return 0; };
  native.AXUIElementPerformAction = () => { presses++; return 0; };
  s.$ = native; s.Ref = () => [];
  const api = s.nativeAX({ cleanup: true }, { check() {} });
  api.closeButton({}, () => { validations++; });
  assert.equal(validations, 1);
  assert.equal(presses, 1);
});
