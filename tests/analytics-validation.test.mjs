import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareAnalytics, analyticsArm, writeAnalyticsMcp, parseStats, checkPrivacy, validateAnalytics, checkLocalFile } from '../bench/analytics-validation.mjs';
import { ActionLog } from '../plugins/sleight/lib/action-outcomes.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const row = (changes = {}) => ({ time: '2026-10-19T12:00:02.000Z', pid: 41, call: 1, tool: 'js', app: 'Calculator',
  kind: 'click', result: 'ok', outcome: 'no visible change', ms: 2000, ...changes });
const summary = () => ({ log: '~/Library/Logs/sleight/bench-analytics-fixture.jsonl', files: 1, skipped: 0, days: 1,
  from: '2026-10-19T12:00:02.000Z', to: '2026-10-19T12:00:02.000Z', calls: 1, actions: 2, timed: 2, untimed: 0,
  paths: { native: { actions: 2, timed: 2, median: 1, p90: 1 }, turbo: { actions: 0, timed: 0, median: null, p90: null },
    engine: { actions: 0, timed: 0, median: null, p90: null } }, readsSaved: 1,
  refused: { count: 0, reasons: {} }, failed: { count: 0, reasons: {} }, notRun: 0 });
const event = (ms, direction, msg) => ({ t: new Date(Date.UTC(2026, 9, 19, 12, 0, 0, ms)).toISOString(), direction, msg });
const trace = () => [{ pid: 41, events: [
  event(0, 'call-received', { id: 1, params: { name: 'js' } }),
  event(0, 'to-server', { id: 1, method: 'tools/call' }),
  event(2000, 'to-client', { id: 1, result: {} }),
] }];
const validate = (changes = {}) => validateAnalytics({ rows: [row({ saved: 1 }), row()], stats: summary(), traces: trace(), ...changes });

