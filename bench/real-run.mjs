import { mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { retryFixtureCleanup } from './real-fixture.mjs';
import { withElapsed, withStamps } from './timing.mjs';

// The real suite and default tasks with retained fixtures use this lifecycle.
// A cleanup failure preserves its fixture and stops the pass, unless cleanupContained
// says otherwise. The cooperative lock is released on exit, as the task brief requires.
export async function executeRealTask(task, ctx, { drive, dryRun = false, setupOnly = false, signal, permissionCheck, stop, lockHeld = false } = {}) {
  let release, cleanupConfirmed = false, driverStarted = false;
  let monitor, observation;
  const cleanupController = new AbortController();
  const result = setupOnly ? { setupOnly: true } : {};
  ctx.signal = signal;
  ctx.cleanupSignal = cleanupController.signal;
  ctx.onAppDialog = dialog => {
    const dialogs = ctx.appDialogs ??= [];
    if (!dialogs.some(previous => JSON.stringify(previous) === JSON.stringify(dialog))) dialogs.push(dialog);
    if (dialog.stop === false) return;
    result.appDialog = dialog;
    stop?.(); cleanupController.abort();
  };
  const releaseInput = async () => {
    await (ctx.releaseInput ?? releaseHeldMouse)().catch(() => {});
    result.inputReleased = (result.inputReleased ?? 0) + 1;
  };
  const dialogReason = () => result.appDialog && `${result.appDialog.app} ${result.appDialog.category} dialog: stopped`;
  const observe = async () => {
    try {
      const permission = await permissionCheck();
      if (permission) {
        result.permissionPrompt = true;
        if (typeof permission === 'object') result.permissionWindow = permission;
        stop?.(); cleanupController.abort();
      }
    } catch (error) { result.observerError = error.message; stop?.(); cleanupController.abort(); throw error; }
  };
  if (!dryRun && permissionCheck) ctx.beforeFixtureCleanup = async () => { await observation; await observe(); };
  try {
    if (!dryRun && !lockHeld) release = await acquireLiveLock(ctx.lockPath ?? '/tmp/sleight-live.lock', { wait: true, signal, interval: 2000 });
    signal?.throwIfAborted();
    if (!dryRun && permissionCheck) {
      await observe();
      signal?.throwIfAborted();
      if (result.permissionPrompt) throw new Error('macOS permission prompt: stopped');
      monitor = setInterval(() => {
        if (observation) return;
        observation = observe().catch(() => {}).finally(() => { observation = undefined; });
      }, 3000);
    }
    mkdirSync(ctx.dir, { recursive: true });
    // A drag the previous run left half done keeps the app in its tracking loop and breaks this setup (Finder, 2026-10-16).
    if (!dryRun && ctx.ownerAway) await releaseInput();
    await (dryRun ? task.prepare?.(ctx) : task.setup?.(ctx));
    signal?.throwIfAborted();
    const prompt = task.prompt(ctx);
    if (dryRun) {
      Object.assign(result, { dryRun: true, prompt, check: String(await task.check({ ...ctx, answer: '' })) });
    } else if (setupOnly) {
      result.passed = true;
    } else {
      const started = Date.now();
      driverStarted = true;
      const response = await drive(prompt, ctx, { onPermissionRefusal: () => {
        result.permissionRefusal = true;
        // The request was dismissed or denied, so only retained-fixture cleanup
        // remains allowed. A visible system prompt still aborts all AX activity.
        stop?.();
      } });
      Object.assign(result, response);
      // An arm can leave a drag half done, and the app then sits in its mouse tracking loop and ignores Apple events (a Codex
      // drag froze Finder, 2026-10-16). With the owner away, one mouse-up ends it before the check and cleanup read the app.
      if (ctx.ownerAway) await releaseInput();
      if (task.capture) await task.capture(ctx, response);
      const verdict = signal?.aborted || cleanupController.signal.aborted ? dialogReason() || 'run interrupted' :
        await task.check({ ...ctx, answer: response.out?.result ?? '' });
      result.passed = response.code === 0 && verdict === true && !signal?.aborted && !result.permissionPrompt && !result.permissionRefusal && !result.observerError;
      result.taskPassed = result.passed; // before cleanup can fail the run
      // A check may name a stop that isn't a plain failure, such as a shop's human check.
      if (verdict?.outcome && !signal?.aborted) result.outcome = verdict.outcome;
      result.reason = dialogReason() || (result.permissionPrompt ? 'macOS permission prompt: stopped' : result.permissionRefusal ? 'computer-use permission refused: stopped' : signal?.aborted ? 'run interrupted' :
        verdict !== true ? verdict?.reason ?? verdict : response.code !== 0 ? response.reason ?? `driver exited ${response.code}` : undefined);
      const elapsedMs = Date.now() - started;
      result.seconds = Math.round(elapsedMs / 100) / 10;
      withElapsed(result.timing, elapsedMs);
      withStamps(result.timing, response.stamps, started);
    }
  } catch (error) {
    result.passed = false;
    if (error.browserReceipt?.acquisition?.length) result.browserAcquisition = error.browserReceipt.acquisition;
    if (driverStarted && result.groupClean !== true) result.groupClean = false;
    result.reason = dialogReason() || (result.permissionPrompt ? 'macOS permission prompt: stopped' : result.permissionRefusal ? 'computer-use permission refused: stopped' : error.message);
  } finally {
    try {
      if (result.groupClean === false) throw new Error('Owned driver process group cleanup unconfirmed');
      // A prompt may appear just as collection finishes, before the next poll.
      // Refresh before any app cleanup, including after a short setup failure.
      if (monitor) { await observation; await observe().catch(() => {}); }
      if (cleanupController.signal.aborted) {
        throw new Error(result.appDialog ? 'Fixture cleanup stopped by application dialog' : 'Fixture cleanup stopped by permission observation');
      }
      await task.cleanup?.(ctx);
      if (ctx.pendingAcquisitions?.size) throw new Error(`Fixture acquisition unconfirmed: ${[...ctx.pendingAcquisitions].join(', ')}`);
      cleanupConfirmed = true;
    }
    catch (error) {
      result.passed = false; result.cleanupError = error.message;
      if (!dryRun && typeof result.taskPassed === 'boolean' && !signal?.aborted && !cleanupController.signal.aborted &&
          /^Owned .+ fixture window cleanup unconfirmed/.test(result.cleanupError) && !result.permissionPrompt && !result.permissionRefusal &&
          !result.observerError && !result.appDialog && !result.approvalStop && result.groupClean === true) {
        result.cleanupRecovered = false;
        try {
          await retryFixtureCleanup(ctx);
          result.cleanupRecoveryFrom = result.cleanupError;
          delete result.cleanupError;
          result.cleanupRecovered = true;
          result.passed = result.taskPassed;
          cleanupConfirmed = true;
        } catch (failure) { result.cleanupError += '; ' + failure.message; }
      }
    }
    // Local listener cleanup does not act on an app and remains safe when the
    // driver could not be collected or a dialog prevents fixture cleanup.
    try { if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; } }
    catch (error) {
      result.passed = false; cleanupConfirmed = false;
      result.cleanupError = [result.cleanupError, error.message].filter(Boolean).join('; ');
    }
    for (const helper of ctx.windowLeases ?? []) {
      try {
        if (!await helper.dispose()) throw new Error('Fixture helper process group cleanup unconfirmed');
      } catch (error) { result.passed = false; result.cleanupError = error.message; cleanupConfirmed = false; }
    }
    clearInterval(monitor);
    await observation;
    if (ctx.fixtureDiagnostics) result.fixtureDiagnostics = ctx.fixtureDiagnostics;
    if (ctx.appDialogs) result.appDialogs = ctx.appDialogs;
    if (ctx.fixtureDiagnostics?.some(item => item.cleanup === 'unconfirmed')) result.cleanupUnconfirmed = true;
    if (result.permissionPrompt) { result.passed = false; result.reason = 'macOS permission prompt: stopped'; }
    if (result.observerError) { result.passed = false; result.reason = `macOS permission observer failed: ${result.observerError}`; }
    if (cleanupConfirmed && !result.cleanupUnconfirmed) {
      rmSync(ctx.dir, { recursive: true, force: true });
    } else result.fixtureDir = ctx.dir;
    // A JXA helper read an owned app as gone while the kernel still ran it (real-fixture.mjs): that app is still ours, so the
    // live lock stays until someone checks it.
    if (ctx.exitDisagreements?.length) {
      result.passed = false;
      result.exitDisagreements = ctx.exitDisagreements;
      if (release) result.liveLockKept = ctx.lockPath ?? '/tmp/sleight-live.lock';
    } else await release?.();
  }
  return result;
}

