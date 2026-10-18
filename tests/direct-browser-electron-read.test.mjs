// EPV3-4: the app read. A trusted header (window, join, document, coverage) goes in front of snapshot.mjs's
// own read, inside the same maxChars; refs keep snapshot's meaning and invalidateRefs retires them.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { app as joinApp, identity, recipe, page as targetInfo, rect, fakeUpstream, fakeWindows, nativeWindow, fakeBrowser } from './fixtures/electron-graph.mjs';

const base = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const load = async name => import(new URL(name + '.mjs', base)).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const read = await load('electron-read');
const snapshots = await load('snapshot');

const app = Object.freeze({ name: 'Visual Studio Code', version: '1.105.1', pid: 4100 });
const MAIN = 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html';

// Strict doubles: each models only what the read may use, so anything else throws.
function fakePage({ url = MAIN, coverage = null } = {}) {
  const evaluations = [];
  const page = { url: () => url, async evaluate(fn, arg) { evaluations.push({ fn, arg }); return coverage; } };
  return { page, evaluations };
}
const entryFor = (page, extra = {}) => ({ tab: 't' + '0'.repeat(32), targetId: 'a', epoch: 3, window: { id: 812, epoch: 2 }, page, cdp: {},
  state: { snapshotNo: 0, submitUnconfirmed: false }, queue: Promise.resolve(), parked: null, joinNo: 1, released: false, revoked: false, app: true, ...extra });
const pagesOf = (...entries) => ({ entryOf: page => entries.find(entry => entry.page === page) });
const targetsOf = urls => ({ record: id => (id in urls ? { targetId: id, epoch: 3, kind: 'member', reason: 'member', type: 'page', url: urls[id] } : undefined) });
function snapshotDouble(text = '# Snapshot 1 (untrusted page content)\n- main "Editor"') {
  const calls = [];
  const fn = async (page, options) => { calls.push({ page, options }); return { text, number: calls.length }; };
  return Object.assign(fn, { calls });
}
function reader({ entries, urls = { a: MAIN }, snapshot = snapshotDouble(), now } = {}) {
  return { snapshot, read: read.createAppSnapshot({ snapshot, pages: pagesOf(...entries), targets: targetsOf(urls), app, ...(now ? { now } : {}) }) };
}

// A Playwright-shaped page over the real snapshot.mjs: an AI-mode aria tree whose rows the test recycles,
// and one owned frame session that answers the native capture with an empty document.
function snapshotPage(tree, { url = MAIN } = {}) {
  const page = new EventEmitter(), frame = {};
  let current = tree, href = url;
  const capture = () => ({ strings: ['#document'], documents: [{ nodes: { parentIndex: [-1], nodeType: [9], nodeName: [0], nodeValue: [0], backendNodeId: [1], attributes: [[]] } }] });
  Object.assign(page, {
    url: () => href, frames: () => [frame], mainFrame: () => frame,
    async ariaSnapshotJSON(options) { assert.equal(options.mode, 'ai'); return structuredClone(current); },
    context: () => ({ async newCDPSession() {
      return { async send(method) {
        if (method === 'DOMSnapshot.captureSnapshot') return capture();
        throw Error('fake has no CDP method: ' + method);
      }, async detach() {} };
    } }),
    locator: selector => ({ selector }),
    async evaluate() { return null; },
  });
  return { page, set: value => { current = value; }, navigate: value => { href = value; page.emit('framenavigated', frame); } };
}
const rowsTree = (offset, count = 200) => [{ role: 'list', name: 'Explorer', ref: 'e1', children: Array.from({ length: count }, (_, i) =>
  ({ role: 'listitem', name: `file-${String(i + offset).padStart(4, '0')}.txt`, ref: 'e' + (i + 2) })) }];
const refsIn = text => [...text.matchAll(/\[ref=(e\d+)\]/g)].map(match => match[1]);

