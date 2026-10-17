import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { realBrowserPlan, checkBrowserOwner, launchRealBrowser, resetRealBrowser, observeRealBrowser } from '../bench/fowl/real-browser.mjs';
import { realGatePlan, runRealGate } from '../bench/fowl/real-gate.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { answer } from '../bench/fowl/origin-hook.mjs';

const task = { name: 'fixture', browser: 'chrome', prompt: 'Visit {browser}.', result: 'the answer' };
const profile = 'sleight benchmark';
const window = (id, title = 'Start Page', url = 'about:blank') => ({ id, title,
  toolbar: [{ role: 'AXMenuButton', description: profile }], tabs: [{ id: id + '-tab', title, url }] });
function fixture(t) {
  const plan = realBrowserPlan({ browser: 'safari', round: 'test-' + randomUUID() });
  t.after(() => rmSync(dirname(plan.profileRoot), { recursive: true, force: true }));
  const calls = []; let running = false, windows = [window('restored')], serial = 0;
  const bridge = { request: async (op, input = {}) => {
    calls.push([op, input]);
    if (op === 'launch') { running = true; return { pid: 4100, executable: plan.executable, launchDate: 123 }; }
    if (op === 'snapshot') return { windows: structuredClone(windows) };
    if (op === 'new-profile') { windows.push(window('fresh-' + ++serial)); return { menuEscapePosted: true }; }
    if (op === 'navigate') { const w = windows.find(w => w.id === input.window); w.title = plan.marker; w.tabs = [{ id: w.id + '-tab', title: plan.marker, url: input.url }]; return {}; }
    if (op === 'close-window') { windows = windows.filter(w => w.id !== input.window); return {}; }
    if (op === 'quit') { running = false; return { browserClosed: true }; }
    throw Error('unexpected operation ' + op);
  }, close: async () => calls.push(['bridge-closed']) };
  const options = { safariBridge: async () => bridge, timeoutMs: 50,
    listProcesses: async () => running ? [{ pid: 4100, ppid: 1, executable: plan.executable }] : [] };
  return { plan, options, bridge, calls, windows: value => { if (value) windows = value; return windows; } };
}

test('Safari plan uses the owner-created named profile and background native launch without WebDriver', () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'safari-plan' });
  assert.equal(plan.executable, '/Applications/Safari.app/Contents/MacOS/Safari');
  assert.equal(plan.profileName, profile);
  assert.equal(plan.connectionMode, 'engine-computer');
  assert.equal(plan.launchMode, 'NSWorkspace-background');
  assert.equal(plan.resetMode, 'fresh-profile-window');
  assert.equal(plan.inventoryMode, 'AX-tab-bar');
  assert.equal(plan.profileOwned, false);
  assert.ok(!JSON.stringify(plan).match(/safaridriver|remote-debugging/));
});

test('Safari census includes bundle helpers, short names and Safari WebContent with strict ancestry', async () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'census' });
  for (const executable of ['(sAfArI)', 'Safari Web Content', '/Applications/Safari.app/Contents/XPCServices/helper', 'com.apple.WebKit.WebContent (com.apple.Safari)']) {
    await assert.rejects(checkBrowserOwner(plan, { listProcesses: async () => [{ pid: 7, ppid: 1, executable }] }), /PID 7/);
  }
  const rows = [{ pid: 40, ppid: 1, executable: plan.executable }, { pid: 41, ppid: 40, executable: 'intermediate' },
    { pid: 42, ppid: 41, executable: 'Safari Web Content' }];
  assert.equal((await checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => rows })).ok, true);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, { pid: 43, ppid: 1, executable: 'Safari Web Content' }] }), /PID 43/);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, rows[0]] }), /INVALID/);
});

