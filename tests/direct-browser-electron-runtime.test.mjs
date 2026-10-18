import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { createElectronConsent, createGrantStore } from '../plugins/sleight/lib/direct-browser/electron-consent.mjs';
import { validateAppInstance, createAppBinding, validateCardOperation, cardChoices, appKey } from '../plugins/sleight/lib/direct-browser/electron-identity.mjs';
import { createV3TurnBinding, isV3Context } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { readRecipeRegistry, recipeFor, instanceFromRecipe } from '../plugins/sleight/lib/direct-browser/electron-recipes.mjs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { assertEndpointRead } from '../plugins/sleight/lib/direct-browser/endpoint-guard.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { page, rect, fakeUpstream, fakeWindows, nativeWindow, fakeBrowser, tick } from './fixtures/electron-graph.mjs';
import { makeHost } from './direct-browser-electron-host-fixture.mjs';

// EPV3-7b: the worker's app runtime. The EPV3-3 to EPV3-6 modules are the real ones (targets, join, pages, filter,
// recipes, read, handoff, capabilities); the app's pipe, the native window helper, the host's admin channel and
// codesign are strict fakes. Nothing launches an app, shows a window or reads the owner's files.
const runtime = await import('../plugins/sleight/lib/direct-browser/electron-runtime.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const session = 'sessiona', turn = 'turn1';
const pid = 4100, birth = '1700000000.000001';
const dir = mkdtempSync(join(tmpdir(), 'sleight-epv3-7b-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const recipeRow = (extra = {}) => ({ build: 'invalid.fixture.app@1.2.3', name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456',
  runtime: 'electron/39.0.0', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', sha256: 'a'.repeat(64), cdhash: 'c'.repeat(40),
  args: ['--user-data-dir={profile}/user-data', '{profile}/workspace'], schemes: ['app'], fileRoots: [], joinTolerance: 2, focusEmulation: false,
  zoomLevel: 0, qualified: false, ...extra });
let files = 0;
const registryFile = (...recipes) => { const path = join(dir, `recipes${++files}.json`); writeFileSync(path, JSON.stringify({ version: 1, recipes })); return path; };
const registry = readRecipeRegistry(registryFile(recipeRow()));
// codesign and the bundle plists, as deriveAppInstance's inspect seam would see the fixture bundle.
const inspect = bundle => ({ verified: true, codesign: { executable: bundle + '/Contents/MacOS/Fixture', identifier: 'invalid.fixture.app', cdhash: 'c'.repeat(40), team: 'TEAM123456' },
  electron: { CFBundleVersion: '39.0.0' }, info: { CFBundleIdentifier: 'invalid.fixture.app', CFBundleName: 'Fixture App', CFBundleShortVersionString: '1.2.3' } });
const profile = Object.freeze({ path: '/private/tmp/sleight-epv3-7b/invalid.fixture.app', temporary: true });
const unlaunched = () => instanceFromRecipe(recipeFor(registry, 'invalid.fixture.app'), { profile: profile.path, temporary: true, inspect });
const launched = (p = pid, b = birth) => instanceFromRecipe(recipeFor(registry, 'invalid.fixture.app'), { profile: profile.path, temporary: true, pid: p, pidBirth: b, inspect });

// A window helper reply in electron-windows.js's schema, for the real window reader.
const helper = (windows, { processStart = birth } = {}) => async request => {
  assert.deepEqual(request, { pid, pidBirth: birth }, 'the reader asks about the exact process only');
  return JSON.stringify({ status: 'ok', observedAt: Date.now(), processStart, windows: windows.map(row => ({ id: row.id, pid, frame: row.frame, scale: 2, onScreen: true, minimized: false, modal: false, ...row.extra })) });
};

function consentFixture({ engine = () => 'approved' } = {}) {
  const events = new WeakSet(), presented = [];
  const ui = { authenticate: event => events.delete(event), present(id, data, choices, deliver) { presented.push({ id, data, choices, deliver }); }, revoke() {} };
  const consent = createElectronConsent({ ui, store: createGrantStore(), engineApproval: engine });
  const click = (index, choice) => { const event = { id: presented[index].id, choice }; events.add(event); presented[index].deliver(event); };
  return { consent, presented, click, ui };
}

/** The host as the admin client shows it, over an in-memory model. Every op is recorded; quit is never allowed. */
function fakeAdmin({ state = 'none', ownership = 'free', workers } = {}) {
  const calls = [];
  const admin = { calls, state, ownership, workers,
    async status() { calls.push('status'); return { ownership: { state: admin.ownership }, ...(admin.workers ? { workers: admin.workers } : {}), ...(admin.state === 'none' ? {} : { broker: { state: admin.state, epoch: 1, instance: 'i', identity: { pid, birth } } }) }; },
    async start(spec) { calls.push(['start', spec]); admin.state = 'ready'; admin.ownership = 'owned'; return { phase: 'verified' }; },
    async issue(args) { calls.push(['issue', args]); return { handle: 'h' + calls.length }; },
    async revoke(args) { calls.push(['revoke', args]); },
    async resume() { calls.push('resume'); admin.state = 'ready'; return {}; },
    async quit() { throw Error('the worker never quits the app'); },
    async close() { calls.push('close'); },
  };
  return admin;
}

/** The worker's side of the host channel over the fake app pipe, with the host's fence op. */
function fakeProvider(upstream, { fence = { held: true, holder: session, leaseMs: 30000 }, verify = () => true } = {}) {
  const events = [];
  const provider = { events, fenceCalls: [],
    session: upstream.session, identity: undefined,
    async connect() { events.push('connect'); provider.identity = Object.freeze({ host: 'h', pid, birth, epoch: 1, instance: 'i' }); return upstream.session; },
    async verifyConnection(candidate) { return candidate === upstream.session && verify(); },
    async disconnect(candidate) { events.push('disconnect'); return candidate === upstream.session; },
    async fence(action) { provider.fenceCalls.push(action); return typeof fence === 'function' ? fence(action) : fence; },
    createFilter({ app }) {
      const filter = createCDPFilter({ session: upstream.session, app });
      return Object.freeze({ ...filter,
        async connectPlaywright(playwright) {
          assert.equal(playwright, 'playwright-core'); const pw = fakeBrowser(filter); await pw.browser.ready(); provider.pw = pw;
          return { ...pw.browser, async close() { events.push('browser-close'); } };
        },
        async dispose() { events.push('filter-dispose'); return filter.dispose(); } });
    },
  };
  return provider;
}

function world({ targets = [page('a'), page('d', 'devtools://devtools/inspector.html')], windows = [{ id: 11, frame: rect(0, 0) }], admin = fakeAdmin(),
  consent = consentFixture(), apps = ['invalid.fixture.app'], provider, qualify, receipts = new Map(), extra = {} } = {}) {
  const upstream = fakeUpstream(targets);
  provider ??= fakeProvider(upstream);
  const qualified = [];
  const dependencies = {
    instanceFromRecipe: (recipe, options) => instanceFromRecipe(recipe, { ...options, inspect }),
    createElectronConnection: async ({ handle }) => { assert.match(handle.handle, /^h\d+$/, 'the handle is the host\'s issue reply'); return provider; },
    ...(qualify ? { qualify: async options => { qualified.push(options); return qualify(options); } } : {}),
    ...extra,
  };
  const select = (extra = {}) => runtime.selectAppConnection({ bundleId: 'invalid.fixture.app', session, turn, apps, ui: consent.ui, consent: consent.consent, registry,
    admin, playwright: 'playwright-core', windows: helper(windows), profile, receipts, dependencies, ...extra });
  return { upstream, provider, admin, consent, select, qualified, receipts };
}
// The real qualification dry run presses Escape in the background; the fake page takes it.
const pressable = w => {
  const original = w.provider.createFilter;
  w.provider.createFilter = options => {
    const filter = original(options);
    return Object.freeze({ ...filter, async connectPlaywright(playwright) {
      const browser = await filter.connectPlaywright(playwright);
      w.provider.pw.context.on('page', row => { row.keyboard = { press: async key => { (w.keys ??= []).push(key); } }; row.evaluate = async () => false; });
      return browser;
    } });
  };
  return w;
};
const appMethods = upstream => upstream.calls.map(row => row.method);

test('the unlaunched form is pid 0 with birth unlaunched only, never binds a window, and its card offers no Always', () => {
  const card = unlaunched();
  assert.equal(card.pid, 0); assert.equal(card.pidBirth, 'unlaunched');
  assert.equal(validateAppInstance(card).pid, 0);
  for (const bad of [{ pid: 0, pidBirth: birth }, { pid: 4100, pidBirth: 'unlaunched' }, { pid: -1, pidBirth: 'unlaunched' }])
    assert.throws(() => validateAppInstance({ ...card, ...bad }), /INVALID_APP_INSTANCE/, JSON.stringify(bad));
  assert.throws(() => createAppBinding({ instance: card, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe: { schemes: ['app'] },
    authority: { id: 'g1', session, turn: null, current: () => true } }), /INVALID_APP_BINDING/);
  const operation = validateCardOperation('debugger', { app: card, session, turn, sequence: 1 });
  assert.deepEqual(cardChoices('debugger', operation), ['once', 'session', 'cancel']);
  assert.equal(appKey(card), appKey(launched()), 'the persistent key ignores the process');
});

test('adopt moves an unlaunched grant to the exact launched process once', async () => {
  const c = consentFixture(), pending = c.consent.requestDebugger(unlaunched(), { session, turn });
  assert.equal(c.presented[0].data.app.pid, 0, 'the card names the build before any process exists');
  c.click(0, 'session');
  const { grant } = await pending;
  assert.throws(() => c.consent.bindApp({ grant, instance: launched(), window: { id: 11, epoch: 1 }, brokerEpoch: 1, recipe: { schemes: ['app'] } }), /DEBUGGER_GRANT_REQUIRED/,
    'before adoption the grant names no process');
  for (const other of [{ ...launched(), profile: '/private/tmp/other' }, { ...launched(), version: '9.9.9' }, unlaunched()])
    assert.throws(() => c.consent.adopt(grant, other), /GRANT_ADOPT_MISMATCH/);
  assert.equal(c.consent.adopt(grant, launched()), grant);
  assert.equal(c.consent.grantFor(launched(), { session, turn: 'turn2' }), grant, 'the session grant now names the launched process');
  assert.ok(c.consent.bindApp({ grant, instance: launched(), window: { id: 11, epoch: 1 }, brokerEpoch: 1, recipe: { schemes: ['app'] } }));
  assert.throws(() => c.consent.adopt(grant, launched(4200, '1700000001.0')), /GRANT_ALREADY_ADOPTED/, 'a relaunch or PID reuse cannot take it over');
  assert.throws(() => c.consent.adopt(grant, launched()), /GRANT_ALREADY_ADOPTED/);
  const forged = Object.freeze({ current: () => true });
  assert.throws(() => c.consent.adopt(forged, launched()), /DEBUGGER_GRANT_REQUIRED/);
});

test('the host fence answers from its cached lease, renews through the host, and gives a late lease straight back', async () => {
  let clock = 0, reply = { held: true, holder: session, leaseMs: 30000 }, gate;
  const ops = [];
  const fence = runtime.createHostFence({ owner: session, now: () => clock, op: async action => { ops.push(action); if (gate) await gate; return reply; } });
  assert.equal(fence.acquire(session), false, 'nothing is held before the host says so');
  assert.equal(await fence.renew(), true); assert.equal(fence.acquire(session), true);
  assert.equal(fence.acquire('sessionb'), false);
  await fence.renew(); assert.deepEqual(ops, ['acquire'], 'a fresh lease is not asked again');
  clock = 30001; assert.equal(fence.acquire(session), false, 'a lapsed lease is not a lease');
  reply = { held: false, holder: 'sessionb', leaseMs: 30000 };
  assert.equal(await fence.renew(), false); assert.equal(fence.acquire(session), false);
  reply = { held: true, holder: session, leaseMs: 30000 };
  let open; gate = new Promise(resolve => { open = resolve; });
  const late = fence.renew(true); await tick();
  fence.release(session); open(); assert.equal(await late, false); await tick();
  assert.deepEqual(ops.slice(-2), ['acquire', 'release'], 'released while the acquire was in flight');
  assert.equal(fence.acquire(session), false);
  assert.throws(() => runtime.createHostFence({ owner: session }), /ELECTRON_FENCE_UNAVAILABLE/);
});

test('an unlaunched app: one card, one launch, the grant adopted, and only the joined app page listed', async () => {
  assert.equal(typeof runtime.selectAppConnection, 'function', 'EPV3-7b must provide selectAppConnection');
  const w = world({ qualify: () => ({ qualified: true }) });
  const selecting = w.select(); await tick(); await tick();
  assert.equal(w.consent.presented.length, 1); assert.equal(w.consent.presented[0].data.app.pid, 0);
  assert.deepEqual(w.admin.calls, ['status'], 'nothing launches before the click');
  w.consent.click(0, 'session');
  const connection = await selecting;
  assert.deepEqual(w.admin.calls.filter(row => row[0] === 'start'), [['start', { build: 'invalid.fixture.app@1.2.3' }]]);
  assert.equal(connection.instance.pid, pid); assert.equal(connection.grant.current(), true);
  assert.equal(w.consent.consent.grantFor(launched(), { session, turn }), connection.grant);
  const rows = await connection.pages.list();
  assert.deepEqual(rows.map(row => [row.targetId, row.status, row.window.id]), [['a', 'joined', 11]], 'the DevTools target is never listed');
  assert.ok(!w.upstream.attaches().includes('d'), 'and never attached');
  assert.deepEqual(w.provider.fenceCalls, ['acquire']);
  assert.equal(connection.fence.acquire(session), true);
  assert.deepEqual(await runtime.releaseAppConnection(connection), []);
  assert.deepEqual(w.provider.events, ['connect', 'filter-dispose', 'browser-close', 'disconnect']);
  for (const method of ['Target.closeTarget', 'Page.close', 'Browser.close']) assert.ok(!appMethods(w.upstream).includes(method), method);
  assert.deepEqual(w.provider.pw.closes, [], 'no app page closed');
  assert.ok(!w.admin.calls.some(row => row === 'quit' || row[0] === 'quit'));
});

test('a running app reuses its session grant without a card or a launch; a parked one resumes for the same process', async () => {
  const consent = consentFixture(), admin = fakeAdmin({ state: 'ready', ownership: 'owned' });
  const first = world({ admin, consent, qualify: () => ({ qualified: true }) }), choosing = first.select(); await tick(); await tick();
  assert.equal(consent.presented[0].data.app.pid, pid, 'a running process is named exactly');
  consent.click(0, 'session'); await runtime.releaseAppConnection(await choosing);
  admin.state = 'parked';
  const second = world({ admin, consent, qualify: () => ({ qualified: true }) });
  const connection = await second.select({ turn: 'turn2' });
  assert.equal(consent.presented.length, 1, 'no second card'); assert.ok(admin.calls.includes('resume'));
  assert.ok(!admin.calls.some(row => row[0] === 'start'), 'never a second launch');
  await runtime.releaseAppConnection(connection);
});

test('unresolved ownership, a declined card and a missing engine approval refuse before any launch or ticket', async () => {
  const unresolved = world({ admin: fakeAdmin({ ownership: 'unresolved' }) });
  await assert.rejects(unresolved.select(), /ELECTRON_OWNERSHIP_UNRESOLVED/);
  assert.equal(unresolved.consent.presented.length, 0, 'a launch that would be refused shows no card');
  assert.ok(!unresolved.admin.calls.some(row => row[0] === 'start' || row[0] === 'issue'));
  const declined = world(), asking = declined.select(); await tick(); await tick(); declined.consent.click(0, 'cancel');
  await assert.rejects(asking, /ELECTRON_DEBUGGER_REQUIRED/);
  assert.deepEqual(declined.admin.calls, ['status']);
  const unapproved = world({ apps: ['invalid.other.app'] });
  await assert.rejects(unapproved.select(), /ELECTRON_ENGINE_APPROVAL_REQUIRED/);
  assert.deepEqual(unapproved.admin.calls, []); assert.equal(unapproved.consent.presented.length, 0);
});

test('an unqualified dry run releases everything it opened and never quits; a current receipt skips the next dry run', async () => {
  const read = { snapshot: async () => ({ text: '- editor', number: 1 }) };
  const w = pressable(world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned' }), extra: read }));
  w.consent.consent.requestDebugger(launched(), { session, turn }); w.consent.click(0, 'session'); await tick();
  const failing = world({ admin: w.admin, consent: w.consent, targets: [page('a')], windows: [] });
  await assert.rejects(failing.select(), /ELECTRON_UNQUALIFIED/, 'the real qualify finds no joined window');
  assert.deepEqual(failing.provider.events, ['connect', 'filter-dispose', 'browser-close', 'disconnect']);
  assert.equal(failing.receipts.get('invalid.fixture.app').failed, 'ELECTRON_QUALIFY_NO_JOIN');
  const connection = await w.select();
  assert.equal(connection.receipt.qualified, true); assert.deepEqual(w.keys, ['Escape'], 'the dry run pressed Escape in the background once');
  await runtime.releaseAppConnection(connection);
  const again = world({ admin: w.admin, consent: w.consent, receipts: w.receipts, qualify: () => assert.fail('a current receipt skips the dry run') });
  await runtime.releaseAppConnection(await again.select());
  assert.ok(!w.admin.calls.some(row => row[0] === 'quit'));
});

test('revoking the grant revokes this session at the host; a missing fence op refuses after releasing the channel', async () => {
  const w = world({ qualify: () => ({ qualified: true }) }), selecting = w.select(); await tick(); await tick(); w.consent.click(0, 'once');
  const connection = await selecting;
  w.consent.consent.endTurn(session, turn); await tick();
  assert.deepEqual(w.admin.calls.filter(row => row[0] === 'revoke'), [['revoke', { session }]]);
  assert.equal(connection.fence.acquire(session), true, 'the registry still answers; its next mutation fails the grant');
  await runtime.releaseAppConnection(connection);
  const upstream = fakeUpstream([page('a')]), provider = fakeProvider(upstream); delete provider.fence;
  const bare = world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned' }), provider }), asking = bare.select(); await tick(); await tick(); bare.consent.click(0, 'session');
  await assert.rejects(asking, /ELECTRON_FENCE_UNAVAILABLE/);
  assert.deepEqual(provider.events, ['connect', 'disconnect']);
});

test('one v3 context per native window, bound to the grant, the process and the window, disposed together', async () => {
  const w = world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned' }), qualify: () => ({ qualified: true }) }), asking = w.select(); await tick(); await tick();
  w.consent.click(0, 'session');
  const connection = await asking;
  const binding = createV3TurnBinding({ source: 'user', session, turn, id: turn, text: 'edit the file' }, () => true);
  const contexts = runtime.createAppContexts({ binding, consent: w.consent.consent, grant: connection.grant, instance: connection.instance, recipe: connection.recipe,
    provider: connection.provider, targets: connection.targets, ui: undefined });
  const [row] = await connection.pages.list(), entry = connection.pages.tab(row.tab);
  const ctx = contexts(entry);
  assert.ok(isV3Context(ctx)); assert.equal(contexts(entry), ctx, 'cached per window');
  assert.notEqual(contexts({ ...entry, window: { id: 11, epoch: 2 } }), ctx, 'a new window epoch is a new context');
  assert.deepEqual(await contexts.dispose(), { retained: 0 });
  assert.throws(() => contexts(entry), /TRUSTED_TURN_REQUIRED/);
  connection.grant.onRevoke(() => {}); w.consent.consent.revokeSession(session);
  const late = runtime.createAppContexts({ binding, consent: w.consent.consent, grant: connection.grant, instance: connection.instance, recipe: connection.recipe,
    provider: connection.provider, targets: connection.targets });
  assert.throws(() => late(entry), /DEBUGGER_GRANT_REQUIRED/, 'a revoked grant binds nothing');
  await runtime.releaseAppConnection(connection);
});

test('the app turn lists labeled windows, reads with the trusted header, and routes by tab through the real read and handoff', async () => {
  const w = world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned' }), qualify: () => ({ qualified: true }) }), asking = w.select(); await tick(); await tick();
  w.consent.click(0, 'session');
  const connection = await asking;
  const binding = createV3TurnBinding({ source: 'user', session, turn, id: turn, text: 'read the editor' }, () => true);
  const reads = [];
  const surface = await runtime.createAppTurn({ connections: [connection], binding, consent: w.consent.consent, ui: undefined,
    dependencies: { snapshot: async (p, options) => { reads.push(options.maxChars); return { text: '- editor [ref=e1]', number: reads.length }; } } });
  w.provider.pw.pages[0].url = () => 'app://main/index.html';
  const dispatcher = createToolDispatcher({ browser: 'bapp', pages: surface.pages, snapshot: surface.snapshot, runSteps: surface.runSteps, fillFields: surface.fillFields,
    ctx: surface.context, endpoint: undefined, deliverSnapshot: (state, capture) => surface.acknowledgeSnapshot(capture.page, capture.number) && !!(state.snapshotNo = capture.number) });
  const list = await dispatcher.call({ name: 'browser_tabs', arguments: { do: 'list' } });
  assert.match(list.text, /^t[0-9a-f]{32} Fixture App window 11$/, 'the label replaces the opaque app origin');
  const tab = list.text.split(' ')[0];
  const read = await dispatcher.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(read.isError, false);
  assert.match(read.text, /^# Fixture App 1\.2\.3 \(pid 4100\) window 11 epoch 1, join 1 joined\n# Document: app:\/\/main \(app document\)\n- editor \[ref=e1\]$/);
  assert.ok(reads[0] < 8000, 'the header counts inside max_chars');
  const unread = await dispatcher.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'press', key: 'Meta+Q' }] } });
  assert.match(unread.text, /ELECTRON_APP_KEY_REFUSED.*Nothing was sent/);
  const open = await dispatcher.call({ name: 'browser_open', arguments: { url: 'https://example.com/' } });
  assert.match(open.text, /ELECTRON_NATIVE_HANDOFF.*Nothing was sent/);
  assert.match((await dispatcher.call({ name: 'browser_read', arguments: { tab: 'tffff' } })).text, /unknown or released app page/);
  assert.throws(() => surface.snapshot({}, {}), /ELECTRON_PAGE_UNKNOWN/);
  await dispatcher.end(); await runtime.releaseAppConnection(connection);
  assert.deepEqual(w.provider.pw.closes, []);
});

