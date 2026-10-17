import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkDecision } from '../bench/approve.mjs';
import { BENCH_APPS, REAL_APPS } from '../bench/tasks.mjs';
import { raceApps, raceBundles } from '../bench/fowl/support.mjs';
import { prepareRoundArms, roundArmPrep, terminalAncestor, admitRealGate, runGateAgent, realGatePlan } from '../bench/fowl/real-gate.mjs';
import { cuaDaemonPlan, ensureCuaDaemon } from '../bench/world/native-arms.mjs';

const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'race-arms-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const elicit = (server, app) => ({ mcp_server_name: server, message: `Allow Computer Use to use "${app}"?`,
  requested_schema: { properties: { choice: { enum: ['once', 'session', 'always'] } }, required: ['choice'] } });
const raceEnv = (browser, server) => ({ BENCH_SUITE: 'browser-race', BENCH_RACE_APPS: JSON.stringify(raceApps(browser)), BENCH_ARM_SERVERS: JSON.stringify([server]) });

test('every race app is on the benchmark allowlist', () => {
  for (const browser of ['chrome', 'helium', 'firefox', 'safari']) for (const app of raceApps(browser)) assert.ok([...BENCH_APPS, ...REAL_APPS].includes(app), app);
  assert.deepEqual(raceBundles('safari'), ['com.apple.Safari', 'com.apple.Preview', 'com.apple.TextEdit']);
});

test('a race approves its own browser for the arm\'s server and declines everything else', () => {
  const env = raceEnv('firefox', 'lcu');
  assert.deepEqual(benchmarkDecision(elicit('lcu', 'Firefox'), env).hookSpecificOutput, { hookEventName: 'Elicitation', action: 'accept', content: { choice: 'session' } });
  assert.equal(benchmarkDecision(elicit('lcu', 'Google Chrome'), env).hookSpecificOutput.action, 'decline');
  assert.equal(benchmarkDecision(elicit('cua', 'Firefox'), env).hookSpecificOutput.action, 'decline');
  // The native claim's world suite has no browsers but Helium: the first Firefox round's LCU declines.
  assert.equal(benchmarkDecision(elicit('lcu', 'Firefox'), { ...env, BENCH_SUITE: 'world' }).hookSpecificOutput.action, 'decline');
  // A listed app off the allowlist, or a malformed list, approves nothing.
  assert.equal(benchmarkDecision(elicit('lcu', 'Terminal'), { ...env, BENCH_RACE_APPS: '["Terminal"]' }).hookSpecificOutput.action, 'decline');
  assert.equal(benchmarkDecision(elicit('lcu', 'Firefox'), { ...env, BENCH_RACE_APPS: '{"Firefox":1}' }).hookSpecificOutput.action, 'decline');
});

test('Codex rounds hold the round\'s bundles in the engine\'s Always allow list and put it back', async t => {
  const dir = temporary(t), calls = [];
  const plan = { surface: 'codex', out: '/tmp/fb-rounds/real-x-codex', browser: { browser: 'firefox' } };
  const { receipt, release } = await prepareRoundArms(plan, { logs: dir, armHome: dir,
    approve: (ids, backup) => { calls.push(['approve', ids, backup]); return () => calls.push(['restore']); },
    daemon: () => assert.fail('no daemon for Codex') });
  assert.deepEqual(calls[0].slice(0, 2), ['approve', ['org.mozilla.firefox', 'com.apple.Preview', 'com.apple.TextEdit']]);
  assert.equal(receipt.approvalsBackup, join(dir, 'ComputerUseAppApprovals.before-real-x-codex.json'));
  await release();
  assert.deepEqual(calls.at(-1), ['restore']);
});

test('Cua rounds start its daemon first and stop only a daemon they started', async t => {
  const dir = temporary(t), calls = [];
  const plan = { surface: 'cua', out: '/tmp/x', browser: { browser: 'firefox' } };
  const { receipt, release } = await prepareRoundArms(plan, { armHome: dir, approve: () => assert.fail('no approvals for Cua'),
    daemon: async cwd => { calls.push(cwd); return { started: true, socket: join(cwd, 'driver.sock'), pids: [7], stop: async () => calls.push('stopped') }; } });
  assert.deepEqual(calls, [join(dir, 'mcp-cua-arm')]);
  assert.deepEqual(receipt.cuaDaemon, { started: true, socket: join(dir, 'mcp-cua-arm/driver.sock'), pids: [7] });
  await release();
  assert.equal(calls.at(-1), 'stopped');
  for (const surface of ['lcu', 'peekaboo', 'sleight']) {
    const none = await prepareRoundArms({ ...plan, surface }, { armHome: dir, approve: () => assert.fail(surface), daemon: () => assert.fail(surface) });
    assert.equal(none.receipt.approvals, undefined); assert.equal(none.receipt.cuaDaemon, undefined);
  }
  assert.match(roundArmPrep({ ...plan, surface: 'peekaboo' }, { armHome: dir }).host, /Terminal\.app/);
});

