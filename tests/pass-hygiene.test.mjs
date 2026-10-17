import test from 'node:test';
import assert from 'node:assert/strict';
import * as hygiene from '../bench/pass-hygiene.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const app = (pid, start = pid) => ({ pid, start, bundle: `org.fixture.${pid}` });
const win = (id, pid, start = pid) => ({ ...app(pid, start), id, onScreen: true });
const baseline = { apps: [app(1), app(2)], windows: [win(10, 1), { ...win(20, 2), onScreen: false }] };
const current = { apps: [...baseline.apps, app(3), app(4)], windows: [...baseline.windows, win(11, 1), win(21, 2), win(30, 3), win(40, 4)] };

test('quits only proven cold launches; closes only new windows of other apps', () => {
  assert.deepEqual(hygiene.planWindows(baseline, current, [app(3), app(1)]), [
    { ...win(11, 1), action: 'close' }, { ...win(21, 2), action: 'close' },
    { ...app(3), action: 'quit' }, { ...win(40, 4), action: 'close' },
  ]);
});

test('PID reuse does not inherit launch ownership and window IDs are process-scoped', () => {
  const after = { apps: [app(1, 100)], windows: [win(10, 1, 100)] };
  assert.deepEqual(hygiene.planWindows(baseline, after, [app(1)]), [{ ...win(10, 1, 100), action: 'close' }]);
});

test('dry run prints every planned action without acting or stopping a daemon', async () => {
  const calls = [], logs = [];
  const result = await hygiene.finishWindows(baseline, {
    snapshot: async () => current, act: async item => calls.push(item), launched: [app(3)],
    dryRun: true, log: line => logs.push(line), daemons: [{ stop: () => calls.push('stop') }],
  });
  assert.equal(calls.length, 0);
  assert.equal(logs.filter(line => /would (close|quit|stop)/.test(line)).length, 5);
  assert.equal(result.planned.length, 4);
});

test('a refused quit and close are left in results; no prompt response is attempted', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, {
    snapshot: async () => current, launched: [app(3)],
    act: async item => { calls.push(item.action); throw new Error('prompt or identity changed'); }, log() {},
  });
  assert.deepEqual(calls, ['close', 'close', 'quit', 'close']);
  assert.equal(result.leftWindows.length, 4);
  assert.equal(result.errors.length, 4);
});

test('an owned app still running with no window after Quit is reported', async () => {
  let reads = 0;
  const result = await hygiene.finishWindows({ apps: [], windows: [] }, {
    snapshot: async () => ++reads === 1 ? { apps: [app(3)], windows: [win(30, 3)] } : { apps: [app(3)], windows: [] },
    launched: [app(3)], act: async () => {}, log() {},
  });
  assert.deepEqual(result.leftWindows, [{ ...app(3), reason: 'still running after Quit' }]);
});

test('a proven cold-launched app whose fixture window already closed still gets a gentle Quit', () => {
  assert.deepEqual(hygiene.planWindows({ apps: [], windows: [] }, { apps: [app(3)], windows: [] }, [app(3)]), [{ ...app(3), action: 'quit' }]);
});

test('an observation stop prevents every later action, including in other apps', async () => {
  let checks = 0;
  const result = await hygiene.finishWindows(baseline, { snapshot: async () => current,
    beforeAction: async () => { checks++; throw new Error('permission prompt'); }, act: () => assert.fail('blocked'), log() {} });
  assert.equal(checks, 1); assert.equal(result.leftWindows.length, 4);
});

test('permission, user interruption and uncollected drivers block window actions but collect owned daemons', async () => {
  const calls = [];
  const result = await hygiene.finishWindows(baseline, {
    snapshot: async () => current, blocked: true, act: () => assert.fail('blocked'), log() {},
    daemons: [{ stop: async () => calls.push('owned stop') }],
  });
  assert.deepEqual(calls, ['owned stop']);
  assert.equal(result.leftWindows.length, 4);
});

test('native adapter refuses an uncollected compiler or helper before claiming a baseline', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-compile-')));
  await assert.rejects(hygiene.beginPassHygiene({ cacheDir, run: async () => ({ stdout: '{}', groupClean: false, exit: { code: 0 } }) }), /group cleanup unconfirmed/);
});

test('native adapter checks its baseline and routes every helper through owned process collection', async t => {
  const cacheDir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-native-'))), calls = [];
  let malformed = true;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/xcrun') writeFileSync(args.at(-1), 'fake compiled helper');
    const request = command === '/usr/bin/xcrun' ? {} : JSON.parse(args[0]);
    return { stdout: JSON.stringify(request.action === 'snapshot' ? malformed ? {} : baseline : {}), groupClean: true, exit: { code: 0 } };
  };
  await assert.rejects(hygiene.beginPassHygiene({ cacheDir, run }), /snapshot unavailable or incomplete/);
  malformed = false;
  const pass = await hygiene.beginPassHygiene({ cacheDir, run });
  const result = await pass.finish({ dryRun: true, log() {} });
  assert.deepEqual(result.planned, []);
  assert.equal(calls.filter(call => call.command === '/usr/bin/xcrun').length, 1, 'compiled source hash is cached');
  assert.ok(calls.every(call => call.options.timeoutMs > 0));
});