test('an app turn has no DevTools endpoint, so the endpoint read guard is a no-op', async () => {
  const touched = [];
  const page = new Proxy({}, { get(_target, key) { touched.push(key); throw Error('the guard must not read the page'); } });
  await assertEndpointRead(page, undefined);
  assert.deepEqual(touched, []);
});

test('a real host: worker loss parks this session, the app pipe stays open, and the next turn resumes without a launch', async () => {
  const h = await makeHost();
  try {
    const consent = consentFixture();
    const admin = { calls: [], status: async () => h.host.status(), start: spec => h.host.start(spec), issue: args => h.host.issueTicket(args),
      revoke: async ({ session: name }) => { admin.calls.push(['revoke', name]); h.host.revokeSession(name); }, resume: () => h.host.resume(),
      quit: async () => assert.fail('the worker never quits the app') };
    const playwright = { chromium: { async connectOverCDP(transport) { assert.equal(typeof transport.send, 'function'); return { contexts: () => [], async close() {} }; } } };
    const real = { instanceFromRecipe: (recipe, options) => instanceFromRecipe(recipe, { ...options, inspect }), createElectronConnection,
      qualify: async () => ({ qualified: true }) };
    const select = turnId => runtime.selectAppConnection({ bundleId: 'invalid.fixture.app', session, turn: turnId, apps: ['invalid.fixture.app'], consent: consent.consent,
      registry, admin, playwright, windows: async () => JSON.stringify({ status: 'ok', observedAt: Date.now(), processStart: 'birth-1', windows: [] }), profile, dependencies: real });
    const asking = select('turn1'); await new Promise(resolve => setTimeout(resolve, 50)); consent.click(0, 'session');
    const connection = await asking;
    assert.equal(h.world.apps.length, 1, 'one launch, through the admin start');
    assert.equal(connection.fence.acquire(session), true, "the host's own fence op granted the lease");
    // The worker process is lost: it releases what it can and the session is revoked at the host.
    await runtime.releaseAppConnection(connection); await admin.revoke({ session });
    assert.equal(h.host.broker.state, 'parked'); assert.equal(h.app.input.destroyed, false, 'the app pipe stays open');
    const next = await select('turn2');
    assert.equal(h.host.broker.state, 'ready'); assert.equal(h.world.apps.length, 1, 'never a second launch');
    assert.equal(consent.presented.length, 1);
    await runtime.releaseAppConnection(next);
    const methods = h.app.frames.map(frame => frame.method);
    for (const method of ['Target.closeTarget', 'Page.close', 'Browser.close']) assert.ok(!methods.includes(method), method);
  } finally { h.host._crashForTest(); h.state.remove(); }
});