test('Safari dry plans support all five arms with plain sleight, explicit limits and profile fences', t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2s-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armHome = join(dir, 'arms'); mkdirSync(join(armHome, 'lcu-arm'), { recursive: true });
  writeFileSync(join(armHome, 'lcu-arm/.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  const tasks = [task, { ...task, name: 'mobile', viewport: {} }, { ...task, name: 'download', downloads: {} }, { ...task, name: 'takeover', takeover: {} }];
  for (const surface of [undefined, 'sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const plan = realGatePlan({ args: { 'real-browser': 'safari', surface, out: join(dir, 'never') }, tasks, armHome, round: 'dry' });
    assert.equal(plan.arms.length, 1);
    assert.match(plan.arms[0].prompt, /dedicated Safari window/);
    assert.match(plan.arms[0].prompt, /sleight benchmark/);
    assert.equal(plan.arms[0].metadata.profile, profile);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'download', 'takeover']);
    if (!surface || surface === 'sleight') {
      assert.equal(plan.surface, 'sleight');
      assert.deepEqual(Object.keys(plan.arms[0].mcpConfig.mcpServers), ['plugin:sleight:computer']);
      assert.equal(plan.arms[0].settingsOverrides.hooks.PreToolUse, undefined);
    }
  }
  assert.equal(existsSync(join(dir, 'never')), false);
  assert.throws(() => realGatePlan({ args: { 'real-browser': 'safari', surface: 'sleight-turbo' }, tasks: [task] }), /turbo/i);
  assert.match(taskSupport(tasks[1], 'sleight', { realBrowser: 'safari' }), /viewport/);
  assert.equal(answer({ mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "Safari"?' }), 'accept');
});

test('Safari selects a new profile window by toolbar evidence, closes restored windows and resets freshly', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  assert.equal(browser.pid, 4100);
  assert.equal(browser.profileEvidence.attribute, 'AXDescription');
  assert.equal(browser.profileEvidence.value, profile);
  assert.equal(f.windows().length, 1);
  assert.ok(f.calls.some(([op, data]) => op === 'close-window' && data.window === 'restored'));
  const first = f.windows()[0].id;
  const start = await resetRealBrowser(browser);
  assert.equal(Object.values(start)[0].title, f.plan.marker);
  assert.notEqual(f.windows()[0].id, first);
  assert.equal(f.windows().length, 1);
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.equal(Object.values(observed.tabs)[0].url, f.plan.markerUrl);
  assert.deepEqual(await browser.stop(), { browserClosed: true, profileDeleted: false, harnessDeleted: true });
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 1);
});

test('profile evidence cannot come from page content, window title or a substring', async () => {
  const { safariProfileEvidence } = await import('../bench/fowl/safari-browser.mjs');
  assert.equal(safariProfileEvidence({ title: profile, toolbar: [], content: [{ description: profile }] }), null);
  assert.equal(safariProfileEvidence({ toolbar: [{ role: 'AXMenuButton', description: profile + ' other' }] }), null);
  assert.equal(safariProfileEvidence({ toolbar: [{ role: 'AXStaticText', value: profile }] }), null);
  assert.deepEqual(safariProfileEvidence({ toolbar: [{ role: 'AXMenuButton', title: profile }] }), { attribute: 'AXTitle', value: profile });
});

test('missing or ambiguous new profile evidence stops before navigating or closing restored windows', async t => {
  for (const ambiguous of [false, true]) {
    const f = fixture(t), original = f.bridge.request;
    f.bridge.request = async (op, input) => {
      const result = await original(op, input);
      if (op === 'new-profile') f.windows(ambiguous ? [window('a'), window('b')] : [{ ...window('a'), toolbar: [] }]);
      return result;
    };
    await assert.rejects(launchRealBrowser(f.plan, f.options), /PROFILE_WINDOW_UNPROVED/);
    assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
    assert.ok(f.calls.some(([op]) => op === 'quit'));
  }
});

test('missing tab URLs and duplicate IDs report unobserved rather than certifying partial inventory', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows()[0].tabs.push({ id: 'new', title: 'page without URL' });
  let observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false); assert.deepEqual(observed.tabs, {});
  assert.ok(observed.unavailableGraders.includes('handoff'));
  f.windows()[0].tabs = [{ id: 'same', title: 'a', url: 'https://a.test' }, { id: 'same', title: 'b', url: 'https://b.test' }];
  observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  await browser.stop();
});

test('profile changes during a task and owner arrivals invalidate observation', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows()[0].toolbar = [];
  assert.equal((await observeRealBrowser(browser)).observed, false);
  await browser.stop();
  const g = fixture(t); let other = false;
  const b = await launchRealBrowser(g.plan, { ...g.options, listProcesses: async () => [...await g.options.listProcesses(),
    ...(other ? [{ pid: 999, ppid: 1, executable: 'Safari' }] : [])] });
  other = true;
  const result = await observeRealBrowser(b);
  assert.equal(result.ownerCheck.ok, false);
  assert.equal(result.observed, false);
  await b.stop();
});

test('owner arriving during bridge preparation prevents launch', async t => {
  const f = fixture(t); let ready = false;
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options,
    safariBridge: async () => { ready = true; return f.bridge; },
    listProcesses: async () => ready ? [{ pid: 999, ppid: 1, executable: 'Safari' }] : [] }), /PID 999/);
  assert.ok(!f.calls.some(([op]) => ['launch', 'quit'].includes(op)));
});

test('failed Safari collection retains the harness and never deletes the dedicated profile', async t => {
  const f = fixture(t), original = f.bridge.request;
  const browser = await launchRealBrowser(f.plan, f.options);
  f.bridge.request = async (op, input) => { if (op === 'quit') throw Error('quit refused'); return original(op, input); };
  await assert.rejects(browser.stop(), /CLEANUP_UNPROVED/);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), true);
  assert.ok(!f.calls.some(([op]) => op === 'bridge-closed'));
});

test('Safari stop is idempotent after proven collection', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  const first = await browser.stop();
  assert.deepEqual(await browser.stop(), first);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 1);
  assert.equal(f.calls.filter(([op]) => op === 'bridge-closed').length, 1);
});

