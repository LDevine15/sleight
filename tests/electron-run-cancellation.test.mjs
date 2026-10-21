import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as runner from '../bench/electron-live-runner.mjs';
import { APPS, CELLS, RELAUNCH_CELLS, HOLD, runQualification, validateReceipt } from '../bench/electron-qualification.mjs';
const location = new URL('../bench/electron-run-cancellation.mjs', import.meta.url);
const cancellation = existsSync(location) ? await import(location) : {};
const tick = () => new Promise(resolve => setImmediate(resolve));
const pass = { status: 'pass', cleanup: { confirmed: true } };
const options = { phases: ['qualify', 'arm'], mode: 'live' };
function phaseDeps(signal, events, overrides = {}) {
  return { signal, log() {}, now: Date.now, sleep: tick, io: { exists: () => false },
    preflight: async () => ({ ok: true, problems: [], skips: {} }), watcher: { poll: async () => {}, summary: () => [] },
    lock: async () => { events.push('lock'); return async () => events.push('release'); },
    cleanup: async () => { events.push('cleanup'); return { confirmed: true }; },
    arm: async () => { events.push('arm'); return pass; }, ...overrides };
}
test('the consent cell accepts the real worker requested receipt without claiming a visible card', async () => {
  const card = { requested: true, shown: null, status: 'granted', by: 'user', scope: 'session', ms: 3 }, cards = [];
  await CELLS.find(cell => cell.id === 'consent-card').run({ state: {}, options: { consentWaitMs: 120000 },
    driver: { connect: async () => ({ card }) }, consent: row => cards.push(row) });
  assert.equal(cards[0].requested, true); assert.equal(cards[0].shown, null);
});
test('relaunch reuse refuses a new requested card even when native visibility is unknown', async () => {
  const identity = { pid: 4, pidBirth: 'owned' };
  await assert.rejects(RELAUNCH_CELLS.find(cell => cell.id === 'relaunch-reuse').run({
    driver: { identity: () => identity, nextTurn: async () => ({ launched: false, card: { requested: true, shown: null, status: 'granted' } }) },
    consent() {},
  }), /REUSE_ASKED_OR_LAUNCHED/);
});

test('SIGINT requests cancellation once and retains its handler until explicit disposal', () => {
  assert.equal(typeof cancellation.installRunCancellation, 'function');
  const events = new EventEmitter(), session = cancellation.installRunCancellation({ events });
  events.emit('SIGINT'); events.emit('SIGINT');
  assert.equal(session.signal.aborted, true);
  assert.equal(events.listenerCount('SIGINT'), 1);
  session.dispose(); assert.equal(events.listenerCount('SIGINT'), 0);
});
test('terminal publication precedes release and a failed save retains the lock', async () => {
  for (const fail of [false, true]) {
    const events = [], work = runner.runPhases({ options: { ...options, phases: ['qualify'] }, deps: phaseDeps(undefined, events, {
      qualify: async () => pass,
      publish: async () => { events.push('terminal-save'); if (fail) throw Error('WRITE_FAILED'); },
    }) });
    if (fail) await assert.rejects(work, /WRITE_FAILED/); else await work;
    assert.deepEqual(events, fail ? ['lock', 'cleanup', 'terminal-save'] : ['lock', 'cleanup', 'terminal-save', 'release']);
  }
});
test('a cancellation before a scheduled phase callback prevents its invocation', async () => {
  const controller = new AbortController(), events = [];
  const result = await runner.runPhases({ options: { ...options, phases: ['qualify'] }, deps: phaseDeps(controller.signal, events, {
    pump: async work => { controller.abort(); return work; }, qualify: async () => { events.push('phase-start'); return pass; },
  }) });
  assert.equal(result.code, 130); assert.equal(events.includes('phase-start'), false);
});
test('cancellation during outer cleanup has the same bounded grace and keeps the lock on timeout', async () => {
  const controller = new AbortController(), lifecycle = { cleanupAllowed: true }, events = []; let finish;
  const work = runner.runPhases({ options: { ...options, phases: ['qualify'] }, deps: phaseDeps(controller.signal, events, {
    lifecycle, cancelWaitMs: 1, qualify: async () => pass,
    cleanup: async () => { controller.abort(); return new Promise(resolve => { finish = resolve; setTimeout(() => resolve({ confirmed: true }), 25); }); },
  }) });
  const result = await work; assert.equal(result.keep, true); assert.equal(result.unsettled, true);
  assert.equal(result.code, 130); assert.equal(result.summary.interrupted, true);
  finish({ confirmed: true }); await tick(); assert.deepEqual(events, ['lock']);
});

