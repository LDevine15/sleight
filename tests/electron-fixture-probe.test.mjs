import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS, CELLS, runQualification } from '../bench/electron-qualification.mjs';
import { fakeDriver, fakeObserver } from '../bench/electron-qualification-fakes.mjs';
import { main } from '../bench/electron-live-runner.mjs';
import * as probe from '../bench/electron-fixture-probe.mjs';

test('the fixed probe omits destructive lifecycle cells and cannot qualify the app', async () => {
  assert.deepEqual(probe.FIXTURE_PROBE_CELLS.map(cell => cell.id), ['consent-card', 'connect', 'list', 'read', 'click', 'key', 'webview', 'new-window', 'quit']);
  let now = 1000;
  const clock = { now: () => now, sleep: async ms => { now += ms; } };
  const driver = fakeDriver({ now: clock.now });
  driver.fixtureObservation = async ({ fixtureName }) => ({ ok: true, fixtureName, frameCount: 1 });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: clock.now }),
    clock, io: { exists: () => false, permission: async () => false }, cells: probe.FIXTURE_PROBE_CELLS });
  assert.equal(receipt.qualified, false);
  assert.equal(receipt.cleanup.confirmed, true);
  assert.ok(receipt.validation.unqualified.length > 0);
  assert.equal(receipt.cells.find(cell => cell.id === 'key').detail.fixtureObservation.after.fixtureName, 'a-scratch.txt');
  assert.equal(receipt.cells.find(cell => cell.id === 'webview').detail.fixtureObservation.beforePreview.fixtureName, 'a-notes.md');
});

test('observations preserve the original editor failure and collect preview evidence around its chord', async () => {
  assert.equal(typeof probe.observeCell, 'function');
  const calls = [], diagnostic = { ok: true, matchedCount: 1 };
  const context = { tab: () => 't1', driver: { fixtureObservation: async args => { calls.push(args); return diagnostic; } },
    act: async (...args) => { calls.push(args); return {}; } };
  const failure = Object.assign(Error('EDITOR_NOT_FOUND'), { detail: { original: true } });
  const wrapped = probe.observeCell({ id: 'key', run: async () => { throw failure; } }, 'a-scratch.txt');
  await assert.rejects(wrapped.run(context), error => error === failure && error.detail.original && error.detail.fixtureObservation.after === diagnostic);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const preview = probe.observeCell({ id: 'webview', run: async c => {
    await c.act('t1', [{ do: 'press', key: 'Meta+Shift+V' }]);
    return { detail: { frameRef: true } };
  } }, 'a-notes.md');
  const result = await preview.run(context);
  assert.equal(result.detail.frameRef, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { tab: 't1', fixtureName: 'a-notes.md' });
  assert.deepEqual(calls[1], ['t1', [{ do: 'press', key: 'Meta+Shift+V' }]]);
  assert.equal(result.detail.fixtureObservation.after, diagnostic);
  assert.equal(probe.FIXTURE_PROBE_CELLS.find(cell => cell.id === 'new-window'), CELLS.find(cell => cell.id === 'new-window'));
});

test('diagnostic failure is bounded and never replaces the cell verdict', async () => {
  const wrapped = probe.observeCell({ id: 'key', run: async () => ({}) }, 'a-scratch.txt');
  const result = await wrapped.run({ tab: () => 't1', driver: { fixtureObservation: async () => { throw Error('private content'); } } });
  assert.deepEqual(result.detail.fixtureObservation.after, { ok: false, code: 'ELECTRON_FIXTURE_OBSERVATION_FAILED' });
});

test('probe invocation admits only mode and output and always runs qualification alone', () => {
  assert.deepEqual(probe.probeArgs(['--owner-away', '--out', '/fixture/out']), ['--owner-away', '--out', '/fixture/out', '--phases', 'qualify']);
  for (const argv of [['--phases', 'arm'], ['--samples', '0'], ['--model', 'anything'], ['--out'], ['--owner-away', '--dry-run']])
    assert.throws(() => probe.probeArgs(argv));
});

test('the runner dry run uses the exact probe subset and records no qualification', async t => {
  const out = mkdtempSync(join(tmpdir(), 'eq-probe-dry-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await main(probe.probeArgs(['--dry-run', '--out', out]), { qualificationCells: probe.FIXTURE_PROBE_CELLS, log: () => {} });
  const receipts = readdirSync(out).filter(name => name.startsWith('vscode-')).map(name => JSON.parse(readFileSync(join(out, name), 'utf8')));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].cells.map(cell => cell.id), probe.FIXTURE_PROBE_CELLS.map(cell => cell.id));
  assert.equal(receipts[0].qualified, false);
  assert.equal(receipts[0].diagnosticOnly, true);
});
