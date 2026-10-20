// A long-lived JXA host read an owned Excel process as gone while the same pid was alive, and Word hid an untitled
// document's Don't Save sheet from AXWindows/AXSheets (Office investigation, 2026-10-17). These fakes cover the harness's
// independent exit check, the lock it keeps on a disagreement, and the hidden-sheet scan before a window counts as closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { finderDiagnostic, openFixture, processExitConfirmed } from '../bench/real-fixture.mjs';
import { executeRealTask, releaseFixtureLock } from '../bench/real-run.mjs';
import { acquireLiveLock } from '../bench/live-lock.mjs';

const fail = code => () => { throw Object.assign(new Error(code), { code }); };

test('an exit counts only when the kernel agrees the launched process is gone', async () => {
  const alive = startedAtMs => async () => ({ zombie: false, startedAtMs });
  assert.equal(await processExitConfirmed(42, 1000, { kill: fail('ESRCH'), ps: () => assert.fail('no ps without a pid') }), true);
  assert.equal(await processExitConfirmed(42, 1000, { kill: fail('EPERM'), ps: () => assert.fail('another user owns it') }), true);
  assert.equal(await processExitConfirmed(42, 1000, { kill() {}, ps: async () => null }), true, 'exited between the reads');
  assert.equal(await processExitConfirmed(42, 1000, { kill() {}, ps: async () => ({ zombie: true, startedAtMs: 1000 }) }), true);
  assert.equal(await processExitConfirmed(42, 1000, { kill() {}, ps: alive(60000) }), true, 'a reused pid started later');
  assert.equal(await processExitConfirmed(42, 1000, { kill() {}, ps: alive(1000) }), false, 'the same process is still running');
  assert.equal(await processExitConfirmed(42, undefined, { kill() {}, ps: alive(60000) }), false, 'no launch time proves nothing');
  assert.equal(await processExitConfirmed(undefined, 1000, { kill: () => assert.fail('no pid'), ps: alive(1000) }), false);
  await assert.rejects(processExitConfirmed(42, 1000, { kill: fail('EINVAL') }), /EINVAL/);
});

test('an independent process-state read failure cannot confirm exit', async () => {
  await assert.rejects(processExitConfirmed(42, 1000, {
    kill() {}, ps: async () => { throw new Error('process state unreadable'); },
  }), /process state unreadable/);
});

