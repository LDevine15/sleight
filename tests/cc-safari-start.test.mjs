import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { initialBrowserPage, realBrowserPlan } from '../bench/fowl/real-browser.mjs';
import { launchSafari } from '../bench/fowl/safari-browser.mjs';
import { ccHeldOutTasks } from '../bench/world/cc-held-out.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

// Only the native bridge is replaced. No app lookup, compiler, input or window is used.
// The bridge retains navigate's data-only contract from the recorded CC failure.
function fixture(t, { redirect = true, restoredOwner = false, finalState = () => {}, foreignAfterNavigation = false } = {}) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-cc-safari-')));
  t.after(() => removeTemp(root));
  let running = false, windows = [], serial = 0, active;
  const calls = [];
  const bridge = { close: async () => {}, request: async (op, input = {}) => {
    calls.push(op);
    if (op === 'launch') {
      running = true;
      windows = restoredOwner ? [{ id: 'owner', startPage: false }] : [{ id: 'launch', startPage: true }];
      return { pid: 4101, executable: process.execPath, launchDate: Date.now() / 1000 };
    }
    if (op === 'snapshot') return { windows: structuredClone(windows) };
    if (op === 'close-launch-window') {
      assert.equal(input.window, 'launch'); windows = []; return {};
    }
    if (op === 'new-profile') {
      const id = `profile-${++serial}`;
      windows = [{ id, toolbar: [{ id: `${id}-profile`, role: 'AXMenuButton', description: 'sleight benchmark' }],
        tabs: [{ id: `${id}-tab`, title: 'Start Page', url: 'about:blank' }] }];
      return { menuEscapePosted: true, menuCleared: true, menuEscapes: 1 };
    }
    if (op === 'navigate') {
      if (!input.url.startsWith('data:text/html,')) throw Error('BENCH_SAFARI_MARKER_INVALID');
      assert.equal(input.window, windows[0].id);
      let target;
      const html = decodeURIComponent(input.url.slice('data:text/html,'.length));
      for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        new Script(source).runInNewContext({ location: { replace(url) { target = url; } } });
      }
      let title = active.marker;
      if (active.navigationUrl) {
        assert.equal(target, active.acquisitionPage.url);
        // Read the served title, independent of the launcher's expected title.
        const response = await fetch(target), html = await response.text();
        assert.equal(response.status, 200);
        title = /<title>([^<]+)<\/title>/.exec(html)[1];
      }
      windows[0].tabs[0] = { ...windows[0].tabs[0],
        title: redirect ? title : active.marker, url: redirect ? target ?? input.url : input.url };
      finalState(windows, active);
      return {};
    }
    if (op === 'quit') { running = false; windows = []; return { browserClosed: true }; }
    assert.fail(`unexpected bridge operation ${op}`);
  } };
  return { calls,
    launch: async (plan, { initialPage }) => {
      active = { ...initialBrowserPage(plan, initialPage), executable: process.execPath, profileRoot: join(root, 'harness/profile') };
      return launchSafari(active, { safariBridge: async () => bridge, timeoutMs: 50, restoreWait: async () => {},
        listProcesses: async () => running ? [{ pid: 4101, ppid: 1, executable: process.execPath },
          ...(foreignAfterNavigation && calls.includes('navigate') ? [{ pid: 4102, ppid: 1, executable: process.execPath }] : [])] : [] });
    } };
}

for (const id of ['cc-list-safari', 'cc-list-pop-up-safari', 'cc-calendar-safari',
  'cc-calendar-ambiguous-safari', 'cc-dropdown-safari', 'cc-dropdown-slow-safari', 'cc-new-tab-safari']) {
  test(`${id} reaches its loopback fixture through a data marker`, async t => {
    const f = fixture(t);
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
    assert.equal((await ctx.browser.observe()).observed, true);
    // A second reset must use the same bootstrap after collecting the first process.
    assert.equal(Object.values(await ctx.browser.reset())[0].url, ctx.url);
    assert.equal(f.calls.filter(op => op === 'navigate').length, 2);
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
    await assert.rejects(f.launch(plan, {}), /BENCH_SAFARI_MARKER_UNPROVED/);
    assert.equal(f.calls.filter(op => op === 'quit').length, 1);
  });
}

test('Safari requires a clean process census after matching the redirected fixture', async t => {
  const f = fixture(t, { foreignAfterNavigation: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'foreign-process', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /PID 4102/);
  assert.deepEqual([...ctx.pendingAcquisitions], ['browser']);
  assert.equal(f.calls.filter(op => op === 'quit').length, 1);
});

test('Safari fixture readiness rejects a bootstrap that never reaches its final URL', async t => {
  const f = fixture(t, { redirect: false });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'stalled', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /BENCH_SAFARI_MARKER_UNPROVED/);
  assert.deepEqual([...ctx.pendingAcquisitions], ['browser']);
  assert.equal(f.calls.filter(op => op === 'quit').length, 1);
});

for (const [name, finalState, reason] of [
  ['wrong title', windows => { windows[0].tabs[0].title = 'Unexpected fixture'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['wrong run URL', windows => { windows[0].tabs[0].url += 'other-run/'; }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['extra tab', windows => { windows[0].tabs.push({ ...windows[0].tabs[0], id: 'extra-tab' }); }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['extra window', windows => { windows.push({ ...windows[0], id: 'extra-window' }); }, /BENCH_SAFARI_MARKER_UNPROVED/],
  ['replaced window', windows => { windows[0].id = 'replacement'; }, /BENCH_SAFARI_PROFILE_WINDOW_UNPROVED/],
  ['lost profile', windows => { windows[0].toolbar = []; }, /BENCH_SAFARI_PROFILE_WINDOW_UNPROVED/],
]) {
  test(`Safari fixture readiness refuses ${name} after redirect`, async t => {
    const f = fixture(t, { finalState });
    const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
    const ctx = { nonce: 'refused', ownerAway: true, realProfile: 'fresh' };
    t.after(() => ctx.closeServer?.());
    await assert.rejects(task.setup(ctx), reason);
    assert.deepEqual([...ctx.pendingAcquisitions], ['browser']);
    assert.equal(f.calls.filter(op => op === 'quit').length, 1);
  });
}

test('Safari refuses restored owner windows before a fixture can navigate', async t => {
  const f = fixture(t, { restoredOwner: true });
  const task = ccHeldOutTasks(undefined, { launchBrowser: f.launch }).find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'restored', ownerAway: true, realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /BENCH_SAFARI_RESTORED_WINDOWS/);
  assert.ok(!f.calls.some(op => ['close-launch-window', 'new-profile', 'navigate'].includes(op)));
});

test('Safari bootstrap preserves URL data as one redirect without executing injected markup', () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'escaping' });
  const url = 'http://127.0.0.1:5431/held-out/list/test/?x=</script><script>throw 1</script>&q="quoted"#tail';
  const start = initialBrowserPage(plan, { url, title: 'Fixture' });
  let target;
  assert.match(start.navigationUrl ?? '', /^data:text\/html,/);
  const html = decodeURIComponent(start.navigationUrl.slice('data:text/html,'.length));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1]).runInNewContext({ location: { replace(value) { target = value; } } });
  assert.equal(target, new URL(url).href);
  assert.ok(plan.markerUrl.startsWith('data:text/html,'), 'original race plan stays unchanged');
});