test('preparation writes only a fresh temporary arm config and cannot select the owner config', t => {
  const parent = registerTemp(t, mkdtempSync('/tmp/x3-fixture-'));
  const bank = prepareAnalytics({ tempRoot: parent });
  const arm = analyticsArm(bank, { root: '/fixture/repo' });
  assert.equal(arm.cwd, join(bank, 'arm'));
  assert.equal(arm.env.CLAUDE_CONFIG_DIR, join(bank, 'claude'));
  assert.equal(arm.server.env.SLEIGHT_ACTION_LOG.startsWith('bench-analytics-'), true);
  assert.equal(arm.server.env.SLEIGHT_TRACE, join(bank, 'traces'));
  assert.equal(existsSync(join(bank, 'claude/settings.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(bank, 'plan.json'))).version, 1);
  assert.throws(() => analyticsArm('/Users/fixture/.claude', { root: '/fixture/repo' }), /ANALYTICS_BANK/);
  const alias = join(parent, 'alias'); symlinkSync(bank, alias);
  assert.throws(() => analyticsArm(alias, { root: '/fixture/repo' }), /ANALYTICS_BANK/);
});

test('MCP config writes cannot follow a link or truncate an owner file', t => {
  const parent = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-config-')));
  const bank = prepareAnalytics({ tempRoot: parent });
  const owner = join(parent, 'owner-settings.json'); writeFileSync(owner, '{"owner":true}', { mode: 0o600 });
  const descriptor = join(bank, 'arm/bench-mcp.json'); symlinkSync(owner, descriptor);
  assert.throws(() => writeAnalyticsMcp(bank), /ANALYTICS_CONFIG/);
  assert.equal(readFileSync(owner, 'utf8'), '{"owner":true}');
  const linked = prepareAnalytics({ tempRoot: parent }); linkSync(owner, join(linked, 'arm/bench-mcp.json'));
  assert.throws(() => writeAnalyticsMcp(linked), /ANALYTICS_CONFIG/);
  assert.equal(readFileSync(owner, 'utf8'), '{"owner":true}');
  const fresh = prepareAnalytics({ tempRoot: parent });
  const path = writeAnalyticsMcp(fresh);
  assert.equal(JSON.parse(readFileSync(path)).mcpServers['plugin:sleight:computer'].env.SLEIGHT_ACTION_LOG, analyticsArm(fresh).log);
  assert.equal(writeAnalyticsMcp(fresh), path, 'an unused bank can retry after login preflight');
});

test('stats parser rejects missing, nonfinite, negative, unknown and malformed fields', () => {
  assert.equal(parseStats(JSON.stringify(summary())).paths.native.median, 1);
  for (const bad of ['not json', '{}', JSON.stringify({ ...summary(), actions: -1 }),
    JSON.stringify({ ...summary(), calls: '1' }), JSON.stringify({ ...summary(), privateName: 'Robin' }),
    JSON.stringify({ ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: null, p90: 1 } } })]) {
    assert.throws(() => parseStats(bad), /ANALYTICS_STATS/);
  }
});

test('privacy checks reject personal data in every free text slot and unknown nested fields', () => {
  checkPrivacy([row({ target: { role: 'button', name: 'Save' }, key: 'Super+s' })]);
  for (const changes of [{ path: '/Users/Robin/private' }, { app: 'Robin Calculator' }, { call: 'Robin' },
    { outcome: 'Window: personal.txt' }, { reason: 'Robin' }, { origin: 'https://private.example' },
    { target: { role: 'button', name: 'Robin' } }, { target: { role: 'Robin' } },
    { target: { role: 'button', windowTitle: 'Private' } }, { key: 'Robin' }]) {
    assert.throws(() => checkPrivacy([row(changes)]), /ANALYTICS_PRIVACY/);
  }
});

test('validation deduplicates call time and counts both actions and one saved read', () => {
  assert.deepEqual(validate(), { calls: 1, actions: 2, readsSaved: 1, maxTimingDeltaMs: 0, tolerance: 'max(250 ms, 10% of trace call time)' });
  assert.throws(() => validate({ stats: { ...summary(), actions: 3 } }), /ANALYTICS_STATS_MISMATCH/);
  assert.throws(() => validate({ stats: { ...summary(), readsSaved: 2 } }), /ANALYTICS_STATS_MISMATCH/);
  assert.throws(() => validate({ stats: { ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: 2, p90: 2 } } } }), /ANALYTICS_STATS_MISMATCH/);
});

test('trace matching uses pid and call id, enforces tolerance, and refuses unrelated or incomplete evidence', () => {
  assert.equal(validate({ rows: [row({ ms: 1800, saved: 1 }), row({ ms: 1800 })],
    stats: { ...summary(), paths: { ...summary().paths, native: { actions: 2, timed: 2, median: 0.9, p90: 0.9 } } } }).maxTimingDeltaMs, 200);
  assert.throws(() => validate({ rows: [row({ ms: 100 }), row({ ms: 100 })] }), /ANALYTICS_TIMING/);
  assert.throws(() => validate({ rows: [row({ pid: 42 }), row({ pid: 42 })] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ traces: [] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ traces: [{ pid: 41, events: trace()[0].events.slice(0, 2) }] }), /ANALYTICS_TRACE/);
  assert.throws(() => validate({ rows: [row(), row({ ms: 1999 })] }), /ANALYTICS_CALL/);
});

test('trace timing subtracts overlapping engine approval waits once', () => {
  const traces = trace();
  traces[0].events.splice(2, 0, event(100, 'from-server', { id: 9, method: 'elicitation/create' }),
    event(200, 'from-server', { id: 10, method: 'elicitation/create' }),
    event(700, 'to-server', { id: 9, result: {} }), event(1100, 'to-server', { id: 10, result: {} }));
  const stats = summary(); stats.paths.native.median = stats.paths.native.p90 = 0.5;
  assert.equal(validate({ traces, rows: [row({ ms: 1000, saved: 1 }), row({ ms: 1000 })], stats }).maxTimingDeltaMs, 0);
});

