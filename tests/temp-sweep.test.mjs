import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { sweepTemp } from '../scripts/temp-sweep.mjs';

function fixture(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'hygiene-temp-')));
  const old = name => { const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir, 'data'), 'payload'); utimesSync(dir, new Date(0), new Date(0)); return dir; };
  return { root, old };
}
test('sweep deletes only old unheld sleight directories and reports bytes', t => {
  const { root, old } = fixture(t), gone = old('sleight-old'), held = old('sleight-held'), other = old('other');
  old('sleight-bench'); const git = old('sleight-worktree'); writeFileSync(join(git, '.git'), 'gitdir: elsewhere');
  mkdirSync(join(root, 'sleight-fresh')); symlinkSync(other, join(root, 'sleight-link'));
  const logs = [];
  const result = sweepTemp({ roots: [root], held: new Set([join(held, 'data')]), log: line => logs.push(line) });
  assert.equal(existsSync(gone), false); assert.equal(existsSync(held), true); assert.equal(existsSync(other), true);
  assert.equal(existsSync(git), true); assert.equal(existsSync(join(root, 'sleight-link')), true);
  assert.ok(result.freedBytes >= 7); assert.match(logs.at(-1), /freed.*bytes/);
});
test('temp dry run lists deletes but frees nothing', t => {
  const { root, old } = fixture(t), dir = old('sleight-old'), logs = [];
  const result = sweepTemp({ roots: [root], held: new Set(), dryRun: true, log: line => logs.push(line) });
  assert.equal(existsSync(dir), true); assert.equal(result.freedBytes, 0); assert.match(logs.join('\n'), /would delete/);
});
test('an unavailable process inventory fails closed without failing check', t => {
  const { root, old } = fixture(t), dir = old('sleight-old');
  const result = sweepTemp({ roots: [root], inventory: () => { throw new Error('lsof unavailable'); }, log() {} });
  assert.equal(existsSync(dir), true); assert.match(result.warning, /lsof unavailable/);
});
test('check sweeps after the hold gate and before tests', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.match(pkg.scripts.check, /^scripts\/wait-hold.sh && node scripts\/temp-sweep.mjs && npm test/);
});
test('the live lock and retained real evidence are never temp leftovers, even after six hours', t => {
  const { root, old } = fixture(t);
  const lock = old('sleight-live.lock'), evidence = old('sleight-real-evidence');
  sweepTemp({ roots: [root], held: new Set(), log() {} });
  assert.equal(existsSync(lock), true); assert.equal(existsSync(evidence), true);
});


test('lane evidence, review undo copies, probe banks, ledger claim descendants and keep-temp opt-out are protected', t => {
  const { root, old } = fixture(t);
  const evidence = old('sleight-pw1r-evidence'), suffix = old('sleight-review-evidence-old');
  const kept = ['sleight-review-AbC123', 'sleight-xl1-MMisj1', 'sleight-xd1-probe-XyZ987'].map(old);
  const claim = join(root, 'ledger', 'claims', 'HY1C'); mkdirSync(claim, { recursive: true });
  const owned = join(claim, 'sleight-fixture'); mkdirSync(owned); utimesSync(owned, new Date(0), new Date(0));
  sweepTemp({ roots: [root, claim], held: new Set(), log() {} });
  for (const dir of [evidence, suffix, owned, ...kept]) assert.equal(existsSync(dir), true, dir);
  const keep = old('sleight-opt-out'), previous = process.env.SLEIGHT_KEEP_TEMP;
  try { process.env.SLEIGHT_KEEP_TEMP = '1'; sweepTemp({ roots: [root], held: new Set(), log() {} }); }
  finally { if (previous === undefined) delete process.env.SLEIGHT_KEEP_TEMP; else process.env.SLEIGHT_KEEP_TEMP = previous; }
  assert.equal(existsSync(keep), true);
});

test('aliased temp roots are visited only once', t => {
  const { root, old } = fixture(t), dir = old('sleight-old');
  const alias = join(root, 'alias'); symlinkSync(root, alias);
  const result = sweepTemp({ roots: [root, alias], held: new Set(), dryRun: true, log() {} });
  assert.equal(result.planned.length, 1); assert.ok(existsSync(dir));
});


test('sleight-evidence names retain lane artifacts without an intermediate name', t => {
  const { root, old } = fixture(t), dirs = [old('sleight-evidence'), old('sleight-evidence-review')];
  const result = sweepTemp({ roots: [root], held: new Set(), log() {} });
  assert.deepEqual(result.removed, []);
  for (const dir of dirs) assert.equal(existsSync(dir), true);
});
