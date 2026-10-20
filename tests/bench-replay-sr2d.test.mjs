import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { TargetMapper, elementMapping, comparisonResult } = await import('../bench/replay/mapping.mjs');
const { replayCalls } = await import('../bench/replay/engine.mjs');
const runner = await import('../bench/replay/run.mjs');
const checks = await import('../bench/replay/checks.mjs');
const fixtures = await import('../bench/replay/fixtures.mjs');

const text = value => ({ content: [{ type: 'text', text: value }] });
const source = { server: 'plugin:sleight:computer', name: 'js' };
const tree = (window, id, group = 'A') => `Window: "${window}", App: TextEdit.\n0 window ${window}\n  1 group ${group}\n    ${id} button Save`;
const observe = (mapper, handle, window, oldId, newId) => mapper.observe(tree(window, oldId), tree(window, newId), { code: `await ${handle}.getAXState()` }, source);
const nativeRecording = () => ({ kind: 'native', task: { id: 'textedit-drag' }, metadata: {}, calls: [{
  ...source, id: '1', name: 'open_file', arguments: { app: 'TextEdit', path: '/tmp/sleight-bench/stamp/run/1234abcd-drag.txt' }, result: text('opened'),
}] });

test('native numbers cannot cross app handles, apps, windows or ancestor paths', () => {
  const mapper = new TargetMapper();
  observe(mapper, 'first', 'One', 2, 12);
  assert.equal(mapper.code('await first.click(2)'), 'await first.click(12)');
  assert.throws(() => mapper.code('await other.click(2)'), /receiver/i);
  observe(mapper, 'other', 'Two', 2, 22);
  assert.equal(mapper.code('await other.click(2)'), 'await other.click(22)');
  assert.throws(() => mapper.code('await first.click(2)'), /receiver/i);
  assert.throws(() => mapper.arguments({ app: 'com.apple.Safari', elementIndex: 2 }), /receiver|app/i);
  mapper.observe(tree('One', 2), tree('One', 12, 'B'), { code: 'await first.getAXState()' }, source);
  assert.throws(() => mapper.code('await first.click(2)'), /refresh required/i);
  assert.equal(elementMapping('1 group A\n  2 button Save', '11 group B\n  12 button Save').has(2), false);
});

test('selection changes expire native numbers until a tree for that window is observed', () => {
  const mapper = new TargetMapper(); observe(mapper, 'app', 'One', 2, 12);
  const receipt = n => JSON.stringify({ target: { appId: 'com.apple.TextEdit', title: 'Two' }, identity: { windowNumber: n } });
  mapper.observe(receipt(1), receipt(11), { app: 'TextEdit', title: 'Two' }, { ...source, name: 'select_window' });
  assert.throws(() => mapper.code('await app.click(2)'), /receiver|tree/i);
});

test('reacquiring another app or rebinding the observed receiver cannot reuse its tree', () => {
  const mapper = new TargetMapper(); observe(mapper, 'app', 'One', 2, 12);
  for (const code of ['let app = await cua.getApp("Safari"); await app.click(2)',
    'app = other; await app.click(2)', 'let app = other; await app.click(2)',
    'let app = await cua.getApp({ app: "TextEdit", title: "Two" }); await app.click(2)'])
    assert.throws(() => mapper.code(code), /receiver|window|app/i);
});

