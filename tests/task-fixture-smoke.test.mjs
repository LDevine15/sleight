import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { executeRealTask } from '../bench/real-run.mjs';
import { acquireLiveLock } from '../bench/live-lock.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const module = await import('../bench/task-fixture-smoke.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const run = (...args) => {
  assert.equal(typeof module.runTaskFixtureSmoke, 'function', 'task fixture smoke implementation is missing');
  return module.runTaskFixtureSmoke(...args);
};

function fixture(t, overrides = {}) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-task-smoke-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], events = [];
  const deps = {
    tempRoot: root, lockPath: join(root, 'live.lock'), hold: () => false, permission: async () => false,
    releaseInput: async () => { events.push('release-input'); },
    lock: async (path, options) => {
      assert.equal(options.wait, false);
      const release = await acquireLiveLock(path, options);
      return async () => {
        const bank = readdirSync(root).find(name => name.startsWith('sleight-task-fixture-'));
        const receipt = JSON.parse(readFileSync(join(root, bank, 'receipt.json'), 'utf8'));
        assert.equal(receipt.phase, 'terminal', 'terminal receipt must exist before release');
        assert.equal(receipt.releaseAuthorized, true);
        events.push('release-lock'); await release();
      };
    },
    open: async (ctx, request) => {
      calls.push(request);
      assert.equal(request.stopOnLiveHold, true);
      const diagnostic = { launched: false, windowCleanupConfirmed: false };
      const lease = { running: true, launched: false, diagnostics: diagnostic,
        close: async () => { events.push('close'); diagnostic.windowCleanupConfirmed = true; },
        dispose: async () => { events.push('collect'); return true; } };
      (ctx.windowLeases ??= []).push(lease);
      (ctx.fixtureDiagnostics ??= []).push(diagnostic);
      return lease;
    },
    ...overrides,
  };
  return { root, calls, events, deps };
}

test('setup-only executor can retain its owned fixture for outer receipt finalization', async t => {
  const f = fixture(t), dir = join(f.root, 'fixture');
  const result = await executeRealTask({ setup: async () => {}, prompt: () => '', cleanup: async () => {},
    check: () => assert.fail('action check') }, { dir }, { setupOnly: true, lockHeld: true, retainFixture: true,
    drive: () => assert.fail('driver') });
  assert.equal(result.passed, true);
  assert.equal(existsSync(dir), true);
  const ordinary = join(f.root, 'ordinary');
  await executeRealTask({ setup: async () => {}, prompt: () => '', cleanup: async () => {} }, { dir: ordinary },
    { setupOnly: true, lockHeld: true });
  assert.equal(existsSync(ordinary), false, 'existing callers still remove confirmed fixtures');
});

test('CLI accepts only the two task IDs and closed option set', () => {
  assert.deepEqual(module.parseFixtureSmokeArgs(['--task', 'cc-list-native', '--owner-away']),
    { task: 'cc-list-native', ownerAway: true });
  assert.deepEqual(module.parseFixtureSmokeArgs(['--plan', '--task', 'textedit-two-windows']),
    { plan: true, task: 'textedit-two-windows' });
  for (const args of [[], ['--task'], ['--task', 'finder-files'], ['--task', 'cc-list-native', '--recover'],
    ['--task', 'cc-list-native', '--task', 'textedit-two-windows'], ['--plan', '--plan']])
    assert.throws(() => module.parseFixtureSmokeArgs(args));
});

test('plan and invalid task/owner boundaries have no filesystem or native effects', async t => {
  const f = fixture(t, { hold: () => assert.fail('hold inspection'), lock: () => assert.fail('lock'),
    open: () => assert.fail('native open') });
  assert.equal((await run({ task: 'cc-list-native', plan: true }, f.deps)).plan, true);
  await assert.rejects(run({ task: 'finder-files', ownerAway: true }, f.deps), /task/);
  await assert.rejects(run({ task: 'cc-list-native' }, f.deps), /owner-away/);
  assert.deepEqual(readdirSync(f.root), []);
});

