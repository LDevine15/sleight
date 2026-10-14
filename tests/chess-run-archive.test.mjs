import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as archive from '../bench/run-archive.mjs';
import { webBrowsers } from '../bench/tasks-web.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { genericTask } from '../bench/generic-task.mjs';
import { tasks } from '../bench/tasks.mjs';

function fixture(t) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'bench-chess-archive-'))));
  const benchDir = join(root, 'sleight-bench'), archiveDir = join(root, 'archive');
  const stamp = '2026-10-14T19-00-00-000Z';
  const make = (name, pass = stamp) => {
    const dir = join(benchDir, pass, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trace.jsonl'), name + '\n');
    writeFileSync(join(dir, 'saved.game'), '<key>Moves</key><string>e2e4</string>');
    return dir;
  };
  const current = make('codex-chess-drag-2');
  return { root, benchDir, archiveDir, stamp, make, current };
}

test('Chess archiving moves every earlier arm and repetition, preserving evidence and the current target', t => {
  const f = fixture(t);
  const earlier = [f.make('sleight-chess-drag-1'), f.make('codex-chess-drag-1'),
    f.make('lcu-chess-drag-1', '2026-10-14T18-59-00-000Z')];
  assert.equal(typeof archive.archiveChessRuns, 'function');
  const moved = archive.archiveChessRuns(f.current, f);
  assert.equal(moved.length, earlier.length);
  for (const from of earlier) {
    assert.equal(existsSync(from), false);
    const record = moved.find(item => item.from === from);
    assert.ok(record.to.startsWith(f.archiveDir + '/'));
    assert.equal(readFileSync(join(record.to, 'trace.jsonl'), 'utf8'), from.split('/').at(-1) + '\n');
    assert.equal(readFileSync(join(record.to, 'saved.game'), 'utf8'), '<key>Moves</key><string>e2e4</string>');
  }
  assert.equal(readFileSync(join(f.current, 'trace.jsonl'), 'utf8'), 'codex-chess-drag-2\n');
});

test('Chess archiving leaves unrelated names, files and symlinked folders alone', t => {
  const f = fixture(t);
  const unrelated = [f.make('sleight-textedit-drag-1'), f.make('notes-chess-drag-other'),
    f.make('sleight-chess-drag-1', 'personal')];
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.benchDir, f.stamp, 'sleight-chess-drag-4'));
  symlinkSync(outside, join(f.benchDir, '2026-10-14T18-00-00-000Z'));
  const file = join(f.benchDir, f.stamp, 'sleight-chess-drag-3');
  writeFileSync(file, 'keep');
  assert.equal(typeof archive.archiveChessRuns, 'function');
  assert.deepEqual(archive.archiveChessRuns(f.current, f), []);
  for (const path of [...unrelated, outside, file]) assert.ok(existsSync(path));
  assert.equal(existsSync(f.archiveDir), false, 'an empty scan creates no archive');
});

test('Chess archives never replace evidence when the same run name is reused', t => {
  const f = fixture(t);
  const old = f.make('sleight-chess-drag-1');
  assert.equal(typeof archive.archiveChessRuns, 'function');
  const [first] = archive.archiveChessRuns(f.current, f);
  f.make('sleight-chess-drag-1');
  writeFileSync(join(old, 'trace.jsonl'), 'second\n');
  const [second] = archive.archiveChessRuns(f.current, f);
  assert.notEqual(first.to, second.to);
  assert.equal(readFileSync(join(first.to, 'trace.jsonl'), 'utf8'), 'sleight-chess-drag-1\n');
  assert.equal(readFileSync(join(second.to, 'trace.jsonl'), 'utf8'), 'second\n');
});

test('Chess archive refuses an outside current target and propagates archive failures', t => {
  const f = fixture(t);
  const earlier = f.make('sleight-chess-drag-1');
  assert.equal(typeof archive.archiveChessRuns, 'function');
  assert.throws(() => archive.archiveChessRuns(f.root, f), /current.*benchmark/i);
  writeFileSync(f.archiveDir, 'not a directory');
  assert.throws(() => archive.archiveChessRuns(f.current, f), /ENOTDIR|EEXIST/);
  assert.ok(existsSync(join(earlier, 'saved.game')));
});

