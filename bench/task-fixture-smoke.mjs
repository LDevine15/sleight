import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { tasks, getTasks } from './tasks.mjs';
import { getWorldTasks } from './world/tasks.mjs';
import { executeRealTask } from './real-run.mjs';
import { openFixture } from './real-fixture.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { observePermission } from './real-permission.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const taskIds = ['cc-list-native', 'textedit-two-windows'];
const lockPath = '/tmp/sleight-live.lock', holdPath = '/tmp/sleight-hold';
const sourceFiles = ['bench/task-fixture-smoke.mjs', 'bench/tasks.mjs', 'bench/tasks-real.mjs',
  'bench/world/tasks.mjs', 'bench/world/cc-held-out.mjs', 'bench/world/tasks/cc-held-out.json', 'bench/fowl/site/cc-held-out.mjs',
  'bench/real-run.mjs', 'bench/real-fixture.mjs', 'bench/real-fixture.js', 'bench/live-lock.mjs',
  'bench/real-permission.mjs', 'bench/real-permission.js', 'bench/preapproved-process.mjs', 'bench/release-mouse.js'];

function sourceIdentity() {
  return { head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])) };
}

function holdExists() {
  try { lstatSync(holdPath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function lockIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || readdirSync(path).length)
    throw Error('Live lock identity or empty-directory ownership unconfirmed');
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode, birthtimeMs: stat.birthtimeMs };
}

function persist(receipt, beforePersist) {
  beforePersist?.(structuredClone(receipt));
  const next = receipt.receiptPath + '.next';
  const fd = openSync(next, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(next, receipt.receiptPath);
  const directory = openSync(receipt.receiptDir, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// Native operations and private paths are injectable only through this offline-test API.
// The CLI has no dependency, path, process, recovery, or relaunch overrides.
export async function runTaskFixtureSmoke({ task, ownerAway = false, plan = false, signal } = {}, deps = {}) {
  if (!taskIds.includes(task)) throw Error('Choose task cc-list-native or textedit-two-windows');
  if (plan) return { plan: true, task, suite: 'world', setupOnly: true, opensWindows: false, writesFiles: false,
    lockPath, holdPath, command: `node bench/task-fixture-smoke.mjs --task ${task} --owner-away` };
  if (!ownerAway) throw Error('Fixture qualification requires explicit --owner-away');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason ?? Error('Interrupted'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const heldPath = deps.lockPath ?? lockPath;
  const readSource = deps.readSource ?? sourceIdentity;
  const hold = deps.hold ?? holdExists;
  const checkHold = () => { if (hold()) throw Error('Live hold exists; fixture qualification stopped'); };
  const result = { version: 1, task, suite: 'world', phase: 'initial', startedAt: new Date().toISOString(),
    passed: false, actionAttempted: false, lockReleased: false, releaseAuthorized: false };
  let release, ctx, persistenceFailed = false;
  const save = () => {
    try { persist(result, deps.beforePersist); }
    catch (error) { persistenceFailed = true; throw error; }
  };
  try {
    controller.signal.throwIfAborted(); checkHold();
    release = await (deps.lock ?? acquireLiveLock)(heldPath, { wait: false, signal: controller.signal });
    result.liveLockKept = heldPath;
    result.lockIdentity = lockIdentity(heldPath);
    checkHold(); controller.signal.throwIfAborted();
    result.receiptDir = mkdtempSync(join(deps.tempRoot ?? realpathSync(tmpdir()), 'sleight-task-fixture-'));
    result.receiptPath = join(result.receiptDir, 'receipt.json');
    result.fixtureDir = join(result.receiptDir, 'fixture');
    result.source = readSource();
    result.phase = 'acquired'; save();
    ctx = { dir: result.fixtureDir, fixtureRoot: result.fixtureDir, nonce: randomUUID(), ownerAway: true,
      stopOnAppDialog: true, lockPath: heldPath, ...(deps.releaseInput && { releaseInput: deps.releaseInput }) };
    const registered = getWorldTasks({ defaults: tasks, real: getTasks('real'), open: async (context, request) => {
      checkHold(); context.signal?.throwIfAborted();
      return (deps.open ?? openFixture)(context, { ...request, stopOnLiveHold: true });
    } }).find(candidate => candidate.id === task);
    const actionTrap = () => { result.actionAttempted = true; throw Error('Setup-only fixture runner refused an action'); };
    result.lifecycle = await executeRealTask({ ...registered, check: actionTrap }, ctx, {
      setupOnly: true, retainFixture: true, lockHeld: true, drive: actionTrap, signal: controller.signal,
      stop: () => controller.abort(Error('Fixture observation stopped the run')),
      permissionCheck: async () => {
        checkHold();
        return (deps.permission ?? (() => observePermission({ stopOnLiveHold: true, check: checkHold })))();
      },
    });
    result.pendingAcquisitions = [...ctx.pendingAcquisitions ?? []];
    if (task === 'cc-list-native') result.finderRecovery = {
      relaunchRecorded: ctx.fixtureDiagnostics?.some(item => !!item.finderRelaunch) === true,
      recoveryRecorded: ctx.fixtureDiagnostics?.some(item => item.finderRecovery?.originalExitConfirmed === true) === true,
    };
    result.sourceAfter = readSource();
    result.sourceStable = isDeepStrictEqual(result.source, result.sourceAfter);
    if (!result.sourceStable) throw Error('Fixture source identity changed; release refused');
    result.cancelled = controller.signal.aborted;
    checkHold();
    const expected = task === 'cc-list-native' ? 1 : 2;
    result.releaseAuthorized = result.lifecycle.passed === true && !result.actionAttempted && !result.cancelled &&
      !ctx.fixtureLockUnconfirmed && !ctx.exitDisagreements?.length && !ctx.pendingAcquisitions?.size &&
      ctx.windowLeases?.length === expected;
    result.passed = result.releaseAuthorized;
    result.phase = 'terminal';
    save();
    // The durable receipt states release authorization, never a release that has not happened.
    // No receipt writes occur after this boundary, including if release itself fails.
    checkHold(); controller.signal.throwIfAborted();
    if (result.releaseAuthorized) {
      if (JSON.stringify(lockIdentity(heldPath)) !== JSON.stringify(result.lockIdentity)) throw Error('Live lock identity changed; release refused');
      await release();
      result.lockReleased = true;
      delete result.liveLockKept;
    }
  } catch (error) {
    result.passed = false;
    result.failure = error.message;
    result.cancelled = controller.signal.aborted;
    result.pendingAcquisitions = [...ctx?.pendingAcquisitions ?? []];
    if (result.receiptPath && result.phase !== 'terminal' && !persistenceFailed) {
      result.phase = 'terminal'; result.releaseAuthorized = false;
      try { save(); } catch (failure) { result.failure += '; ' + failure.message; }
    }
  } finally { signal?.removeEventListener('abort', cancel); }
  return result;
}

export function parseFixtureSmokeArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--task' && options.task === undefined) options.task = args[++index];
    else if (arg === '--owner-away' && !options.ownerAway) options.ownerAway = true;
    else if (arg === '--plan' && !options.plan) options.plan = true;
    else throw Error(`Unknown or duplicate fixture option: ${arg}`);
  }
  if (!taskIds.includes(options.task)) throw Error('Choose task cc-list-native or textedit-two-windows');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(Error('Interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const result = await runTaskFixtureSmoke({ ...parseFixtureSmokeArgs(process.argv.slice(2)), signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.plan || result.passed && result.lockReleased ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