// A minimal DOM for readCoverage, with only the calls it may make.
function element(role, attributes = {}, children = []) {
  const all = { ...(role ? { role } : {}), ...attributes };
  const node = { nodeType: 1, children,
    getAttribute: name => (Object.hasOwn(all, name) ? String(all[name]) : null),
    querySelectorAll(selector) {
      const match = /^\[([a-z-]+)\]$/.exec(selector);
      assert.ok(match, 'readCoverage uses attribute-presence selectors only: ' + selector);
      const found = [];
      const visit = list => { for (const child of list) { if (child.getAttribute(match[1]) !== null) found.push(child); visit(child.children); } };
      visit(children);
      return found;
    } };
  return node;
}
const inPage = (body, root) => vm.runInNewContext(`(${read.readCoverage.toString()})(root)`, { document: { body }, root });

test('electron-read and snapshot export the EPV3-4 interface', () => {
  assert.equal(typeof read.createAppSnapshot, 'function');
  assert.equal(typeof read.coverageLine, 'function');
  assert.equal(typeof read.readCoverage, 'function');
  assert.equal(typeof snapshots.invalidateRefs, 'function');
  assert.throws(() => read.createAppSnapshot({ snapshot: snapshotDouble(), pages: {}, targets: targetsOf({}), app }), /^Error: ELECTRON_READ_REQUIRED$/);
  assert.throws(() => read.createAppSnapshot({ snapshot: snapshotDouble(), pages: pagesOf(), targets: targetsOf({}), app: { name: 'x', version: '1', pid: -1 } }), /ELECTRON_READ_REQUIRED/);
});

test('entryOf finds the registry entry by page object, never a foreign, released or ended one', async t => {
  const pages = await load('electron-pages'), targets = await load('electron-targets'), join = await load('electron-native-join');
  const f = fakeUpstream([targetInfo('a'), targetInfo('b', 'app://main/b.html')]);
  f.geometry.set('a', { ...rect(0, 0), scale: 2, visible: true }); f.geometry.set('b', { ...rect(900, 0), scale: 2, visible: true });
  const appTargets = targets.createAppTargets({ upstream: f.session, identity, expected: joinApp, recipe, verify: async () => true });
  await appTargets.start();
  const filter = createCDPFilter({ session: f.session, app: appTargets.filterHooks });
  t.after(() => filter.dispose());
  const pw = fakeBrowser(filter); await pw.browser.ready();
  const registry = pages.createAppPageRegistry({ browser: pw.browser, filter, targets: appTargets, fence: targets.createInstanceFence(), owner: 'session-a', timeoutMs: 500,
    join: join.createNativeJoin({ app: joinApp, approved: () => true, readWindows: fakeWindows([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0))]).read, now: () => 1000 }) });
  await registry.seed();
  const [a, b] = await registry.list();
  const entryA = registry.tab(a.tab), entryB = registry.tab(b.tab);
  assert.equal(registry.entryOf(entryA.page), entryA);
  assert.equal(registry.entryOf(entryB.page), entryB);
  assert.equal(registry.entryOf({ url: () => MAIN }), undefined, 'a page object the registry never admitted');
  await registry.keep(b.tab);
  assert.equal(registry.entryOf(entryB.page), undefined, 'released');
  await registry.endTurn();
  assert.equal(registry.entryOf(entryA.page), undefined, 'the turn released every page');
});

test('a joined read: the trusted header lines come first, then snapshot\'s own header, all inside maxChars', async () => {
  const { page, evaluations } = fakePage();
  const entry = entryFor(page);
  const { snapshot, read: appRead } = reader({ entries: [entry] });
  const result = await appRead(page, { find: 'Editor', maxChars: 8000 });
  const lines = result.text.split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    '# Visual Studio Code 1.105.1 (pid 4100) window 812 epoch 2, join 1 joined',
    '# Document: vscode-file://vscode-app (app document)',
    '# Snapshot 1 (untrusted page content)',
  ]);
  assert.equal(result.number, 1);
  assert.equal(snapshot.calls.length, 1);
  assert.equal(snapshot.calls[0].page, page);
  const header = lines.slice(0, 2).join('\n');
  assert.deepEqual(snapshot.calls[0].options, { find: 'Editor', maxChars: 8000 - header.length - 1 }, 'the header is taken out of the budget');
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].fn, read.readCoverage, 'coverage runs the exported closure-free function in the main world');
  assert.doesNotMatch(result.text, /Coverage/, 'no list, no coverage line');
});