function lease(t, { stdout = '{"stage":"armed","running":false,"pid":42,"processStartedAtMs":1000}\n{"stage":"ready"}\n', closed, quit, recovered,
  exited = () => assert.fail('no uninjected process inspection'), finder = false, ctx }) {
  if (!ctx) {
    const dir = mkdtempSync(join(tmpdir(), 'exit-confirmation-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    ctx = { dir, nonce: 'nonce', lockPath: join(dir, 'synthetic-lock') };
  }
  const request = finder ? { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', target: join(ctx.dir, 'Files-nonce') } :
    { app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', mode: 'document', target: join(ctx.dir, 'Book-nonce.xlsx'), token: 'nonce' };
  return openFixture(ctx, request, {
    helper: async () => ({ command: 'fake', args: [] }), open: async () => {}, exited,
    run: async (_command, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (request.mode === 'quit') return quit ?? { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"quit","quitWait":{"reason":"exited"}}\n' };
      if (request.mode === 'recover') return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify(recovered) + '\n' };
      options.onStdout(stdout);
      // The helper answers the parent's close command, or its collection.
      return new Promise(resolve => {
        const finish = () => {
          clearInterval(poll);
          const stdout = JSON.stringify(closed ?? { stage: 'closed' }) + '\n';
          options.onStdout(stdout);
          resolve({ groupClean: true, exit: { code: 0 }, stdout });
        };
        const poll = setInterval(() => { try { if (JSON.parse(readFileSync(request.control, 'utf8')).command === 'close') finish(); } catch {} }, 5);
        options.signal.addEventListener('abort', finish, { once: true });
      });
    },
  }).then(value => ({ lease: value, ctx }));
}

for (const agrees of [true, false]) test(`a reported quit ${agrees ? 'counts' : 'is refused'} when the kernel ${agrees ? 'agrees' : 'still runs the pid'}`, async t => {
  const checks = [];
  const { lease: owned, ctx } = await lease(t, { exited: async (pid, start) => { checks.push([pid, start]); return agrees; } });
  await owned.dispose();
  if (agrees) await owned.quit();
  else await assert.rejects(owned.quit(), /exit disagreement after quit: .*pid 42.*still running; live lock kept/);
  assert.deepEqual(checks, [[42, 1000]]);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, agrees ? true : undefined);
  assert.deepEqual(ctx.exitDisagreements, agrees ? undefined : [{ app: 'Microsoft Excel', bundle: 'com.microsoft.Excel', step: 'quit', pid: 42 }]);
});

test('a failed independent check is a disagreement, not a clean exit', async t => {
  const { lease: owned, ctx } = await lease(t, { exited: async () => { throw new Error('ps timed out'); } });
  await owned.dispose();
  await assert.rejects(owned.quit(), /independent check failed \(ps timed out\)/);
  assert.equal(ctx.exitDisagreements.length, 1);
});

for (const agrees of [true, false]) test(`a skipped close for an app read as gone ${agrees ? 'is clean' : 'stays unconfirmed'} by the kernel's answer`, async t => {
  const { lease: owned, ctx } = await lease(t, { stdout: '{"stage":"armed","running":true,"pid":42,"processStartedAtMs":1000}\n{"stage":"ready"}\n',
    closed: { stage: 'closed', appAbsent: true, pid: 42 }, exited: async () => agrees });
  if (agrees) await owned.close();
  else await assert.rejects(owned.close(), /exit disagreement after window cleanup/);
  assert.equal(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, agrees ? true : undefined);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, agrees ? undefined : 'unconfirmed');
});

test('an ordinary closed receipt needs no exit check', async t => {
  const { lease: owned } = await lease(t, { exited: () => assert.fail('the window was closed, not skipped') });
  await owned.close();
});

test('Finder filtering retains only boolean appAbsent through repeated receipt filtering', () => {
  for (const appAbsent of [true, false]) {
    const event = { stage: 'closed', appAbsent, pid: 42, title: 'OWNER-SECRET' };
    assert.deepEqual(finderDiagnostic(event), { stage: 'closed', appAbsent, pid: 42 });
    assert.deepEqual(finderDiagnostic(finderDiagnostic(event)), { stage: 'closed', appAbsent, pid: 42 });
  }
  for (const appAbsent of ['OWNER-SECRET', 1, null, {}])
    assert.deepEqual(finderDiagnostic({ stage: 'closed', appAbsent }), { stage: 'closed' });
});

for (const answer of ['alive', 'throws', 'exited']) for (const lockHeld of [false, true])
  test(`Finder appAbsent cleanup with ${answer} checker preserves the ${lockHeld ? 'outer' : 'task'} lock until exit is confirmed`, async t => {
    const bank = mkdtempSync(join(tmpdir(), 'finder-exit-lock-'));
    t.after(() => rmSync(bank, { recursive: true, force: true }));
    const ctx = { dir: join(bank, 'fixture'), nonce: 'nonce', lockPath: join(bank, 'synthetic-lock') };
    let releases = 0;
    const checks = [];
    const lock = async (path, options) => {
      assert.equal(path, ctx.lockPath);
      const release = await acquireLiveLock(path, options);
      return async () => { releases++; await release(); };
    };
    const outerRelease = lockHeld ? await lock(ctx.lockPath) : undefined;
    const result = await executeRealTask({
      async setup() {
        assert.equal(existsSync(ctx.lockPath), true);
        const opened = await lease(t, { ctx, finder: true,
          stdout: '{"stage":"armed","running":true,"bundle":"com.apple.finder","pid":42,"processStartedAtMs":1000}\n{"stage":"ready"}\n',
          closed: { stage: 'closed', appAbsent: true, pid: 42 },
          exited: async (pid, start) => {
            checks.push([pid, start]);
            if (answer === 'throws') throw new Error('independent state unreadable');
            return answer === 'exited';
          },
        });
        ctx.fixture = opened.lease;
      },
      prompt: () => 'offline', cleanup: c => c.fixture.close(),
    }, ctx, { lockHeld, lock, setupOnly: true });
    const confirmed = answer === 'exited';
    if (lockHeld) assert.equal(await releaseFixtureLock([ctx], outerRelease), confirmed);
    assert.equal(releases, confirmed ? 1 : 0);
    assert.equal(existsSync(ctx.lockPath), !confirmed);
    assert.equal(existsSync(ctx.dir), !confirmed);
    assert.equal(result.fixtureDir, confirmed ? undefined : ctx.dir);
    assert.equal(result.liveLockKept, confirmed ? undefined : ctx.lockPath);
    assert.equal(result.passed, confirmed);
    assert.equal(ctx.fixtureLockUnconfirmed, !confirmed);
    assert.deepEqual(checks, [[42, 1000]]);
    const diagnostic = ctx.fixtureDiagnostics[0];
    assert.equal(diagnostic.helperCollectionConfirmed, true);
    assert.equal(diagnostic.launched, false);
    assert.equal(diagnostic.windowCleanupConfirmed, confirmed ? true : undefined);
    assert.equal(diagnostic.cleanup, confirmed ? undefined : 'unconfirmed');
    assert.deepEqual(ctx.exitDisagreements, confirmed ? undefined : [
      { app: 'Finder', bundle: 'com.apple.finder', step: 'window cleanup', pid: 42 },
    ]);
    if (!confirmed) assert.match(result.cleanupError, answer === 'throws' ? /independent check failed/ : /process is still running/);
  });

test('recovery confirms every pid it quit with the start times it read', async t => {
  const checks = [];
  const { lease: owned, ctx } = await lease(t, {
    recovered: { stage: 'recovered', pids: [42, 43], processes: [{ pid: 42, processStartedAtMs: 1000 }, { pid: 43, processStartedAtMs: 2000 }] },
    exited: async (pid, start) => { checks.push([pid, start]); return pid !== 43; } });
  await assert.rejects(owned.recover(), /exit disagreement after recovery: .*pid 43/);
  assert.deepEqual(checks, [[42, 1000], [43, 2000]]);
  assert.notEqual(ctx.fixtureDiagnostics[0].appQuit, true);
});

test('an exit disagreement keeps the live lock and the fixture', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'exit-lock-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const ctx = { dir: join(bank, 'fixture'), nonce: 'abc', lockPath: join(bank, 'lock') };
  const result = await executeRealTask({ setup() {}, prompt: () => '', check: () => true,
    cleanup: c => { c.exitDisagreements = [{ app: 'Microsoft Excel', step: 'quit', pid: 42 }]; throw new Error('Owned Microsoft Excel exit disagreement'); },
  }, ctx, { drive: async () => ({ code: 0, out: {} }) });
  assert.equal(result.passed, false);
  assert.equal(result.liveLockKept, ctx.lockPath);
  assert.equal(existsSync(ctx.lockPath), true);
  assert.equal(existsSync(ctx.dir), true);
});

