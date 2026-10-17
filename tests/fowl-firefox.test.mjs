import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, observeRealBrowser, checkBrowserOwner } from '../bench/fowl/real-browser.mjs';
import { realGatePlan, runRealGate } from '../bench/fowl/real-gate.mjs';
import { gradeGateTask } from '../bench/fowl/real-gate-grade.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { answer } from '../bench/fowl/origin-hook.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const task = { name: 'fixture', browser: 'chrome', prompt: 'Visit the fixture in {browser}.', result: 'the answer' };
const session = tabs => ({ windows: [{ tabs: tabs.map(([url, title]) => ({ index: 1, entries: [{ url, title }] })) }] });
// Literal-only LZ4 block, independent of the decoder under test.
function encoded(value) {
  const bytes = Buffer.from(JSON.stringify(value)), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  const extra = []; let left = bytes.length - 15;
  if (left >= 0) { while (left >= 255) { extra.push(255); left -= 255; } extra.push(left); }
  return Buffer.concat([Buffer.from('mozLz40\0'), length, Buffer.from([Math.min(bytes.length, 15) << 4, ...extra]), bytes]);
}
function fixture(t) {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'test-' + randomUUID() });
  t.after(() => rmSync(dirname(plan.profileRoot), { recursive: true, force: true }));
  const children = [], requests = [], signals = [];
  let current;
  const spawnBrowser = (command, args) => {
    assert.equal(command, '/Applications/Firefox.app/Contents/MacOS/firefox');
    assert.deepEqual(args.slice(0, 4), ['-profile', plan.profileRoot, '-no-remote', '-new-instance']);
    assert.ok(!existsSync(join(plan.profileRoot, 'old-task')));
    assert.match(readFileSync(join(plan.profileRoot, 'user.js'), 'utf8'), /browser.sessionstore.resume_from_crash", false/);
    current = new EventEmitter(); current.pid = 4000 + children.length; children.push(current);
    current.kill = signal => { signals.push(signal); setImmediate(() => current.emit('close', null, signal)); };
    mkdirSync(join(plan.profileRoot, 'sessionstore-backups'), { recursive: true });
    writeFileSync(join(plan.profileRoot, 'sessionstore-backups/recovery.jsonlz4'), encoded(session([[args.at(-1), plan.marker]])));
    return current;
  };
  const options = { spawnBrowser, listProcesses: async () => [], stopMs: 5, timeoutMs: 100,
    quitBrowser: async browser => {
      requests.push(browser.pid);
      for (const name of ['sessionstore.jsonlz4', 'sessionstore-backups/recovery.jsonlz4']) {
        const file = join(plan.profileRoot, name);
        if (existsSync(file)) writeFileSync(file, readFileSync(file));
      }
      setImmediate(() => current.emit('close', 0, null));
    } };
  return { plan, options, children, requests, signals, current: () => current };
}

test('Firefox plans a fresh visible profile without CDP and names the installed executable', () => {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'fixture-firefox' });
  assert.equal(plan.command, '/Applications/Firefox.app/Contents/MacOS/firefox');
  assert.deepEqual(plan.args.slice(0, 4), ['-profile', plan.profileRoot, '-no-remote', '-new-instance']);
  assert.equal(plan.connectionMode, 'engine-computer');
  assert.equal(plan.version, '157');
  assert.ok(!plan.args.some(arg => /debugging|headless/.test(arg)));
  assert.match(decodeURIComponent(plan.args.at(-1)), /Sleight Gate fixture-firefox/);
});

test('Firefox owner census refuses an external process but accepts owned ancestry', async () => {
  const plan = realBrowserPlan({ browser: 'firefox', round: 'fixture-census' });
  const rows = [{ pid: 40, ppid: 1, executable: plan.executable }, { pid: 41, ppid: 40, executable: 'firefox' }];
  await assert.rejects(checkBrowserOwner(plan, { listProcesses: async () => rows }), /Quit firefox/);
  assert.equal((await checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => rows })).ok, true);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, { pid: 42, ppid: 1, executable: 'firefox' }] }), /PID 42/);
});