for (const task of ['cc-list-native', 'textedit-two-windows']) test(`${task} uses the exact world setup and owned cleanup without actions`, async t => {
  const f = fixture(t);
  const open = f.deps.open;
  let setup;
  f.deps.open = async (ctx, request) => {
    if (task === 'cc-list-native') {
      const files = readdirSync(request.target).sort();
      assert.equal(files.length, 640);
      assert.deepEqual(files, ctx.cc.rows.map(row => row.file).sort());
      for (const row of ctx.cc.rows) assert.equal(readFileSync(join(request.target, row.file), 'utf8'),
        `Collection ${ctx.nonce} ${ctx.cc.token}\n${row.name}\n`);
      assert.equal(request.token, basename(request.target));
      assert.equal(request.bundle, 'com.apple.finder');
      setup = { files: files.length };
    } else {
      assert.equal(readFileSync(ctx.documents[0], 'utf8'), 'first line\n');
      assert.equal(readFileSync(ctx.documents[1], 'utf8'), 'destination\n');
      assert.equal(request.bundle, 'com.apple.TextEdit');
      setup = { documents: [...ctx.documents] };
    }
    return open(ctx, request);
  };
  const result = await run({ task, ownerAway: true }, f.deps);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.lifecycle.setupOnly, true);
  assert.equal(result.actionAttempted, false);
  assert.equal(result.lockReleased, true);
  assert.equal(existsSync(f.deps.lockPath), false);
  assert.equal(existsSync(result.fixtureDir), true);
  assert.ok(setup);
  assert.equal(f.calls.length, task === 'cc-list-native' ? 1 : 2);
  if (task === 'textedit-two-windows') {
    assert.deepEqual(f.calls.map(call => call.target), setup.documents);
    assert.deepEqual(f.calls.map(call => call.placement), [{ slot: 0, count: 2 }, { slot: 1, count: 2 }]);
  }
  assert.equal(f.events.filter(event => event === 'close').length, f.calls.length);
  assert.equal(f.events.filter(event => event === 'collect').length, f.calls.length);
  assert.equal(f.events.at(-1), 'release-lock');
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.phase, 'terminal');
  assert.equal(receipt.lockReleased, false, 'receipt conservatively precedes release');
  assert.equal(receipt.releaseAuthorized, true);
  assert.equal(statSync(result.receiptDir).mode & 0o777, 0o700);
  assert.equal(statSync(result.receiptPath).mode & 0o777, 0o600);
  assert.notEqual(basename(result.receiptDir), basename(result.fixtureDir));
  assert.match(receipt.source.head, /^[a-f0-9]{40}$/);
  assert.match(receipt.source.files['bench/task-fixture-smoke.mjs'], /^[a-f0-9]{64}$/);
  assert.match(receipt.source.files['bench/world/tasks/cc-held-out.json'], /^[a-f0-9]{64}$/);
  assert.match(receipt.source.files['bench/release-mouse.js'], /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.sourceAfter, receipt.source);
});

test('busy lock refuses setup without creating an artifact bank or touching the holder', async t => {
  const f = fixture(t, { open: () => assert.fail('native open') });
  mkdirSync(f.deps.lockPath);
  const before = statSync(f.deps.lockPath);
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.match(result.failure, /Another live run/);
  assert.equal(statSync(f.deps.lockPath).ino, before.ino);
  assert.deepEqual(readdirSync(f.root), ['live.lock']);
});

test('initial receipt failure prevents native setup and retains its acquired lock', async t => {
  const f = fixture(t, { open: () => assert.fail('native open'),
    beforePersist: () => { throw Error('initial receipt write failed'); } });
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.lockReleased, false);
  assert.equal(existsSync(f.deps.lockPath), true);
  assert.match(result.failure, /initial receipt write failed/);
});

test('Finder qualification reports the existing conditional recovery receipts', async t => {
  const f = fixture(t), open = f.deps.open;
  f.deps.open = async (ctx, request) => {
    const lease = await open(ctx, request);
    lease.diagnostics.finderRelaunch = { reason: 'three AXWindows timeouts', pid: 123, startedAtMs: 10 };
    lease.diagnostics.finderRecovery = { originalExitConfirmed: true, fromPid: 123, toPid: 124 };
    return lease;
  };
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(result.passed, true);
  assert.deepEqual(result.finderRecovery, { relaunchRecorded: true, recoveryRecorded: true });
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.deepEqual(receipt.finderRecovery, result.finderRecovery);
});

