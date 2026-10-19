import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { createAppTargets, createInstanceFence } from '../plugins/sleight/lib/direct-browser/electron-targets.mjs';
import { createNativeJoin } from '../plugins/sleight/lib/direct-browser/electron-native-join.mjs';
import { createAppPageRegistry } from '../plugins/sleight/lib/direct-browser/electron-pages.mjs';
import { check as rulesCheck, captureSnapshot, deliverSnapshot } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { app, identity, recipe, page as target, rect, fakeUpstream, fakeWindows, nativeWindow, fakeBrowser } from './fixtures/electron-graph.mjs';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import { siteRefusal } from '../plugins/sleight/lib/permissions.mjs';

// EPV3-5: input to an app page runs one step at a time inside the registry's guard, after a delivered read at the
// current join, with no hook script in the app's renderer. The registry, join, targets and CDP filter are the real
// EPV3-3 modules over the strict electron-graph fakes. The Playwright page is a strict fake: an unmodelled reader throws.
const handoff = await import('../plugins/sleight/lib/direct-browser/electron-handoff.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });

const element = (attrs = {}, parentNode = null) => ({ nodeType: 1, parentNode, getAttribute: name => attrs[name] ?? null });
const shadowRoot = host => ({ nodeType: 11, host, parentNode: null });
const chain = (depth, top) => { let node = top; for (let i = 0; i < depth; i++) node = element({}, node); return node; };
const terminalInShadow = () => element({}, element({}, shadowRoot(element({ class: 'xterm xterm-dom-renderer-owner-1' }, element({ class: 'pane-body' })))));

async function world({ check = rulesCheck, dom = {}, inspect = {}, onClick, onSleep, wrapPages = pages => pages, acknowledged = () => true } = {}) {
  assert.equal(typeof handoff.createAppRunners, 'function', 'EPV3-5 must provide createAppRunners');
  const f = fakeUpstream([target('a')]); f.geometry.set('a', { ...rect(0, 0), scale: 2, visible: true });
  const w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  const targets = createAppTargets({ upstream: f.session, identity, expected: app, recipe, verify: async () => true });
  await targets.start();
  const join = createNativeJoin({ app, approved: () => true, readWindows: w.read, now: () => 1000 });
  const filter = createCDPFilter({ session: f.session, app: targets.filterHooks });
  const pw = fakeBrowser(filter); await pw.browser.ready();
  const registry = createAppPageRegistry({ browser: pw.browser, filter, targets, join, fence: createInstanceFence(), owner: 'session-a', timeoutMs: 500 });
  await registry.seed();
  const [row] = await registry.list(), entry = registry.tab(row.tab), page = entry.page;
  const sends = [], invalidated = [], reads = [], waits = [];
  let clock = 0, number = 0;
  const metadata = ref => ({ name: 'Run', accName: 'Run', tag: 'button', role: null, kind: 'button', button: true, form: false, link: false,
    submit: false, scriptButton: false, payment: false, formPayment: false, formSignature: null, ...inspect[ref] });
  const locator = ref => utilityLocator({
    async evaluate(fn, arg) {
      if (fn.name === 'terminalAncestor') return fn(dom[ref] ?? element({ class: 'monaco-editor' }, element({ role: 'main' })), arg);
      if (fn.name === 'inspectTarget') return metadata(ref);
      if (fn.name === 'overlaySignature') return { count: 0, hash: 1 };
      if (fn.name === 'placeClear') return 'clear';
      if (fn.name === 'inspect') return { kind: 'text', type: 'text', tag: 'input', role: '', editableText: true, submit: false, payment: false, form: false,
        formPayment: false, enabled: true, visible: true, connected: true, readonly: false, disabled: false, matched: true, current: '' };
      throw Error('unexpected page reader ' + fn.name);
    },
    async count() { return 1; },
    async click() { sends.push(['click', ref]); await onClick?.(ref); },
    async fill(text) { sends.push(['fill', ref, text]); },
    async press(key) { sends.push(['press', ref, key]); },
  });
  page.getByRef = locator;
  page.locator = selector => { assert.equal(selector, ':focus'); return locator('focus'); };
  page.mainFrame = () => page;
  page.keyboard = { async press(key) { sends.push(['key', key]); } };
  page.mouse = { async move() {}, async wheel(dx, dy) { sends.push(['wheel', dx, dy]); } };
  // EPV3-4's read records the join it captured at; the fake does the same.
  const snapshot = async (p, options) => {
    assert.equal(p, page); reads.push(options);
    entry.state.readJoinNo = entry.joinNo; entry.state.readEpoch = entry.epoch;
    return { text: 'No visible changes.', number: ++number };
  };
  // EPV3-4 adds entryOf to the registry; the test adds the same lookup.
  const pages = wrapPages({ ...registry, entryOf: p => p === page && !entry.released && !entry.revoked ? entry : undefined });
  const runners = handoff.createAppRunners({ pages, invalidateRefs: p => invalidated.push(p), check, snapshot, acknowledgeSnapshot: (p, n) => acknowledged(p, n),
    now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; await onSleep?.(clock); } });
  const s = { f, w, join, filter, registry, entry, page, runners, sends, invalidated, reads, waits,
    get elapsed() { return clock; },
    // A read whose text reached the client, at the current join: the worker delivers it and acknowledges its number.
    async deliver() {
      const { number: read } = await runners.read(page, { maxChars: 8000 }), capture = captureSnapshot(entry.state, clock);
      deliverSnapshot(entry.state, capture); return runners.acknowledgeSnapshot(page, read);
    },
    sheet() { w.windows = [nativeWindow(11, rect(0, 0), { modal: 'sheet' })]; },
    clear() { w.windows = [nativeWindow(11, rect(0, 0))]; },
    act: (steps, ctx = {}, options) => runners.runSteps(entry, steps, ctx, options),
  };
  assert.equal(await s.deliver(), true);
  return s;
}
const notRun = pattern => error => { assert.match(error.message, pattern); assert.equal(error.notRun, true); return true; };