test('Firefox launches with offline prefs, relaunches a clean profile, and inventories after graceful quit', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  assert.equal(browser.pid, 4000);
  const prefs = readFileSync(join(f.plan.profileRoot, 'user.js'), 'utf8');
  for (const key of ['browser.shell.checkDefaultBrowser', 'toolkit.telemetry.enabled', 'app.update.staging.enabled', 'browser.sessionstore.resume_from_crash'])
    assert.ok(prefs.includes(`user_pref("${key}", false)`), key);
  assert.ok(prefs.includes('user_pref("app.update.interval", 2147483647)'));
  writeFileSync(join(f.plan.profileRoot, 'old-task'), 'must not survive');
  const start = await resetRealBrowser(browser);
  assert.equal(browser.pid, 4001);
  assert.equal(Object.values(start)[0].title, f.plan.marker);
  writeFileSync(join(f.plan.profileRoot, 'sessionstore.jsonlz4'), encoded(session([['http://127.0.0.1:5420/checkout/signin', 'Sign in']])));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.match(observed.source, /sessionstore.jsonlz4$/);
  assert.equal(Object.values(observed.tabs)[0].url, 'http://127.0.0.1:5420/checkout/signin');
  assert.equal(browser.pid, undefined);
  assert.deepEqual(f.requests, [4000, 4001]);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(await browser.stop(), { browserClosed: true, profileDeleted: true });
  assert.equal(existsSync(f.plan.profileRoot), false);
});

test('a missing sessionstore is unobserved, and forced collection never certifies an inventory', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {} });
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /graceful/i);
  assert.ok(observed.unavailableGraders.includes('handoff'));
  assert.deepEqual(f.signals, ['SIGTERM']);
  await browser.stop();
  const g = fixture(t), other = await launchRealBrowser(g.plan, g.options);
  rmSync(join(g.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
  const absent = await observeRealBrowser(other);
  assert.equal(absent.observed, false);
  assert.match(absent.reason, /sessionstore/i);
  await other.stop();
});

test('an uncollected Firefox retains its profile and blocks relaunch', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options, quitBrowser: async () => {} });
  f.current().kill = () => {};
  await assert.rejects(resetRealBrowser(browser), /CLEANUP_UNPROVED/);
  assert.equal(f.children.length, 1);
  assert.equal(existsSync(f.plan.profileRoot), true);
  f.current().emit('close', 0, null);
});

test('a graceful quit with only a stale recovery file cannot certify the after-task pages', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options,
    quitBrowser: async () => { setImmediate(() => f.current().emit('close', 0, null)); } });
  const file = join(f.plan.profileRoot, 'sessionstore-backups/recovery.jsonlz4');
  utimesSync(file, new Date(0), new Date(0));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /stale/i);
  await browser.stop();
});

test('Firefox observation refuses sessionstore paths escaping the owned profile', async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, { ...f.options,
    quitBrowser: async () => { setImmediate(() => f.current().emit('close', 0, null)); } });
  const outside = mkdtempSync(join(tmpdir(), 'br2a-session-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'recovery.jsonlz4'), encoded(session([['outside', 'not ours']])));
  rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
  symlinkSync(outside, join(f.plan.profileRoot, 'sessionstore-backups'));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.match(observed.reason, /SESSIONSTORE_INVALID/);
  await browser.stop();
  assert.equal(existsSync(join(outside, 'recovery.jsonlz4')), true);
});

test('a Firefox startup timeout collects its child and removes its private bank', async t => {
  const f = fixture(t);
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, timeoutMs: 1, spawnBrowser: (...args) => {
    const child = f.options.spawnBrowser(...args);
    rmSync(join(f.plan.profileRoot, 'sessionstore-backups'), { recursive: true });
    return child;
  } }), /START_FAILED/);
  assert.deepEqual(f.requests, [4000]);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox rechecks for newly arrived owners before relaunching and collects only its own bank', async t => {
  const f = fixture(t); let occupied = false;
  const browser = await launchRealBrowser(f.plan, { ...f.options, listProcesses: async () => occupied
    ? [{ pid: 999, ppid: 1, executable: 'firefox' }] : [] });
  occupied = true;
  await assert.rejects(resetRealBrowser(browser), /PID 999/);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.requests, [4000]);
  await browser.stop();
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('Firefox repeats admission after helper preparation and preserves a newly arrived owner refusal', async t => {
  const f = fixture(t); let checks = 0;
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options, listProcesses: async () => ++checks === 1
    ? [] : [{ pid: 999, ppid: 1, executable: 'firefox' }] }), error => {
    assert.match(error.message, /PID 999/);
    assert.equal(error.ownerCheck.ok, false);
    assert.deepEqual(error.ownerCheck.otherPids, [999]);
    return true;
  });
  assert.equal(f.children.length, 0);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
});