function chessTask(archiveChessRuns, calls) {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\} from .*;\n/gm, '').replace(/^export /gm, '');
  return runInNewContext(`${source}\ngetTasks().find(task => task.id === 'chess-drag')`, {
    webBrowsers, join, tmpdir: () => '/private/tmp', realpathSync: path => path,
    archiveChessRuns, restartChess: () => calls.push('restart'),
    execFileSync: (command, args) => {
      assert.equal(command, 'sleep');
      assert.deepEqual([...args], ['3']);
      calls.push('settle');
    },
  });
}

test('every arm archives Chess folders before restart through the shared task setup', () => {
  for (const arm of ['sleight', 'codex', 'lcu']) {
    const calls = [], dir = `/private/tmp/sleight-bench/2026-10-14T19-00-00-000Z/${arm}-chess-drag-1`;
    const task = chessTask(current => { assert.equal(current, dir); calls.push('archive'); }, calls);
    task.setup({ dir, nonce: 'nonce' });
    assert.deepEqual(calls, ['archive', 'restart', 'settle']);
    assert.ok(task.prompt({ dir, nonce: 'nonce' }).includes(join(dir, 'nonce.game')));
  }
});

test('an archive failure prevents Chess from starting', () => {
  const calls = [];
  const task = chessTask(() => { throw new Error('archive denied'); }, calls);
  assert.throws(() => task.setup({ dir: 'unused' }), /archive denied/);
  assert.deepEqual(calls, []);
});

for (const arm of ['mcp:rival_one', 'plugin:rival_one']) test('Chess archive preserves the current prefixed arm and earlier evidence for ' + arm, t => {
  const f = fixture(t), current = f.make(arm + '-chess-drag-2');
  const earlier = f.make(arm + '-chess-drag-1');
  const unrelated = f.make(arm.split(':')[0] + ':_invalid-chess-drag-1');
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.benchDir, f.stamp, arm + '-chess-drag-3'));
  const moved = archive.archiveChessRuns(current, f);
  assert.equal(existsSync(earlier), false);
  assert.equal(readFileSync(join(moved.find(r => r.from === earlier).to, 'trace.jsonl'), 'utf8'), arm + '-chess-drag-1\n');
  assert.equal(readFileSync(join(current, 'trace.jsonl'), 'utf8'), arm + '-chess-drag-2\n');
  assert.ok(existsSync(unrelated)); assert.ok(existsSync(outside));
  assert.ok(existsSync(join(f.benchDir, f.stamp, arm + '-chess-drag-3')));
});

test('retained Chess fixture archives earlier folders before opening without legacy setup', async t => {
  const f = fixture(t), earlier = f.make('sleight-chess-drag-1'), calls = [];
  const original = tasks.find(task => task.id === 'chess-drag');
  const task = genericTask({ ...original, setup: () => assert.fail('legacy restart must not run') }, {
    archiveChess: dir => { calls.push('archive'); return archive.archiveChessRuns(dir, f); },
    open: async () => { assert.equal(existsSync(earlier), false, 'earlier save folder remains at app opening'); calls.push('open'); return {}; },
  });
  await task.setup({ dir: f.current, nonce: 'fixture', ownerAway: true, signal: new AbortController().signal,
    beforeFixtureCleanup: () => calls.push('gate') });
  assert.deepEqual(calls, ['gate', 'archive', 'open']);
  assert.equal(readFileSync(join(f.current, 'trace.jsonl'), 'utf8'), 'codex-chess-drag-2\n');
});

test('retained Chess fixture never opens after archive failure or cancellation', async t => {
  const f = fixture(t), original = tasks.find(task => task.id === 'chess-drag');
  let archives = 0;
  const task = genericTask(original, { archiveChess: () => { archives++; throw Error('archive denied'); },
    open: () => assert.fail('archive refusal must prevent app opening') });
  await assert.rejects(task.setup({ dir: f.current, ownerAway: true, signal: new AbortController().signal }), /archive denied/);
  assert.equal(archives, 1);
  const signal = AbortSignal.abort(Error('stopped'));
  await assert.rejects(task.setup({ dir: f.current, ownerAway: true, signal }), /stopped/);
  await assert.rejects(task.setup({ dir: f.current, ownerAway: false }), /owner-away/);
  await assert.rejects(task.setup({ dir: f.current, ownerAway: true, beforeFixtureCleanup: () => { throw Error('permission stop'); } }), /permission stop/);
  assert.equal(archives, 1, 'permission, owner-away and cancellation gates precede archiving');
});
