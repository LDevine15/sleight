import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const mod = await import('../bench/electron-fixture-observation.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
// Synthetic adversarial data, never a filesystem path used by the test.
const poison = 'PRIVATE ' + ['', 'Users', 'someone', 'secret.txt'].join('/') + ' token-and-document-content';
function element({ label = 'a-scratch.txt, preview', tag = 'DIV', role = 'textbox', active = false, width = 0,
  inlineWidth = '-8px', native = true, selected = null } = {}) {
  const node = { tagName: tag, isConnected: true, editContext: native ? {} : null, active,
    classList: { contains: name => name === 'native-edit-context' && native }, style: { width: inlineWidth },
    getAttribute(name) { return ({ 'aria-label': label, role, 'aria-selected': selected })[name] ?? null; },
    getBoundingClientRect: () => ({ x: 12, y: 30, width, height: 20 }), checkVisibility: () => width > 0 };
  for (const key of ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'value', 'name', 'id', 'href'])
    Object.defineProperty(node, key, { get() { throw Error(poison); } });
  return node;
}
function documentCapture(nodes, fixtureName = 'a-scratch.txt', tabs = []) {
  assert.equal(typeof mod.observeFixtureDocument, 'function', 'fixed read-only document observer exists');
  const document = { activeElement: nodes.find(row => row.active) ?? null,
    querySelectorAll(selector) { assert.ok(['[role="textbox"],textarea,input', '[role="tab"]'].includes(selector)); return selector === '[role="tab"]' ? tabs : nodes; } };
  const context = vm.createContext({ document, getComputedStyle: node => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto', width: node.getBoundingClientRect().width + 'px' }) });
  return vm.runInContext(`(${mod.observeFixtureDocument.toString()})(${JSON.stringify(fixtureName)})`, context);
}

test('captures the recorded active scratch textbox without inventing refs or reading content', () => {
  const scratch = element({ active: true });
  const row = documentCapture([scratch], 'a-scratch.txt', [element({ label: 'a-scratch.txt, preview', role: 'tab', selected: 'true' })]);
  assert.equal(row.matchedCount, 1);
  assert.equal(row.activeFixtureEditor, true);
  assert.equal(row.selectedFixtureTab, true);
  assert.equal(row.editors[0].rect.width, 0);
  assert.equal(row.editors[0].computedWidth, 0);
  assert.equal(row.editors[0].inlineWidth, 'negative');
  assert.equal(row.editors[0].classCategory, 'native-edit-context');
  assert.equal(row.editors[0].editContextPresent, true);
  assert.equal(row.editors[0].matchesFixtureName, true);
  assert.ok(!JSON.stringify(row).includes('ref'));
});
test('distinguishes normal notes geometry and refuses arbitrary fixture-name substrings', () => {
  const row = documentCapture([element({ label: 'a-notes.md, preview', tag: 'TEXTAREA', native: false, width: 320, inlineWidth: '320px' }),
    element({ label: poison + 'a-notes.md, preview' })], 'a-notes.md');
  assert.equal(row.textboxCount, 2);
  assert.equal(row.matchedCount, 1);
  assert.equal(row.editors[0].rect.width, 320);
  assert.equal(row.editors[0].classCategory, 'textarea');
  assert.equal(row.editors[0].inlineWidth, 'positive');
  assert.equal(row.activeFixtureEditor, false);
  assert.ok(!JSON.stringify(row).includes(poison));
});
test('bounds element metadata and refuses invalid fixture input before touching DOM', () => {
  const row = documentCapture(Array.from({ length: 70 }, () => element()));
  assert.equal(row.editors.length, 64);
  assert.equal(row.truncated, true);
  assert.throws(() => documentCapture([], poison), /ELECTRON_FIXTURE_NAME/);
});

function harness({ beforeVerify, afterRead, raw } = {}) {
  const page = { isClosed: () => false, frames: () => [frame], ariaSnapshotJSON() { throw Error('snapshot must not be used'); } };
  const frame = { isDetached: () => false, parentFrame: () => null, url: () => 'vscode-file://vscode-app/PRIVATE/path',
    async evaluate() { throw Error('MAIN-world evaluation is forbidden'); } };
  const utility = { world: 'utility', async evaluateExpression(source, options, name) { assert.equal(source, mod.observeFixtureDocument.toString());
    assert.deepEqual(options, { isFunction: true }); assert.equal(name, 'a-scratch.txt');
    const result = raw ?? documentCapture([element({ active: true })]); afterRead?.(h); return result; } };
  const impl = { _page: { delegate: { noUtilityWorld: () => false } }, utilityContext: async () => utility };
  frame._connection = { toImpl: candidate => { assert.equal(candidate, frame); return impl; } };
  const entry = { tab: 't1', targetId: 'private-target', epoch: 1, window: { id: 3, epoch: 1 }, joinNo: 1,
    page, parked: null, released: false, revoked: false, releasing: false };
  let grant = true, verifies = 0, guards = 0;
  const connection = { grant: { current: () => grant }, provider: { session: {}, async verifyConnection() { verifies++; beforeVerify?.(h, verifies); return true; } },
    targets: { current: (target, epoch) => target === entry.targetId && epoch === 1 },
    pages: { tab: id => { assert.equal(id, 't1'); return entry; },
      async enqueue(id, run, options) { assert.deepEqual(options, { mutation: false }); return run(entry); },
      async guard(current, prepare) { assert.equal(current, entry); guards++; return prepare(entry); } } };
  const turn = { id: 'private-turn', connection };
  const h = { entry, frame, page, turn, utility, impl, current: turn, revoke() { grant = false; }, counts: () => ({ verifies, guards }),
    run: () => mod.captureFixtureObservation({ turn, currentTurn: () => h.current, tab: 't1', fixtureName: 'a-scratch.txt' }) };
  return h;
}
test('uses current owned page guards without a new snapshot and returns bounded sanitized metadata', async () => {
  assert.equal(typeof mod.captureFixtureObservation, 'function', 'guarded fixture diagnostic exists');
  const h = harness(), result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.frames[0].parentOrdinal, null);
  assert.equal(result.frames[0].owner, null);
  assert.equal(result.activeFixtureEditor, true);
  assert.ok(h.counts().verifies >= 2);
  assert.equal(h.counts().guards, 1);
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('refuses grant, connection, turn, and page identity changes before releasing diagnostic output', async t => {
  assert.equal(typeof mod.captureFixtureObservation, 'function', 'guarded fixture diagnostic exists');
  for (const [name, change] of [ ['grant', h => h.revoke()], ['turn', h => { h.current = {}; }],
    ['target', h => { h.entry.targetId = 'changed'; }], ['epoch', h => { h.entry.epoch++; }],
    ['window', h => { h.entry.window.epoch++; }], ['join', h => { h.entry.joinNo++; }],
    ['parked', h => { h.entry.parked = poison; }], ['released', h => { h.entry.released = true; }],
    ['revoked', h => { h.entry.revoked = true; }], ['detached', h => { h.frame.isDetached = () => true; }] ]) {
    await t.test(name, async () => { const h = harness({ afterRead: change }), result = await h.run();
      assert.equal(result.ok, false); assert.match(result.code, /^ELECTRON_FIXTURE_[A-Z_]+$/); assert.equal(result.frames, undefined);
      assert.ok(!JSON.stringify(result).includes(poison)); });
  }
  const h = harness(); h.turn.connection.provider.verifyConnection = async () => false;
  assert.equal((await h.run()).ok, false);
});
test('sanitizes poisoned result fields and emits fixed stage codes for page errors', async () => {
  assert.equal(typeof mod.captureFixtureObservation, 'function', 'guarded fixture diagnostic exists');
  const raw = { textboxCount: 1, matchedCount: 1, selectedFixtureTab: null, activeFixtureEditor: false, truncated: false, editors: [{ tag: poison, role: poison,
    rect: { x: Infinity, y: poison, width: -1, height: 20 }, computedWidth: poison, inlineWidth: poison,
    classCategory: poison, display: poison, visibility: poison, pointerEvents: poison, checkVisibility: poison, active: poison, connected: true,
    editContextPresent: poison, matchesFixtureName: true, arbitrary: poison }], arbitrary: poison };
  const h = harness({ raw }), result = await h.run();
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(result.frames[0].editors[0].tag, 'other');
  assert.equal(result.frames[0].editors[0].rect.width, null);
  h.utility.evaluateExpression = async () => { throw Error(poison); };
  const unavailable = await h.run();
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.frames[0].captureStatus, 'unavailable');
  assert.ok(!JSON.stringify(unavailable).includes(poison));
});
test('rechecks provider and registry identity after the final asynchronous provider verification', async t => {
  for (const [name, change] of [['provider', h => { h.turn.connection.provider = {}; }],
    ['session', h => { h.turn.connection.provider.session = {}; }], ['pages', h => { h.turn.connection.pages = {}; }],
    ['targets', h => { h.turn.connection.targets = {}; }], ['connection', h => { h.turn.connection = {}; }]]) {
    await t.test(name, async () => {
      const h = harness({ beforeVerify(h, verifies) { if (verifies === 5) change(h); } });
      assert.equal((await h.run()).ok, false);
    });
  }
});
test('rejects a parked page before capture and preserves a refusing native page guard', async () => {
  const h = harness(); h.frame.evaluate = async () => { throw Error('must not capture'); };
  h.entry.parked = poison;
  assert.equal((await h.run()).code, 'ELECTRON_FIXTURE_IDENTITY_CHANGED');
  h.entry.parked = null;
  h.turn.connection.pages.guard = async () => { throw Error(poison); };
  assert.deepEqual(await h.run(), { ok: false, code: 'ELECTRON_FIXTURE_GUARD_REFUSED', stage: 'guard' });
});
test('records frame structure and bounded owner metadata, disposes owner handles, and rejects too many frames', async () => {
  const h = harness(); let disposed = false;
  const owner = element({ tag: 'IFRAME', role: null, width: 500, native: false });
  const ownerHandle = { async dispose() { disposed = true; } };
  const ownerImpl = { _frame: { _page: h.impl._page, utilityContext: async () => ({ world: 'utility', async evaluateExpression(source, options, node) {
    assert.equal(node, ownerImpl);
    return vm.runInNewContext(`(${source})(owner)`, { owner, getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }) });
  } }) } };
  ownerHandle._connection = { toImpl: candidate => { assert.equal(candidate, ownerHandle); return ownerImpl; } };
  const child = { ...h.frame, url: () => 'vscode-webview://PRIVATE/private', parentFrame: () => h.frame, frameElement: async () => ownerHandle };
  child._connection = { toImpl: candidate => { assert.equal(candidate, child); return h.impl; } };
  h.page.frames = () => [h.frame, child];
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.frameCount, 2);
  assert.equal(result.frames[1].parentOrdinal, 0);
  assert.equal(result.frames[1].owner.tag, 'iframe');
  assert.equal(result.frames[1].owner.rect.width, 500);
  assert.equal(result.frames[1].scheme, 'vscode-webview');
  assert.equal(result.frames[1].captureStatus, 'captured');
  assert.equal(disposed, true);
  h.page.frames = () => Array(17).fill(h.frame);
  assert.deepEqual(await h.run(), { ok: false, code: 'ELECTRON_FIXTURE_FRAME_LIMIT', stage: 'capture' });
});
test('refuses MAIN-world fallback and reports unavailable child acquisition with no URL', async () => {
  const h = harness(); h.impl._page.delegate.noUtilityWorld = () => true;
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.frames[0].captureStatus, 'unavailable');
  assert.equal(result.frames[0].captureCode, 'utility-world-unavailable');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('deadline withholds output while the registry retains the unsettled capture until it finishes', async () => {
  const h = harness(); let finishRead, queued, childAcquired = false;
  const child = { ...h.frame, parentFrame: () => h.frame, async frameElement() { childAcquired = true; throw Error('late child read'); } };
  h.page.frames = () => [h.frame, child];
  h.utility.evaluateExpression = () => new Promise(resolve => { finishRead = resolve; });
  const enqueue = h.turn.connection.pages.enqueue;
  h.turn.connection.pages.enqueue = (...args) => queued = enqueue(...args);
  const result = await h.run();
  assert.deepEqual(result, { ok: false, code: 'ELECTRON_FIXTURE_CAPTURE_PENDING', stage: 'deadline', pending: true });
  let settled = false; queued.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finishRead({ editors: [] });
  await queued.catch(() => {});
  assert.equal(settled, true);
  assert.equal(childAcquired, false);
});
test('deadline during preverification prevents a late verification from enqueueing any capture', async () => {
  const h = harness(); let finishVerify, queued = false;
  h.turn.connection.provider.verifyConnection = () => new Promise(resolve => { finishVerify = resolve; });
  h.turn.connection.pages.enqueue = async () => { queued = true; throw Error('expired verification must not enqueue'); };
  assert.deepEqual(await h.run(), { ok: false, code: 'ELECTRON_FIXTURE_CAPTURE_PENDING', stage: 'deadline', pending: true });
  finishVerify(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queued, false);
});
test('never invokes accessors supplied in page results while sanitizing them', async () => {
  const raw = { textboxCount: 0, matchedCount: 0, selectedFixtureTab: null, activeFixtureEditor: false, truncated: false, editors: [] };
  Object.defineProperty(raw, 'arbitrary', { get() { throw Error(poison); } });
  const editor = { matchesFixtureName: true };
  Object.defineProperty(editor, 'tag', { get() { throw Error(poison); } });
  raw.editors.push(editor);
  const result = await harness({ raw }).run();
  assert.equal(result.ok, true);
  assert.equal(result.frames[0].editors[0].tag, 'other');
  assert.ok(!JSON.stringify(result).includes(poison));
});