test('a parked read is allowed and says why; hidden renderers say so', async () => {
  const { page } = fakePage();
  const parked = entryFor(page, { parked: 'native-modal', joinNo: 2 });
  const parkedText = (await reader({ entries: [parked] }).read(page)).text;
  assert.equal(parkedText.split('\n')[0], '# Visual Studio Code 1.105.1 (pid 4100) window 812 epoch 2, join 2 parked: native-modal');
  const other = fakePage();
  const hidden = entryFor(other.page, { renderer: 'hidden', joinNo: 4 });
  const hiddenText = (await reader({ entries: [hidden] }).read(other.page)).text;
  assert.equal(hiddenText.split('\n')[0], '# Visual Studio Code 1.105.1 (pid 4100) window 812 epoch 2, join 4 joined, renderer hidden');
});

test('the document line comes from the target record: a scheme and host or an https origin, never a path or page text', async () => {
  const cases = [
    [MAIN, '# Document: vscode-file://vscode-app (app document)'],
    ['vscode-webview://1a2b3c/index.html?id=x', '# Document: vscode-webview://1a2b3c (app document)'],
    ['https://github.com/login/oauth?state=secret#x', '# Document: https://github.com (web)'],
    ['file:///Users/someone/Projects/notes.md', '# Document: file:// (app document)'],
    ['not a url', '# Document: unavailable'],
  ];
  for (const [url, expected] of cases) {
    const { page } = fakePage({ url: 'https://page-says.example/' });
    const text = (await reader({ entries: [entryFor(page)], urls: { a: url } }).read(page)).text;
    assert.equal(text.split('\n')[1], expected, url);
    assert.doesNotMatch(text, /page-says|secret|someone/);
  }
});

test('coverage is labeled untrusted page content and sits last in the header', async () => {
  const { page } = fakePage({ coverage: { declaredTotal: 1500, renderedRows: 44, first: 1, last: 44 } });
  const text = (await reader({ entries: [entryFor(page)] }).read(page)).text;
  assert.equal(text.split('\n')[2], '# Coverage (untrusted page content): rows 1-44 of 1500 rendered; scroll with until:text or press End for more');
  assert.equal(text.split('\n')[3], '# Snapshot 1 (untrusted page content)');
  assert.equal(read.coverageLine({ declaredTotal: 12, renderedRows: 12, first: 1, last: 12 }),
    '# Coverage (untrusted page content): rows 1-12 of 12 rendered', 'nothing more to scroll to');
});

test('coverage is null without a list, and a malformed summary prints nothing', async () => {
  const body = element(null, {}, [element('main', {}, [element('button', { 'aria-setsize': 3, 'aria-posinset': 1 })]),
    element('list', {}, [element('listitem'), element('listitem')])]);
  assert.equal(inPage(body), null);
  assert.equal(read.coverageLine(null), null);
  for (const bad of [{}, { declaredTotal: '1500', renderedRows: 44, first: 1, last: 44 }, { declaredTotal: 10, renderedRows: 3, first: 5, last: 2 },
    { declaredTotal: 10, renderedRows: 3, first: 0, last: 3 }, { declaredTotal: 10, renderedRows: 3, first: 1, last: 11 }, { declaredTotal: 2 ** 60, renderedRows: 1, first: 1, last: 1 }, 'rows 1-44'])
    assert.equal(read.coverageLine(bad), null, JSON.stringify(bad));
  const { page } = fakePage({ coverage: { declaredTotal: -1 } });
  assert.doesNotMatch((await reader({ entries: [entryFor(page)] }).read(page)).text, /Coverage/);
});