test('cancellation awaits an in-flight phase before cleanup, records interruption and starts no later phase', async () => {
  const controller = new AbortController(), events = []; let finish;
  const pending = runner.runPhases({ options, deps: phaseDeps(controller.signal, events, {
    qualify: async ({ signal }) => { assert.equal(signal, controller.signal); events.push('work'); return new Promise(resolve => { finish = resolve; }); },
  }) });
  for (let attempt = 0; !finish && attempt < 20; attempt++) await tick();
  assert.equal(typeof finish, 'function', 'phase must receive the cancellation signal');
  controller.abort(); await tick();
  assert.deepEqual(events, ['lock', 'work']);
  finish(pass); const result = await pending;
  assert.equal(result.code, 130);
  assert.equal(result.summary.interrupted, true);
  assert.deepEqual(events, ['lock', 'work', 'cleanup', 'release']);
});

test('uncertain in-flight settlement keeps the lock and never races infrastructure cleanup', async () => {
  const controller = new AbortController(), events = []; let finish;
  const result = await runner.runPhases({ options, deps: phaseDeps(controller.signal, events, { cancelWaitMs: 1,
    qualify: async () => { controller.abort(); return new Promise(resolve => { finish = resolve; setTimeout(() => resolve(pass), 50); }); },
  }) });
  assert.equal(result.keep, true);
  assert.equal(result.unsettled, true);
  assert.deepEqual(events, ['lock']);
  finish(pass);
});

test('cancellation during a hold prevents lock acquisition and phase launch', async () => {
  const controller = new AbortController(), events = []; let holds = 0;
  const result = await runner.runPhases({ options, deps: phaseDeps(controller.signal, events, {
    io: { exists: path => path === HOLD && holds++ === 0 }, sleep: async () => { controller.abort(); },
    qualify: async () => { events.push('qualify'); return pass; },
  }) });
  assert.equal(result.code, 130);
  assert.equal(result.summary.interrupted, true);
  assert.deepEqual(events, []);
});

test('a settled cell cannot issue its next driver action after cancellation; cleanup still runs', async () => {
  const controller = new AbortController(), events = []; let finish;
  const driver = { tool: async () => { events.push('tool'); if (finish) return { text: '', isError: false }; return new Promise(resolve => { finish = resolve; }); },
    identity: () => null, cleanup: async () => { events.push('cleanup'); return { confirmed: true }; } };
  const clock = { now: Date.now, sleep: tick }, observer = { start: async () => {}, stop: async () => events.push('observer-stop'), samples: async () => [] };
  const pending = runQualification({ app: APPS.vscode, driver, observer, io: { exists: () => false, permission: async () => null }, clock,
    options: { signal: controller.signal }, cells: [{ id: 'first', async run(c) {
      await c.driver.tool('first', {}); await c.driver.tool('second', {});
    } }, { id: 'later', run: async () => events.push('later') }] });
  for (let attempt = 0; !finish && attempt < 20; attempt++) await tick();
  assert.equal(typeof finish, 'function'); controller.abort(); await tick();
  assert.deepEqual(events, ['tool']); finish({ text: '', isError: false });
  const receipt = await pending;
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.qualified, false);
  assert.equal(receipt.stopped.reason, 'interrupted');
  assert.deepEqual(events, ['tool', 'cleanup', 'observer-stop']);
});

test('an interrupted receipt cannot qualify even when all requested cells and cleanup pass', () => {
  const verdict = validateReceipt({ kind: 'electron-qualification', mode: 'live', interrupted: true, app: { bundleId: APPS.vscode.bundleId },
    profile: { temporary: true }, cells: [], cleanup: { confirmed: true } }, { required: [] });
  assert.equal(verdict.qualified, false);
  assert.ok(verdict.unqualified.includes('RUN_INTERRUPTED'));
});

test('an early runner failure retains its evidence root and saves a closed summary', async t => {
  assert.equal(typeof runner.runMain, 'function');
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'cancel-run-')))); t.after(() => rmSync(bank, { recursive: true, force: true }));
  const root = join(bank, 'elr-fixture'), out = join(bank, 'out');
  const { mkdirSync } = await import('node:fs'); mkdirSync(root);
  const result = await runner.runMain(['--owner-away', '--out', out], { log() {}, createRoot: () => root,
    resolvePython: async () => { throw Error('private diagnostic must not escape'); } });
  assert.equal(result.keep, true); assert.equal(existsSync(root), true);
  const file = readdirSync(out).find(name => name.startsWith('live-run-'));
  const receipt = JSON.parse(readFileSync(join(out, file), 'utf8'));
  assert.equal(receipt.cleanup.confirmed, false);
  assert.equal(JSON.stringify(receipt).includes('private diagnostic'), false);
});