test('native plans validate fixtures and string mappings before any launch', async () => {
  const rec = nativeRecording();
  assert.equal(fixtures.prepareReplay(rec, '/private/tmp/sr2d-fixture').native.ctx.nonce, '1234abcd');
  assert.throws(() => fixtures.prepareReplay({ ...rec, calls: [] }, '/private/tmp/sr2d-fixture'), /exactly one/);
  assert.throws(() => fixtures.prepareReplay(rec, '/private/tmp/sr2d-fixture', { addString() { throw Error('mapping failed before launch'); } }), /mapping failed/);
  const dir = mkdtempSync(join(tmpdir(), 'sr2d-plan-'));
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ task: 'textedit-drag' }));
    writeFileSync(join(dir, 'events.jsonl'), [
      { message: { content: [{ type: 'tool_use', id: 'one', name: 'mcp__plugin_sleight_computer__open_file', input: { app: 'TextEdit', path: '/tmp/unowned.txt' } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'opened' }] } },
    ].map(JSON.stringify).join('\n'));
    await assert.rejects(runner.main([dir, '--plan']), /exactly one/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('A/B records per-call output changes and permits an expected baseline check failure', () => {
  const run = (variant, value, verdict, ms) => ({ variant, iteration: 1, verdict: 'pass', cleanupConfirmed: true,
    check: { verdict }, calls: [{ index: 0, name: 'drag', recordedArguments: {}, result: text(value), comparisonResult: text(value), toolMs: ms, verdict: 'pass' }] });
  const runs = [run('A', 'fixed', 'pass', 20000), run('B', 'old', 'fail', 40000)];
  const spec = { id: 'DP2', tool: 'drag', toolRatioBelow: 1 };
  const report = checks.campaignEvidence(runs, spec, { candidate: 'A', baseline: 'B' });
  assert.equal(report.verdict, 'pass');
  assert.equal(report.comparisons[0].calls[0].verdict, 'changed');
  assert.deepEqual(report.comparisons[0].calls[0].A, text('fixed'));
  assert.deepEqual(report.comparisons[0].calls[0].changes, [{ path: '$.content.0.text', A: 'fixed', B: 'old' }]);
  assert.equal(report.timing[0].ratio, 0.5);
  assert.equal(checks.campaignEvidence(runs, spec, { candidate: 'B', baseline: 'A' }).verdict, 'check-incomplete');
  runs[1].check.verdict = 'skip';
  assert.equal(checks.campaignEvidence(runs, spec, { candidate: 'A', baseline: 'B' }).verdict, 'check-incomplete');
  runs[1].check.verdict = 'fail'; runs[0].calls[0].toolMs = 80000;
  assert.equal(checks.campaignEvidence(runs, spec, { candidate: 'A', baseline: 'B' }).verdict, 'check-incomplete');
});

test('comparison canonicalizes changing handles and fixture aliases without hiding values', () => {
  const a = new TargetMapper(), b = new TargetMapper();
  for (const [mapper, fresh] of [[a, '/tmp/arm-a'], [b, '/tmp/arm-b']]) {
    mapper.addString('/tmp/old', fresh); mapper.addString('/private/tmp/old', fresh);
  }
  assert.deepEqual(comparisonResult(text('/tmp/arm-a Value: 7'), a), comparisonResult(text('/tmp/arm-b Value: 7'), b));
  assert.notDeepEqual(comparisonResult(text('/tmp/arm-a Value: 7'), a), comparisonResult(text('/tmp/arm-b Value: 8'), b));
});

test('the disabled switch is baseline in either A/B order and the old build is baseline', () => {
  const variants = [{ variant: 'A', env: { SLEIGHT_DP2: '0' } }, { variant: 'B', env: { SLEIGHT_DP2: '1' } }];
  assert.deepEqual(runner.comparisonRoles(variants, { switch: 'SLEIGHT_DP2' }, false), { candidate: 'B', baseline: 'A' });
  assert.deepEqual(runner.comparisonRoles(variants, {}, true), { candidate: 'B', baseline: 'A' });
  assert.throws(() => runner.comparisonRoles(variants, { switch: 'SLEIGHT_DP1' }, false), /needs/);
  assert.throws(() => runner.options(['--deadline-ms', '0']), /deadline/);
});

for (const reason of ['hold', 'permission', 'SIGINT', 'deadline']) test(`in-flight calls stop on ${reason} without sending another request`, async () => {
  const parent = new AbortController();
  const control = runner.replayControl({ parent: parent.signal, deadlineMs: reason === 'deadline' ? 10 : 1000, hold: () => false });
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let submitted = 0;
  const rows = [1, 2].map(id => ({ ...source, id: String(id), arguments: { code: 'await app.getAXState()' }, result: text('tree') }));
  const pending = replayCalls(rows, { signal: control.signal, beforeCall: control.beforeCall, call: () => { submitted++; started(); return new Promise(() => {}); } });
  await began;
  if (reason !== 'deadline') parent.abort(Error(reason));
  try {
    const result = await pending;
    assert.equal(result.verdict, 'diverge'); assert.equal(submitted, 1);
    assert.match(result.reason, new RegExp(reason, 'i'));
  } finally { control.dispose(); }
});

test('a hold first seen at cleanup aborts and retains the browser', async () => {
  const control = runner.replayControl({ hold: () => true });
  let stopped = 0, closed = 0;
  try {
    const result = await fixtures.cleanupRace({ browser: { stop: async () => { stopped++; } }, sites: { close: async () => { closed++; } }, signal: control.signal, beforeCall: control.beforeCall });
    assert.equal(result.cleanupConfirmed, false); assert.equal(stopped, 0); assert.equal(closed, 1);
    assert.equal(control.signal.aborted, true);
  } finally { control.dispose(); }
});

test('an abort before browser launch can confirm cleanup without retaining ownership', async () => {
  const control = new AbortController(); control.abort(Error('hold'));
  const result = await fixtures.cleanupRace({ signal: control.signal, beforeCall: () => { throw Error('hold'); } });
  assert.equal(result.cleanupConfirmed, true);
});

test('a baseline transport or mapping stop and unproved cleanup cannot become a passing comparison', () => {
  const good = { variant: 'A', iteration: 1, verdict: 'pass', cleanupConfirmed: true, check: { verdict: 'pass' }, calls: [] };
  for (const reason of ['confirmation or approval gate', 'MCP closed', 'Ambiguous target; refresh required']) {
    const baseline = { ...good, variant: 'B', verdict: 'diverge', reason, check: { verdict: 'fail' } };
    assert.equal(checks.campaignEvidence([good, baseline], {}, { candidate: 'A', baseline: 'B' }).verdict, 'diverge');
  }
  assert.equal(checks.campaignEvidence([{ ...good, cleanupConfirmed: false }], {}).verdict, 'diverge');
});

test('mapping reads are also interruptible and never proceed to input after abort', async () => {
  const mapper = new TargetMapper();
  mapper.observe(tree('One', 2), 'Window: "One", App: TextEdit.\n0 window One', { code: 'await app.getAXState()' }, source);
  const control = new AbortController(); let began;
  const started = new Promise(resolve => { began = resolve; }); let sent = 0;
  const pending = replayCalls([{ ...source, id: 'one', arguments: { code: 'await app.click(2)' }, result: text('saved') }], {
    mapper, signal: control.signal, call: () => { sent++; began(); return new Promise(() => {}); },
  });
  await started; control.abort(Error('permission'));
  assert.equal((await pending).reason, 'permission'); assert.equal(sent, 1);
});

test('unlisted bundle IDs and URLs refuse before transport, including nested JS selectors', async () => {
  for (const args of [
    { app: 'com.apple.Terminal' }, { url: 'https://example.invalid/' },
    { code: 'await cua.getApp("com.apple.Terminal")' },
    { code: 'await cua.getApp({ bundleId: "com.apple.Terminal" })' },
    { code: 'await cua["getApp"]("com.apple.Terminal")' },
    { code: 'await cua.getTab("https://" + "example.invalid")' },
    { url: 'ftp://example.invalid/' },
    { url: 'ssh://example.invalid/' },
    { url: 'about:blank' },
    { code: 'await cua.getTab({ url: dynamicUrl })' },
    { code: 'await app.setValue(2, "https://example.invalid/")' },
    { steps: [{ do: 'goto', url: 'http://127.0.0.1:9999/' }] },
    { code: 'await cua.getTab("https://en.wikipedia.org.evil.invalid/")' },
  ]) {
    let sent = 0;
    const result = await replayCalls([{ ...source, id: 'one', name: 'js', arguments: args, result: text('ok') }], { call: async () => { sent++; return text('ok'); } });
    assert.equal(sent, 0, JSON.stringify(args)); assert.match(result.reason, /allowlist/i);
  }
  const rec = nativeRecording();
  rec.calls[0].arguments.app = 'com.apple.Terminal';
  assert.throws(() => fixtures.prepareReplay(rec, '/private/tmp/sr2d-fixture'), /allowlist/i);
});
});