test('a 1,500-line editor with 44 rendered lines reads as rows 1-44 of 1500, from a closure-free function', () => {
  const lines = Array.from({ length: 44 }, (_, i) => element('listitem', { 'aria-setsize': 1500, 'aria-posinset': i + 1 }));
  const editor = element('list', { 'aria-label': 'Editor content' }, lines);
  const body = element(null, {}, [element('tree', {}, []), editor]);
  const summary = inPage(body);
  assert.deepEqual({ ...summary }, { declaredTotal: 1500, renderedRows: 44, first: 1, last: 44 });
  assert.equal(read.coverageLine(summary), '# Coverage (untrusted page content): rows 1-44 of 1500 rendered; scroll with until:text or press End for more');
  const grid = element('grid', { 'aria-rowcount': 1500 }, Array.from({ length: 44 }, (_, i) => element('row', { 'aria-rowindex': i + 101 })));
  assert.deepEqual({ ...inPage(element(null, {}, [grid])) }, { declaredTotal: 1500, renderedRows: 44, first: 101, last: 144 });
  assert.deepEqual({ ...inPage(body, grid) }, { declaredTotal: 1500, renderedRows: 44, first: 101, last: 144 }, 'a scoped root reads its own list');
});

test('a ref-scoped read measures coverage on that element through getByRef', async () => {
  const scoped = [];
  const { page } = fakePage();
  page.getByRef = ref => ({ async evaluate(fn, arg, options) { scoped.push({ ref, fn, options }); return { declaredTotal: 50, renderedRows: 10, first: 11, last: 20 }; } });
  const text = (await reader({ entries: [entryFor(page)] }).read(page, { ref: 'e7' })).text;
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].ref, 'e7'); assert.equal(scoped[0].fn, read.readCoverage);
  assert.match(text, /^# Coverage \(untrusted page content\): rows 11-20 of 50 rendered;/m);
  page.getByRef = () => { throw Error('Ref is stale or its snapshot was not delivered; use browser_read again.'); };
  assert.doesNotMatch((await reader({ entries: [entryFor(page)] }).read(page, { ref: 'e7' })).text, /Coverage/, 'a coverage failure never fails the read');
});

test('200 recycled rows: after invalidateRefs the same rows read again carry new refs, and the old refs refuse', async () => {
  const fixture = snapshotPage(rowsTree(0));
  const entry = entryFor(fixture.page);
  const appRead = read.createAppSnapshot({ snapshot: snapshots.snapshot, pages: pagesOf(entry), targets: targetsOf({ a: MAIN }), app });
  const first = await appRead(fixture.page, { maxChars: 40000 });
  const oldRefs = refsIn(first.text);
  assert.equal(oldRefs.length, 201);
  assert.equal(snapshots.acknowledgeSnapshot(fixture.page, first.number), true);
  assert.deepEqual(fixture.page.getByRef('e100'), { selector: 'aria-ref=e100' });
  // The list scrolled: the renderer recycled every row element (same aria refs) with new text.
  fixture.set(rowsTree(200));
  snapshots.invalidateRefs(fixture.page);
  for (const ref of ['e1', 'e100', 'e201']) assert.throws(() => fixture.page.getByRef(ref), /stale.*use browser_read again/);
  const second = await appRead(fixture.page, { maxChars: 40000 });
  const newRefs = refsIn(second.text);
  assert.equal(newRefs.length, 201);
  assert.equal(newRefs.filter(ref => oldRefs.includes(ref)).length, 0, 'no old ref is reused for a recycled row');
  assert.match(second.text, /file-0399\.txt/);
  assert.equal(snapshots.acknowledgeSnapshot(fixture.page, second.number), true);
  assert.deepEqual(fixture.page.getByRef(newRefs[99]), { selector: 'aria-ref=e100' }, 'the new ref resolves to the recycled element');
  assert.throws(() => fixture.page.getByRef('e100'), /stale/, 'the old ref stays retired after the new read is delivered');
  assert.doesNotThrow(() => snapshots.invalidateRefs({}), 'a page never read has nothing to invalidate');
});