test('Safari gate uses structured observation and stable AX tab IDs for retention', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2s-gate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'lock'); let browser;
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'safari', out: join(dir, 'out') }, tasks: [task],
    runner: { gradeOutcome: input => { assert.equal(input.observed, true); assert.deepEqual([...input.startKeys], ['safari:tab-1']); return { problems: [] }; }, gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => browser = { ...plan, pid: 40, stop: async () => ({ browserClosed: true }) },
      checkOwner: async () => ({ ok: true }), resetBrowser: async () => ({ 'safari:tab-1': { url: browser.markerUrl, title: browser.marker } }),
      runAgent: async arm => { mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
      observeBrowser: async () => ({ observed: true, tabs: { 'safari:tab-1': { url: 'https://changed.test', title: 'Changed' } } }) } });
  assert.equal(rows[0].outcome.ok, true);
  assert.equal(existsSync(lockPath), false);
});

test('later resets refuse unexpected windows without closing or navigating them', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows().push(window('not-a-restored-window'));
  f.calls.length = 0;
  await assert.rejects(resetRealBrowser(browser), /EXTRA_WINDOWS/);
  assert.ok(!f.calls.some(([op]) => ['new-profile', 'navigate', 'close-window'].includes(op)));
  await browser.stop();
});

test('ambiguous shared WebContent is refused rather than silently attributed to the round', async () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'shared-webcontent' });
  for (const executable of ['com.apple.WebKit.WebContent', '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent']) {
    await assert.rejects(checkBrowserOwner(plan, { listProcesses: async () => [{ pid: 88, ppid: 1, executable }] }), /PID 88/);
  }
});

test('native Safari helper compiles and rejects unowned requests before any app lookup or input', t => {
  const root = mkdtempSync(join(tmpdir(), 'br2s-native-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'helper');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    fileURLToPath(new URL('../bench/fowl/safari-helper.swift', import.meta.url)), '-o', executable], { encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 1000,
    input: '{"op":"snapshot"}\n{"op":"navigate","window":"fake","url":"https://wrong.test"}\n{"op":"close-window","window":"fake"}\n' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n').map(line => JSON.parse(line).error),
    ['BENCH_SAFARI_IDENTITY_UNPROVED', 'BENCH_SAFARI_MARKER_INVALID', 'BENCH_SAFARI_IDENTITY_UNPROVED']);
  const uncertain = spawnSync(executable, ['--self-test-unreceipted-launch'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(uncertain.status, 0, uncertain.stderr);
  assert.deepEqual(JSON.parse(uncertain.stdout), { error: 'BENCH_SAFARI_LAUNCH_UNRECEIPTED' });
});

test('Safari CLI dry plans enumerate pinned tasks for all five arms without creating a browser or output', t => {
  const tasks = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/tools/agents/codex-h2h.json');
  if (!existsSync(tasks)) return t.skip('pinned FowlBrowser cache is absent');
  const home = mkdtempSync(join(tmpdir(), 'br2s-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const lcu = join(home, 'Library/Caches/sleight-bench/lcu-arm'); mkdirSync(lcu, { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  for (const surface of ['sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const out = join(home, 'never', surface);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bench/fowl/real-gate.mjs', import.meta.url)),
      '--real-browser', 'safari', '--dry-run', '--surface', surface, '--tasks', tasks, '--out', out],
    { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.arms.length, 12);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    assert.equal(plan.browser.profileName, profile);
    assert.equal(plan.browser.connectionMode, 'engine-computer');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(dirname(plan.browser.profileRoot)), false);
    assert.equal(existsSync(join(home, '.config')), false);
  }
});

test('a profile menu without its pid-directed Escape receipt cannot navigate or close windows', async t => {
  const f = fixture(t), request = f.bridge.request;
  f.bridge.request = async (op, input) => { const result = await request(op, input); return op === 'new-profile' ? {} : result; };
  await assert.rejects(launchRealBrowser(f.plan, f.options), /MENU_ESCAPE_UNPROVED/);
  assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
  assert.ok(f.calls.some(([op]) => op === 'quit'));
});

test('a broken helper transport collects its own helper through EOF and rejects future requests', async t => {
  const { prepareSafariBridge } = await import('../bench/fowl/safari-browser.mjs');
  const root = mkdtempSync(join(tmpdir(), 'br2s-bridge-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(); let ended = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); },
    final(callback) { ended = true; callback(); setImmediate(() => child.emit('close', 0)); } });
  const bridge = await prepareSafariBridge(root, { compile: async () => {}, spawnBrowser: () => child, timeoutMs: 10 });
  const pending = bridge.request('snapshot');
  child.stdout.write('not JSON\n');
  await assert.rejects(pending, /JSON/);
  assert.equal(ended, true);
  await assert.rejects(bridge.request('quit'), /JSON/);
  await bridge.close();
});
