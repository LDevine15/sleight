import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, parseRun11Args } from '../bench/electron-run11.mjs';
import { HOLD, LOCK } from '../bench/electron-qualification.mjs';

const commit = 'a'.repeat(40), out = join(tmpdir(), 'run11-fixture-output');
const argv = ['--commit', commit, '--owner-away', '--phases', 'qualify,arm,relaunch', '--out', out];
function world(overrides = {}) {
  const calls = [], gitCalls = [];
  return { calls, gitCalls, deps: {
    git: async args => { gitCalls.push(args); return args[0] === 'rev-parse' ? commit : ''; },
    accepted: async () => { calls.push('receipt'); return true; },
    exists: path => { calls.push(path); return false; },
    run: async args => { calls.push(args); return 0; }, ...overrides,
  } };
}

test('run11 requires a literal immutable commit, an away window and an explicit live output', () => {
  for (const value of ['HEAD', 'main', 'a'.repeat(39), 'A'.repeat(40)])
    assert.throws(() => parseRun11Args(['--commit', value, '--owner-away', '--out', out]), /RUN11_COMMIT_REQUIRED/);
  assert.throws(() => parseRun11Args(['--owner-away', '--out', out]), /RUN11_COMMIT_REQUIRED/);
  assert.throws(() => parseRun11Args(['--commit', commit, '--out', out]), /OWNER_AWAY_REQUIRED/);
  assert.throws(() => parseRun11Args(['--commit', commit, '--dry-run', '--out', out]), /RUN11_LIVE_OUTPUT_REQUIRED/);
  assert.throws(() => parseRun11Args(['--commit', commit, '--owner-away']), /RUN11_LIVE_OUTPUT_REQUIRED/);
});

test('run11 refuses a different HEAD, changed tracked files and untracked plugin or harness files before launch', async () => {
  for (const [stage, code] of [['rev-parse', 'RUN11_COMMIT_MISMATCH'], ['diff', 'RUN11_BUILD_DIRTY'], ['ls-files', 'RUN11_BUILD_DIRTY']]) {
    const w = world({ git: async args => args[0] === stage ? 'changed' : args[0] === 'rev-parse' ? commit : '' });
    await assert.rejects(main(argv, w.deps), new RegExp(code));
    assert.deepEqual(w.calls, []);
  }
});

test('missing, stale and wrong-Node owner receipts stop before marker inspection or a live runner call', async () => {
  for (const code of [null, 'HOST_PACKAGE_MISMATCH', 'INSTALLED_CONFIG_UNSAFE: running Node v26, receipt Node v24']) {
    const w = world({ accepted: async () => { if (code) throw Error(code); return false; } });
    await assert.rejects(main(argv, w.deps), new RegExp(code ?? 'RUN11_TURBO_RECEIPT_REQUIRED'));
    assert.deepEqual(w.calls, []);
  }
});

test('an existing evidence directory, hold or lock stops run11 and is never removed', async () => {
  for (const [path, code] of [[out, 'RUN11_OUTPUT_EXISTS'], [HOLD, 'RUN11_HOLD_PRESENT'], [LOCK, 'RUN11_LOCK_PRESENT']]) {
    const checked = [], w = world({ exists: candidate => { checked.push(candidate); return candidate === path; } });
    await assert.rejects(main(argv, w.deps), new RegExp(code));
    assert.equal(checked.at(-1), path);
    assert.deepEqual(w.calls, ['receipt']);
  }
});

test('the admitted command forwards the fixed run phases and keeps runner exit failures', async () => {
  const w = world({ run: async args => { w.calls.push(args); return 1; } });
  assert.equal(await main(argv, w.deps), 1);
  assert.deepEqual(w.calls, ['receipt', out, HOLD, LOCK, argv.slice(2)]);
  assert.deepEqual(w.gitCalls, [['rev-parse', 'HEAD'], ['diff', '--name-only', 'HEAD', '--'],
    ['ls-files', '--others', '--exclude-standard', '--', 'plugins/sleight', 'bench']]);
});
