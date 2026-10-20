import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialBrowserPage, realBrowserPlan } from '../bench/fowl/real-browser.mjs';
import { launchSafari } from '../bench/fowl/safari-browser.mjs';
import { ccHeldOutTasks } from '../bench/world/cc-held-out.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { executeRealTask } from '../bench/real-run.mjs';

// Only the native bridge is replaced. No app lookup, compiler, input or window is used.
// Safari's native calls are doubled, including its data-only ordinary marker operation.
function fixture(t, { navigates = true, restoredOwner = false, finalState = () => {}, foreignAfterNavigation = false,
  stuckAt, helperTimeout = false, timeoutAt, schemeLess = false, cleanupAt } = {}) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-cc-safari-')));
  let launchedBrowser;
  t.after(async () => { try { await launchedBrowser?.stop(); } finally { removeTemp(root); } });
  let running = false, windows = [], serial = 0, active, planned;
  const calls = [], pollTimes = [];
  const bridge = { close: async () => { if (cleanupAt === 'close') throw Error('helper collection failed'); }, request: async (op, input = {}) => {
    calls.push(op);
    if (op === timeoutAt) throw Error('BENCH_SAFARI_HELPER_TIMEOUT');
    if (op === 'fixture-plan') { planned = input.url; return {}; }
    if (op === 'launch') {
      running = true;
      windows = restoredOwner ? [{ id: 'owner', startPage: false }] : [{ id: 'launch', startPage: true }];
      return { pid: 4101, executable: process.execPath, launchDate: Date.now() / 1000 };
    }
    if (op === 'snapshot') {
      if (calls.includes('navigate-fixture')) pollTimes.push(Date.now());
      return { windows: structuredClone(windows) };
    }
    if (op === 'close-launch-window') {
      assert.equal(input.window, 'launch'); if (stuckAt !== 'close-launch-window') windows = []; return {};
    }
    if (op === 'new-profile') {
      const id = `profile-${++serial}`;
      windows = stuckAt === 'new-profile' ? [] : [{ id, profileEvidence: { element: `${id}-profile`, role: 'AXMenuButton',
        attribute: 'AXIdentifier', identifier: 'TabGroupPickerButton?Profile=sleight%20benchmark&Icon=hammer.fill', value: 'sleight benchmark' },
        tabs: [{ id: `${id}-tab`, title: 'Start Page', url: 'about:blank' }] }];
      return { menuEscapePosted: true, menuCleared: true, menuEscapes: 1 };
    }
    if (op === 'navigate' || op === 'navigate-fixture') {
      if (op === 'navigate') {
        if (!input.url.startsWith('data:text/html,')) throw Error('BENCH_SAFARI_MARKER_INVALID');
        // Reproduce the reported failure when Safari leaves a data redirect unnavigated.
        if (active.acquisitionPage) return {};
      } else {
        assert.equal(input.url, planned);
      }
      assert.equal(input.window, windows[0].id);
      let title = active.marker;
      if (op === 'navigate-fixture') {
        // Read the served title, independent of the launcher's expected title.
        const response = await fetch(input.url), html = await response.text();
        assert.equal(response.status, 200);
        title = /<title>([^<]+)<\/title>/.exec(html)[1];
      }
      windows[0].tabs[0] = { ...windows[0].tabs[0],
        title: navigates ? title : active.marker,
        url: navigates ? schemeLess ? input.url.replace(/^http:\/\//, '') : input.url : active.markerUrl };
      finalState(windows, active);
      if (helperTimeout) throw Error('BENCH_SAFARI_HELPER_TIMEOUT');
      return {};
    }
    if (op === 'quit') {
      if (cleanupAt === 'quit') throw Error('quit failed');
      running = false; windows = []; return { browserClosed: true };
    }
    assert.fail(`unexpected bridge operation ${op}`);
  } };
  return { calls, pollTimes, root, windows: () => windows,
    launch: async (plan, { initialPage }) => {
      active = { ...initialBrowserPage(plan, initialPage), executable: process.execPath, profileRoot: join(root, 'harness/profile') };
      return launchedBrowser = await launchSafari(active, { safariBridge: async () => {
        if (timeoutAt === 'prepare-helper') throw Error('BENCH_SAFARI_HELPER_TIMEOUT');
        return bridge;
      }, timeoutMs: 50, restoreWait: async () => {},
        listProcesses: async () => running ? [{ pid: 4101, ppid: 1, executable: process.execPath },
          ...(foreignAfterNavigation && calls.some(op => op.startsWith('navigate')) ? [{ pid: 4102, ppid: 1, executable: process.execPath }] : [])] : [] });
    } };
}

for (const id of ['cc-list-safari', 'cc-list-pop-up-safari', 'cc-calendar-safari',
  'cc-calendar-ambiguous-safari', 'cc-dropdown-safari', 'cc-dropdown-slow-safari', 'cc-new-tab-safari']) {
  for (const schemeLess of [false, true]) test(`${id} reaches its fixture with ${schemeLess ? 'a scheme-less' : 'an exact'} URL`, async t => {
    const f = fixture(t, { schemeLess });
    const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === id);
    const ctx = { nonce: 'recorded-failure', seed: 'fixed', ownerAway: true, realProfile: 'fresh' };
    t.after(async () => { await ctx.browser?.stop(); await ctx.closeServer?.(); });
    await task.setup(ctx);
    assert.equal(ctx.pendingAcquisitions.size, 0, 'recorded failure left browser acquisition unconfirmed');
    assert.match(ctx.url, /^http:\/\/127\.0\.0\.1:\d+\/held-out\/[^/]+\/recorded-failure\/$/);
    assert.equal((await fetch(ctx.url)).status, 200);
    assert.equal(ctx.browser.profileName, 'sleight benchmark');
    const inventory = await ctx.browser.reset();
    assert.deepEqual(Object.values(inventory), [{ title: `Held-out ${ctx.cc.kind} ${ctx.nonce}`, url: ctx.url }]);
    assert.notEqual(ctx.browser.marker, Object.values(inventory)[0].title);
    assert.notEqual(ctx.browser.markerUrl, ctx.url);
    const observation = await ctx.browser.observe();
    assert.equal(observation.observed, true);
    assert.equal(Object.values(observation.tabs)[0].url, ctx.url);
    // A second reset must use the same planned fixture after collecting the first process.
    assert.equal(Object.values(await ctx.browser.reset())[0].url, ctx.url);
    assert.equal(f.calls.filter(op => op === 'navigate-fixture').length, 2);
    assert.ok(!f.calls.includes('navigate'));
    await task.cleanup(ctx);
    assert.equal(f.calls.filter(op => op === 'quit').length, 2);
  });
}

