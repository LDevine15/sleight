import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOldRuns } from '../bench/run-archive.mjs';
import * as archiveTools from '../bench/run-archive.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

test('old run folders move to the archive with their traces; recent runs and other files stay', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-archive-')));
  const bench = join(root, 'sleight-bench'), archive = join(root, 'archive');
  const old = join(bench, '2026-10-09T01-38-31-540Z'), recent = join(bench, '2026-10-10T11-17-52-572Z');
  for (const dir of [old, recent]) { mkdirSync(join(dir, 'run-1'), { recursive: true }); writeFileSync(join(dir, 'run-1', 'trace.jsonl'), '{}\n'); }
  writeFileSync(join(bench, 'notes.txt'), 'x');
  const now = Date.now();
  utimesSync(old, new Date(now - 7 * 3600 * 1000), new Date(now - 7 * 3600 * 1000));
  assert.deepEqual(archiveOldRuns(bench, archive, { now }), ['2026-10-09T01-38-31-540Z']);
  assert.ok(existsSync(join(archive, '2026-10-09T01-38-31-540Z', 'run-1', 'trace.jsonl')));
  assert.ok(existsSync(recent) && existsSync(join(bench, 'notes.txt')));
  assert.deepEqual(archiveOldRuns(join(root, 'missing'), archive, { now }), []);
});

test('retention removes only old unreferenced images, keeping traces, results, links and recent runs', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-')));
  const docs = join(root, 'docs'), bank = join(root, 'archive'), evidence = join(root, 'sleight-real-evidence');
  mkdirSync(docs); writeFileSync(join(docs, 'study.md'), 'bench/results/2026-09-01T10-00-00-000Z.json');
  const exclusions = join(root, 'exclusions.json'); writeFileSync(exclusions, '{"files":[{"prefix":"2026-09-02T10-00"}]}');
  const add = (base, stamp) => {
    const dir = join(base, stamp, 'arm'); mkdirSync(dir, { recursive: true });
    for (const name of ['screen.png', 'other.JPG', 'trace.jsonl', 'result.json', 'saved.txt']) writeFileSync(join(dir, name), name);
    return dir;
  };
  const old = add(bank, '2026-09-03T10-00-00-000Z');
  const held = add(bank, '2026-09-04T10-00-00-000Z');
  const cited = add(bank, '2026-09-01T10-00-00-000Z'), excluded = add(bank, '2026-09-02T10-00-00-000Z');
  const recent = add(bank, '2026-10-17T10-00-00-000Z'), real = add(evidence, '2026-09-03T10-00-00-000Z');
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'screen.png'), 'keep');
  symlinkSync(outside, join(old, 'linked')); symlinkSync(outside, join(bank, '2026-08-01T10-00-00-000Z'));
  const options = { roots: [bank, evidence], docsDir: docs, exclusionsFile: exclusions, now: Date.parse('2026-10-17T12:00:00Z'), held: new Set([join(held, 'trace.jsonl')]), log() {} };
  assert.equal(typeof archiveTools.pruneRunImages, 'function', 'image retention is missing');
  const dry = archiveTools.pruneRunImages({ ...options, dryRun: true });
  assert.equal(dry.planned.length, 4); assert.equal(existsSync(join(old, 'screen.png')), true);
  const result = archiveTools.pruneRunImages(options);
  assert.equal(result.removed.length, 4); assert.ok(result.freedBytes > 0);
  for (const dir of [old, real]) {
    assert.equal(existsSync(join(dir, 'screen.png')), false); assert.equal(existsSync(join(dir, 'other.JPG')), false);
    for (const name of ['trace.jsonl', 'result.json', 'saved.txt']) assert.equal(existsSync(join(dir, name)), true);
  }
  for (const dir of [held, cited, excluded, recent, outside]) assert.equal(existsSync(join(dir, 'screen.png')), true);
});

test('retention refuses deletion when reference files cannot be read', t => {
  assert.equal(typeof archiveTools.pruneRunImages, 'function', 'image retention is missing');
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'bench-retention-')));
  const result = archiveTools.pruneRunImages({ roots: [root], docsDir: join(root, 'missing'), exclusionsFile: join(root, 'missing.json'), held: new Set(), log() {} });
  assert.deepEqual(result.removed, []); assert.match(result.warning, /reference/);
});