test('native aggregates use weighted percentiles across calls, and preserve refusal and not-run counts', () => {
  const rows = [row({ saved: 1 }), row(), row({ call: 2, ms: 4000 }),
    row({ call: 2, ms: 4000, result: 'refused', reason: 'input lease' }),
    row({ call: 2, ms: 4000, kind: 'rest', result: 'not run', count: 3 })];
  const traces = trace();
  traces[0].events = [traces[0].events[0], traces[0].events[1],
    event(0, 'call-received', { id: 2, params: { name: 'js' } }), event(0, 'to-server', { id: 2, method: 'tools/call' }),
    event(2000, 'to-client', { id: 1, result: {} }), event(4000, 'to-client', { id: 2, result: {} })];
  const stats = summary();
  Object.assign(stats, { calls: 2, actions: 3, timed: 3, notRun: 3, refused: { count: 1, reasons: { 'input lease': 1 } } });
  stats.paths.native = { actions: 3, timed: 3, median: 1, p90: 3.4 };
  assert.equal(validateAnalytics({ rows, stats, traces }).actions, 3);
});

test('timing stops when a local consent prompt has no observable answer in the trace', () => {
  const traces = trace();
  traces[0].events.splice(2, 0, event(100, 'to-client', { id: 9, method: 'elicitation/create' }));
  assert.throws(() => validate({ traces }), /ANALYTICS_UNOBSERVABLE_PROMPT/);
});

test('locality rejects linked, shared, or public log files without modifying them', t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-local-')));
  const file = join(dir, 'log.jsonl'); writeFileSync(file, '{}\n', { mode: 0o600 });
  assert.equal(checkLocalFile(file, dir), '{}\n');
  const alias = join(dir, 'alias'); symlinkSync(file, alias);
  assert.throws(() => checkLocalFile(alias, dir), /ANALYTICS_LOCAL/);
  const hard = join(dir, 'hard'); linkSync(file, hard);
  assert.throws(() => checkLocalFile(hard, dir), /ANALYTICS_LOCAL/);
  chmodSync(file, 0o644);
  assert.throws(() => checkLocalFile(file, dir), /ANALYTICS_LOCAL/);
  assert.equal(readFileSync(file, 'utf8'), '{}\n');
});

test('offline CLI reads real logger output and stats, and rejects personal data hidden behind a duplicate JSON key', t => {
  const parent = registerTemp(t, realpathSync(mkdtempSync('/tmp/x3-cli-')));
  const bank = prepareAnalytics({ tempRoot: parent }), arm = analyticsArm(bank);
  const home = join(parent, 'home'), root = join(home, 'Library/Logs/sleight');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, arm.log), now = Date.now(), started = new Date(now - 2000).toISOString();
  let clock = 0;
  const log = new ActionLog({ path, root, home, names: [], pid: 41, now: () => new Date(now), clock: () => clock });
  log.request({ id: 1, method: 'tools/call', params: { name: 'js' } }); log.sent(1);
  log.outcomes(1, { app: 'Calculator', outcomes: [{ a: 'click' }, { a: 'pressKey', k: 'Return' }] });
  log.saved(1, 1); clock = 2000; log.reply({ id: 1, result: {} });
  writeFileSync(join(bank, 'traces/trace-41.jsonl'), [
    { t: started, direction: 'call-received', msg: { id: 1, params: { name: 'js' } } },
    { t: started, direction: 'to-server', msg: { id: 1, method: 'tools/call' } },
    { t: new Date(now).toISOString(), direction: 'to-client', msg: { id: 1, result: {} } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const check = () => spawnSync(process.execPath, ['bench/analytics-validation.mjs', 'check', bank], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: arm.env.CLAUDE_CONFIG_DIR },
  });
  const before = readFileSync(path, 'utf8'), good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).actions, 2);
  assert.equal(JSON.parse(good.stdout).readsSaved, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(path, before.replace('"app":"Calculator"', '"app":"Robin private window","app":"Calculator"'));
  const bad = check();
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'ANALYTICS_LOG_PARSE');
  assert.equal(bad.stdout, '');
});