test('a site block refuses the first Electron action without sending input', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const perms = { state: 'ok', sites: ['https://blocked.example'] };
  const result = await s.act([{ do: 'click', ref: 'e1' }], {}, { siteCheck: () => siteRefusal(perms, 'https://blocked.example/') });
  assert.deepEqual(s.sends, []);
  assert.match(result.lines[0], /^1 click e1: not run: You blocked sleight on/);
  assert.equal(result.stoppedAt, 1);
});

test('an Electron step reaching a blocked site stops every later input', async t => {
  let url = 'https://fine.example/';
  const s = await world({ onClick: () => { url = 'https://blocked.example/'; } }); t.after(() => s.filter.dispose());
  const perms = { state: 'ok', sites: ['https://blocked.example'] }, seen = [];
  const result = await s.act([{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'private' }, { do: 'press', key: 'Enter' }], {},
    { siteCheck: () => { seen.push(url); return siteRefusal(perms, url); } });
  assert.deepEqual(s.sends, [['click', 'e1']]);
  assert.deepEqual(seen, ['https://fine.example/', 'https://blocked.example/']);
  assert.match(result.lines[1], /^2 type e2: not run: You blocked sleight on/);
  assert.match(result.lines[2], /^3 press: not reached$/);
  assert.equal(result.stoppedAt, 2);
});

test('Electron input fails closed for an unproven site only while site limits exist', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  for (const url of [undefined, 'not a URL', 'app://main/index.html']) {
    for (const perms of [{ state: 'ok', sites: ['https://blocked.example'] }, { state: 'ok', sites: [], only: ['https://fine.example'] }]) {
      const result = await s.act([{ do: 'press', key: 'a' }], {}, { siteCheck: () => siteRefusal(perms, url) });
      assert.equal(result.stoppedAt, 1);
      assert.match(result.lines[0], /can't tell which site this tab shows/);
    }
  }
  assert.deepEqual(s.sends, []);
  const result = await s.act([{ do: 'press', key: 'a' }], {}, { siteCheck: () => siteRefusal({ state: 'ok', sites: [] }, undefined) });
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(s.sends, [['key', 'a']]);
});

test('six adjacent plain keys settle for five short waits and one full final wait', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const result = await s.act(['a', 'b', 'c', 'd', 'e', 'f'].map(key => ({ do: 'press', key })));
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(s.sends, ['a', 'b', 'c', 'd', 'e', 'f'].map(key => ['key', key]));
  assert.deepEqual(s.waits.slice(0, 5), [40, 40, 40, 40, 40]);
  assert.equal(s.elapsed, 800);
  assert.ok(result.lines.slice(0, 5).every(line => line.includes('within 40 ms')));
  assert.match(result.lines.at(-1), /within 600 ms/);
});

test('typing and plain keys share short settling, with a full wait after the final type', async t => {
  const s = await world({ inspect: { e1: { tag: 'input', kind: 'text', button: false } } });
  t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'type', ref: 'e1', text: 'alpha' }, { do: 'press', key: 'Backspace' }, { do: 'type', ref: 'e1', text: 'beta' }]);
  assert.equal(result.stoppedAt, null);
  assert.equal(s.elapsed, 680);
  assert.equal(s.sends.length, 3);
});