test('a phase that settles after the grace deadline cannot resume cell actions, cleanup or removal', async t => {
  const controller = new AbortController(), lifecycle = { cleanupAllowed: true }, events = [];
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-late-cancel-')));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  let finish, phase;
  const driver = { tool: async () => { events.push('tool'); await new Promise(resolve => { finish = resolve; }); return {}; },
    identity: () => null, cleanup: async () => { events.push('late-cleanup'); rmSync(bank, { recursive: true }); return { confirmed: true }; } };
  const resultPromise = runner.runPhases({ options, deps: phaseDeps(controller.signal, events, { lifecycle, cancelWaitMs: 1,
    qualify: () => phase = runQualification({ app: APPS.vscode, driver,
      observer: { start() {}, stop: async () => events.push('observer-stop'), samples: async () => [] },
      io: { exists: () => false, permission: async () => null }, clock: { now: Date.now, sleep: tick },
      options: { signal: controller.signal, lifecycle }, cells: [{ id: 'first', run: async c => {
        await c.driver.tool(); await c.driver.tool();
      } }] }),
  }) });
  for (let attempt = 0; !finish && attempt < 20; attempt++) await tick();
  assert.equal(typeof finish, 'function'); controller.abort();
  const result = await resultPromise;
  assert.equal(result.keep, true); assert.equal(result.unsettled, true);
  finish(); const receipt = await phase; await tick();
  assert.equal(receipt.interrupted, true);
  assert.deepEqual(events, ['lock', 'tool']);
  assert.equal(existsSync(bank), true);
});

test('an early interrupted run saves an unqualified receipt', async t => {
  const events = new EventEmitter(), observed = [], bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-main-cancel-')));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const root = join(bank, 'root'), out = join(bank, 'out');
  const { mkdirSync } = await import('node:fs'); mkdirSync(root);
  const controller = new AbortController();
  const lifecycle = { cleanupAllowed: true };
  const result = await runner.runMain(['--owner-away', '--out', out], { signal: controller.signal, lifecycle,
    log() {}, createRoot: () => root, resolvePython: async () => { controller.abort(); throw Error('cancelled'); } });
  assert.equal(result.code, 130); assert.equal(result.keep, true);
  assert.equal(result.summary.interrupted, true); assert.equal(existsSync(root), true);
  const receipt = JSON.parse(readFileSync(join(out, readdirSync(out).find(name => name.startsWith('live-run-'))), 'utf8'));
  assert.equal(receipt.qualified, false); assert.equal(receipt.interrupted, true);
  const cancellationState = cancellation.installRunCancellation({ events });
  cancellationState.signal.addEventListener('abort', () => observed.push('abort'));
  events.emit('SIGTERM'); events.emit('SIGINT');
  assert.deepEqual(observed, ['abort']); cancellationState.dispose();
});
test('main retains installed SIGINT and SIGTERM handlers when ownership is unsettled', async t => {
  const events = new EventEmitter(), bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-main-handler-'))));
  t.after(() => { events.removeAllListeners(); rmSync(bank, { recursive: true, force: true }); });
  const root = join(bank, 'root'), out = join(bank, 'out'), lifecycle = { cleanupAllowed: true };
  const { mkdirSync } = await import('node:fs'); mkdirSync(root);
  const code = await runner.main(['--owner-away', '--out', out], { signals: events, lifecycle, log() {}, createRoot: () => root,
    resolvePython: async () => { events.emit('SIGTERM'); lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; throw Error('unsettled'); } });
  assert.equal(code, 130); assert.equal(events.listenerCount('SIGINT'), 1); assert.equal(events.listenerCount('SIGTERM'), 1);
  events.emit('SIGINT'); assert.equal(existsSync(root), true);
  const receipt = JSON.parse(readFileSync(join(out, readdirSync(out).find(name => name.startsWith('live-run-')))));
  assert.equal(receipt.interrupted, true); assert.equal(receipt.qualified, false);
});
test('a terminal write failure cannot remove a run evidence root', async t => {
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-summary-fail-')))); t.after(() => rmSync(bank, { recursive: true, force: true }));
  const root = join(bank, 'root'), out = join(bank, 'out'); (await import('node:fs')).mkdirSync(root);
  await assert.rejects(runner.runMain(['--dry-run', '--out', out], { log() {}, createRoot: () => root,
    writeSummary: async () => { throw Error('WRITE_FAILED'); } }), /WRITE_FAILED/);
  assert.equal(existsSync(root), true);
});