test('mozlz4 decoding handles literal lengths, overlapping matches, active history and closed tabs', async () => {
  const { decodeMozLz4, firefoxTabs } = await import('../bench/fowl/firefox-browser.mjs');
  const value = { text: 'x'.repeat(600) };
  assert.deepEqual(decodeMozLz4(encoded(value)), value);
  // {"a":"aaaaaa"}: 7 literals, a 5-byte overlapping match, then 2 literals.
  const header = Buffer.alloc(4); header.writeUInt32LE(14);
  const matched = Buffer.concat([Buffer.from('mozLz40\0'), header, Buffer.from([0x71]), Buffer.from('{"a":"a'), Buffer.from([1, 0, 0x20]), Buffer.from('"}')]);
  assert.deepEqual(decodeMozLz4(matched), { a: 'aaaaaa' });
  const state = { windows: [{ tabs: [{ index: 2, entries: [{ url: 'old' }, { url: 'new', title: 'Current' }] }], _closedTabs: [{ state: { entries: [{ url: 'closed' }] } }] }], _closedWindows: [{ tabs: [] }] };
  assert.deepEqual(Object.values(firefoxTabs(state)), [{ url: 'new', title: 'Current' }]);
  for (const bad of [Buffer.from('not lz4'), encoded(value).subarray(0, 14), Buffer.concat([Buffer.from('mozLz40\0'), Buffer.from([255, 255, 255, 127]), Buffer.from([0])])])
    assert.throws(() => decodeMozLz4(bad), /SESSIONSTORE/);
  assert.throws(() => firefoxTabs({ windows: [{ tabs: [{ index: 2, entries: [{ url: 'x' }] }] }] }), /SESSIONSTORE/);
});