for (const key of ['Enter', 'Return', 'NumpadEnter', 'Space', ' ']) test(`activation key ${JSON.stringify(key)} keeps its full wait before an adjacent key`, async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'press', key }, { do: 'press', key: 'a' }]);
  assert.equal(result.stoppedAt, null);
  assert.equal(s.elapsed, 1200);
});

test('a submit keeps its five-second observation even before an adjacent key', async t => {
  const s = await world({ inspect: { focus: { tag: 'input', kind: 'text', button: false, form: true, formSignature: 7 } } });
  t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'press', key: 'Enter' }, { do: 'press', key: 'a' }]);
  assert.match(result.lines[0], /submit unconfirmed after 5 s/);
  assert.ok(s.elapsed >= 5000);
});

test('a native modal arriving in the short wait stops before the next key', async t => {
  let s;
  s = await world({ onSleep: () => s.sheet() }); t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'press', key: 'a' }, { do: 'press', key: 'b' }]);
  assert.equal(s.elapsed, 40);
  assert.deepEqual(s.sends, [['key', 'a']]);
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.observe, undefined);
  assert.match(result.lines.join('\n'), /2 press: not reached/);
});

test('a sheet that arrives between the pre-check and the click: one send, the sent line, and the batch stops', async t => {
  let s; s = await world({ onClick: () => { s.sheet(); s.join.invalidate('native-change'); } });
  t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'x' }]);
  assert.deepEqual(s.sends, [['click', 'e1']]);
  assert.match(result.lines[0], /^1 click e1: /);
  assert.deepEqual(result.lines.slice(1), ['1 click: sent. The app window then native-change. Read before continuing.', '2 type: not reached']);
  assert.equal(result.observe, undefined);
  assert.equal(result.stoppedAt, 1);
  assert.equal(s.entry.parked, 'native-change');
});

test('a page parked before the step: nothing is sent and the refusal is marked not run', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  s.sheet(); assert.equal((await s.registry.list())[0].status, 'parked');
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_PARKED: native-modal\. /));
  assert.deepEqual(s.sends, []);
});

test('a join number newer than the last read is stale until a delivered read at that join', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  s.sheet(); await s.registry.list(); s.clear();
  const [row] = await s.registry.list();
  assert.equal(row.joinNo, 2);
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_STALE_READ: the app window changed since your last read \(join 2\); read again before input$/));
  assert.deepEqual(s.sends, []);
  await s.deliver();
  await s.act([{ do: 'click', ref: 'e1' }]);
  assert.deepEqual(s.sends, [['click', 'e1']]);
});

test('a read that succeeded but was never delivered does not satisfy the gate', async t => {
  let ack = true;
  const s = await world({ acknowledged: () => ack }); t.after(() => s.filter.dispose());
  s.sheet(); await s.registry.list(); s.clear(); await s.registry.list();
  await s.runners.read(s.page, {});
  assert.equal(s.entry.state.readJoinNo, 2, 'the read itself recorded the new join');
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_STALE_READ: .*\(join 2\)/));
  ack = false;
  assert.equal(await s.deliver(), false, 'the snapshot module refused the acknowledgment (refs invalidated since)');
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_STALE_READ: /));
  assert.equal(s.runners.acknowledgeSnapshot(s.page, 999), false, 'an unknown capture number is never delivered');
  ack = true; await s.deliver();
  await s.act([{ do: 'click', ref: 'e1' }]);
  assert.deepEqual(s.sends, [['click', 'e1']]);
});

test('a read captured before a park and delivered after the unpark is stale', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const { number } = await s.runners.read(s.page, {});
  s.sheet(); await s.registry.list(); s.clear(); await s.registry.list();
  assert.equal(s.runners.acknowledgeSnapshot(s.page, number), true);
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_STALE_READ: .*\(join 2\)/));
  assert.deepEqual(s.sends, []);
});

test('a page never read, or read in another target epoch, refuses input as stale', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  s.entry.state.readEpoch = s.entry.epoch + 1;
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }]), notRun(/^ELECTRON_STALE_READ: /));
  s.entry.state.readEpoch = s.entry.epoch; s.entry.state.snapshotNo = 0;
  await assert.rejects(s.act([{ do: 'press', key: 'a' }]), notRun(/^ELECTRON_STALE_READ: /));
  assert.deepEqual(s.sends, []);
});

const refusedKeys = ['Meta+Q', 'Cmd+q', 'Command+W', 'Meta+H', 'Meta+M', 'Meta+Shift+W', 'Shift+Meta+w', 'Meta+Option+H', 'Alt+Cmd+H',
  'Control+Meta+F', 'Meta+Ctrl+f', 'ControlOrMeta+Q', 'Meta+KeyQ'];