test('ordinary Safari race markers still navigate directly and retain their inventory', async t => {
  const f = fixture(t), plan = realBrowserPlan({ browser: 'safari', round: 'ordinary-race' });
  const browser = await f.launch(plan, {});
  try {
    assert.equal(browser.navigationUrl, undefined);
    const inventory = Object.values(await browser.reset());
    assert.deepEqual(inventory, [{ title: 'Sleight Gate ordinary-race', url: plan.markerUrl }]);
  } finally { await browser.stop(); }
});

for (const key of ['title', 'url']) {
  test(`ordinary Safari race markers still require the exact ${key}`, async t => {
    const f = fixture(t, { finalState: windows => { windows[0].tabs[0][key] += 'different'; } });
    const plan = realBrowserPlan({ browser: 'safari', round: 'ordinary-refusal' });
    await assert.rejects(f.launch(plan, {}), error => {
      assert.match(error.message, /BENCH_SAFARI_MARKER_UNPROVED/);
      const diagnostic = error.browserReceipt.acquisition.at(-1);
      assert.equal(diagnostic.stage, 'navigate');
      assert.equal(diagnostic.lastObserved.windowCount, 1);
      assert.equal(diagnostic.lastObserved.tabCount, 1);
      assert.match(diagnostic.lastObserved.ownedTabs[0].title, /<nonce>/);
      assert.match(diagnostic.lastObserved.ownedTabs[0].url, /<nonce>/);
      assert.doesNotMatch(JSON.stringify(diagnostic), /ordinary-refusal/);
      return true;
    });
    assert.equal(f.calls.filter(op => op === 'quit').length, 1);
  });
}