function native() {
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

test('cleanup looks a pid up again before it skips the close of an app its listing lost', () => {
  const { cleanupTarget } = native(), excel = { processIdentifier: 42, bundleIdentifier: 'com.microsoft.Excel' };
  assert.equal(cleanupTarget(null, 42, 'com.microsoft.Excel', pid => (pid === 42 ? excel : null)), excel);
  assert.equal(cleanupTarget(null, 42, 'com.microsoft.Excel', () => null), null);
  assert.equal(cleanupTarget(null, 42, 'com.microsoft.Excel', () => ({ processIdentifier: 42, bundleIdentifier: 'other.app' })), null);
  assert.equal(cleanupTarget(excel, 42, 'com.microsoft.Excel', () => assert.fail('listed')), excel);
});

// A window that closes under the close button while a save sheet stays behind AXFocusedUIElement.
function hiddenSheetFixture(parentOf) {
  const sandbox = native();
  const owned = { name: 'owned' }, app = { name: 'app' }, sheet = { name: 'sheet' }, button = { name: 'button' }, other = { name: 'other' };
  let open = true;
  const values = new Map([
    [owned, { AXRole: () => (open ? 'AXWindow' : null), AXDocument: () => '', AXTitle: () => 'Book nonce', AXCloseButton: () => button }],
    [button, { AXRole: () => 'AXButton', AXParent: () => sheet }],
    [sheet, { AXRole: () => 'AXSheet', AXParent: () => parentOf({ owned, app, other }) }],
    [other, { AXRole: () => 'AXWindow' }],
    [app, { AXRole: () => 'AXApplication', AXFocusedUIElement: () => button, AXFocusedWindow: () => owned }],
  ]);
  const $ = value => value;
  $.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (element === owned && !open) return -25202;
    const read = values.get(element)?.[attribute];
    if (!read) return -25205;
    const value = read();
    if (value === null) return -25212;
    output[0] = value; return 0;
  };
  $.AXUIElementPerformAction = target => { assert.equal(target, button); open = false; return 0; };
  $.CFEqual = (a, b) => a === b;
  sandbox.$ = $; sandbox.Ref = () => []; sandbox.ObjC.castRefToObject = value => value;
  const api = sandbox.nativeAX({ cleanup: true, setupCase: 'cold-launch' }, { now: () => 0, wait() {}, emit() {} });
  const close = () => sandbox.closeOwnedWindow(owned, { mode: 'window', token: 'nonce' }, app, { ...api, wait() {} });
  return { close };
}

for (const [where, parentOf, closes] of [
  ['under the closed window', ({ owned }) => owned, false],
  ['with no window in its ancestry', ({ app }) => app, false],
  ['on another window', ({ other }) => other, true],
]) test(`a save sheet left ${where} ${closes ? 'belongs to that window' : 'keeps cleanup unconfirmed'}`, () => {
  const { close } = hiddenSheetFixture(parentOf);
  if (closes) close();
  else assert.throws(close, /save sheet left outside AXSheets; cleanup unconfirmed/);
});
