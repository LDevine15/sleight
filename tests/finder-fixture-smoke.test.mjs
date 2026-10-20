import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { runFinderSmoke, sampleForeground, smokeMain } from '../bench/finder-fixture-smoke.mjs';

// The installed gateway path is an exact assertion, never a test allocation root.

async function fake(t, changes = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'fh1q-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const calls = [], records = [], ctxs = [];
  const deps = {
    tempRoot: parent, token: () => 'unique-test-token', intervalMs: 2, collectionMs: 20,
    hold: () => false,
    lock: async () => { calls.push('lock'); return async () => { calls.push('release'); }; },
    permission: async () => false,
    foreground: async () => ({ pid: 42, windows: [101] }),
    persist: (_dir, receipt) => records.push(structuredClone(receipt)),
    open: async (ctx, request) => {
      calls.push('open'); ctxs.push(ctx);
      assert.equal(request.bundle, 'com.apple.finder');
      assert.equal(request.mode, 'folder');
      assert.equal(request.stopOnLiveHold, true);
      assert.equal(request.stopOnAppDialog, true);
      assert.match(request.target, /Finder-smoke-unique-test-token$/);
      const lease = { diagnostics: { cleanup: undefined }, dispose: async () => { calls.push('dispose'); return true; } };
      ctx.windowLeases.push(lease);
      ctx.onFixtureDiagnostics({ fixtureWindow: null, readiness: { titleMatches: true } });
      return lease;
    },
    close: async ctx => {
      calls.push('close');
      for (const lease of ctx.windowLeases) lease.diagnostics.windowCleanupConfirmed = true;
    },
    ...changes,
  };
  return { deps, calls, records, ctxs, parent };
}

test('plan performs no writes, lock, observation or fixture calls', async () => {
  const poison = new Proxy({}, { get: (_, key) => { throw new Error(`plan touched ${String(key)}`); } });
  const result = await runFinderSmoke({ plan: true }, poison);
  assert.equal(result.plan, true);
  assert.equal(result.opensWindows, false);
});

test('owner-away is mandatory before any live dependency', async () => {
  await assert.rejects(runFinderSmoke({}, {}), /--owner-away/);
});

test('hold and foreign lock prevent setup and are never released', async t => {
  for (const changes of [{ hold: () => true }, { lock: async () => { throw new Error('foreign lock'); } }]) {
    const f = await fake(t, changes);
    const result = await runFinderSmoke({ ownerAway: true }, f.deps);
    assert.equal(result.passed, false);
    assert.deepEqual(f.calls, []);
  }
});

test('success keeps its private folder and receipts, closes and collects before lock release', async t => {
  const f = await fake(t);
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.passed, true);
  assert.deepEqual(f.calls, ['lock', 'open', 'close', 'dispose', 'release']);
  assert.equal((await stat(result.fixtureDir)).mode & 0o777, 0o700);
  assert.equal((await stat(result.target)).mode & 0o777, 0o700);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.collection.confirmed, true);
  assert.equal(result.foreground.changed, false);
  assert.equal(f.records.at(-1).liveLockKept, false);
});

test('setup uncertainty survives a later successful close and collection', async t => {
  const f = await fake(t);
  const base = f.deps.open;
  f.deps.open = async (...args) => { await base(...args); throw new Error('creation uncertain'); };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.liveLockKept, true);
  assert.equal(result.setup.confirmed, false);
  assert.equal(result.failures[0].message, 'Finder smoke setup failed');
  assert.deepEqual(f.calls, ['lock', 'open', 'close', 'dispose']);
});

test('cleanup failure and uncollected helper both retain lock and fixture', async t => {
  for (const kind of ['close', 'false', 'throw', 'timeout']) {
    const f = await fake(t);
    const base = f.deps.open;
    f.deps.open = async (...args) => {
      const lease = await base(...args);
      if (kind !== 'close') lease.dispose = async () => {
        if (kind === 'throw') throw new Error('collection failed');
        if (kind === 'timeout') return new Promise(() => {});
        return false;
      };
      return lease;
    };
    if (kind === 'close') f.deps.close = async () => { throw new Error('retained window not closed'); };
    const result = await runFinderSmoke({ ownerAway: true }, f.deps);
    assert.equal(result.liveLockKept, true, kind);
    assert.equal(result.passed, false, kind);
    assert.ok(result.failures.length, kind);
    assert.ok(!f.calls.includes('release'), kind);
    await stat(result.target);
  }
});