test('Safari requires a clean process census after matching the fixture', async t => {
  const f = fixture(t, { foreignAfterNavigation: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'foreign-process', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /PID 4102/);
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(f.calls.filter(op => op === 'quit').length, 1);
});

test('Safari fixture readiness rejects navigation that never reaches its final URL', async t => {
  const f = fixture(t, { navigates: false });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'stalled', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /BENCH_SAFARI_MARKER_UNPROVED/);
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(f.calls.filter(op => op === 'quit').length, 1);
  assert.equal(f.pollTimes.length, 2);
  assert.ok(f.pollTimes[1] - f.pollTimes[0] >= 200, 'fixture poll must pause about 250 ms');
});

test('Safari observation canonicalizes only the planned fixture with its exact title', async t => {
  const f = fixture(t, { schemeLess: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'observe', ownerAway: true, realProfile: 'fresh' };
  t.after(async () => { await ctx.browser?.stop(); await ctx.closeServer?.(); });
  await task.setup(ctx);
  const tab = f.windows()[0].tabs[0], title = tab.title, shortUrl = ctx.url.slice(7);
  for (const [observedTitle, observedUrl, expectedUrl] of [
    [title, shortUrl, ctx.url], [title, ctx.url, ctx.url], [title, '', ctx.url],
    [title + 'different', shortUrl, shortUrl], [title, shortUrl + 'different', shortUrl + 'different'],
    ['Other page', 'example.test/path', 'example.test/path'],
  ]) {
    Object.assign(tab, { title: observedTitle, url: observedUrl });
    const observation = await ctx.browser.observe();
    assert.equal(observation.observed, true);
    assert.deepEqual(Object.values(observation.tabs), [{ title: observedTitle, url: expectedUrl }]);
  }
});

for (const cleanupAt of ['quit', 'close']) test(`Safari retains a failed acquisition when ${cleanupAt} cleanup fails`, async t => {
  const f = fixture(t, { navigates: false, cleanupAt });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'cleanup-failure', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), error => {
    assert.equal(error.message, 'BENCH_BROWSER_CLEANUP_UNPROVED');
    assert.notEqual(error.cleanupConfirmed, true);
    return true;
  });
  assert.deepEqual([...ctx.pendingAcquisitions], ['browser']);
});