test('Firefox dry plans choose plain sleight and explicitly exclude mobile and takeover for every arm', t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armHome = join(dir, 'arms'); mkdirSync(join(armHome, 'lcu-arm'), { recursive: true });
  writeFileSync(join(armHome, 'lcu-arm/.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  const tasks = [task, { ...task, name: 'mobile', viewport: { maxWidth: 600 } }, { ...task, name: 'takeover', takeover: { afterViews: 4 } }];
  for (const surface of [undefined, 'sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const plan = realGatePlan({ args: { 'real-browser': 'firefox', surface, out: join(dir, 'never') }, tasks, armHome, round: 'fixture-plan' });
    assert.equal(plan.arms.length, 1);
    assert.match(plan.arms[0].prompt, /dedicated Firefox window/);
    assert.match(plan.arms[0].prompt, /Visit the fixture in Firefox/);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    if (!surface || surface === 'sleight') {
      const arm = plan.arms[0];
      assert.equal(plan.surface, 'sleight');
      assert.deepEqual(Object.keys(arm.mcpConfig.mcpServers), ['plugin:sleight:computer']);
      assert.equal(arm.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'computer');
      assert.ok(arm.args.includes('--plugin-dir'));
      assert.equal(arm.settingsOverrides.hooks.PreToolUse, undefined);
      assert.match(arm.settingsOverrides.hooks.Elicitation[0].hooks[0].command, /origin-hook/);
      assert.equal(arm.metadata.connectionMode, 'engine-computer');
    }
  }
  assert.equal(existsSync(join(dir, 'never')), false);
  assert.throws(() => realGatePlan({ args: { 'real-browser': 'firefox', surface: 'sleight-turbo' }, tasks: [task] }), /turbo/i);
  assert.equal(taskSupport(task, 'sleight', { realBrowser: 'firefox' }), null);
  assert.match(taskSupport(tasks[1], 'sleight', { realBrowser: 'firefox' }), /viewport/i);
  assert.equal(answer({ mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "Firefox"?' }), 'accept');
});

test('Firefox CLI dry plans enumerate all pinned tasks for all five arms without runtime side effects', t => {
  const tasks = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/tools/agents/codex-h2h.json');
  if (!existsSync(tasks)) return t.skip('pinned FowlBrowser cache is absent');
  const home = mkdtempSync(join(tmpdir(), 'br2a-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const lcu = join(home, 'Library/Caches/sleight-bench/lcu-arm'); mkdirSync(lcu, { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  for (const surface of ['sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const out = join(home, 'never', surface);
    const result = spawnSync(process.execPath, [join(repo, 'bench/fowl/real-gate.mjs'), '--real-browser', 'firefox',
      '--dry-run', '--surface', surface, '--tasks', tasks, '--out', out],
    { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.arms.length, 12);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    assert.equal(plan.browser.connectionMode, 'engine-computer');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(plan.browser.profileRoot), false);
    assert.equal(existsSync(join(home, '.config')), false);
  }
});

test('unobserved Firefox inventory runs answer/site grading but cannot pass handoff or retention', () => {
  let observed;
  const runner = { gradeOutcome: input => { observed = input.observed; return { problems: [] }; }, gradeSite: () => ({ problems: [] }),
    gradeHandoff: () => assert.fail('no page inventory for handoff') };
  const input = { task, run: { exitCode: 0, result: { result: 'RESULT: fixture' } }, runner,
    after: {}, observed: false, observationReason: 'sessionstore absent', startKeys: new Set() };
  assert.equal(gradeGateTask(input).ok, true);
  assert.equal(observed, false);
  for (const extra of [{ handoff: { url: '/signin' } }, { keepMin: 1 }, { keep: ['/signin'] }]) {
    const grade = gradeGateTask({ ...input, task: { ...task, ...extra } });
    assert.equal(grade.ok, false); assert.match(grade.problems.join(' '), /unobserved.*sessionstore absent/i);
  }
});

test('Firefox lifecycle rebuilds each arm with the relaunched PID and records unobserved metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-gate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [], lockPath = join(dir, 'lock'); let pid = 40;
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [task, { ...task, name: 'second' }],
    runner: { gradeOutcome: input => { assert.equal(input.observed, false); return { problems: [] }; }, gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => events.push('sites closed') }),
      launchBrowser: async plan => ({ ...plan, get pid() { return pid; }, stop: async () => { events.push('browser closed'); return { browserClosed: true }; } }),
      checkOwner: async (_browser, options) => { events.push(['census', options.ownedPid]); return { ok: true }; },
      resetBrowser: async () => { pid = (pid ?? 40) + 1; return {}; },
      runAgent: async arm => { assert.match(arm.prompt, new RegExp('PID ' + pid)); mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
      observeBrowser: async () => { pid = undefined; return { observed: false, tabs: {}, reason: 'fixture unavailable', unavailableGraders: ['handoff'] }; } } });
  assert.equal(rows.length, 2); assert.equal(rows[0].observation.observed, false);
  assert.deepEqual(events, [['census', 40], ['census', undefined], 'sites closed', 'browser closed']);
  assert.equal(existsSync(lockPath), false);
});

test('a refusal during Firefox reset replaces the successful pre-task census receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2a-refusal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'out'), lockPath = join(dir, 'lock'); let stopped = false;
  const ownerCheck = { ok: false, otherPids: [999], error: 'new owner' };
  await assert.rejects(runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out }, tasks: [task],
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 40, stop: async () => { stopped = true; return { browserClosed: true }; } }),
      checkOwner: async () => ({ ok: true }),
      resetBrowser: async () => { throw Object.assign(Error('new owner'), { ownerCheck }); },
      runAgent: () => assert.fail('must not start an arm after an owner refusal') } }), /new owner/);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'browser.json'), 'utf8')).ownerCheck, ownerCheck);
  assert.equal(stopped, true);
  assert.equal(existsSync(lockPath), false);
});
