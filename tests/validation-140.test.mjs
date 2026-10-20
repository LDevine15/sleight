import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const moduleURL = new URL('../race-1017/validation-140.mjs', import.meta.url);

test('missing or changed provenance schedules both sides', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { reuseProblems } = await import(moduleURL);
  const a = { promptHash: 'p', harnessHash: 'h', model: 'haiku', effort: 'high', engine: 'e', tasks: ['one'], clean: true };
  assert.deepEqual(reuseProblems(a, a), []);
  for (const key of ['promptHash', 'harnessHash', 'model', 'effort', 'engine']) {
    assert.ok(reuseProblems(a, { ...a, [key]: 'different' }).some(p => p.includes(key)));
    assert.ok(reuseProblems({ ...a, [key]: null }, a).some(p => p.includes(key)));
  }
  assert.ok(reuseProblems({ ...a, clean: false }, a).length);
  assert.ok(reuseProblems(a, { ...a, tasks: ['one', 'two'] }).length);
});

test('plan preserves named A rounds and adds A only for changed tasks', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { planGroups } = await import(moduleURL);
  const groups = [{ id: 'native', rounds: 3, tasks: ['one', 'two'], a: ['old-1', 'old-2', 'old-3'],
    both: ['two'], seconds: 30, runner: 'native', model: 'haiku' }];
  const plan = planGroups(groups);
  assert.equal(plan.rounds.length, 6);
  assert.equal(plan.rounds.filter(r => r.side === 'A').length, 3);
  assert.deepEqual(plan.rounds.find(r => r.side === 'A').tasks, ['two']);
  assert.deepEqual(plan.rounds.find(r => r.side === 'B').tasks, ['one', 'two']);
  assert.deepEqual(plan.groups[0].a, ['old-1', 'old-2', 'old-3']);
});

test('scoring counts failures, names A evidence, and refuses incomplete comparisons', async () => {
  assert.ok(existsSync(moduleURL), 'validation planner is missing');
  const { compareRows } = await import(moduleURL);
  const rows = [
    { side: 'A', task: 'one', seconds: 10, passed: true, round: 'old-1' },
    { side: 'A', task: 'one', seconds: 30, passed: false, round: 'old-2' },
    { side: 'B', task: 'one', seconds: 15, passed: true, round: 'new-1' },
    { side: 'B', task: 'one', seconds: 15, passed: true, round: 'new-2' },
  ];
  const got = compareRows(rows, ['one'], 2);
  assert.equal(got.complete, true);
  assert.equal(got.table.A.one.expected, 40);
  assert.equal(got.table.B.one.expected, 15);
  assert.deepEqual(got.aRounds, ['old-1', 'old-2']);
  assert.equal(compareRows(rows.slice(0, 3), ['one'], 2).complete, false);
  assert.equal(compareRows([...rows, rows[0]], ['one'], 2).complete, false);
});

