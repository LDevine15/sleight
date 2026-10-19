import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { compatApproval, docsDiff, engineTier, lastRecord, launcherChecks, liveTier, mergeEntries, publish, rawEngineChecks,
  record, renderPage, runDoctor, runWatch, summary, verdictOf } from '../bench/compat.mjs';

const fake = fileURLToPath(new URL('./fixtures/compat-engine.mjs', import.meta.url));
const server = (mode = 'ok') => ({ command: process.execPath, args: [fake], env: { COMPAT_FAKE_MODE: mode } });

function temp(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-compat-mac-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A launcher whose --doctor prints a version (or fails) and otherwise serves the fake engine as sleight would.
function launcher(dir, { version = '26.1013.1001501', fail = false } = {}) {
  const path = join(dir, 'sleight-mcp');
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --doctor ]; then\n${fail ? '  echo "MISSING   node_repl: /x"; exit 1' : `  echo "Codex computer-use ${version}"; echo "live read ok (helper inventory)"; exit 0`}\nfi\nCOMPAT_FAKE_MODE=launcher exec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  return path;
}

test('the doctor result carries the engine version or the first problem line', async t => {
  const dir = temp(t);
  const ok = await runDoctor(launcher(dir), process.env);
  assert.equal(ok.version, '26.1013.1001501');
  assert.equal(ok.result.status, 'pass');
  const bad = await runDoctor(launcher(join(dir, '..', dir.split('/').at(-1)), { fail: true }), process.env);
  assert.equal(bad.result.status, 'fail');
  assert.match(bad.result.reason, /^MISSING/);
  assert.equal((await runDoctor(join(dir, 'absent'), process.env)).result.status, 'fail');
});