for (const key of refusedKeys) test('app key ' + key + ' is refused before anything is sent', async t => {
  assert.equal(handoff.appKeyRefusal(key), handoff.APP_REFUSALS.appKey);
  const s = await world(); t.after(() => s.filter.dispose());
  await assert.rejects(s.act([{ do: 'press', key: 'a' }, { do: 'press', key }]), notRun(/^ELECTRON_APP_KEY_REFUSED: /));
  assert.deepEqual(s.sends, []);
});

test('Cmd+P, Cmd+Shift+P and the Cmd+K Cmd+S chord reach the renderer', async t => {
  for (const key of ['Meta+P', 'Meta+Shift+P', 'Meta+K', 'Meta+S', 'q', 'Shift+Q', 'Meta+Shift+Q', 'Control+F', 'Meta+F', 'Escape'])
    assert.equal(handoff.appKeyRefusal(key), undefined, key);
  const s = await world(); t.after(() => s.filter.dispose());
  for (const steps of [[{ do: 'press', key: 'Meta+P' }], [{ do: 'press', key: 'Meta+Shift+P' }], [{ do: 'press', key: 'Meta+K' }, { do: 'press', key: 'Meta+S' }]]) {
    const result = await s.act(steps);
    assert.ok(result.lines.every(line => !/not run|unconfirmed/.test(line)), result.lines.join('\n'));
  }
  assert.deepEqual(s.sends, [['key', 'Meta+P'], ['key', 'Meta+Shift+P'], ['key', 'Meta+K'], ['key', 'Meta+S']]);
});

test('terminalAncestor: role, class or label within 8 levels, through shadow hosts', () => {
  const { terminalAncestor } = handoff;
  assert.equal(terminalAncestor(terminalInShadow()), true, 'xterm class on the shadow host');
  assert.equal(terminalAncestor(element({ 'aria-label': 'Terminal 1, zsh' })), true);
  assert.equal(terminalAncestor(element({}, element({ role: 'terminal' }))), true);
  assert.equal(terminalAncestor(chain(8, element({ class: 'terminal-wrapper' }))), true, 'the eighth ancestor counts');
  assert.equal(terminalAncestor(chain(9, element({ class: 'terminal-wrapper' }))), false, 'the ninth does not');
  assert.equal(terminalAncestor(element({ class: 'terminals-view' }, element({ 'aria-label': 'Explorer' }))), false);
  assert.equal(terminalAncestor(element({ class: 'monaco-editor' })), false);
});