test('a URL change with the same target epoch retires refs through snapshot\'s own generation', async () => {
  const fixture = snapshotPage(rowsTree(0, 3));
  const urls = { a: MAIN };
  const entry = entryFor(fixture.page);
  const appRead = read.createAppSnapshot({ snapshot: snapshots.snapshot, pages: pagesOf(entry), targets: targetsOf(urls), app });
  const first = await appRead(fixture.page);
  snapshots.acknowledgeSnapshot(fixture.page, first.number);
  assert.ok(fixture.page.getByRef('e2'));
  urls.a = 'https://github.com/login';
  fixture.navigate('https://github.com/login');
  assert.equal(entry.epoch, 3);
  assert.throws(() => fixture.page.getByRef('e2'), /stale/);
  const second = await appRead(fixture.page);
  assert.equal(second.text.split('\n')[1], '# Document: https://github.com (web)');
  assert.equal(refsIn(second.text).filter(ref => refsIn(first.text).includes(ref)).length, 0);
});

test('an unknown page is refused before anything reads it', async () => {
  const { page, evaluations } = fakePage();
  const { snapshot, read: appRead } = reader({ entries: [] });
  await assert.rejects(appRead(page), /^Error: ELECTRON_PAGE_UNKNOWN$/);
  assert.equal(snapshot.calls.length, 0);
  assert.equal(evaluations.length, 0);
});

test('the header counts against maxChars, and a budget too small for it refuses with the size that fits', async () => {
  const fixture = snapshotPage(rowsTree(0));
  const entry = entryFor(fixture.page);
  const appRead = read.createAppSnapshot({ snapshot: snapshots.snapshot, pages: pagesOf(entry), targets: targetsOf({ a: MAIN }), app });
  const result = await appRead(fixture.page, { maxChars: 2000 });
  assert.ok(result.text.length <= 2000, `${result.text.length} characters`);
  assert.match(result.text, /^# Visual Studio Code/);
  assert.match(result.text, /# Cut: more rows omitted/);
  const header = result.text.split('\n').slice(0, 2).join('\n');
  await assert.rejects(appRead(fixture.page, { maxChars: 1000 }), new RegExp(`^Error: Snapshot unavailable: max_chars 1000 leaves no room for the app window header; use max_chars: ${1001 + header.length} or more$`));
  for (const maxChars of [999, 40001, 1.5, '8000']) await assert.rejects(appRead(fixture.page, { maxChars }), /^Error: Invalid snapshot request$/);
  for (const line of result.text.split('\n').slice(0, 2)) assert.ok(line.length <= 240);
  const long = entryFor(fixture.page, { parked: 'x'.repeat(500) });
  const longRead = read.createAppSnapshot({ snapshot: snapshotDouble(), pages: pagesOf(long), targets: targetsOf({ a: MAIN }), app: { ...app, name: 'A\nB'.repeat(200) } });
  for (const line of (await longRead(fixture.page)).text.split('\n').slice(0, 2)) { assert.ok(line.length <= 240, line.length); assert.match(line, /^# /); }
});

test('the read records the join and target epoch from capture start, and a failed read clears them', async () => {
  const { page } = fakePage();
  const entry = entryFor(page, { joinNo: 5 });
  let fail = false;
  const snapshot = async () => {
    assert.deepEqual([entry.state.readJoinNo, entry.state.readEpoch, entry.state.readAt], [5, 3, 1234], 'set before the snapshot runs');
    entry.joinNo = 6; // a sheet came and went during the read
    if (fail) throw Error('Snapshot unavailable; try browser_read again');
    return { text: '# Snapshot 1 (untrusted page content)', number: 1 };
  };
  const appRead = read.createAppSnapshot({ snapshot, pages: pagesOf(entry), targets: targetsOf({ a: MAIN }), app, now: () => 1234 });
  await appRead(page);
  assert.equal(entry.state.readJoinNo, 5, 'the start value, so a join that changed mid-read is stale');
  assert.equal(entry.state.readEpoch, 3);
  entry.joinNo = 5; fail = true;
  await assert.rejects(appRead(page), /Snapshot unavailable/);
  assert.equal(entry.state.readJoinNo, undefined);
  assert.equal(entry.state.readEpoch, undefined);
});