test('cleanup, engine or model uncertainty refuses continuation', async () => {
  const { safeResult } = await import(moduleURL);
  const dir = mkdtempSync(join(tmpdir(), 'vp1-receipt-'));
  const path = join(dir, 'result.json');
  const raw = { model: 'haiku', effort: 'high', engine: { version: 'e', changed: false },
    results: [{ task: 'one', seconds: 10, groupClean: true, models: ['haiku'] }], leftWindows: [], hygiene: { errors: [], trackingErrors: [] } };
  try {
    writeFileSync(path, JSON.stringify(raw));
    assert.equal(safeResult(path, 'native', ['one'], 'e', 'haiku'), true);
    for (const bad of [
      { ...raw, leftWindows: ['unclosed'] }, { ...raw, engine: { version: 'other', changed: false } },
      { ...raw, model: 'opus' }, { ...raw, results: [{ ...raw.results[0], groupClean: false }] },
      { ...raw, results: [] },
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      assert.equal(safeResult(path, 'native', ['one'], 'e', 'haiku'), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both builds use explicit current task catalogs, including the changed demoid prompt', async () => {
  const { roundCommand } = await import(moduleURL);
  assert.equal(typeof roundCommand, 'function', 'round command builder is missing');
  const root = '/owned/A', stem = '/owned/out/round';
  const r = { runner: 'browser', group: 'race-safari', browser: 'safari', model: 'haiku', tasks: ['demoid'] };
  const got = roundCommand(r, root, stem);
  assert.equal(got.command, '/bin/sh');
  assert.equal(got.args[got.args.indexOf('--tasks') + 1], '/owned/A/bench/world/tasks/fowlbrowser.json');
  const as3 = roundCommand({ ...r, group: 'as3-safari' }, root, stem);
  assert.equal(as3.args[as3.args.indexOf('--tasks') + 1], '/owned/A/bench/world/tasks/browser-open-heldout.json');
});

test('shared harness imports B helpers while leaving the A server path intact', async () => {
  const { sharedHarnessSource } = await import(moduleURL);
  assert.equal(typeof sharedHarnessSource, 'function', 'shared helper import staging is missing');
  const dir = mkdtempSync(join(tmpdir(), 'vp1-import-'));
  try {
    for (const d of ['A/bench', 'A/plugins', 'B/plugins']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'A/plugins/helper.mjs'), "export const value = 'old helper';\n");
    writeFileSync(join(dir, 'B/plugins/helper.mjs'), "export const value = 'shared helper';\n");
    const source = "import { value } from '../plugins/helper.mjs'; export { value }; export const server = '../plugins/server.mjs';\n";
    const got = sharedHarnessSource(source, 'bench/load.mjs', join(dir, 'B'));
    const file = join(dir, 'A/bench/load.mjs'); writeFileSync(file, got.source);
    const loaded = await import(pathToFileURL(file));
    assert.equal(loaded.value, 'shared helper');
    assert.equal(loaded.server, '../plugins/server.mjs');
    assert.deepEqual(got.imports, ['plugins/helper.mjs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline scorer checks actual model evidence, not just the driver receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vp1-score-'));
  try {
    const rounds = ['A', 'B'].map(side => ({ id: side, side, group: 'native', runner: 'native', model: 'haiku', tasks: ['one'] }));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ aBuild: 'a', bBuild: 'b', engine: 'e', harnessHash: 'hh', rounds,
      groups: [{ id: 'native', tasks: ['one'], both: ['one'], a: [], rounds: 1 }] }));
    for (const side of ['A', 'B']) {
      const result = join(dir, `${side}.json`), build = side.toLowerCase();
      writeFileSync(result, JSON.stringify({ sleight: { commit: build }, model: 'haiku', effort: 'high', engine: { version: 'e', changed: false },
        results: [{ task: 'one', arm: 'sleight', seconds: 10, passed: true, groupClean: true, models: ['haiku'] }],
        leftWindows: [], hygiene: { errors: [], trackingErrors: [] } }));
      writeFileSync(join(dir, `${side}.receipt.json`), JSON.stringify({ safe: true, build, harnessHash: 'hh', engine: 'e', result }));
    }
    writeFileSync(join(dir, 'full-check.receipt.json'), JSON.stringify({ build: 'b', code: 0 }));
    let got = spawnSync(process.execPath, [moduleURL.pathname, '--score', '--out', dir], { encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /A rounds: .*A\.json/);
    const changed = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'B.json')));
    changed.results[0].models = ['opus'];
    writeFileSync(join(dir, 'B.json'), JSON.stringify(changed));
    got = spawnSync(process.execPath, [moduleURL.pathname, '--score', '--out', dir], { encoding: 'utf8' });
    assert.notEqual(got.status, 0, 'edited model evidence was counted as a complete comparison');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zsh plan and invalid invocation never create output or run a child benchmark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vp1-plan-'));
  try {
    const command = new URL('../race-1017/validate-140.command', import.meta.url).pathname;
    assert.ok(existsSync(command), 'validation command is missing');
    const got = spawnSync('/bin/zsh', [command, '--plan', '--out', dir], { encoding: 'utf8' });
    assert.equal(got.status, 0, got.stderr);
    const plan = JSON.parse(got.stdout);
    assert.ok(plan.rounds.length >= 30);
    assert.equal(plan.live, false);
    assert.deepEqual(plan.groups.find(g => g.id === 'as3-safari').tasks,
      ['smoke-red', 'survey-p09', 'survey-p10', 'ao-moss-color', 'ao-cheapest-mug']);
    assert.deepEqual(plan.groups.find(g => g.id === 'race-safari').both.filter(t => t === 'demoid'), ['demoid']);
    assert.deepEqual(readdirSync(dir), []);
    const bad = spawnSync('/bin/zsh', [command, '--run', '--out', dir], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