export async function acquireFixture(ctx, key, operation) {
  ctx.pendingAcquisitions ??= new Set();
  ctx.pendingAcquisitions.add(key);
  try { ctx[key] = await operation(); }
  catch (error) {
    if (error.noMutation === true || error.cleanupConfirmed === true) ctx.pendingAcquisitions.delete(key);
    throw error;
  }
  ctx.pendingAcquisitions.delete(key);
  return ctx[key];
}

// An unconfirmed fixture window cleanup stopped seven passes on 2026-10-16, each after the app this run launched had
// already exited, which takes its windows with it. Such a failure continues the pass with the task's own verdict
// (owner, 2026-10-16). Anything else (a dialog, a permission prompt, a stray process, an app still running or one the
// run didn't launch) still stops it.
export function cleanupContained(result) {
  if (!/^Owned .+ fixture window cleanup unconfirmed/.test(result.cleanupError ?? '') || result.permissionPrompt || result.permissionRefusal ||
    result.observerError || result.appDialog || result.approvalStop || result.groupClean === false) return false;
  const leases = result.fixtureDiagnostics ?? [];
  return leases.length > 0 && leases.every(item => item.launched === true && item.appQuit === true && item.helperCollectionConfirmed === true);
}

function releaseHeldMouse() {
  return new Promise(resolve => execFile('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./release-mouse.js', import.meta.url))],
    { timeout: 5000 }, () => resolve()));
}