// Lines other lanes' files need for this path to run end to end (epv3-contracts.md: a failing expectation per missing line).
test('electron-connection exposes the host fence op to the worker (provider.fence)', async () => {
  const h = await makeHost();
  try {
    await h.host.start({ build: 'fake-build' });
    const provider = await createElectronConnection({ handle: await h.host.issueTicket({ session }) });
    await provider.connect();
    assert.equal(typeof provider.fence, 'function');
    const fence = runtime.createHostFence({ owner: session, op: action => provider.fence(action) });
    assert.equal(await fence.renew(), true);
    assert.equal(fence.acquire(session), true);
    fence.release(session);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await provider.fence('acquire'), { held: true, holder: session, leaseMs: 30000 }, 'released, so free to take again');
    await provider.disconnect();
  } finally { h.host._crashForTest(); h.state.remove(); }
});

// F2: the admin secret comes from the MCP server through the worker; a host started by an earlier server stays foreign.
test('connectAppHost hands the server\'s secret to ensureHost and names the app when the host is foreign', async () => {
  const path = registryFile(recipeRow()), asked = [];
  const deps = (ensureHost) => ({ registryPath: path, ensureHost, instanceFromRecipe: (recipe, options) => instanceFromRecipe(recipe, { ...options, inspect }),
    config: { tempRoot: '/private/tmp/sleight-epv3-f2', hostStateDir: key => '/private/tmp/sleight-epv3-f2/hosts/' + key } });
  const secret = 'S'.repeat(43);
  const host = await runtime.connectAppHost({ bundleId: 'invalid.fixture.app', secret,
    dependencies: deps(async options => { asked.push(options); return { pid: 77 }; }) });
  assert.equal(asked[0].secret, secret);
  assert.equal(asked[0].registryPath, path);
  assert.equal(host.admin.pid, 77);
  assert.deepEqual(host.profile, { path: '/private/tmp/sleight-epv3-f2/invalid.fixture.app', temporary: true });
  await assert.rejects(runtime.connectAppHost({ bundleId: 'invalid.fixture.app', secret,
    dependencies: deps(async () => { throw Error('ELECTRON_HOST_FOREIGN'); }) }), error => error.message === 'ELECTRON_HOST_FOREIGN' && error.appName === 'Fixture App');
});

// H4: a second session refuses busy from the host's status, before sleight's card asks the user anything.
test('another session connected at the host refuses ELECTRON_BUSY before any card, launch or ticket', async () => {
  const busy = world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned', workers: ['sessionb'] }) });
  await assert.rejects(busy.select(), /ELECTRON_BUSY: another session is acting in this app; nothing was sent/);
  assert.equal(busy.consent.presented.length, 0, 'no card');
  assert.deepEqual(busy.admin.calls, ['status']);
  const mine = world({ admin: fakeAdmin({ state: 'ready', ownership: 'owned', workers: [session] }), qualify: () => ({ qualified: true }) });
  const selecting = mine.select(); await tick(); await tick();
  assert.equal(mine.consent.presented.length, 1, 'this session\'s own channel is not busy');
  mine.consent.click(0, 'session');
  await runtime.releaseAppConnection(await selecting);
});