test('permission, observer failure, dialog and mid-run hold stop AX cleanup but collect helper', async t => {
  for (const kind of ['permission', 'observer', 'dialog', 'hold']) {
    const f = await fake(t);
    const base = f.deps.open;
    let stop = false;
    f.deps.permission = async () => {
      if (!stop) return false;
      if (kind === 'observer') throw new Error('observer unreadable');
      return kind === 'permission' && { process: 'UserNotificationCenter' };
    };
    f.deps.hold = () => kind === 'hold' && stop;
    f.deps.open = async (...args) => {
      const lease = await base(...args); stop = true;
      if (kind === 'dialog') args[0].onAppDialog({ app: 'Finder', category: 'unknown' });
      return lease;
    };
    const result = await runFinderSmoke({ ownerAway: true }, f.deps);
    assert.equal(result.liveLockKept, true, kind);
    assert.ok(!f.calls.includes('close'), kind);
    assert.ok(f.calls.includes('dispose'), kind);
    assert.equal(f.ctxs[0].cleanupSignal.aborted, true, kind);
  }
});

test('interrupt during setup waits for its lease, closes it, then collects without releasing uncertain creation', async t => {
  const controller = new AbortController(), f = await fake(t);
  const base = f.deps.open;
  f.deps.open = async (...args) => {
    controller.abort(new Error('SIGTERM'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await base(...args);
    throw new Error('setup cancelled');
  };
  const result = await runFinderSmoke({ ownerAway: true, signal: controller.signal }, f.deps);
  assert.equal(result.cancelled, true);
  assert.deepEqual(f.calls, ['lock', 'open', 'close', 'dispose']);
  assert.equal(result.liveLockKept, true);
});

test('samples during setup preserve a focus change without restoring focus', async t => {
  const f = await fake(t); let count = 0;
  f.deps.foreground = async () => ({ pid: ++count === 2 ? 88 : 42, windows: [101] });
  const base = f.deps.open;
  f.deps.open = async (...args) => { await new Promise(resolve => setTimeout(resolve, 12)); return base(...args); };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.foreground.changed, true);
  assert.equal(result.passed, false);
  assert.ok(result.foreground.samples.some(s => s.phase === 'setup' && s.identity.pid === 88));
  assert.ok(f.calls.includes('close'));
});

test('release ownership failure is preserved and never retried', async t => {
  const f = await fake(t, { lock: async () => async () => { throw new Error('ownership changed'); } });
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.liveLockKept, true);
  assert.equal(result.passed, false);
  assert.equal(result.failures.at(-1).message, 'Finder smoke lock-release failed');
});

test('foreground adapter uses only the installed no-argument operation and rejects unknown identity', async () => {
  let calls = 0;
  const identity = await sampleForeground(async (command, args) => {
    calls++;
    assert.equal(command, join(homedir(), '.codex/bin/codex-macos-inspect'));
    assert.deepEqual(args, ['frontmost-window']);
    return { stdout: JSON.stringify([{ ownerPID: 42, windowNumber: 101, ownerName: 'Owner' }]) };
  });
  assert.deepEqual(identity, { pid: 42, windows: [101] });
  assert.equal(calls, 1);
  for (const rows of [[], [{ ownerPID: 0 }], [{ ownerPID: 42 }, { ownerPID: 88 }]])
    await assert.rejects(sampleForeground(async () => ({ stdout: JSON.stringify(rows) })), /identity/);
});

