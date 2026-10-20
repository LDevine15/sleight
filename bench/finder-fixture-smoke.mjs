import { execFile } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLiveLock } from './live-lock.mjs';
import { openFixture, closeFixtures, finderDiagnostic, finderFailureDiagnostic } from './real-fixture.mjs';
import { observePermission } from './real-permission.mjs';
import { runOwned } from './preapproved-process.mjs';

const execute = promisify(execFile);
const inspector = join(homedir(), '.codex/bin/codex-macos-inspect');
const lockPath = '/tmp/sleight-live.lock';
const holdPath = '/tmp/sleight-hold';
const limitation = 'Foreground samples cannot prove the absence of every transient focus change. ' +
  'The inspector identifies the frontmost app PID and its visible windows, not its focused window.';

function holdExists() {
  try { lstatSync(holdPath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function sampleForeground(run = execute) {
  const { stdout } = await run(inspector, ['frontmost-window'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !Number.isInteger(row.ownerPID) || row.ownerPID <= 0 ||
      !Number.isInteger(row.windowNumber) || row.windowNumber <= 0) || new Set(rows.map(row => row.ownerPID)).size !== 1)
    throw new Error('Foreground identity unconfirmed');
  return { pid: rows[0].ownerPID, windows: [...new Set(rows.map(row => row.windowNumber))].sort((a, b) => a - b) };
}

async function bounded(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out; result unconfirmed`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Dependency injection is for offline tests. The CLI always uses these production defaults.
export async function runFinderSmoke({ plan = false, ownerAway = false, signal } = {}, deps = {}) {
  if (plan) return { plan: true, opensWindows: false, writesFiles: false, lockPath, holdPath,
    command: 'node bench/finder-fixture-smoke.mjs --owner-away', limitation };
  if (!ownerAway) throw new Error('Live smoke requires explicit --owner-away');
  const hold = deps.hold ?? holdExists;
  const lock = deps.lock ?? acquireLiveLock;
  const foreground = deps.foreground ?? sampleForeground;
  const open = deps.open ?? openFixture;
  const close = deps.close ?? closeFixtures;
  const collectionMs = deps.collectionMs ?? 5000;
  const controller = new AbortController(), cleanup = new AbortController();
  const result = { passed: false, failures: [], setup: { confirmed: false },
    retainedWindow: { confirmed: false, referenceExported: false }, navigation: { confirmed: false },
    cleanup: { confirmed: false }, collection: { confirmed: false },
    foreground: { samples: [], changed: false, limitation }, liveLockKept: false };
  let release, timer, observation, setupAttempted = false, persistenceFailed = false;
  let ctx;
  const fail = (phase, error) => result.failures.push({ phase, message: `Finder smoke ${phase} failed`, diagnostic: finderFailureDiagnostic(error) });
  const cancel = () => { result.cancelled = true; controller.abort(signal?.reason ?? new Error('Run interrupted')); };
  const persist = deps.persist ?? ((dir, receipt) => appendFileSync(join(dir, 'receipts.jsonl'),
    JSON.stringify({ kind: 'result', at: new Date().toISOString(), receipt }) + '\n', { mode: 0o600 }));
  const record = (kind, data) => {
    if (!ctx?.dir || persistenceFailed) return;
    try {
      if (deps.persist) deps.persist(ctx.dir, structuredClone(result));
      else appendFileSync(join(ctx.dir, 'receipts.jsonl'),
        JSON.stringify({ kind, at: new Date().toISOString(), data }) + '\n', { mode: 0o600 });
    } catch (error) {
      persistenceFailed = true; fail('receipt', error);
      controller.abort(error); cleanup.abort(error);
    }
  };
  const stopAX = (phase, error) => {
    fail(phase, error); controller.abort(error); cleanup.abort(error);
    record('stop', { phase, failed: true });
  };
  const checkHold = () => {
    if (hold()) throw new Error('Live hold exists; smoke stopped');
  };
  const sample = async phase => {
    const identity = await bounded(foreground, 12000, 'Foreground observation');
    const before = result.foreground.samples[0]?.identity;
    result.foreground.samples.push({ phase, at: new Date().toISOString(), identity });
    if (before && identity.pid !== before.pid) {
      result.foreground.changed = true;
      const error = new Error('Owner foreground PID changed; no focus restoration attempted');
      fail('foreground', error); controller.abort(error);
    }
    record('foreground', result.foreground.samples.at(-1));
  };
  const permission = deps.permission ?? (() => observePermission({ stopOnLiveHold: true,
    check: () => { checkHold(); cleanup.signal.throwIfAborted(); } }));
  const observe = async () => {
    if (cleanup.signal.aborted) return;
    try {
      checkHold();
      const prompt = await bounded(permission, 12000, 'Permission observation');
      record('permission-observation', { prompt: !!prompt });
      if (prompt) {
        result.permission = true;
        throw new Error('Permission window observed; no response sent');
      }
    } catch (error) { stopAX('permission-or-hold', error); }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    checkHold();
    release = await lock(deps.lockPath ?? lockPath, { wait: false, signal: controller.signal });
    result.liveLockKept = true;
    checkHold();
    const nonce = (deps.token ?? randomUUID)();
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(nonce)) throw new Error('Invalid fixture token');
    const dir = mkdtempSync(join(deps.tempRoot ?? '/private/tmp', `sleight-fh1q-${nonce}-`));
    ctx = { dir, nonce, ownerAway: true, signal: controller.signal, cleanupSignal: cleanup.signal,
      stopOnAppDialog: true, windowLeases: [] };
    result.fixtureDir = dir;
    result.target = join(dir, `Finder-smoke-${nonce}`);
    mkdirSync(result.target, { mode: 0o700 });
    // mkdtemp creates the bank with 0700. Keep the bank even on success: it owns all receipts.
    ctx.onAppDialog = dialog => {
      (result.appDialogs ??= []).push(finderDiagnostic(dialog));
      // This smoke never answers even the dialogs other fixtures permit.
      stopAX('app-dialog', new Error('Application dialog observed; no response sent'));
    };
    ctx.onFixtureDiagnostics = diagnostics => {
      result.fixtureDiagnostics = (ctx.fixtureDiagnostics ?? [diagnostics]).map(value => finderDiagnostic(value));
      record('fixture-diagnostics', finderDiagnostic(diagnostics));
    };
    ctx.beforeFixtureCleanup = async () => {
      await observation;
      await observe();
      cleanup.signal.throwIfAborted();
    };
    record('created', { dir, target: result.target, nonce });
    await observe();
    cleanup.signal.throwIfAborted();
    await sample('before');
    controller.signal.throwIfAborted();
    timer = setInterval(() => {
      if (observation || cleanup.signal.aborted) return;
      observation = (async () => {
        await observe();
        if (!cleanup.signal.aborted) {
          try { await sample('setup'); }
          catch (error) { stopAX('foreground-observer', error); }
        }
      })().finally(() => { observation = undefined; });
    }, deps.intervalMs ?? 1000);
    setupAttempted = true;
    record('setup-start', { target: result.target });
    await open(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder',
      target: result.target, token: `Finder-smoke-${nonce}`, stopOnAppDialog: true, stopOnLiveHold: true }, {
      // Persist only the fixed Finder receipt schema, including failed stages.
      run: async (command, args, options) => {
        let buffer = '';
        const response = await (deps.fixtureRun ?? runOwned)(command, args, { ...options, onStdout: data => {
          buffer += String(data);
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              const event = finderDiagnostic(JSON.parse(line));
              if (event.stage === 'finder-window-retained') result.retainedWindow = {
                confirmed: true, referenceExported: false, evidence: event.stage,
              };
              if (event.stage === 'finder-folder-submitted') result.navigation = {
                confirmed: false, submitted: true, target: result.target, evidence: event.stage,
              };
              record('fixture-event', event);
            } catch { record('fixture-output', { bytes: Buffer.byteLength(line), parsed: false }); }
          }
          options.onStdout?.(data);
        } });
        if (buffer) record('fixture-output-tail', { bytes: Buffer.byteLength(buffer), parsed: false });
        record('helper-result', { groupClean: response.groupClean === true,
          exit: { code: Number.isInteger(response.exit?.code) ? response.exit.code : null },
          stdoutBytes: Buffer.byteLength(String(response.stdout ?? '')), stderrBytes: Buffer.byteLength(String(response.stderr ?? '')),
          failed: !!response.error, diagnostic: finderFailureDiagnostic(response.stderr || response.error),
        });
        return response;
      },
    });
    result.setup.confirmed = true;
    // Finder's ready stage follows retention, folder submission and path matching.
    // The AX reference remains private to that helper, and is never rediscovered here.
    result.retainedWindow = { confirmed: true, referenceExported: false, evidence: 'production openFixture ready' };
    result.navigation = { confirmed: true, target: result.target, evidence: 'production fixture path readiness' };
    record('setup-ready', { setup: result.setup, retainedWindow: result.retainedWindow, navigation: result.navigation });
    controller.signal.throwIfAborted();
  } catch (error) {
    fail('setup', error);
    if (error.fixtureDiagnostics) record('setup-failure-diagnostics', finderDiagnostic(error.fixtureDiagnostics));
  } finally {
    clearInterval(timer);
    await observation;
    if (ctx) {
      try { await sample('after-setup'); } catch (error) { fail('foreground-after-setup', error); }
      try {
        await ctx.beforeFixtureCleanup();
        // Cancellation alone permits retained-reference cleanup; permission/dialog/hold stops do not.
        await close(ctx);
        result.cleanup.confirmed = (ctx.windowLeases ?? []).every(lease => lease.diagnostics?.windowCleanupConfirmed === true);
        if (setupAttempted && !ctx.windowLeases.length) result.cleanup.confirmed = false;
        if (!result.cleanup.confirmed) throw new Error('Window cleanup receipt unconfirmed');
        record('cleanup', result.cleanup);
      } catch (error) { fail('cleanup', error); record('cleanup-failure', { failed: true }); }
      const collected = [];
      for (const lease of ctx.windowLeases) {
        try {
          const confirmed = await bounded(() => lease.dispose(), collectionMs, 'Fixture helper collection');
          collected.push(confirmed === true);
          if (lease.diagnostics) lease.diagnostics.helperCollectionConfirmed = confirmed === true;
          if (confirmed !== true) throw new Error('Fixture helper collection unconfirmed');
          record('helper-collected', { confirmed: true });
        } catch (error) { collected.push(false); fail('collection', error); record('collection-failure', { failed: true }); }
      }
      result.collection.confirmed = collected.every(Boolean) && (!setupAttempted || collected.length > 0);
      if (ctx.fixtureDiagnostics) result.fixtureDiagnostics = ctx.fixtureDiagnostics.map(value => finderDiagnostic(value));
      if (ctx.exitDisagreements?.length) result.exitDisagreements = ctx.exitDisagreements;
      try { await sample('after-cleanup'); } catch (error) { fail('foreground-after-cleanup', error); }
      record('cleanup-result', { cleanup: result.cleanup, collection: result.collection });
    }
    // An early setup error can precede a delayed window. Even later closure is not proof of creation ownership.
    const safe = ctx && result.setup.confirmed && result.cleanup.confirmed && result.collection.confirmed &&
      !cleanup.signal.aborted && !persistenceFailed && !ctx.exitDisagreements?.length &&
      !(ctx.fixtureDiagnostics ?? []).some(item => item.cleanup === 'unconfirmed');
    if (release && safe) {
      try { await release(); result.liveLockKept = false; }
      catch (error) { fail('lock-release', error); }
    }
    result.passed = !!safe && !result.liveLockKept && !result.failures.length && !result.cancelled;
    if (ctx) {
      try { await persist(ctx.dir, result); }
      catch (error) { fail('final-receipt', error); result.passed = false; }
    }
    signal?.removeEventListener('abort', cancel);
  }
  return result;
}

export async function smokeMain(args = process.argv.slice(2), { host = process, deps } = {}) {
  for (const flag of args) if (!['--plan', '--owner-away'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Run interrupted by signal'));
  host.on('SIGINT', interrupt); host.on('SIGTERM', interrupt);
  try {
    const receipt = await runFinderSmoke({ plan: args.includes('--plan') || args.length === 0,
      ownerAway: args.includes('--owner-away'), signal: controller.signal }, deps);
    host.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    host.exitCode = receipt.plan || receipt.passed ? 0 : 1;
    return receipt;
  } finally { host.removeListener('SIGINT', interrupt); host.removeListener('SIGTERM', interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeMain().catch(error => { console.error(error.message); process.exitCode = 1; });
}
