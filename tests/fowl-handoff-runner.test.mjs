import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-handoff-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('download cleanup compares names and times and preserves other files and symlinks', async (t) => {
  const { snapshotDownloads, cleanupDownloads } = await import('../bench/fowl/handoff-runner.mjs');
  const dir = temp(t);
  writeFileSync(join(dir, 'invoice-old.pdf'), 'old');
  const before = snapshotDownloads(dir);
  const started = Date.now() - 1000;
  writeFileSync(join(dir, 'invoice-run.pdf'), 'owned');
  writeFileSync(join(dir, 'invoice-run (1).pdf'), 'owned retry');
  writeFileSync(join(dir, 'invoice-other.pdf'), 'other');
  const clean = (name) => cleanupDownloads({ dir, before, name, started, ended: Date.now() + 1000 });
  clean('invoice-run.pdf');
  assert.equal(existsSync(join(dir, 'invoice-run.pdf')), false);
  assert.equal(existsSync(join(dir, 'invoice-run (1).pdf')), false);
  clean('invoice-old.pdf');
  assert.equal(existsSync(join(dir, 'invoice-old.pdf')), true);
  assert.equal(existsSync(join(dir, 'invoice-other.pdf')), true);
  writeFileSync(join(dir, 'invoice-stale.pdf'), 'stale');
  utimesSync(join(dir, 'invoice-stale.pdf'), 1, 1);
  clean('invoice-stale.pdf');
  assert.equal(existsSync(join(dir, 'invoice-stale.pdf')), true);
  symlinkSync(join(dir, 'invoice-other.pdf'), join(dir, 'invoice-link.pdf'));
  clean('invoice-link.pdf');
  assert.equal(existsSync(join(dir, 'invoice-link.pdf')), true);
});

test('every arm cleans artifacts and its download when the round fails or throws', async (t) => {
  const { runHandoffs } = await import('../bench/fowl/handoff-runner.mjs');
  const dir = temp(t);
  const downloads = join(dir, 'downloads');
  mkdirSync(downloads);
  const seen = [];
  const result = await runHandoffs({ outRoot: dir, downloads, stamp: 'test', run: async ({ arm, out, downloadName, args }) => {
    seen.push(arm);
    assert.ok(args[args.indexOf('--serve') + 1].includes(downloadName));
    for (const task of ['invoice-preview', 'table-textedit', 'note-textedit']) {
      mkdirSync(join(out, task), { recursive: true });
      for (const file of ['invoice.pdf', 'invoice-total.txt', 'roster.txt', 'note.txt']) writeFileSync(join(out, task, file), 'artifact');
    }
    writeFileSync(join(downloads, downloadName), 'owned');
    if (arm === 'sleight') throw new Error('fake failure');
    return 1;
  } });
  assert.deepEqual(seen, ['fowlbrowser', 'sleight', 'fowl+sleight']);
  assert.equal(result.every((r) => r.code === 1), true);
  assert.deepEqual(readdirSync(downloads), []);
  for (const arm of seen) {
    for (const task of ['invoice-preview', 'table-textedit', 'note-textedit']) {
      assert.deepEqual(readdirSync(join(dir, 'handoff-test-' + arm, task)), []);
    }
  }
});