test('CLI removes signal handlers after bounded collection and rejects unknown flags', async t => {
  const f = await fake(t), host = new EventEmitter(), output = [];
  host.stdout = { write: value => output.push(value) };
  host.stderr = { write: value => output.push(value) };
  await smokeMain(['--plan'], { host, deps: f.deps });
  assert.equal(host.listenerCount('SIGINT'), 0);
  assert.equal(host.listenerCount('SIGTERM'), 0);
  await assert.rejects(smokeMain(['--unknown'], { host, deps: f.deps }), /Unknown/);
  assert.ok(output.length);
});

test('default private receipt file is append-only and includes final receipt', async t => {
  const f = await fake(t); delete f.deps.persist;
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  const events = (await readFile(join(result.fixtureDir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.length > 3);
  assert.equal(events.at(-1).kind, 'result');
  assert.equal(events.at(-1).receipt.passed, true);
});

test('receipt failure before release retains the live lock', async t => {
  const f = await fake(t);
  f.deps.persist = (_dir, receipt) => {
    if (receipt.collection.confirmed) throw new Error('receipt disk full');
  };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.liveLockKept, true);
  assert.ok(!f.calls.includes('release'));
  assert.equal(result.passed, false);
});

test('production fixture API with a fake child preserves split events and collects its exact lease on SIGINT', async t => {
  const f = await fake(t), host = new EventEmitter();
  const output = [];
  host.stdout = { write: value => output.push(value) };
  host.stderr = host.stdout;
  delete f.deps.persist;
  let collected = false, closed = false;
  delete f.deps.open;
  f.deps.fixtureRun = async (command, args, { onStdout, signal }) => {
      assert.equal(command, '/usr/bin/osascript');
      const request = JSON.parse(args.at(-1)), control = request.control;
      let stdout = '';
      const emit = event => { const line = JSON.stringify(event) + '\n'; stdout += line;
        onStdout(line.slice(0, 4)); onStdout(line.slice(4)); };
      emit({ stage: 'armed', running: true, pid: 123 });
      await new Promise(resolve => {
        const poll = setInterval(() => {
          const command = JSON.parse(readFileSync(control, 'utf8')).command;
          if (command !== 'opened') return;
          clearInterval(poll);
          emit({ stage: 'finder-window-retained', referenceExported: false });
          emit({ stage: 'finder-folder-submitted', target: request.target });
          emit({ stage: 'ready', bundle: request.bundle, pid: 123 });
          host.emit('SIGINT');
          resolve();
        }, 1);
      });
      await new Promise(resolve => {
        const poll = setInterval(() => {
          const command = JSON.parse(readFileSync(control, 'utf8')).command;
          if (command === 'close') { clearInterval(poll); closed = true; emit({ stage: 'closed' }); resolve(); }
        }, 1);
        signal.addEventListener('abort', () => { clearInterval(poll); resolve(); }, { once: true });
      });
      collected = true;
      return { stdout, stderr: '', groupClean: true, exit: { code: 0 } };
  };
  // Use the real closeFixtures as well; the fake only replaces its external child.
  delete f.deps.close;
  const result = await smokeMain(['--owner-away'], { host, deps: f.deps });
  assert.equal(result.cancelled, true);
  assert.equal(collected, true);
  assert.equal(closed, true);
  assert.equal(result.collection.confirmed, true);
  assert.equal(host.listenerCount('SIGINT'), 0);
  assert.equal(host.exitCode, 1);
  assert.equal(output.length, 1);
  const records = (await readFile(join(result.fixtureDir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.filter(event => event.kind === 'fixture-event').map(event => event.data.stage),
    ['armed', 'finder-window-retained', 'finder-folder-submitted', 'ready', 'closed']);
  assert.ok(records.some(event => event.kind === 'helper-result' && event.data.groupClean === true));
});

test('production setup refusal preserves retained-window evidence without claiming navigation or releasing lock', async t => {
  const f = await fake(t); delete f.deps.open; delete f.deps.close; delete f.deps.persist;
  f.deps.fixtureRun = async (_command, _args, { onStdout }) => {
    const events = [{ stage: 'armed', running: true, pid: 123 },
      { stage: 'finder-window-retained', referenceExported: false },
      { stage: 'setup-failure', cleanup: 'unconfirmed', actionTaken: true }];
    const stdout = events.map(event => JSON.stringify(event) + '\n').join('');
    onStdout(stdout);
    return { stdout, stderr: 'late Go menu refusal', groupClean: true, exit: { code: 1 } };
  };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.setup.confirmed, false);
  assert.equal(result.retainedWindow.confirmed, true);
  assert.equal(result.navigation.confirmed, false);
  assert.equal(result.cleanup.confirmed, false);
  assert.equal(result.collection.confirmed, true);
  assert.equal(result.liveLockKept, true);
  assert.ok(!f.calls.includes('release'));
  assert.ok(result.failures.some(failure => failure.phase === 'setup'));
  assert.ok(!JSON.stringify(result).includes('late Go menu refusal'));
  const records = (await readFile(join(result.fixtureDir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(event => event.kind === 'fixture-event' && event.data.stage === 'setup-failure'));
});

test('production inventory exception reaches the smoke receipt log before any action', async t => {
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  let message;
  try {
    sandbox.openFinderFolder({}, {}, null, { windows: () => [null] }, {}, () => assert.fail('no retention'));
    assert.fail('inventory must refuse');
  } catch (error) { message = error.message; }
  assert.match(message, /reason=missing-element count=1 index=0/);
  const f = await fake(t); delete f.deps.open; delete f.deps.close; delete f.deps.persist;
  f.deps.fixtureRun = async (_command, _args, { onStdout }) => {
    const events = [{ stage: 'armed', running: true, pid: 123 },
      { stage: 'setup-failure', cleanup: 'nothing created', actionTaken: false, launched: false }];
    const stdout = events.map(event => JSON.stringify(event) + '\n').join('');
    onStdout(stdout);
    return { stdout, stderr: message, groupClean: true, exit: { code: 1 } };
  };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.setup.confirmed, false);
  assert.equal(result.retainedWindow.confirmed, false);
  assert.equal(result.navigation.confirmed, false);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.collection.confirmed, true);
  assert.equal(result.liveLockKept, true);
  assert.ok(!f.calls.includes('release'));
  assert.ok(result.failures.some(failure => failure.diagnostic.reason === 'missing-element' && failure.diagnostic.count === 1));
  const records = (await readFile(join(result.fixtureDir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(event => event.kind === 'helper-result' && event.data.diagnostic.reason === 'missing-element' && event.data.diagnostic.count === 1));
  assert.ok(records.some(event => event.kind === 'result' && event.receipt.failures.some(failure => failure.diagnostic.reason === 'missing-element')));
});

test('R4 receipts and final result omit owner text from every helper and dialog channel', async t => {
  const sentinel = 'OWNER-SECRET-FILENAME-DIALOG';
  const f = await fake(t); delete f.deps.open; delete f.deps.close; delete f.deps.persist;
  f.deps.fixtureRun = async (_command, _args, { onStdout }) => {
    const stdout = JSON.stringify({ stage: 'menu-items', menuItems: [sentinel], menuCommands: [{ title: sentinel, enabled: true }] }) + '\n' +
      JSON.stringify({ stage: 'setup-failure', cleanup: 'unconfirmed', cleanupError: sentinel, appDialog: { title: sentinel, buttons: [sentinel] } }) + '\n' + sentinel + '\n' + sentinel;
    onStdout(stdout.slice(0, 9)); onStdout(stdout.slice(9));
    return { stdout, stderr: sentinel, error: sentinel, groupClean: true, exit: { code: 1 } };
  };
  const result = await runFinderSmoke({ ownerAway: true }, f.deps);
  const receipts = await readFile(join(result.fixtureDir, 'receipts.jsonl'), 'utf8');
  assert.ok(!receipts.includes(sentinel), 'event, diagnostics, raw stdout/stderr and final persistence must be schema bounded');
  assert.ok(!JSON.stringify(result).includes(sentinel));
  const records = receipts.trim().split('\n').map(JSON.parse);
  assert.ok(records.some(e => e.kind === 'fixture-event' && e.data.stage === 'setup-failure'));
  assert.ok(records.some(e => e.kind === 'helper-result' && e.data.groupClean === true && e.data.exit.code === 1));
});
