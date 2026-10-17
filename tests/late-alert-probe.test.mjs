import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrial, fakeIO, keyCode, keyTimes, parseArgs, percentile, runProbe, stats, summarize } from '../bench/late-alert-probe.mjs';

test('percentiles use nearest rank, so p95 of five trials is the largest', () => {
  assert.equal(percentile([30, 10, 50, 20, 40], 0.95), 50);
  assert.equal(percentile([30, 10, 50, 20, 40], 0.5), 30);
  assert.equal(percentile([5, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([], 0.95), null);
  assert.deepEqual(stats([120, null, 40, 80]), { n: 3, min: 40, p50: 80, p95: 120, max: 120 });
  assert.equal(stats([null]), null);
});

test('the summary counts seen, missed and errored trials, and late ones against the light wait', () => {
  const row = (firstSeenMs, notBeforeMs, extra = {}) => ({ scenario: 's', key: 'Return', seen: true, firstSeenMs, notBeforeMs,
    kinds: ['sheet'], sampleMs: 12, ...extra });
  const summary = summarize([row(90, 80), row(260, 240), row(400, 300, { kinds: ['sheet', 'focus'] }),
    { scenario: 's', key: 'Return', seen: false, kinds: [] }, { scenario: 's', key: 'Return', error: 'Baseline unstable' }], 250);
  assert.deepEqual(summary.s, { key: 'Return', trials: 5, seen: 3, missed: 1, errors: 1, beforeKey: 0, kinds: { sheet: 3, focus: 1 },
    sampleMs: 12, firstSeenMs: { n: 3, min: 90, p50: 260, p95: 400, max: 400 }, notBeforeMs: { n: 3, min: 80, p50: 240, p95: 300, max: 300 },
    possiblyLate: 2, surelyLate: 1 });
});

test('a trial brackets the change between the last unchanged sample and the first changed one', () => {
  const ok = sheets => ({ status: 'ok', matches: 1, window: 1, focus: { sheets, role: 'AXTextArea', subrole: null, inWindow: true } });
  const baseline = { status: 'ok', matches: 1, window: 1, sheets: 0, role: 'AXTextArea', subrole: null, inWindow: true };
  const samples = [
    { start: 1000, end: 1008, observed: ok(0) }, { start: 1010, end: 1018, observed: { status: 'unknown' } },
    { start: 1150, end: 1160, observed: ok(0) }, { start: 1170, end: 1182, observed: ok(1) }, { start: 1190, end: 1200, observed: ok(1) }];
  const result = analyzeTrial({ baseline, samples, reference: 1020, keyStart: 1010 });
  assert.equal(result.firstSeenMs, 162);
  assert.equal(result.notBeforeMs, 130);
  assert.deepEqual(result.kinds, ['sheet']);
  assert.equal(result.unknown, 1);
  assert.equal(result.beforeKey, false);
  assert.equal(result.transitions.length, 2);
  assert.equal(analyzeTrial({ baseline, samples: samples.slice(0, 3), reference: 1020 }).seen, false);
});

test('the key call reports when pressKey started and returned inside the engine', () => {
  assert.match(keyCode('Return'), /await app\.pressKey\("Return"\)/);
  assert.deepEqual(keyTimes('state\n[late-alert-key]{"keyStart":5,"keyDone":9}\nmore'), { keyStart: 5, keyDone: 9 });
  assert.equal(keyTimes('no marker'), undefined);
});

test('a live run needs --owner-away; a dry run does not', () => {
  assert.throws(() => parseArgs([]), /--owner-away/);
  assert.throws(() => parseArgs(['--owner-away', '--only', 'word']), /Unknown group/);
  assert.equal(parseArgs(['--owner-away', '--trials', '3']).trials, 3);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('the dry run walks every scenario and finds each simulated change within one sample of its delay', async () => {
  const delays = { 'super+f': 120, 'super+alt+shift+s': 300, 'super+option+shift+s': 300, Return: 60, Escape: 200 };
  const report = await runProbe({ trials: 2, groups: ['textedit', 'finder', 'excel'], dryRun: true }, fakeIO({ delays }));
  assert.deepEqual(report.trialErrors, []);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(Object.keys(report.summary).length, 12);
  for (const result of report.results) {
    const delay = delays[result.key];
    assert.ok(result.seen, result.scenario);
    assert.ok(result.notBeforeMs <= delay && result.firstSeenMs >= delay && result.firstSeenMs - delay <= 20,
      `${result.scenario}: ${result.notBeforeMs}..${result.firstSeenMs} vs ${delay}`);
  }
});

test('a rejected Save As key name is retried with "option" and kept out of the measurements', async () => {
  const report = await runProbe({ trials: 1, groups: ['textedit'], dryRun: true }, fakeIO({ rejectKeys: ['super+alt+shift+s'] }));
  assert.deepEqual(report.trialErrors, []);
  assert.deepEqual(report.keyAttempts.map(a => a.key), ['super+alt+shift+s']);
  assert.deepEqual(report.results.filter(r => r.scenario === 'textedit-save-sheet').map(r => [r.key, r.seen]), [['super+option+shift+s', true]]);
});

test('each Excel trial records what A1 held after typing, after Return and after the trial', async () => {
  const report = await runProbe({ trials: 2, groups: ['excel'], dryRun: true }, fakeIO());
  assert.deepEqual(report.readouts.map(r => `${r.trial}:${r.phase}`), ['1:after-typing', '1:after-return', '1:after-trial', '2:after-typing', '2:after-return', '2:after-trial']);
  assert.equal(report.readouts[1].dialogs, 1);
});