for (const drift of ['stable', 'helper', 'head']) test(`source verification checks ${drift} before release`, async t => {
  const f = fixture(t);
  const changed = drift !== 'stable';
  const source = { head: 'a'.repeat(40), files: { 'bench/release-mouse.js': 'b'.repeat(64) } };
  let reads = 0;
  f.deps.readSource = () => {
    reads++;
    const observation = structuredClone(source);
    if (drift === 'helper' && reads === 2) observation.files['bench/release-mouse.js'] = 'c'.repeat(64);
    if (drift === 'head' && reads === 2) observation.head = 'd'.repeat(40);
    return observation;
  };
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(reads, 2);
  assert.equal(result.passed, !changed);
  assert.equal(result.lockReleased, !changed);
  assert.equal(result.sourceStable, !changed);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.deepEqual(receipt.source, source);
  assert.equal(receipt.sourceAfter.files['bench/release-mouse.js'], (drift === 'helper' ? 'c' : 'b').repeat(64));
  assert.equal(receipt.sourceAfter.head, (drift === 'head' ? 'd' : 'a').repeat(40));
  if (changed) {
    assert.equal(existsSync(result.fixtureDir), true);
    assert.equal(existsSync(f.deps.lockPath), true);
    assert.match(result.failure, /source.*changed/i);
  }
});

test('second document acquisition uncertainty retains the fixture and shared lock', async t => {
  const f = fixture(t), open = f.deps.open;
  let count = 0;
  f.deps.open = async (...args) => { if (++count === 2) throw Error('second acquisition uncertain'); return open(...args); };
  const result = await run({ task: 'textedit-two-windows', ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.lockReleased, false);
  assert.equal(existsSync(f.deps.lockPath), true);
  assert.equal(existsSync(result.fixtureDir), true);
  assert.deepEqual(result.pendingAcquisitions, ['document1']);
  assert.equal(f.events.filter(event => event === 'close').length, 1);
});

for (const mode of ['hold', 'permission', 'dialog', 'cancel', 'collection', 'exit']) test(`${mode} stops qualification and retains uncertain ownership`, async t => {
  const f = fixture(t), controller = new AbortController(), open = f.deps.open;
  let opened = false;
  f.deps.hold = () => mode === 'hold' && opened;
  f.deps.permission = async () => mode === 'permission' && opened;
  f.deps.open = async (ctx, request) => {
    const lease = await open(ctx, request); opened = true;
    if (mode === 'dialog') ctx.onAppDialog({ app: request.app, category: 'unknown', stop: true });
    if (mode === 'cancel') controller.abort(Error('cancelled'));
    if (mode === 'collection') lease.dispose = async () => false;
    if (mode === 'exit') ctx.exitDisagreements = [{ app: request.app, pid: 123 }];
    return lease;
  };
  const result = await run({ task: 'cc-list-native', ownerAway: true, signal: controller.signal }, f.deps);
  assert.equal(result.passed, false, mode);
  assert.equal(result.lockReleased, false, mode);
  assert.equal(existsSync(f.deps.lockPath), true);
  assert.equal(existsSync(result.fixtureDir), true);
  if (['hold', 'permission', 'dialog'].includes(mode)) assert.equal(f.events.includes('close'), false);
});

test('terminal receipt failure retains the fixture and lock after exact cleanup', async t => {
  const f = fixture(t);
  f.deps.beforePersist = receipt => { if (receipt.phase === 'terminal') throw Error('terminal write failure'); };
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.lockReleased, false);
  assert.equal(existsSync(f.deps.lockPath), true);
  assert.equal(existsSync(result.fixtureDir), true);
  assert.match(result.failure, /terminal write failure/);
  assert.equal(f.events.includes('close'), true);
});

test('changed lock identity is never released', async t => {
  const f = fixture(t);
  f.deps.beforePersist = receipt => {
    if (receipt.phase !== 'terminal') return;
    renameSync(f.deps.lockPath, f.deps.lockPath + '.original');
    mkdirSync(f.deps.lockPath);
  };
  const result = await run({ task: 'cc-list-native', ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.lockReleased, false);
  assert.equal(existsSync(f.deps.lockPath), true);
  assert.equal(f.events.includes('release-lock'), false);
});