test('input into a terminal is refused, by ref or by focus; a later step stops the batch with its own line', async t => {
  const s = await world({ dom: { e5: terminalInShadow(), focus: terminalInShadow() }, inspect: { e5: { tag: 'textarea', kind: 'text', button: false } } });
  t.after(() => s.filter.dispose());
  await assert.rejects(s.act([{ do: 'type', ref: 'e5', text: 'ls' }]), notRun(/^ELECTRON_TERMINAL_REFUSED: /));
  await assert.rejects(s.act([{ do: 'press', key: 'Enter' }]), notRun(/^ELECTRON_TERMINAL_REFUSED: /));
  assert.deepEqual(s.sends, []);
  const result = await s.act([{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e5', text: 'ls' }, { do: 'click', ref: 'e2' }]);
  assert.deepEqual(s.sends, [['click', 'e1']]);
  assert.deepEqual(result.lines.slice(1), ['2 type: not run: ' + handoff.APP_REFUSALS.terminal, '3 click: not reached']);
  assert.equal(result.stoppedAt, 2);
});

test('reload, back, forward, navigate, viewport and upload are refused before any step runs', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const cases = [[{ do: 'reload' }, 'navigation'], [{ do: 'back' }, 'navigation'], [{ do: 'forward' }, 'navigation'],
    [{ do: 'navigate', ref: 'e3' }, 'navigation'], [{ do: 'viewport', width: 400, height: 800 }, 'viewport'], [{ do: 'viewport' }, 'viewport'],
    [{ do: 'upload', ref: 'e4', paths: ['/tmp/x'] }, 'upload']];
  for (const [step, kind] of cases) await assert.rejects(s.act([{ do: 'click', ref: 'e1' }, step]),
    error => { assert.equal(error.message, handoff.APP_REFUSALS[kind]); assert.equal(error.notRun, true); return true; });
  await assert.rejects(s.act([{ do: 'click', ref: 'e1' }, { do: 'click' }]), notRun(/click needs ref/), 'the whole batch is validated first');
  assert.deepEqual(s.sends, []);
});

test('a fill where field 2 parks: row 1 set, row 2 refused, later rows and the submit untouched', async t => {
  let guards = 0;
  const s = await world({ wrapPages: pages => ({ ...pages, guard(entry, prepare) { if (++guards === 2) s.sheet(); return pages.guard(entry, prepare); } }) });
  t.after(() => s.filter.dispose());
  const result = await s.runners.fillFields(s.entry, [{ ref: 'e1', value: 'one' }, { ref: 'e2', value: 'two' }, { ref: 'e3', value: 'three' }], { submit: 'e9' }, {});
  assert.deepEqual(s.sends, [['fill', 'e1', 'one']]);
  assert.deepEqual(result.rows[0], { ref: 'e1', status: 'set' });
  assert.equal(result.rows[1].status, 'failed'); assert.match(result.rows[1].reason, /^ELECTRON_PARKED: native-modal\. /);
  assert.deepEqual(result.rows[2], { ref: 'e3', status: 'not reached' });
  assert.equal(result.submitted.status, 'not reached');
  assert.ok(result.stopped);
});

test('a fill with every field set clicks the submit as one guarded step', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  const result = await s.runners.fillFields(s.entry, [{ ref: 'e1', value: 'one' }], { submit: 'e9' }, {});
  assert.deepEqual(s.sends, [['fill', 'e1', 'one'], ['click', 'e9']]);
  assert.deepEqual(result.rows, [{ ref: 'e1', status: 'set' }]);
  assert.equal(result.submitted.status, 'done'); assert.match(result.submitted.lines[0], /^1 click e9: /);
  await assert.rejects(s.runners.fillFields(s.entry, [{ ref: 'bad', value: 'x' }], {}, {}), notRun(/snapshot ref/));
});

test('a duplicate submit is refused until a delivered read', async t => {
  const s = await world({ inspect: { e9: { name: 'Save', accName: 'Save', submit: true, form: true, formSignature: 7 } } });
  t.after(() => s.filter.dispose());
  const first = await s.act([{ do: 'click', ref: 'e9' }]);
  assert.match(first.lines[0], /submit unconfirmed after 5 s/);
  assert.ok(s.entry.state.submitUnconfirmed);
  const again = await s.act([{ do: 'click', ref: 'e9' }]);
  assert.match(again.lines[0], /^1 click e9: not run: Submit unconfirmed\. Deliver a fresh browser_read before retrying/);
  assert.equal(s.sends.length, 1);
  await s.deliver();
  assert.equal(s.entry.state.submitUnconfirmed, false);
  await s.act([{ do: 'click', ref: 'e9' }]);
  assert.equal(s.sends.length, 2);
});

test('scrolling and scroll keys invalidate refs; other keys do not', async t => {
  const s = await world(); t.after(() => s.filter.dispose());
  for (const step of [{ do: 'scroll', dy: 300 }, { do: 'press', key: 'PageDown' }, { do: 'press', key: 'End' }, { do: 'press', key: 'Meta+ArrowDown' }]) {
    const before = s.invalidated.length, result = await s.act([step]);
    assert.equal(s.invalidated.length, before + 1, step.do + ' ' + (step.key ?? ''));
    assert.equal(s.invalidated.at(-1), s.page);
    assert.ok(result.lines.includes('refs invalidated by scrolling. Read again.'));
  }
  const before = s.invalidated.length, result = await s.act([{ do: 'press', key: 'a' }]);
  assert.equal(s.invalidated.length, before);
  assert.ok(!result.lines.includes('refs invalidated by scrolling. Read again.'));
});

test('a payment click inside an app page still asks through the rules, with its step number, and is not sent', async t => {
  const seen = [];
  const check = (ctx, kind, value) => { seen.push({ kind, payment: value.payment }); return rulesCheck(ctx, kind, value); };
  const s = await world({ check, inspect: { e1: { tag: 'input', kind: 'text', button: false },
    e7: { name: 'Pay now', accName: 'Pay now', submit: true, payment: true, form: true, formPayment: true, formSignature: 3 } } });
  t.after(() => s.filter.dispose());
  const result = await s.act([{ do: 'type', ref: 'e1', text: 'card holder' }, { do: 'click', ref: 'e7' }]);
  assert.deepEqual(s.sends, [['fill', 'e1', 'card holder']]);
  assert.match(result.lines[1], /^2 click e7: not run: confirmation required/);
  assert.equal(result.confirmation.step, 2);
  assert.deepEqual(seen.at(-1), { kind: 'click', payment: true });
});