test('the raw engine checks pass on the recorded engine and name what broke', async () => {
  const ok = await rawEngineChecks(server(), process.env);
  assert.deepEqual(ok.steps.filter(s => s.status !== 'pass'), []);
  assert.deepEqual(ok.steps.map(s => s.id), ['tool-surface', 'js-description', 'api-contract', 'doc-headings', 'policy-rewrite', 'repl-probe', 'turn-end']);
  assert.match(ok.docs, /^## Computer Use/);
  assert.match((await rawEngineChecks(server('no-turn-end'), process.env)).steps[0].reason, /no turn_ended/);
  assert.equal((await rawEngineChecks(server('new-policy'), process.env)).steps.find(s => s.id === 'policy-rewrite').status, 'warn');
  assert.match((await rawEngineChecks(server('probe-missing'), process.env)).steps.find(s => s.id === 'repl-probe').reason, /cua\.getTab/);
  const open = options => import('../bench/compat/client.mjs').then(m => m.openClient({ ...options, timeoutMs: 300, graceMs: 100, forceMs: 300 }));
  const hung = await rawEngineChecks(server('hang'), process.env, { open });
  assert.equal(hung.steps.at(-1).status, 'error');
  assert.equal(verdictOf(hung.steps), 'error');
});

test('the launcher check needs js and select_window', async t => {
  const dir = temp(t);
  assert.equal((await launcherChecks(launcher(dir), process.env))[0].status, 'pass');
  assert.match((await launcherChecks(process.execPath, { ...process.env, COMPAT_FAKE_MODE: 'ok' }, { open: o => import('../bench/compat/client.mjs').then(m => m.openClient({ ...o, args: [fake] })) }))[0].reason, /select_window/);
});

test('the docs diff compares against the last accepted version only', async t => {
  const logs = temp(t);
  assert.match((await docsDiff(logs, '2', 'a\nb\n', undefined))[0].reason, /no earlier version/);
  writeFileSync(join(logs, 'engine-raw-1.md'), 'a\nb\n');
  assert.match((await docsDiff(logs, '2', 'a\nb\n', '1'))[0].reason, /unchanged since 1/);
  const changed = await docsDiff(logs, '2', 'a\nc\nd\n', '1');
  assert.equal(changed[0].status, 'warn');
  assert.match(changed[0].reason, /^3 lines changed since 1/);
  assert.ok(existsSync(join(logs, 'engine-raw-2.diff')));
  assert.match((await docsDiff(logs, '3', 'x', '0'))[0].reason, /no raw snapshot of 0/);
});

test('the engine tier runs doctor, raw engine, launcher and diff in order', async t => {
  const dir = temp(t);
  const tier = await engineTier({ launcher: launcher(dir), logs: dir, resolve: () => server() });
  assert.equal(tier.version, '26.1013.1001501');
  assert.equal(verdictOf(tier.steps), 'pass');
  assert.deepEqual([tier.steps[0].id, ...tier.steps.slice(-2).map(s => s.id)], ['doctor', 'sleight-start', 'api-docs']);
  const failed = await engineTier({ launcher: launcher(dir, { fail: true }), logs: dir, resolve: () => { throw new Error('not called'); } });
  assert.equal(failed.steps.length, 1);
  assert.equal((await engineTier({ launcher: launcher(dir), logs: dir, resolve: () => ({ error: 'no engine' }) })).steps.at(-1).status, 'fail');
});

test('approvals go only to Calculator and Safari on the benchmark allowlist', async () => {
  assert.equal((await compatApproval({ message: 'Allow Computer Use to use "Calculator"?', requestedSchema: { type: 'object', properties: {} } })).action, 'accept');
  assert.equal((await compatApproval({ message: 'Allow Claude to select a window in Safari? It changes the main window.', requestedSchema: { type: 'object', properties: {} } })).action, 'accept');
  assert.equal((await compatApproval({ message: 'Allow Computer Use to use "TextEdit"?', requestedSchema: { type: 'object', properties: {} } })).action, 'decline');
  assert.equal((await compatApproval({ message: 'Allow Computer Use to use "Mail"?' })).action, 'decline');
});

test('the live tier waits for owner-away and the lock, and keeps the lock when cleanup failed', async t => {
  const dir = temp(t);
  const lockPath = join(dir, 'live.lock'), holdPath = join(dir, 'hold');
  assert.match((await liveTier({ ownerAway: false, lockPath, holdPath })).pending, /--owner-away/);
  writeFileSync(holdPath, '');
  assert.match((await liveTier({ ownerAway: true, lockPath, holdPath })).pending, /hold exists/);
  rmSync(holdPath);
  const { acquireLiveLock } = await import('../bench/live-lock.mjs');
  const held = await acquireLiveLock(lockPath);
  assert.match((await liveTier({ ownerAway: true, lockPath, holdPath })).steps[0].reason, /Another live run holds/);
  await held();
  const real = await import('../bench/compat/live.mjs');
  const live = (calc, browser) => ({ ...real, idleSeconds: async () => 999, runCalculator: async () => calc, runBrowserRead: async () => browser, fixtures: {} });
  const open = async () => ({ close: async () => true });
  const passed = await liveTier({ ownerAway: true, lockPath, holdPath, open, live: live({ id: 'live-calculator', status: 'pass' }, { id: 'live-browser-read', status: 'pass' }) });
  assert.deepEqual(passed.steps.map(s => s.status), ['pass', 'pass']);
  assert.equal(existsSync(lockPath), false);
  const dirty = await liveTier({ ownerAway: true, lockPath, holdPath, open, live: live({ id: 'live-calculator', status: 'fail', cleanup: 'quit unconfirmed' }, { id: 'live-browser-read', status: 'skip' }) });
  assert.equal(dirty.steps.at(-1).id, 'live-lock');
  assert.equal(existsSync(lockPath), true);
});

test('watch: unchanged versions only log, a new version records and notifies, failures keep retrying', async t => {
  const dir = temp(t);
  // Live checks off whatever the shell says, so this test can never reach a real app or the real live lock.
  const env = { ...process.env, SLEIGHT_COMPAT_LIVE: '0' };
  const logs = join(dir, 'logs');
  const notes = [];
  const deps = version => ({ launcher: launcher(join(dir), { version }), resolve: () => server(), notify: async text => notes.push(text) });
  mkdirSync(join(dir), { recursive: true });
  assert.equal(await runWatch({ env, logs, deps: deps('1.0') }), 0);
  assert.equal(readFileSync(join(logs, 'watch-engine-version'), 'utf8'), '1.0\n');
  assert.equal(readFileSync(join(logs, 'compat-accepted'), 'utf8'), '1.0\n');
  assert.match(notes[0], /updated to 1\.0\. sleight passed the compatibility check \(live checks not run\)/);
  assert.equal(lastRecord(logs, '1.0').verdict, 'pass');
  assert.equal(await runWatch({ env, logs, deps: deps('1.0') }), 0);
  assert.match(readFileSync(join(logs, 'watch.log'), 'utf8'), /doctor ok, engine 1\.0 unchanged/);
  assert.equal(notes.length, 1);

  const broken = { ...deps('2.0'), resolve: () => server('no-turn-end') };
  assert.equal(await runWatch({ env, logs, deps: broken }), 1);
  assert.match(notes[1], /engine 2\.0: compatibility check FAIL at tool-surface \(no turn_ended tool\)/);
  // A contract failure was checked, so the version advances; the baseline stays at the last pass.
  assert.equal(readFileSync(join(logs, 'watch-engine-version'), 'utf8'), '2.0\n');
  assert.equal(readFileSync(join(logs, 'compat-accepted'), 'utf8'), '1.0\n');

  const open = options => import('../bench/compat/client.mjs').then(m => m.openClient({ ...options, timeoutMs: 300, graceMs: 100, forceMs: 300 }));
  assert.equal(await runWatch({ env, logs, deps: { ...deps('3.0'), resolve: () => server('hang'), open } }), 1);
  assert.equal(readFileSync(join(logs, 'watch-engine-version'), 'utf8'), '2.0\n');

  assert.equal(await runWatch({ env, logs, deps: { ...deps('3.0'), launcher: launcher(join(dir), { fail: true }) } }), 1);
  assert.match(notes.at(-1), /Doctor failed/);
  assert.equal(readFileSync(join(logs, 'compat.jsonl'), 'utf8').trim().split('\n').length, 4);
});

test('watch with live checks on retries them while they are pending', async t => {
  const dir = temp(t);
  const logs = join(dir, 'logs');
  const env = { ...process.env, SLEIGHT_COMPAT_LIVE: '1' };
  let liveResult = { pending: 'busy', steps: [{ id: 'live', status: 'pending', reason: 'busy' }] };
  const calls = [];
  const deps = { launcher: launcher(dir, { version: '5.0' }), resolve: () => server(), notify: async () => {},
    liveOptions: { live: { liveGate: () => (calls.push('gate'), liveResult.pending ? { pending: liveResult.pending } : { ok: true }), idleSeconds: async () => 999 } } };
  await runWatch({ env, logs, deps });
  assert.equal(lastRecord(logs, '5.0').live, 'pending');
  liveResult = { steps: [] };
  deps.liveOptions = { lock: async () => async () => {}, open: async () => ({ close: async () => true }), holdPath: join(dir, 'hold'),
    live: { liveGate: () => ({ ok: true }), idleSeconds: async () => 999, fixtures: {}, runCalculator: async () => ({ id: 'live-calculator', status: 'pass' }),
      runBrowserRead: async () => ({ id: 'live-browser-read', status: 'pass' }) } };
  await runWatch({ env, logs, deps });
  const entry = lastRecord(logs, '5.0');
  assert.equal(entry.tier, 'live');
  assert.equal(entry.live, 'pass');
  await runWatch({ env, logs, deps });
  assert.match(readFileSync(join(logs, 'watch.log'), 'utf8').trim().split('\n').at(-1), /unchanged/);
});

test('publish merges Mac and static results into one page with UTC dates and versions', async t => {
  const dir = temp(t);
  const logs = join(dir, 'logs');
  mkdirSync(logs);
  record(logs, { checkedAt: '2026-10-19T09:00:00.000Z', source: 'watch', tier: 'engine', appVersion: '26.1013.40934', engineVersion: '26.1013.1001501',
    verdict: 'pass', live: 'pending', steps: [{ id: 'js-description', status: 'warn', reason: 'changed | wording' }] });
  writeFileSync(join(dir, 'static.jsonl'), JSON.stringify({ checkedAt: '2026-10-19T05:00:00.000Z', source: 'static', appVersion: '26.1013.40934', engineVersion: '26.1013.1001501', verdict: 'pass', steps: [] }) + '\n');
  const data = join(dir, 'data.json'), page = join(dir, 'page.md');
  writeFileSync(data, JSON.stringify({ entries: [{ checkedAt: '2026-10-14T13:00:30Z', source: 'watch-task', appVersion: null, engineVersion: '26.1007.71326', verdict: 'pass', notes: [] }] }));
  assert.equal(publish({ logs, staticLogs: [join(dir, 'static.jsonl')], data, page }), 3);
  assert.equal(publish({ logs, staticLogs: [join(dir, 'static.jsonl')], data, page }), 3);
  const text = readFileSync(page, 'utf8');
  const rows = text.split('\n').filter(line => /^\| 2026/.test(line));
  assert.deepEqual(rows.map(row => row.split(' | ')[0]), ['| 2026-10-19 09:00', '| 2026-10-19 05:00', '| 2026-10-14 13:00']);
  assert.match(rows[0], /\| Mac \| pass \| pending \| js-description: changed \\\| wording \|$/);
  assert.match(rows[2], /Mac \(watch task\)/);
  assert.equal(mergeEntries([], [{ source: 'x' }]).length, 0);
  assert.match(renderPage([]), /^# Engine compatibility/);
  assert.match(summary({ engineVersion: '1', appVersion: '2', verdict: 'pass', live: 'not run', steps: [{ id: 'doctor', status: 'pass' }] }), /^compat 1 \(ChatGPT 2\): PASS, live not run\n  pass    doctor$/);
});
