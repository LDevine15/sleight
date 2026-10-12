import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function temp(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-handoff-runner-')));
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
  const result = await runHandoffs({ outRoot: dir, downloads, icloud: join(dir, 'icloud'), stamp: 'test', run: async ({ arm, out, downloadName, args }) => {
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

test('cleanup exceptions are reported and every other task and arm still runs', async (t) => {
  const { runHandoffs } = await import('../bench/fowl/handoff-runner.mjs');
  const dir = temp(t);
  const seen = [];
  const cleaned = [];
  const results = await runHandoffs({ outRoot: dir, downloads: join(dir, 'downloads'), icloud: join(dir, 'icloud'), stamp: 'cleanup',
    cleanup: (path) => { cleaned.push(path); if (path.endsWith('invoice-preview')) throw new Error('cleanup refused'); },
    run: async ({ arm }) => { seen.push(arm); return 0; } });
  assert.equal(seen.length, 3);
  assert.equal(cleaned.length, 9);
  for (const result of results) {
    assert.equal(result.code, 1);
    assert.match(result.cleanupErrors.join('\n'), /invoice-preview.*cleanup refused/);
  }
});

test('each arm reports only new Untitled files with exact task content and leaves them intact', async (t) => {
  const { runHandoffs } = await import('../bench/fowl/handoff-runner.mjs');
  const { NOTE } = await import('../bench/fowl/data.mjs');
  const dir = temp(t);
  const icloud = join(dir, 'icloud');
  mkdirSync(icloud);
  const content = NOTE.title + '\n' + NOTE.body + '\n';
  writeFileSync(join(icloud, 'Untitled.txt'), content);
  const results = await runHandoffs({ outRoot: dir, downloads: join(dir, 'downloads'), icloud, stamp: 'untitled',
    run: async ({ arm }) => {
      const n = ['fowlbrowser', 'sleight', 'fowl+sleight'].indexOf(arm) + 1;
      writeFileSync(join(icloud, `Untitled ${n}.txt`), content);
      writeFileSync(join(icloud, `Untitled ${n + 3}.txt`), content + 'private text');
      writeFileSync(join(icloud, `Named ${n}.txt`), content);
      writeFileSync(join(icloud, `Untitled ${n + 6}.txt`), content);
      utimesSync(join(icloud, `Untitled ${n + 6}.txt`), 1, 1);
      symlinkSync(join(icloud, `Untitled ${n}.txt`), join(icloud, `Untitled ${n + 9}.txt`));
      return 0;
    } });
  results.forEach((r, i) => assert.deepEqual(r.untitled, [join(icloud, `Untitled ${i + 1}.txt`)]));
  assert.equal(readdirSync(icloud).length, 16);
});

test('a real unlink failure still cleans the other tasks and the owned download in all arms', async (t) => {
  const { runHandoffs } = await import('../bench/fowl/handoff-runner.mjs');
  const dir = temp(t);
  const downloads = join(dir, 'downloads');
  mkdirSync(downloads);
  const results = await runHandoffs({ outRoot: dir, downloads, icloud: join(dir, 'icloud'), stamp: 'unlink',
    run: async ({ out, downloadName }) => {
      mkdirSync(join(out, 'invoice-preview', 'invoice.pdf'), { recursive: true });
      mkdirSync(join(out, 'table-textedit'));
      writeFileSync(join(out, 'table-textedit', 'roster.txt'), 'owned');
      writeFileSync(join(downloads, downloadName), 'owned');
      return 0;
    } });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.code, 1);
    assert.match(r.cleanupErrors.join('\n'), /invoice-preview.*(?:EISDIR|EPERM)/);
    assert.deepEqual(readdirSync(join(r.out, 'table-textedit')), []);
  }
  assert.deepEqual(readdirSync(downloads), []);
});