for (const [name, finalState, reason] of [
  ['wrong title', windows => { windows[0].tabs[0].title = 'Unexpected fixture'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['wrong run URL', windows => { windows[0].tabs[0].url += 'other-run/'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['scheme-less wrong run URL', windows => { windows[0].tabs[0].url = windows[0].tabs[0].url.slice(7) + 'other-run/'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['scheme-less wrong title', windows => { windows[0].tabs[0].url = windows[0].tabs[0].url.slice(7); windows[0].tabs[0].title += 'different'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['wrong scheme', windows => { windows[0].tabs[0].url = windows[0].tabs[0].url.replace('http:', 'https:'); }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['missing URL', windows => { windows[0].tabs[0].url = ''; }, /BENCH_SAFARI_TABS_UNOBSERVED/],
  ['extra tab', windows => { windows[0].tabs.push({ ...windows[0].tabs[0], id: 'extra-tab' }); }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['extra window', windows => { windows.push({ ...windows[0], id: 'extra-window' }); }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['replaced window', windows => { windows[0].id = 'replacement'; }, /BENCH_SAFARI_PROFILE_WINDOW_UNPROVED/],
  ['lost profile', windows => { delete windows[0].profileEvidence; }, /BENCH_SAFARI_PROFILE_WINDOW_UNPROVED/],
]) {
  test(`Safari fixture readiness refuses ${name} after direct navigation`, async t => {
    const f = fixture(t, { finalState });
    const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
    const ctx = { nonce: 'refused', ownerAway: true, realProfile: 'fresh' };
    t.after(() => ctx.closeServer?.());
    await assert.rejects(task.setup(ctx), reason);
    assert.equal(ctx.pendingAcquisitions.size, 0);
    assert.equal(f.calls.filter(op => op === 'quit').length, 1);
  });
}

test('Safari refuses restored owner windows before a fixture can navigate', async t => {
  const f = fixture(t, { restoredOwner: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'restored', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /BENCH_SAFARI_RESTORED_WINDOWS/);
  assert.ok(!f.calls.some(op => ['close-launch-window', 'new-profile', 'navigate', 'navigate-fixture'].includes(op)));
});

test('Safari fixture plans admit only held-out fixture bases and retain the original race marker', () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'escaping' });
  const url = 'http://127.0.0.1:5431/held-out/list/test/';
  const start = initialBrowserPage(plan, { url, title: 'Fixture' });
  assert.equal(start.navigationUrl, undefined);
  assert.deepEqual(start.acquisitionPage, { url, title: 'Fixture' });
  for (const path of ['/other/', '/held-out/', '/held-out/list/test/?q=x', '/held-out/list/test/#tail', '/held-out/list/test/child']) {
    assert.throws(() => initialBrowserPage(plan, { url: `http://127.0.0.1:5431${path}`, title: 'Fixture' }), /BENCH_INITIAL_PAGE_UNSAFE/);
  }
  assert.ok(plan.markerUrl.startsWith('data:text/html,'), 'original race plan stays unchanged');
});

for (const [stuckAt, stage, reason, windowCount, tabCount] of [
  ['close-launch-window', 'close-launch-window', 'BENCH_SAFARI_LAUNCH_WINDOW_UNCLOSED', 1, null],
  ['new-profile', 'new-profile', 'BENCH_SAFARI_PROFILE_WINDOW_UNPROVED', 0, null],
  [undefined, 'await-fixture', 'BENCH_SAFARI_MARKER_UNPROVED', 1, 1],
]) {
  test(`Safari ${stage} timeout preserves its last observation in the run receipt`, async t => {
    const f = fixture(t, { stuckAt, finalState: windows => {
      windows[0].tabs[0].title = 'Held-out list diagnostic-nonce still loading';
      windows[0].tabs[0].url += '?waiting=diagnostic-nonce';
      // An unowned window's title and URL must never enter diagnostics.
      windows.push({ id: 'owner', title: 'private-title', tabs: [{ title: 'private-tab', url: 'https://private.test/' }] });
    } });
    const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
    const ctx = { dir: join(f.root, 'run'), nonce: 'diagnostic-nonce', ownerAway: true, realProfile: 'fresh', releaseInput: async () => {} };
    t.after(() => ctx.closeServer?.());
    const result = await executeRealTask(task, ctx, { lockHeld: true });
    assert.equal(result.reason, reason);
    const diagnostic = result.browserAcquisition.at(-1);
    assert.equal(diagnostic.stage, stage);
    assert.equal(diagnostic.lastObserved.windowCount, stage === 'await-fixture' ? 2 : windowCount);
    assert.equal(diagnostic.lastObserved.tabCount, tabCount);
    if (stage === 'await-fixture') {
      assert.deepEqual(diagnostic.lastObserved.ownedTabs, [{ title: 'Held-out list <nonce> still loading',
        url: 'http://127.0.0.1:<port>/held-out/list/<nonce>/?waiting=<nonce>' }]);
    }
    assert.doesNotMatch(JSON.stringify(result.browserAcquisition), /diagnostic-nonce|private-title|private-tab|private\.test/);
    assert.equal(result.cleanupError, undefined);
    assert.equal(ctx.pendingAcquisitions.size, 0);
  });
}

test('a helper timeout retains the last pre-navigation snapshot before collection', async t => {
  const f = fixture(t, { helperTimeout: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'helper-timeout', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), error => {
    assert.equal(error.message, 'BENCH_SAFARI_HELPER_TIMEOUT');
    assert.deepEqual(error.browserReceipt.acquisition.at(-1), { stage: 'navigate-fixture', reason: 'BENCH_SAFARI_HELPER_TIMEOUT',
      lastObserved: { windowCount: 1, tabCount: 1, ownedTabs: [{ title: 'Start Page', url: 'about:blank' }] } });
    return true;
  });
});

for (const stage of ['prepare-helper', 'fixture-plan', 'launch', 'restore']) {
  test(`Safari ${stage} timeout records an unobserved census without reading other windows`, async t => {
    const f = fixture(t, { timeoutAt: stage === 'restore' ? 'snapshot' : stage });
    const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
    const ctx = { nonce: 'early-timeout', ownerAway: true, realProfile: 'fresh' };
    t.after(() => ctx.closeServer?.());
    await assert.rejects(task.setup(ctx), error => {
      assert.equal(error.message, 'BENCH_SAFARI_HELPER_TIMEOUT');
      assert.deepEqual(error.browserReceipt.acquisition.at(-1), { stage, reason: 'BENCH_SAFARI_HELPER_TIMEOUT',
        lastObserved: { windowCount: null, tabCount: null, ownedTabs: [] } });
      return true;
    });
  });
}
