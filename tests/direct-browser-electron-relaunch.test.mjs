import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { createElectronConsent, createGrantStore } from '../plugins/sleight/lib/direct-browser/electron-consent.mjs';
import { readRecipeRegistry, recipeFor, instanceFromRecipe } from '../plugins/sleight/lib/direct-browser/electron-recipes.mjs';
import { connectAdmin } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { hostDependencies } from '../plugins/sleight/lib/direct-browser/electron-host-run.mjs';
import { page, rect, fakeUpstream, fakeBrowser, tick } from './fixtures/electron-graph.mjs';
import { makeHost } from './direct-browser-electron-host-fixture.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// 1.3.1's relaunch flow (LAWS decision F3): turbo in an opted-in Electron app on the user's own app and profile. The
// app's own Quit, the native card, the host and the process table are strict fakes. Nothing launches, quits or shows.
const runtime = await import('../plugins/sleight/lib/direct-browser/electron-runtime.mjs');
const relaunch = await import('../plugins/sleight/lib/direct-browser/electron-relaunch.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const recipes = await import('../plugins/sleight/lib/direct-browser/electron-recipes.mjs');
const session = 'sessiona', turn = 'turn1', uid = 501;
const pid = 4100, birth = '1700000000.000001';             // the process sleight launches
const mine = { pid: 3000, birth: '1690000000.000002' };     // the user's own copy, running without the pipe
const EXE = '/Applications/Fixture.app/Contents/MacOS/Fixture';
const home = '/private/tmp/sleight-rf1-home';
const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rf1-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const row = (extra = {}) => ({ build: 'invalid.fixture.app@1.2.3', name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456',
  runtime: 'electron/39.0.0', executable: EXE, sha256: 'a'.repeat(64), cdhash: 'c'.repeat(40),
  args: ['--user-data-dir={profile}/user-data', '{profile}/workspace'], schemes: ['app'], fileRoots: [], joinTolerance: 2, focusEmulation: false,
  zoomLevel: 0, qualified: false, userProfile: { supportDir: 'Fixture', args: [] }, ...extra });
let files = 0;
const registryFile = (...list) => { const path = join(dir, `recipes${++files}.json`); writeFileSync(path, JSON.stringify({ version: 1, recipes: list })); return path; };
const registry = readRecipeRegistry(registryFile(row()));
const recipe = () => recipeFor(registry, 'invalid.fixture.app');
const inspect = bundle => ({ verified: true, codesign: { executable: bundle + '/Contents/MacOS/Fixture', identifier: 'invalid.fixture.app', cdhash: 'c'.repeat(40), team: 'TEAM123456' },
  electron: { CFBundleVersion: '39.0.0' }, info: { CFBundleIdentifier: 'invalid.fixture.app', CFBundleName: 'Fixture App', CFBundleShortVersionString: '1.2.3' } });
const profilePath = home + '/Library/Application Support/Fixture';
const userProfile = Object.freeze({ path: profilePath, temporary: false });
const instance = (p = 0, b = 'unlaunched', profile = userProfile) => instanceFromRecipe(recipe(), { profile: profile.path, temporary: profile.temporary, pid: p, pidBirth: b, inspect });

function consentFixture({ engine = () => 'approved' } = {}) {
  const events = new WeakSet(), presented = [];
  const ui = { authenticate: event => events.delete(event), present(id, data, choices, deliver) { presented.push({ id, data, choices, deliver }); }, revoke() {} };
  const consent = createElectronConsent({ ui, store: createGrantStore(), engineApproval: engine });
  const click = (index, choice) => { const event = { id: presented[index].id, choice }; events.add(event); presented[index].deliver(event); };
  return { consent, presented, click, ui };
}

/** The host as the admin client shows it. start can fail; quit is never allowed (the worker never quits through the host). */
function fakeAdmin({ state = 'none', ownership = 'free', start } = {}) {
  const calls = [];
  const admin = { calls, state, ownership, parked: undefined,
    async status() { calls.push('status'); return { ownership: { state: admin.ownership }, ...(admin.state === 'none' ? {} : { broker: { state: admin.state, epoch: 1, instance: 'i',
      identity: { pid, birth }, ...(admin.parked ? { parked: { reason: admin.parked, resumable: false } } : {}) } }) }; },
    async start(spec) { calls.push(['start', spec]); if (start) return start(admin); admin.state = 'ready'; admin.ownership = 'owned'; return { phase: 'verified' }; },
    async issue(args) { calls.push(['issue', args]); return { handle: 'h' + calls.length }; },
    async revoke(args) { calls.push(['revoke', args]); },
    async resume() { calls.push('resume'); admin.state = 'ready'; return {}; },
    async collect() { calls.push('collect'); admin.state = 'collected'; admin.ownership = 'free'; admin.parked = undefined; return { cleanup: 'removed' }; },
    async quit() { throw Error('the worker never quits the app through the host'); },
  };
  return admin;
}

/** The user's process table and the app's own Quit, as the JXA helper reports them. No activate, no signal: there is no such method. */
function fakeProcesses({ apps = [{ ...mine, uid, executable: EXE }], quit = 'exited', fronts = [90, 90], args = () => EXE } = {}) {
  const p = { calls: [], apps,
    async args(pidValue) { p.calls.push(['args', pidValue]); return args(pidValue); },
    async list(bundleId) { p.calls.push(['list', bundleId]); return p.apps.map(item => ({ ...item })); },
    async quit(target, options) {
      p.calls.push(['quit', target, options]);
      if (typeof quit === 'function') return { outcome: quit(p), ms: 12 };
      if (quit === 'exited') p.apps = [];
      const outcome = quit;
      return { outcome, ms: 12 };
    },
    async front() { p.calls.push(['front']); return fronts.shift() ?? null; },
  };
  return p;
}

function fakeProvider(upstream) {
  const provider = { events: [], session: upstream.session, identity: undefined,
    async connect() { provider.events.push('connect'); provider.identity = Object.freeze({ host: 'h', pid, birth, epoch: 1, instance: 'i' }); return upstream.session; },
    async verifyConnection(candidate) { return candidate === upstream.session; },
    async disconnect(candidate) { provider.events.push('disconnect'); return candidate === upstream.session; },
    async fence() { return { held: true, holder: session, leaseMs: 30000 }; },
    createFilter({ app }) {
      const filter = createCDPFilter({ session: upstream.session, app });
      return Object.freeze({ ...filter,
        async connectPlaywright() { const pw = fakeBrowser(filter); await pw.browser.ready(); provider.pw = pw; return { ...pw.browser, async close() {} }; },
        async dispose() { return filter.dispose(); } });
    },
  };
  return provider;
}

// The window helper: the launched process's windows, which an app restores a few reads after it starts.
const helper = ({ after = 0 } = {}) => { let reads = 0; return async request => {
  assert.deepEqual(request, { pid, pidBirth: birth }, 'windows are read for the launched process only');
  const windows = ++reads > after ? [{ id: 11, pid, frame: rect(0, 0), scale: 2, onScreen: true, minimized: false, modal: false }] : [];
  return JSON.stringify({ status: 'ok', observedAt: Date.now(), processStart: birth, windows });
}; };

function world({ processes = fakeProcesses(), admin = fakeAdmin(), consent = consentFixture(), profile = userProfile, memory = { declined: new Set() }, windows = helper(), extra = {} } = {}) {
  const upstream = fakeUpstream([page('a')]), provider = fakeProvider(upstream);
  const dependencies = { instanceFromRecipe: (r, options) => instanceFromRecipe(r, { ...options, inspect }), createElectronConnection: async () => provider,
    qualify: async () => ({ qualified: true }), processes, uid, ...extra };
  const select = (more = {}) => runtime.selectAppConnection({ bundleId: 'invalid.fixture.app', session, turn, apps: ['invalid.fixture.app'], ui: consent.ui, consent: consent.consent,
    registry, admin, playwright: 'playwright-core', windows, profile, receipts: new Map(), memory, quitWaitMs: 4000, restoreWaitMs: 2000, dependencies, ...more });
  return { processes, admin, consent, provider, upstream, select, memory };
}
// Answers the cards in order as they appear: each entry is a choice, or undefined to leave that card unanswered.
async function answer(w, choices) {
  for (let index = 0; index < choices.length; index++) {
    for (let i = 0; i < 200 && w.consent.presented.length <= index; i++) await tick();
    if (choices[index] !== undefined && w.consent.presented[index]) w.consent.click(index, choices[index]);
  }
}
const starts = w => w.admin.calls.filter(call => call[0] === 'start');
const quits = w => w.processes.calls.filter(call => call[0] === 'quit');
const refusal = (code, pattern) => error => { assert.equal(error.message, code); assert.match(error.notice, new RegExp('^' + code + ': ')); if (pattern) assert.match(error.notice, pattern); return true; };

test('a recipe may name the user\'s own profile: its folder under Application Support and launch arguments with no profile switch', () => {
  assert.deepEqual(recipe().userProfile, { supportDir: 'Fixture', args: [] });
  assert.deepEqual(recipes.userProfileFor(recipe(), home), { path: profilePath, temporary: false });
  assert.deepEqual(recipeFor(readRecipeRegistry(registryFile(row({ userProfile: { supportDir: 'Fixture', args: [], switches: ['--profile'] } }))), 'invalid.fixture.app')
    .userProfile.switches, ['--profile'], 'a recipe may name the app\'s own profile switches');
  const bare = { ...row() }; delete bare.userProfile;
  const without = recipeFor(readRecipeRegistry(registryFile(bare)), 'invalid.fixture.app');
  assert.throws(() => recipes.userProfileFor(without, home), /ELECTRON_USER_PROFILE_UNSUPPORTED/);
  for (const [userProfile, reason] of [[{ supportDir: 'Fixture' }, 'userProfile'], [{ supportDir: '../Code', args: [] }, 'userProfile'], [{ supportDir: 'a/b', args: [] }, 'userProfile'],
    [{ supportDir: 'Fixture', args: ['--user-data-dir=/tmp/x'] }, 'userProfile'], [{ supportDir: 'Fixture', args: ['{profile}/x'] }, 'userProfile'],
    [{ supportDir: 'Fixture', args: ['--remote-debugging-port=9222'] }, 'userProfile'], [{ supportDir: 'Fixture', args: [], extra: 1 }, 'userProfile'], ['Fixture', 'userProfile'],
    [{ supportDir: 'Fixture', args: [], switches: ['profile'] }, 'userProfile'], [{ supportDir: 'Fixture', args: [], switches: [] }, 'userProfile']]) {
    assert.throws(() => readRecipeRegistry(registryFile(row({ userProfile }))), error => error.message === 'INVALID_RECIPE_REGISTRY' && error.reason === reason, JSON.stringify(userProfile));
  }
});

test('happy path: the debugger card, then the relaunch card naming the running process, then the app\'s own Quit and one launch on the user\'s profile', async () => {
  const w = world();
  const selecting = w.select();
  await answer(w, ['session']);
  assert.equal(w.consent.presented[0].data.kind, 'debugger');
  assert.equal(w.consent.presented[0].data.app.pid, 0);
  assert.equal(w.consent.presented[0].data.app.temporary, false);
  assert.deepEqual(w.consent.presented[0].choices, ['once', 'session', 'always', 'cancel'], 'the user\'s own profile offers Always');
  for (let i = 0; i < 200 && w.consent.presented.length < 2; i++) await tick();
  assert.equal(w.consent.presented[1].data.kind, 'relaunch');
  assert.equal(w.consent.presented[1].data.app.pid, mine.pid, 'the relaunch card names the exact running process');
  assert.deepEqual(w.consent.presented[1].choices, ['relaunch', 'cancel']);
  assert.deepEqual(quits(w), [], 'nothing quits before the click'); assert.deepEqual(starts(w), []);
  w.consent.click(1, 'relaunch');
  const connection = await selecting;
  assert.deepEqual(quits(w), [['quit', { pid: mine.pid, birth: mine.birth, executable: EXE }, { waitMs: 4000 }]]);
  assert.deepEqual(starts(w), [['start', { build: 'invalid.fixture.app@1.2.3', profile: 'user' }]]);
  assert.equal(connection.instance.pid, pid); assert.equal(connection.instance.profile, profilePath); assert.equal(connection.instance.temporary, false);
  assert.equal(w.consent.consent.grantFor(instance(pid, birth), { session, turn }), connection.grant, 'the grant moved to the reopened process');
  assert.equal(connection.relaunch.activated, false); assert.equal(connection.relaunch.wasFront, false);
  assert.ok(Number.isFinite(connection.relaunch.quitMs) && Number.isFinite(connection.relaunch.launchMs));
  assert.deepEqual((await connection.pages.list()).map(item => [item.targetId, item.status]), [['a', 'joined']]);
  assert.ok(!w.admin.calls.some(call => call === 'quit' || call[0] === 'quit'));
  await runtime.releaseAppConnection(connection);
});

test('macOS activating the reopened app is recorded and never fought: no activation, focus or window call follows', async () => {
  const w = world({ processes: fakeProcesses({ fronts: [90, pid] }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  const connection = await selecting;
  assert.equal(connection.relaunch.activated, true);
  assert.deepEqual(w.processes.calls.map(call => call[0]), ['list', 'args', 'list', 'front', 'quit', 'list', 'front']);
  await runtime.releaseAppConnection(connection);
});

test('windows the app restores late are waited for before the dry run, up to restoreWaitMs', async () => {
  const seen = [];
  const w = world({ windows: helper({ after: 2 }), extra: {
    qualify: async ({ pages }) => { const rows = await pages.list(); seen.push(rows.length); return { qualified: rows.some(item => item.status === 'joined') }; } } });
  const selecting = w.select();
  await answer(w, ['session', 'relaunch']);
  const connection = await selecting;
  assert.deepEqual(seen, [1], 'the dry run saw the restored window');
  await runtime.releaseAppConnection(connection);
});

test('Cancel on the relaunch card keeps the native path: nothing quits or launches, and this session is not asked again', async () => {
  const w = world();
  const selecting = w.select(); await answer(w, ['session', 'cancel']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_DECLINED', /Fixture App.*nothing was quit.*native path/i));
  assert.deepEqual(quits(w), []); assert.deepEqual(starts(w), []);
  const cards = w.consent.presented.length;
  await assert.rejects(w.select({ turn: 'turn2' }), refusal('ELECTRON_RELAUNCH_DECLINED'));
  assert.equal(w.consent.presented.length, cards, 'no second card this session');
});

test('an unanswered relaunch card quits nothing and is not remembered as a decline', async () => {
  // The card's own timer expires it (120 s); the consent channel then answers 'expired', as here.
  const w = world();
  const consent = Object.create(w.consent.consent, { requestRelaunch: { value: async () => Object.freeze({ status: 'expired' }) } });
  const selecting = w.select({ consent }); await answer(w, ['session']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_UNANSWERED', /nothing was quit/i));
  assert.deepEqual(quits(w), []); assert.equal(w.memory.declined.size, 0);
});

test('a declined debugger card shows no relaunch card and quits nothing', async () => {
  const w = world();
  const selecting = w.select(); await answer(w, ['cancel']);
  await assert.rejects(selecting, /ELECTRON_DEBUGGER_REQUIRED/);
  await tick(); assert.equal(w.consent.presented.length, 1); assert.deepEqual(quits(w), []); assert.deepEqual(starts(w), []);
});

test('an app that refuses to quit stays open and the turn falls back to the native path', async () => {
  const w = world({ processes: fakeProcesses({ quit: 'refused' }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_QUIT_REFUSED', /still open/));
  assert.deepEqual(starts(w), []);
});

test('unsaved work: while the app\'s own prompt waits for the user past quitWaitMs, sleight answers nothing and never reopens it', async () => {
  const w = world({ processes: fakeProcesses({ quit: 'running' }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_QUIT_PENDING', /unsaved work.*did not reopen/));
  assert.equal(quits(w).length, 1, 'one Quit request, no second one and no force');
  assert.deepEqual(starts(w), []);
});

test('a process that changed after the click is never quit, and a PID the helper finds changed at Quit time is refused', async () => {
  const p = fakeProcesses();
  const w = world({ processes: p });
  const selecting = w.select(); await answer(w, ['session']);
  for (let i = 0; i < 200 && w.consent.presented.length < 2; i++) await tick();
  p.apps = [{ pid: mine.pid, birth: 'recycled', uid, executable: EXE }];
  w.consent.click(1, 'relaunch');
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_CHANGED', /quit nothing/));
  assert.deepEqual(quits(w), []);
  const late = world({ processes: fakeProcesses({ quit: 'mismatch' }) });
  const again = late.select(); await answer(late, ['session', 'relaunch']);
  await assert.rejects(again, refusal('ELECTRON_RELAUNCH_CHANGED'));
  assert.deepEqual(starts(late), []);
});

test('an app reopened by someone else before sleight\'s launch is left alone', async () => {
  const w = world({ processes: fakeProcesses({ quit: p => { p.apps = [{ pid: 3100, birth: 'b-3100', uid, executable: EXE }]; return 'exited'; } }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_RACED', /running without the debugger/));
  assert.deepEqual(starts(w), []);
});

test('a relaunch that fails leaves the app closed: the result says so, and sleight\'s own launch record is collected', async () => {
  const w = world({ admin: fakeAdmin({ start: admin => { admin.state = 'retained'; admin.ownership = 'unresolved'; throw Error('APP_PARKED'); } }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_FAILED', /quit but did not reopen.*open it again/));
  assert.ok(w.admin.calls.includes('collect'));
});

test('an app that comes back without the pipe keeps running for the user and the turn takes the native path', async () => {
  const p = fakeProcesses();
  const w = world({ processes: p, admin: fakeAdmin({ start: admin => { p.apps = [{ pid, birth, uid, executable: EXE }]; admin.state = 'retained'; admin.ownership = 'unresolved';
    throw Error('EFFECT_UNKNOWN'); } }) });
  const selecting = w.select(); await answer(w, ['session', 'relaunch']);
  await assert.rejects(selecting, refusal('ELECTRON_RELAUNCH_NO_PIPE', /reopened without the debugger/));
  assert.ok(!w.admin.calls.includes('collect'), 'a running app is never collected');
  const ready = world({ processes: fakeProcesses(), admin: fakeAdmin({ start: admin => { admin.state = 'parked'; admin.ownership = 'owned'; return { phase: 'verified' }; } }) });
  const selected = ready.select(); await answer(ready, ['session', 'relaunch']);
  await assert.rejects(selected, refusal('ELECTRON_RELAUNCH_FAILED'), 'a start whose host is not ready afterwards is a failed relaunch');
});

test('another user\'s process, two processes and another build refuse before any card', async () => {
  for (const [apps, code] of [[[{ ...mine, uid: 502, executable: EXE }], 'ELECTRON_APP_OTHER_USER'],
    [[{ ...mine, uid, executable: EXE }, { pid: 3001, birth: 'b2', uid, executable: EXE }], 'ELECTRON_RELAUNCH_AMBIGUOUS'],
    [[{ ...mine, uid, executable: '/Users/x/Applications/Fixture.app/Contents/MacOS/Fixture' }], 'ELECTRON_RELAUNCH_BUILD_CHANGED']]) {
    const w = world({ processes: fakeProcesses({ apps }) });
    await assert.rejects(w.select(), refusal(code));
    assert.equal(w.consent.presented.length, 0, code); assert.deepEqual(quits(w), []); assert.deepEqual(starts(w), []);
  }
});

test('an app that is not running opens on the user\'s profile after the debugger card alone: no relaunch card, no Quit', async () => {
  const w = world({ processes: fakeProcesses({ apps: [] }) });
  const selecting = w.select(); await answer(w, ['session']);
  const connection = await selecting;
  assert.equal(w.consent.presented.length, 1);
  assert.deepEqual(quits(w), []);
  assert.deepEqual(starts(w), [['start', { build: 'invalid.fixture.app@1.2.3', profile: 'user' }]]);
  assert.equal(connection.relaunch, undefined);
  await runtime.releaseAppConnection(connection);
});

test('a benchmark\'s temporary profile keeps the separate instance: the process table is never read and the launch names no profile', async () => {
  const temporary = Object.freeze({ path: '/private/tmp/sleight-rf1/invalid.fixture.app', temporary: true });
  const w = world({ profile: temporary });
  const selecting = w.select(); await answer(w, ['session']);
  const connection = await selecting;
  assert.deepEqual(w.processes.calls, []);
  assert.deepEqual(starts(w), [['start', { build: 'invalid.fixture.app@1.2.3' }]]);
  await runtime.releaseAppConnection(connection);
});

test('an app the user quit after a relaunch is collected at the next turn and opened again on the debugger grant', async () => {
  const admin = fakeAdmin({ state: 'parked', ownership: 'owned' }); admin.parked = 'child exited';
  const w = world({ admin, processes: fakeProcesses({ apps: [] }) });
  const selecting = w.select(); await answer(w, ['session']);
  const connection = await selecting;
  assert.deepEqual(admin.calls.filter(call => typeof call === 'string' && call !== 'status'), ['collect']);
  assert.equal(starts(w).length, 1); assert.ok(!admin.calls.includes('resume'));
  await runtime.releaseAppConnection(connection);
});

test('an Always record on the user\'s profile skips the debugger card, never the relaunch card', async () => {
  const consent = consentFixture();
  const first = world({ consent, processes: fakeProcesses({ apps: [] }) });
  const opened = first.select(); await answer(first, ['always']);
  await runtime.releaseAppConnection(await opened);
  const w = world({ consent });
  const selecting = w.select({ session: 'sessionb', turn: 'turn9' });
  for (let i = 0; i < 200 && consent.presented.length < 2; i++) await tick();
  assert.equal(consent.presented[1].data.kind, 'relaunch', 'the second card is the relaunch card, not a debugger card');
  consent.click(1, 'relaunch');
  const connection = await selecting;
  assert.equal(connection.grant.scope, 'always');
  assert.equal(consent.presented.length, 2);
  await runtime.releaseAppConnection(connection);
});

test('connectAppHost uses the user\'s own profile by default and a temporary one only when a benchmark asks', async () => {
  const path = registryFile(row()), asked = [];
  const deps = { registryPath: path, home, ensureHost: async options => { asked.push(options); return { pid: 77 }; },
    instanceFromRecipe: (r, options) => instanceFromRecipe(r, { ...options, inspect }),
    config: { tempRoot: '/private/tmp/sleight-rf1-tmp', hostStateDir: key => '/private/tmp/sleight-rf1-hosts/' + key } };
  const own = await runtime.connectAppHost({ bundleId: 'invalid.fixture.app', secret: 'S'.repeat(43), dependencies: deps });
  assert.deepEqual(own.profile, { path: profilePath, temporary: false });
  const bench = await runtime.connectAppHost({ bundleId: 'invalid.fixture.app', secret: 'S'.repeat(43), profile: 'temporary', dependencies: deps });
  assert.deepEqual(bench.profile, { path: '/private/tmp/sleight-rf1-tmp/invalid.fixture.app', temporary: true });
  assert.notEqual(asked[0].stateDir, asked[1].stateDir, 'the two profiles never share a host');
  const bare = { ...row() }; delete bare.userProfile;
  await assert.rejects(runtime.connectAppHost({ bundleId: 'invalid.fixture.app', secret: 'S'.repeat(43), dependencies: { ...deps, registryPath: registryFile(bare) } }),
    refusal('ELECTRON_USER_PROFILE_UNSUPPORTED', /native path/));
});

// ---- the host: a user-profile launch is its own launch mode, named only by the admin's start.
test('the host passes a user-profile start to the adapter as its own mode and never fills that profile', async () => {
  const secret = randomBytes(32), prepared = [];
  const h = await makeHost({ hostOptions: { adminSecret: secret, prepareProfile: async (root, spec) => { prepared.push(spec); } } });
  try {
    const admin = await connectAdmin({ stateDir: h.state.dir, secret });
    for (const args of [{ build: 'fake-build', profile: 'temporary' }, { build: 'fake-build', profile: '/Users/x' }, { build: 'other-build', profile: 'user' }])
      await assert.rejects(admin.start(args), /BUILD_NOT_REGISTERED/, JSON.stringify(args));
    assert.equal(h.world.apps.length, 0);
    const receipt = await admin.start({ build: 'fake-build', profile: 'user' });
    assert.equal(receipt.phase, 'verified');
    assert.deepEqual(h.adapter.calls.find(call => call[0] === 'reserve'), ['reserve', { build: 'fake-build', mode: 'user' }]);
    assert.deepEqual(prepared, [], 'nothing is written into the user\'s profile');
    admin.close();
  } finally { h.host._crashForTest(); h.state.remove(); }
});

test('hostDependencies launches a user profile only for a recipe that names one', async () => {
  const bare = { ...row({ build: 'invalid.bare.app@1.0.0', bundleId: 'invalid.bare.app' }) }; delete bare.userProfile;
  const reg = readRecipeRegistry(registryFile(row(), bare));
  const deps = hostDependencies({ registry: reg, builds: ['invalid.fixture.app@1.2.3', 'invalid.bare.app@1.0.0'], run: async () => 'sent' });
  assert.equal(await deps.authorizeLaunch({ build: 'invalid.fixture.app@1.2.3', profile: 'user' }), true);
  assert.equal(await deps.authorizeLaunch({ build: 'invalid.bare.app@1.0.0', profile: 'user' }), false);
  assert.equal(await deps.authorizeLaunch({ build: 'invalid.bare.app@1.0.0' }), true, 'its temporary profile still launches for a benchmark');
  assert.equal(await deps.authorizeLaunch({ build: 'invalid.fixture.app@1.2.3', profile: 'other' }), false);
});

// ---- the process helper: the app's own Quit through NSRunningApplication, exact process, never a signal.
const helperSource = () => readFileSync(new URL('../plugins/sleight/lib/direct-browser/electron-apps.js', import.meta.url), 'utf8');
test('the process helper parses, asks NSRunningApplication to terminate by property access, and never signals, forces or activates', () => {
  const source = helperSource();
  new Script(source);
  assert.match(source, /\.terminate;/, 'JXA calls a zero-argument method on property access; terminate() would throw');
  assert.doesNotMatch(source, /forceTerminate|kill\(|activateWithOptions|\.activate\b|unhide|tell application|Application\(/);
});

/** A JXA world for the helper: ObjC.import and bindFunction, NSRunningApplication, proc_pidinfo bytes, NSWorkspace and delay. */
function jxa({ apps, uid: me = 501, front = 90 }) {
  const terminated = [];
  const bytes = (pidValue, info) => {
    const b = Buffer.alloc(136);
    if (info) { b.writeUInt32LE(info.status ?? 2, 4); b.writeUInt32LE(pidValue, 12); b.writeUInt32LE(info.uid, 20);
      const [sec, usec] = info.birth.split('.').map(Number); b.writeBigUInt64LE(BigInt(sec), 120); b.writeBigUInt64LE(BigInt(usec), 128); }
    return b;
  };
  const wrap = value => ({ isNil: () => value == null, ...value });
  // A getter, as JXA's bridge invokes terminate on property access (not spread through wrap, which would call it).
  const running = item => ({ isNil: () => false, processIdentifier: item.pid, executableURL: wrap({ path: item.executable }),
    get terminate() { terminated.push(item.pid); if (item.refuse) return false; if (!item.lingers) item.gone = true; return true; } });
  const $ = Object.assign(value => value, {
    getuid: () => me,
    proc_pidinfo(p, flavor, arg, buffer) { const item = apps.find(a => a.pid === p && !a.gone); if (!item) return 0; buffer.fill(bytes(p, item)); return 136; },
    NSMutableData: { dataWithLength: n => { const b = Buffer.alloc(n); return { mutableBytes: b, base64EncodedStringWithOptions: () => b.toString('base64') }; } },
    NSRunningApplication: {
      runningApplicationsWithBundleIdentifier: id => { const list = apps.filter(a => a.bundleId === id && !a.gone).map(running); return { count: list.length, objectAtIndex: i => list[i] }; },
      runningApplicationWithProcessIdentifier: p => { const item = apps.find(a => a.pid === p && !a.gone); return item ? running(item) : wrap(null); },
    },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: wrap({ processIdentifier: front }) } },
    NSRunLoop: { currentRunLoop: { runUntilDate() {} } }, NSDate: { dateWithTimeIntervalSinceNow: () => 0 },
  });
  // ObjC.unwrap and the base64 copy behave as JXA's do for these shapes.
  const ObjC = { import() {}, bindFunction() {}, unwrap: value => value, deepUnwrap: value => value };
  let clock = 0;
  const sandbox = { $, ObjC, delay: seconds => { clock += seconds * 1000; }, Date: { now: () => clock } };
  runInNewContext(helperSource() + '\nthis.run = run;', sandbox);
  return { run: request => JSON.parse(sandbox.run([JSON.stringify(request)])), terminated };
}

test('the helper lists the bundle\'s processes with birth and uid, and quits only the exact process it was given', () => {
  const fresh = (extra = {}) => ({ bundleId: 'invalid.fixture.app', pid: 3000, birth: '1690000000.000002', uid: 501, executable: EXE, ...extra });
  const app = fresh();
  const world1 = jxa({ apps: [app] });
  assert.deepEqual(world1.run({ op: 'list', bundleId: 'invalid.fixture.app' }), { status: 'ok', apps: [{ pid: 3000, birth: '1690000000.000002', uid: 501, executable: EXE }] });
  assert.deepEqual(world1.run({ op: 'front' }), { status: 'ok', pid: 90 });
  assert.equal(world1.run({ op: 'quit', pid: 3000, birth: 'other', executable: EXE, waitMs: 1000 }).outcome, 'mismatch');
  assert.equal(world1.run({ op: 'quit', pid: 3000, birth: app.birth, executable: '/other', waitMs: 1000 }).outcome, 'mismatch');
  assert.deepEqual(world1.terminated, [], 'a mismatch is never asked to quit');
  assert.equal(world1.run({ op: 'quit', pid: 3000, birth: app.birth, executable: EXE, waitMs: 1000 }).outcome, 'exited');
  assert.deepEqual(world1.terminated, [3000]);
  assert.equal(world1.run({ op: 'quit', pid: 3000, birth: app.birth, executable: EXE, waitMs: 1000 }).outcome, 'absent');
  const other = jxa({ apps: [fresh({ uid: 502 })] });
  assert.equal(other.run({ op: 'quit', pid: 3000, birth: app.birth, executable: EXE, waitMs: 1000 }).outcome, 'mismatch', 'another user\'s process is never asked');
  const refusing = jxa({ apps: [fresh({ refuse: true })] });
  assert.equal(refusing.run({ op: 'quit', pid: 3000, birth: app.birth, executable: EXE, waitMs: 1000 }).outcome, 'refused');
  const prompting = jxa({ apps: [fresh({ lingers: true })] });
  const pending = prompting.run({ op: 'quit', pid: 3000, birth: app.birth, executable: EXE, waitMs: 1000 });
  assert.equal(pending.outcome, 'running', 'an app still asking about unsaved work at the deadline is left to the user');
  assert.deepEqual(prompting.terminated, [3000], 'asked once');
  assert.equal(jxa({ apps: [] }).run({ op: 'nope' }).status, 'error');
});

test('createAppProcesses validates the helper\'s replies and gives Quit its wait plus a margin', async () => {
  const calls = [];
  const replies = { list: { status: 'ok', apps: [{ pid: 3000, birth: 'b', uid: 501, executable: EXE }] }, quit: { status: 'ok', outcome: 'exited', ms: 40 }, front: { status: 'ok', pid: 90 } };
  const run = (file, args, options, callback) => { const request = JSON.parse(args[3]); calls.push([file, request, options.timeout]); callback(null, JSON.stringify(replies[request.op])); };
  const p = relaunch.createAppProcesses({ run, script: '/x/electron-apps.js' });
  assert.deepEqual(await p.list('invalid.fixture.app'), replies.list.apps);
  assert.deepEqual(await p.quit({ pid: 3000, birth: 'b', executable: EXE }, { waitMs: 60000 }), { outcome: 'exited', ms: 40 });
  assert.equal(await p.front(), 90);
  assert.deepEqual(calls.map(call => [call[0], call[1].op, call[2]]), [['/usr/bin/osascript', 'list', 5000], ['/usr/bin/osascript', 'quit', 70000], ['/usr/bin/osascript', 'front', 5000]]);
  for (const bad of [{ status: 'ok', apps: [{ pid: 3000, birth: 'b', uid: 501, executable: EXE, title: 'x' }] }, { status: 'ok', apps: [{ pid: '3000', birth: 'b', uid: 501, executable: EXE }] }, { status: 'error' }]) {
    replies.list = bad;
    await assert.rejects(p.list('invalid.fixture.app'), /ELECTRON_APPS_INVALID|ELECTRON_APPS_UNAVAILABLE/, JSON.stringify(bad));
  }
  replies.quit = { status: 'ok', outcome: 'forced', ms: 1 };
  await assert.rejects(p.quit({ pid: 3000, birth: 'b', executable: EXE }, { waitMs: 1000 }), /ELECTRON_APPS_INVALID/);
});

// Review F4: a copy started on a profile of its own would be reopened on the default one, so it is left alone.
test('a running copy started with a profile switch, or whose arguments cannot be read, refuses before any card', async () => {
  for (const args of [() => EXE + ' --user-data-dir=/Users/x/work', () => EXE + ' --extensions-dir /tmp/e', () => { throw Error('ELECTRON_APPS_UNAVAILABLE'); }]) {
    const w = world({ processes: fakeProcesses({ args }) });
    await assert.rejects(w.select(), refusal('ELECTRON_RELAUNCH_OTHER_PROFILE', /profile of its own/));
    assert.equal(w.consent.presented.length, 0); assert.deepEqual(quits(w), []);
  }
  // The recipe's own switch counts too; a token that only starts with the same letters, or a path containing it, does not.
  const own = recipeFor(readRecipeRegistry(registryFile(row({ userProfile: { supportDir: 'Fixture', args: [], switches: ['--profile'] } }))), 'invalid.fixture.app');
  await assert.rejects(relaunch.runningCopy({ recipe: own, uid, processes: fakeProcesses({ args: () => EXE + ' --profile work' }) }), refusal('ELECTRON_RELAUNCH_OTHER_PROFILE'));
  await assert.rejects(relaunch.runningCopy({ recipe: own, uid, processes: fakeProcesses({ args: () => EXE + ' --profile=work' }) }), refusal('ELECTRON_RELAUNCH_OTHER_PROFILE'));
  assert.equal((await relaunch.runningCopy({ recipe: own, uid, processes: fakeProcesses({ args: () => EXE + ' --profiles-shown' }) })).pid, mine.pid);
  assert.equal((await relaunch.runningCopy({ recipe: recipe(), uid, processes: fakeProcesses({ args: () => '/Applications/Fixture--user-data-dir.app/Contents/MacOS/Fixture' }) })).pid, mine.pid);
});

test('createAppProcesses reads a process\'s arguments with ps, whole lines, for that pid only', async () => {
  const calls = [];
  const run = (file, args, options, callback) => { calls.push([file, args, options.env]); callback(null, EXE + ' --wait\n'); };
  const p = relaunch.createAppProcesses({ run, script: '/x/electron-apps.js' });
  assert.equal(await p.args(3000), EXE + ' --wait');
  assert.deepEqual(calls, [['/bin/ps', ['-ww', '-o', 'args=', '-p', '3000'], { PATH: '/usr/bin:/bin' }]]);
  await assert.rejects(p.args('3000'), /ELECTRON_APPS_INVALID/);
  const failing = relaunch.createAppProcesses({ run: (file, args, options, callback) => callback(Error('exit 1'), ''), script: '/x' });
  await assert.rejects(failing.args(3000), /ELECTRON_APPS_UNAVAILABLE/);
});