test('ensureCuaDaemon opens the app through LaunchServices only when nothing listens', async t => {
  const dir = temporary(t), runs = [];
  const live = await ensureCuaDaemon(dir, { listening: async () => true, run: () => assert.fail('already listening') });
  assert.equal(live.started, false);
  let polls = 0, listed = 0;
  const started = await ensureCuaDaemon(dir, { listening: async () => polls++ >= 2, run: (cmd, args) => runs.push([cmd, ...args]),
    pids: () => (listed++ ? [11, 99] : [11]), sleep: async () => {} });
  assert.equal(started.started, true); assert.deepEqual(started.pids, [99]);
  assert.deepEqual(runs[0], cuaDaemonPlan(dir).start);
  assert.deepEqual(runs[0].slice(0, 3), ['open', '-n', '-g']);
  assert.ok(!runs[0].some(arg => arg.startsWith('CUA_DRIVER_EMBEDDED')));
  assert.deepEqual(runs[0].slice(-4), ['--args', 'serve', '--socket', join(dir, 'driver.sock')]);
  await assert.rejects(ensureCuaDaemon(dir, { listening: async () => false, run: () => {}, pids: () => [], sleep: async () => {}, timeoutMs: 0 }), /did not listen/);
});

test('terminalAncestor walks the process tree to Terminal.app', () => {
  const tree = { 50: '40 /usr/local/bin/node', 40: '30 /bin/sh', 30: '20 -zsh', 20: '10 login', 10: '1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' };
  assert.equal(terminalAncestor(50, pid => tree[pid]), true);
  const desktop = { 50: '40 /usr/local/bin/node', 40: '1 /Applications/Claude.app/Contents/MacOS/Claude' };
  assert.equal(terminalAncestor(50, pid => desktop[pid]), false);
  assert.equal(terminalAncestor(50, () => { throw Error('gone'); }), false);
});

test('a Peekaboo round outside Terminal.app is refused before any setup', async t => {
  const dir = temporary(t);
  const task = { name: 'fixture', browser: 'firefox', prompt: 'Visit {browser}.', result: 'the answer' };
  const plan = realGatePlan({ args: { surface: 'peekaboo', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [task], armHome: dir });
  await assert.rejects(admitRealGate(plan, { terminal: () => false }), /open -a Terminal <file>\.command/);
});

test('Codex rows count failed engine calls as tool errors', async t => {
  const dir = temporary(t);
  const plan = { surface: 'codex', dir: join(dir, 'task'), task: { name: 'fixture' }, prompt: 'fixture' };
  const failed = { type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', result: { content: [{ type: 'text', text: 'Computer Use was not approved to use Firefox' }] } } };
  const run = await runGateAgent(plan, { runNativeCodex: async (_prompt, options) => {
    options.onEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed' } });
    options.onEvent(failed);
    return { groupClean: true, code: 0, out: { result: 'RESULT: none' }, stderr: '', forbidden: [], toolCalls: 2 };
  } });
  assert.equal(run.toolErrors, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'task/run.json'), 'utf8')).toolErrors, 1);
});

test('a live round prepares its arm before the browser launches and releases it after the agents', async t => {
  const { runRealGate } = await import('../bench/fowl/real-gate.mjs');
  const dir = temporary(t), events = [];
  const task = { name: 'fixture', browser: 'firefox', prompt: 'Visit {browser}.', result: 'the answer' };
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'firefox', out: join(dir, 'out') }, tasks: [task],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {},
      prepareArms: async plan => { events.push(['prep', plan.surface]); return { receipt: { approvals: ['x'] }, release: async () => events.push('release') }; },
      startSites: async () => ({ close: async () => events.push('sites closed') }),
      launchBrowser: async plan => { events.push('launch'); return { ...plan, pid: 40, stop: async () => { events.push('browser closed'); return {}; } }; },
      checkOwner: async () => ({ ok: true }), resetBrowser: async () => ({}),
      runAgent: async arm => { events.push('agent'); mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: x' } }; },
      observeBrowser: async () => ({ observed: false, tabs: {}, reason: 'fixture' }) } });
  assert.deepEqual(events, [['prep', 'codex'], 'launch', 'agent', 'release', 'sites closed', 'browser closed']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out/arm-prep.json'), 'utf8')), { approvals: ['x'] });
});
