// Live driver for bench/electron-qualification.mjs. Owner away only; sleight-arch runs it after EPV3-4 to 7 merge.
// - Launch: the resident Electron host starts the app through launch.py with its debugging pipe (open -n can't pass one).
//   The recipe is written by this run into its own temporary folder, with sha256, signer and cdhash read from the bundle.
// - Ownership: the fixture is the main process whose arguments name this run's temporary root; real-electron.mjs's census
//   finds it, and its pid-owned quit (NSRunningApplication plus the fixture's own Don't Save) is the fallback. The owner's
//   instance is counted by pid and never addressed.
// - Consent: sleight's own debugger card, answered only by the user's click. Grants live in this run's state folder. One
//   long-lived worker per app serves every reconnect and timing turn, so one "Allow for this session" click covers them;
//   a new worker or a new app process (restart, worker kill, disconnect, the host-kill instance) shows a new card.
// - Secret: this process plays the MCP server. It holds worker.mjs's serverAppSecret and hands it to each worker it forks,
//   the installed path's only source of the app host's admin secret.
// - No Apple events, no macOS permission prompt answered (the main loop stops and records), no pointer motion.
import { execFile, fork, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { constants as osConstants } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { BENCHMARK_ALLOWLIST, prepareWorkspace } from './electron-qualification.mjs';
import { editorIdentity, parseProcesses, profileProcesses } from './real-electron.mjs';
import { processExitConfirmed } from './real-fixture.mjs';
import { createRunReaper, resolveRunPython } from './electron-run-cleanup.mjs';
import { runOwned } from './preapproved-process.mjs';
import { checkRunSignal } from './electron-run-cancellation.mjs';
import { parkedReceipt } from '../plugins/sleight/lib/direct-browser/electron-host-reasons.mjs';

const execute = promisify(execFile);
const HELPER = fileURLToPath(new URL('./electron-qualification.js', import.meta.url));
const QUIT_HELPER = fileURLToPath(new URL('./real-electron.js', import.meta.url));
const WORKER = fileURLToPath(new URL('./electron-qualification-worker.mjs', import.meta.url));
const D = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);

// macOS's per-user TMPDIR makes even the first host.sock 104 bytes here. The host's bound is 100.
// Use a private mkdtemp directory under the canonical short temporary root, including for nested arm runs.
export const createRunRoot = (prefix = 'seq-') => mkdtempSync(join(realpathSync('/tmp'), prefix));
export function assertHostPath(stateDir) {
  const bytes = Buffer.byteLength(join(stateDir, 'host.sock'));
  if (bytes > 100) throw Error(`STATE_DIR_TOO_LONG: host socket is ${bytes} bytes (limit 100); use a short private temporary root`);
}

export async function turboAcceptance({ readConfig, accept } = {}) {
  const installed = await import(new URL('installed-config.mjs', D));
  let config;
  try { config = (readConfig ?? installed.readInstalledConfig)(); }
  catch (error) {
    if (!readConfig && error.message === 'INSTALLED_CONFIG_UNSAFE') {
      const data = installed.readInstalledConfigFile();
      if (data?.receipt?.node !== process.version) throw Error(`INSTALLED_CONFIG_UNSAFE: running Node ${process.version}, receipt Node ${data?.receipt?.node ?? 'missing'}`);
    }
    throw error;
  }
  if (!config) return false;
  if (!(accept ?? installed.acceptedInstalledPackage)(config).current()) throw Error('HOST_PACKAGE_MISMATCH');
  return true;
}

// The installed worker's app path, which the live worker composes the same way. Missing any refuses before a launch.
export const CONTRACT = Object.freeze([
  ['electron-admin.mjs', ['ensureHost']],
  ['electron-runtime.mjs', ['connectAppHost', 'selectAppConnection', 'createAppTurn', 'releaseAppConnection', 'runWindowHelper']],
  ['electron-identity.mjs', ['deriveAppInstance']],
  ['worker.mjs', ['createAppTurnRuntime', 'serverAppSecret']],
]);
export async function missingContract(load = name => import(new URL(name, D))) {
  const missing = [];
  for (const [file, names] of CONTRACT) {
    let mod;
    try { mod = await load(file); } catch { missing.push(file); continue; }
    for (const name of names) if (typeof mod?.[name] !== 'function') missing.push(`${file} ${name}`);
  }
  return missing;
}

// epv3-contracts.md EPV3-6's recipe args, with the workspace as this run's own folder (prepareProfile lives in the host).
const RECIPE_ARGS = ['--user-data-dir={profile}/user-data', '--extensions-dir={profile}/extensions', '--shared-data-dir={profile}/shared',
  '--use-inmemory-secretstorage', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--new-window'];
const SCHEMES = ['vscode-file', 'vscode-webview'];

/** The registry row for one installed bundle. Identity fields come from electron-identity's deriveAppInstance (the same
 * derivation instanceFromRecipe checks): signer is the team id, runtime 'electron/' + Electron Framework's CFBundleVersion. */
export function recipeFromBundle({ app, derived, executable, sha256, bundlePath, workspace, userProfile }) {
  return { build: `${app.bundleId}@${derived.version}`, name: app.name, bundleId: app.bundleId, signer: derived.signer, runtime: derived.runtime,
    executable, sha256, cdhash: derived.cdhash, args: [...RECIPE_ARGS, workspace], schemes: [...SCHEMES], fileRoots: [join(bundlePath, 'Contents', 'Resources', 'app')],
    joinTolerance: 2, focusEmulation: false, zoomLevel: 0, qualified: false, ...(userProfile ? { userProfile } : {}) };
}

/** The host's own status (electron-host status()) still holds the app's pipe: owned, and ready or parked resumably. */
export const pipeRetained = status => status?.ownership?.state === 'owned' &&
  (status.broker?.state === 'ready' || status.broker?.state === 'parked' && status.broker.parked?.resumable === true);

export function parseCodesign(stderr) {
  const lines = String(stderr).split('\n'), field = key => lines.find(line => line.startsWith(key + '='))?.slice(key.length + 1) ?? null;
  return { signer: field('Authority'), team: field('TeamIdentifier'), cdhash: field('CDHash') };
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function listProcesses(exec = execute) {
  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'uid=', '-o', 'lstart=', '-o', 'args='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  return String(stdout).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!line.trim()) return [];
    const rows = match ? parseProcesses(match[1] + ' ' + match[4]) : [];
    if (rows.length !== 1 || !Number.isFinite(rows[0].startedAtMs)) throw Error('PROCESS_CENSUS_INVALID');
    return rows.map(row => ({ ...row, ppid: Number(match[2]), uid: Number(match[3]) }));
  });
}
export async function helper(request, exec = execute) {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', HELPER, JSON.stringify(request)], { timeout: 15000 });
  return JSON.parse(String(stdout).trim().split('\n').at(-1));
}

// Benchmark setup only: put Terminal in front without sending it input or Apple events.
export async function arrangeTerminal({ exec = execute, inspect = request => helper(request, exec),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { pids } = await inspect({ mode: 'pids', bundle: 'com.apple.Terminal' });
  if (pids.length > 1) throw Error('BACKGROUND_TERMINAL_AMBIGUOUS');
  if (!pids.length) await exec('/usr/bin/open', ['-b', 'com.apple.Terminal'], { timeout: 10000 });
  else await inspect({ mode: 'activate', pid: pids[0], fixturePid: 0 });
  for (let i = 0; i < 50; i++) {
    const front = await inspect({ mode: 'front' });
    if (front.bundle === 'com.apple.Terminal' && front.front > 0 && (!pids.length || front.front === pids[0])) return front;
    await sleep(100);
  }
  throw Error('BACKGROUND_TERMINAL_REQUIRED');
}

// The 50 ms frontmost/pointer sampler, one osascript child for the whole run. Read-only.
export function liveObserver({ spawnProcess = spawn, root }) {
  const samples = [], stop = join(root, 'sampler.stop');
  let child, exited;
  return {
    async start() {
      child = spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript', HELPER, JSON.stringify({ mode: 'sample', intervalMs: 50, durationMs: 6 * 3600 * 1000, stop })],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      exited = new Promise(resolve => child.once('exit', resolve));
      createInterface({ input: child.stdout }).on('line', line => { try { samples.push(JSON.parse(line)); } catch {} });
    },
    async frontPid() { return samples.at(-1)?.front; },
    firstWindowMs(pid, since) { return samples.find(s => s.t >= since && s.windowPids?.includes(pid))?.t ?? null; },
    async samples(start, end) { await new Promise(resolve => setTimeout(resolve, 120)); return samples.filter(s => s.t >= start - 100 && s.t <= end + 100); },
    async stop() {
      writeFileSync(stop, '');
      const done = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]);
      if (done === 'timeout') child.kill('SIGTERM'); // our own child only
    },
  };
}

export function qualificationWorker({ forkProcess = fork, env = process.env, exitWaitMs = 3000, onUnsettled = () => {} } = {}) {
  const child = forkProcess(WORKER, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    env: { ...env, SLEIGHT_TURBO_UNQUALIFIED: '1' } });
  const pending = new Map();
  let sequence = 0, lost, didExit = false, signalled = false;
  const exited = new Promise(resolve => child.once('exit', () => { didExit = true; resolve(true); }));
  child.on('message', msg => { const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); entry(msg); } });
  const lose = () => { if (lost) return; lost = true; if (pending.size) onUnsettled(); for (const entry of pending.values()) entry({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); pending.clear(); };
  for (const event of ['exit', 'error', 'disconnect']) child.on(event, lose);
  const send = (op, extra = {}) => new Promise(resolve => {
    if (lost || signalled) return resolve({ ok: false, error: 'V3_WORKER_UNAVAILABLE' });
    const id = ++sequence; pending.set(id, resolve);
    try { child.send({ id, op, ...extra }, error => { if (error) lose(); }); } catch { lose(); }
  });
  const kill = () => { if (!didExit && !signalled) { signalled = true; child.kill('SIGKILL'); } };
  return { child, send, kill, async stop() {
    kill();
    let timer;
    try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), exitWaitMs); })]); }
    finally { clearTimeout(timer); }
  }, get lost() { return lost; }, get terminating() { return signalled && !didExit; } };
}

export async function liveRuntime(options, { io, root: parentRoot, qualificationDiagnosticPath, python = 'python3', lifecycle, signal } = {}, deps = {}) {
  const exec = deps.exec ?? execute;
  const missing = await missingContract(deps.load);
  if (missing.length) throw Error(`ELECTRON_RUNTIME_MISSING: ${missing.join(', ')}. Merge EPV3-4 to 7 first; nothing was launched`);
  if (process.platform !== 'darwin') throw Error('MACOS_REQUIRED');
  if (!io?.permission) throw Error('PERMISSION_OBSERVER_REQUIRED');
  python = await resolveRunPython(python, { exec });
  checkRunSignal(signal);
  await io.permission(); // throws when codex-macos-inspect is missing, before anything starts
  checkRunSignal(signal);
  const root = parentRoot ? mkdtempSync(join(parentRoot, 'seq-')) : createRunRoot();
  const observer = liveObserver({ spawnProcess: deps.spawn, root }), drivers = [];
  return { observer, driverFor(app, extra = {}) { checkRunSignal(signal); const driver = liveDriver(app, { root, exec, observer, python, qualificationDiagnosticPath, lifecycle, signal, ...extra }); drivers.push(driver); return driver; },
    async close() {
      if (lifecycle?.cleanupAllowed === false) throw Error('RUN_CANCELLATION_UNSETTLED');
      if (drivers.some(driver => !driver.cleanupConfirmed())) throw Error('DRIVER_CLEANUP_UNCONFIRMED');
      const cleanup = await createRunReaper(root, { python, list: () => listProcesses(exec), lifecycle }).reap();
      if (!cleanup.confirmed) throw Error('RUN_PROCESS_EXIT_UNCONFIRMED');
      if (lifecycle?.cleanupAllowed === false) throw Error('RUN_CANCELLATION_UNSETTLED');
      rmSync(root, { recursive: true, force: true });
    } };
}

// Every native helper invocation owns and collects its child before returning a receipt.
const FIXTURE_STAGES = new Set(['quit', 'ready', 'table', 'launch', 'new-window', 'births']);
const WINDOW_SETUP_CODES = new Set(['WINDOW_SETUP_REQUEST', 'WINDOW_SETUP_IDENTITY_CHANGED', 'WINDOW_SETUP_TIMEOUT',
  'WINDOW_SETUP_WINDOW_CHANGED', 'WINDOW_SETUP_ACCESSIBILITY', 'WINDOW_SETUP_MENU_AMBIGUOUS', 'WINDOW_SETUP_PRESS_FAILED']);
function fixtureCensus(rows, request, code) {
  if (request.mode !== 'new-window' || !['WINDOW_SETUP_WINDOW_CHANGED', 'WINDOW_SETUP_TIMEOUT'].includes(code)) return null;
  const failures = rows.filter(row => row?.stage === 'new-window-failure');
  if (failures.length !== 1) return null;
  const c = failures[0].census;
  if (code === 'WINDOW_SETUP_TIMEOUT' && (!c || c.phase !== 'after-new-window' || c.reason !== 'unavailable' ||
      c.count !== null || c.originalPresent !== null)) return null;
  if (!c || !['initial', 'after-new-window'].includes(c.phase) ||
      !['unavailable', 'invalid', 'duplicate', 'count', 'original-missing'].includes(c.reason) ||
      !(c.count === null || Number.isInteger(c.count) && c.count >= 0 && c.count <= 65) ||
      !(c.originalPresent === null || typeof c.originalPresent === 'boolean') ||
      c.phase === 'initial' && c.originalPresent !== null ||
      c.reason === 'original-missing' && (c.phase !== 'after-new-window' || c.originalPresent !== false) ||
      c.reason === 'unavailable' && (c.count !== null || c.originalPresent !== null)) return null;
  return { phase: c.phase, reason: c.reason, count: c.count, originalPresent: c.originalPresent };
}
function fixtureHelperFailure(request, result, row, rows = []) {
  const codes = [...new Set(String(result?.stderr ?? '').match(/\bWINDOW_SETUP_[A-Z_]+\b/g) ?? [])];
  const exitCode = result?.exit?.code, exitSignal = result?.exit?.signal;
  const code = codes.length === 1 && WINDOW_SETUP_CODES.has(codes[0]) ? codes[0] : null;
  const census = fixtureCensus(rows, request, code);
  // Never copy helper output, exception text, paths or arbitrary native error codes into the receipt.
  return Object.assign(Error('FIXTURE_HELPER_UNCONFIRMED'), { detail: { helper: {
    expectedStage: FIXTURE_STAGES.has(request.mode) ? request.mode : null,
    matchedStage: FIXTURE_STAGES.has(row?.stage) ? row.stage : null,
    groupClean: typeof result?.groupClean === 'boolean' ? result.groupClean : null,
    exitCode: Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647 ? exitCode : null,
    exitSignal: typeof exitSignal === 'string' && Object.hasOwn(osConstants.signals, exitSignal) ? exitSignal : null,
    code, ...(census ? { census } : {}),
  } } });
}
export function fixtureHelper(bundle, run = runOwned) {
  return async request => {
    let result;
    try { result = await run('/usr/bin/osascript', ['-l', 'JavaScript', QUIT_HELPER, JSON.stringify({ ...request, bundle })], { timeoutMs: 45000 }); }
    catch { throw fixtureHelperFailure(request); }
    const rows = String(result?.stdout ?? '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const row = rows.find(row => row?.stage === request.mode);
    if (!result?.groupClean || result.exit?.code !== 0 || !row) throw fixtureHelperFailure(request, result, row, rows);
    return row;
  };
}

// forkWorker: the seam the unit tests use for a fake worker; the run forks electron-qualification-worker.mjs.
// cardLog: the live runner's card log (electron-qualification-worker.mjs cardLine), passed to every worker.
export function liveDriver(app, { root, exec: rawExec, observer, forkWorker = qualificationWorker, cardLog, python = 'python3', qualificationDiagnosticPath, lifecycle, signal, deps = {} }) {
  if (!BENCHMARK_ALLOWLIST.includes(app.bundleId)) throw Error('NOT_ON_BENCHMARK_ALLOWLIST');
  const base = mkdtempSync(join(root, app.key + '-'));
  const tempRoot = join(base, 'profiles'), stateDir = join(base, 'state'), registryPath = join(base, 'recipes.json');
  mkdirSync(tempRoot); mkdirSync(stateDir, { mode: 0o700 });
  const files = prepareWorkspace(join(base, 'workspace'));
  const session = 'v3' + randomBytes(16).toString('hex');
  const launched = [], workers = new Set(), observedMains = new Set(), launchWindows = [], adoptionFailures = [];
  const observedBirths = new Map();
  const workerBirths = new Map();
  const observedLaunches = new Set();
  const deferredNativeProvenance = new Map();
  let cleanupConfirmed = false;
  let found, build, recipe, active, current, last, otherFront, hostPid, appSecret;
  let hostIdentity;
  let pendingStartup;
  let cleaning = false;
  const boundary = () => { if (lifecycle?.cleanupAllowed === false) throw Error('RUN_CANCELLATION_UNSETTLED'); if (!cleaning) checkRunSignal(signal); };
  const uncertainEffect = () => { if (lifecycle) { lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; lifecycle.effectUnknown = true; } };
  const exec = (...args) => { boundary(); return rawExec(...args); };
  const inspect = (...args) => { boundary(); return helper(...args); };
  const list = () => (deps.list ?? listProcesses)(rawExec);
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const liveChild = w => !w.lost && w.child?.exitCode == null && w.child?.signalCode == null;
  const reaper = createRunReaper(base, { python, list, pids: () => [...workers].filter(liveChild).map(w => workerBirths.get(w)).filter(Boolean), signal: (...args) => (deps.signal ?? process.kill)(...args), sleep, lifecycle });
  const exited = (...args) => (deps.exited ?? processExitConfirmed)(...args);
  const rawElectron = deps.electron ?? fixtureHelper(app.bundleId);
  const electron = (...args) => { boundary(); return rawElectron(...args); };

  async function prepare() {
    if (recipe) return;
    assertHostPath(stateDir);
    if (deps.inspectBundle) { ({ found, build, recipe, appSecret } = await deps.inspectBundle()); return; }
    found = await editorIdentity(app.path, { exec });
    if (found.bundle !== app.bundleId) throw Error(`${app.path} is ${found.bundle}, not ${app.bundleId}`);
    // codesign and the two plists, read the way the runtime reads them (no launch).
    const { deriveAppInstance } = await import(new URL('electron-identity.mjs', D));
    const derived = deriveAppInstance({ bundle: found.path, executable: found.executable, profile: join(tempRoot, app.bundleId), temporary: true, pid: 1, pidBirth: 'recipe' });
    const signed = parseCodesign((await exec('/usr/bin/codesign', ['-dv', '--verbose=4', found.path], { timeout: 20000 })).stderr);
    build = { version: derived.version, sha256: await sha256(found.executable), signer: signed.signer, team: derived.signer, cdhash: derived.cdhash, runtime: derived.runtime };
    recipe = recipeFromBundle({ app, derived, executable: found.executable, sha256: build.sha256, bundlePath: found.path, workspace: files.root });
    writeFileSync(registryPath, JSON.stringify({ version: 1, recipes: [recipe] }, null, 2), { mode: 0o600 });
    appSecret = (await import(new URL('worker.mjs', D))).serverAppSecret();
  }
  const message = (sessionId = session, extra = {}) => ({ bundleId: app.bundleId, session: sessionId, text: `Qualify turbo in ${app.name}.`,
    registryPath, stateDir, tempRoot, appSecret, python, qualificationDiagnosticPath, allowlist: [...BENCHMARK_ALLOWLIST], ...(cardLog ? { cardLog } : {}), ...extra });
  const seen = reply => {
    if (reply.hostPid && reply.hostPid !== hostPid) { hostPid = reply.hostPid; hostIdentity = undefined; }
    return reply;
  };
  // A turn in the given worker, or in a new one (a new consent instance, so a new card).
  async function spawnWorker() {
    boundary();
    const w = forkWorker({ onUnsettled: uncertainEffect }); workers.add(w);
    for (const key of ['send', 'stop', 'kill']) {
      if (typeof w[key] !== 'function') continue;
      const original = w[key].bind(w);
      w[key] = (...args) => { boundary(); return original(...args); };
    }
    if (Number.isSafeInteger(w.child?.pid)) {
      const row = (await list()).find(row => row.pid === w.child.pid && row.ppid === process.pid && row.uid === process.getuid());
      if (liveChild(w) && row && Number.isFinite(row.startedAtMs)) workerBirths.set(w, Object.freeze({ pid: row.pid, startedAtMs: row.startedAtMs }));
      else throw Error('WORKER_BIRTH_UNCONFIRMED');
    }
    return w;
  }
  async function startWorker(consentWaitMs, sessionId = session, w) {
    if (!w) w = await spawnWorker();
    const reply = seen(await w.send('start', message(sessionId, { consentWaitMs })));
    return { w, reply };
  }
  // The driver's own admin connection, once the workers' channels have closed (the host takes one administrator at a time).
  async function driverAdmin() {
    boundary();
    // Admin connections are frozen; put guarded methods on a separate facade rather than replace Proxy reads of them.
    const guarded = admin => Object.freeze(Object.fromEntries(Object.entries(admin).map(([key, value]) => [key,
      typeof value !== 'function' ? value : (...args) => { if (key !== 'close') boundary(); else if (lifecycle?.cleanupAllowed === false) throw Error('RUN_CANCELLATION_UNSETTLED'); return value.apply(admin, args); },
    ])));
    if (deps.admin) return guarded(await deps.admin());
    const { ensureHost } = deps.ensureHost ? deps : await import(new URL('electron-admin.mjs', D));
    for (let i = 0; ; i++) {
      boundary();
      try { return guarded(await ensureHost({ stateDir, registryPath, tempRoot, build: recipe.build, secret: appSecret, python, qualificationDiagnosticPath,
        env: { ...process.env, SLEIGHT_TURBO_UNQUALIFIED: '1' } })); }
      catch (error) { if (error.message !== 'ELECTRON_HOST_FOREIGN' || i >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  }
  const alive = async (pid, birth) => (await list()).some(p => p.pid === pid && String(p.startedAtMs) === String(birth ?? p.startedAtMs));
  const census = async () => profileProcesses(await list(), tempRoot);

  async function observeFixtureLaunch({ settled = () => true } = {}) {
    if (app.key !== 'vscode' || !observer.firstWindowMs || !launched.length) return;
    const target = launched.at(-1), now = deps.now ?? Date.now;
    if (observedLaunches.has(target.pid)) return;
    if (!(target.processStartedAtMs > 0)) return;
    // Kernel birth bounds exec, including direct launches that have no AppKit launchDate.
    let firstWindowMs;
    for (;;) {
      boundary();
      firstWindowMs = observer.firstWindowMs(target.pid, target.processStartedAtMs);
      if (Number.isFinite(firstWindowMs)) break;
      if (settled()) break;
      await sleep(50);
    }
    if (Number.isFinite(firstWindowMs)) {
      const endMs = firstWindowMs + 2000;
      // Restore as soon as the first window is observed, within the allowance when selection returns promptly.
      await driver.adoptRunning(target);
      launchWindows.push({ pid: target.pid, execMs: target.processStartedAtMs, firstWindowMs, endMs });
      await driver.frontApp();
      const remainingMs = endMs - now();
      if (remainingMs > 0) await sleep(remainingMs);
      observedLaunches.add(target.pid);
      return;
    }
    // Missing first-window evidence grants no exception. Restore the prelaunch app before any later cell starts.
    await driver.adoptRunning(target);
    await driver.frontApp();
    observedLaunches.add(target.pid);
  }

  async function monitorFixtureLaunch(startup) {
    // Physical consent and qualification already bound the start request. Keep observing until
    // that request settles so a late approval cannot exhaust a separate prelaunch polling budget.
    while (!startup.settled) {
      boundary();
      await driver.adoptRunning(undefined, startup.native);
      const target = launched.at(-1);
      if (target && !observedLaunches.has(target.pid)) {
        await observeFixtureLaunch({ settled: () => startup.settled });
        return true;
      }
      if (startup.settled) return false;
      await sleep(50);
    }
    return false;
  }

  const driver = {
    build: () => build ?? {},
    cleanupConfirmed: () => cleanupConfirmed,
    fixturePids: () => [...observedMains],
    launchWindows: () => launchWindows.map(row => ({ ...row })),
    prepare,
    // What the live runner's Claude Code arm needs to reach this run's host through its own worker (electron-arm-server.mjs).
    armConfig: () => ({ bundleId: app.bundleId, name: app.name, session: 'v3' + randomBytes(16).toString('hex'), registryPath, stateDir, tempRoot, appSecret,
      allowlist: [...BENCHMARK_ALLOWLIST], python, qualificationDiagnosticPath, workspace: files.root, ...(cardLog ? { cardLog } : {}) }),
    // The arm's worker launched the app, not this driver: the main process naming this run's temporary root joins the
    // launched list, so cleanup quits it like its own. Nothing else is adopted.
    async adoptRunning(expected, pendingNative) {
      await reaper.scan();
      const all = await list(), mains = profileProcesses(all, tempRoot).filter(p => found && p.args.startsWith(found.executable + ' ') &&
        p.args.includes(`--user-data-dir=${tempRoot}/`));
      for (const [pid, prior] of pendingNative?.candidates ?? []) {
        if (mains.some(p => p.pid === pid)) continue;
        const adoption = { process: { pid, startedAtMs: prior.startedAtMs }, stable: false, native: [] };
        adoptionFailures.push(adoption);
        throw Object.assign(Error('FIXTURE_LAUNCH_IDENTITY_CHANGED'), { detail: { adoption } });
      }
      if (expected && !mains.some(p => p.pid === expected.pid && p.startedAtMs === expected.startedAtMs)) {
        throw Error('FIXTURE_LAUNCH_IDENTITY_CHANGED');
      }
      // Keep host ownership even if the app's native identity cannot be joined.
      hostPid ??= all.find(p => ` ${p.args} `.includes(` --state-dir ${stateDir} `))?.pid;
      const host = all.find(p => p.pid === hostPid && ` ${p.args} `.includes(` --state-dir ${stateDir} `));
      if (host && !hostIdentity) hostIdentity = { pid: host.pid, startedAtMs: host.startedAtMs };
      for (const p of mains) {
        observedMains.add(p.pid);
        if (!observedBirths.has(p.pid)) observedBirths.set(p.pid, p.startedAtMs);
      }
      if (mains.length) {
        const table = await electron({ mode: 'table', bundle: app.bundleId });
        const after = await list();
        const validTable = Array.isArray(table?.processes) && table.processes.every(row => row && !Array.isArray(row) &&
          Number.isSafeInteger(row.pid) && row.pid > 0 && row.bundle === app.bundleId && typeof row.path === 'string' && row.path.length > 0 &&
          typeof row.pidBirth === 'string' && /^[1-9]\d*\.\d{6}$/.test(row.pidBirth) &&
          (row.launchedAtMs === null || Number.isFinite(row.launchedAtMs) && row.launchedAtMs > 0)) &&
          new Set(table.processes.map(row => row.pid)).size === table.processes.length;
        for (const p of mains) {
          const candidates = Array.isArray(table?.processes) ? table.processes.filter(row => row?.pid === p.pid) : [];
          const row = candidates.length === 1 ? candidates[0] : null;
          const prior = deferredNativeProvenance.get(p.pid);
          const stable = Number.isFinite(p.startedAtMs) && observedBirths.get(p.pid) === p.startedAtMs &&
            (!prior || prior.startedAtMs === p.startedAtMs && prior.args === p.args) &&
            after.some(next => next.pid === p.pid && next.startedAtMs === p.startedAtMs && next.args === p.args);
          const birthKnown = typeof row?.pidBirth === 'string' && /^[1-9]\d*\.\d{6}$/.test(row.pidBirth) &&
            Number(row.pidBirth.split('.')[0]) * 1000 === p.startedAtMs;
          // Bracket the native lookup with the executable/profile census and join kernel birth at ps's second resolution.
          // launchDate belongs to LaunchServices and can be null for this direct pipe launch.
          const known = launched.find(l => l.pid === p.pid);
          if (pendingNative && stable && !known && validTable && candidates.length === 0) {
            boundary();
            // Registration can lag exec. Retain census ownership without granting native identity;
            // only an unsettled start may revisit this exact process on a fresh strict census.
            if (pendingNative.isPending()) {
              const provenance = { startedAtMs: p.startedAtMs, args: p.args };
              pendingNative.candidates.set(p.pid, provenance);
              deferredNativeProvenance.set(p.pid, provenance);
              continue;
            }
          }
          if (!stable || !row || row.bundle !== app.bundleId || row.path !== found.path || !birthKnown) {
            const adoption = { process: { pid: p.pid, startedAtMs: p.startedAtMs }, stable,
              native: candidates.map(({ pid, bundle, path, launchedAtMs, pidBirth }) => ({ pid, bundle, path, launchedAtMs, pidBirth })) };
            adoptionFailures.push(adoption);
            throw Object.assign(Error('FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED'), { detail: { adoption } });
          }
          if (known && (known.pidBirth !== row.pidBirth ||
            known.startedAtMs !== undefined && known.startedAtMs !== p.startedAtMs)) throw Error('FIXTURE_LAUNCH_IDENTITY_CHANGED');
          const identity = { pid: p.pid, pidBirth: row.pidBirth, processStartedAtMs: Number(row.pidBirth) * 1000, startedAtMs: p.startedAtMs };
          if (known) Object.assign(known, identity);
          else launched.push(identity);
          pendingNative?.candidates.delete(p.pid);
        }
        last = current ?? launched.find(l => l.pid === mains[0].pid);
      }
      return mains.length;
    },
    identity: () => current ?? last ?? null,
    async fixtureObservation({ tab, fixtureName }) {
      boundary();
      if (!active || active.lost) throw Error('WORKER_NOT_CONNECTED');
      const result = await active.send('fixture-observation', { tab, fixtureName });
      boundary();
      if (result.diagnostic?.pending === true && lifecycle) {
        lifecycle.cleanupAllowed = false;
        lifecycle.unsettled = true;
      }
      return result.diagnostic ?? { ok: false, code: 'ELECTRON_FIXTURE_OBSERVATION_FAILED' };
    },
    async connect({ consentWaitMs } = {}) {
      await prepare();
      if (!otherFront) { const front = await inspect({ mode: 'front' }, exec); if (!BENCHMARK_ALLOWLIST.includes(front.bundle)) otherFront = front; }
      const started = performance.now();
      let w, reply;
      if (app.key === 'vscode' && observer.firstWindowMs) {
        const startup = { settled: false };
        startup.native = { isPending: () => !startup.settled, candidates: new Map() };
        const worker = startWorker(consentWaitMs, session, active).finally(() => { startup.settled = true; });
        // Observe the owned launch while consent/qualification still occupies the worker's start request.
        // Collect both outcomes before returning, including when either side fails first.
        const collection = (async () => {
          const outcomes = await Promise.allSettled([worker, monitorFixtureLaunch(startup)]);
          const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
          if (outcomes[1].status === 'fulfilled' && (!outcomes[1].value || startup.native.candidates.size > 0) &&
              lifecycle?.cleanupAllowed !== false) {
            try {
              await driver.adoptRunning(undefined, startup.native);
              // A launch may become visible only as start settles. Check its current evidence once;
              // no fresh polling may continue after the worker has settled.
              await observeFixtureLaunch({ settled: () => true });
            } catch (error) { errors.push(error); }
          }
          if (errors.length > 1) throw Object.assign(new AggregateError(errors, errors.map(error => error.message).join('; ')), {
            cause: errors[0], ...(errors[0]?.detail ? { detail: errors[0].detail } : {}),
          });
          if (errors.length) throw errors[0];
          return outcomes[0].value;
        })();
        const collected = collection.then(() => {}, () => {});
        pendingStartup = collected;
        try { ({ w, reply } = await collection); }
        finally { if (pendingStartup === collected) pendingStartup = undefined; }
      } else {
        try { ({ w, reply } = await startWorker(consentWaitMs, session, active)); }
        finally { await driver.adoptRunning(); await observeFixtureLaunch(); }
      }
      if (!reply.ok) {
        const card = reply.card ?? { shown: false, status: /DEBUGGER_REQUIRED/.test(reply.error) ? 'timeout' : 'refused', error: reply.error };
        w.kill(); if (active === w) active = undefined;
        return { error: reply.error, stage: reply.stage, card, launch: {}, connect: {} };
      }
      const known = launched.find(row => row.pid === reply.identity.pid);
      if (known && known.pidBirth !== reply.identity.pidBirth) throw Error('FIXTURE_LAUNCH_IDENTITY_CHANGED');
      if (!known) launched.push({ pid: reply.identity.pid, pidBirth: reply.identity.pidBirth });
      active = w; current = last = reply.identity;
      const listeners = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(reply.identity.pid), '-iTCP', '-sTCP:LISTEN', '-t'], { timeout: 10000 })
        .then(r => String(r.stdout).trim().split('\n').filter(Boolean).length, error => (error.code === 1 ? 0 : -1));
      return { card: reply.card, qualification: reply.receipt ?? null,
        launch: { ...reply.launch, ms: reply.launch.ms ?? Math.round(performance.now() - started) }, connect: { ms: reply.connectMs, tcpListeners: listeners } };
    },
    async restart(options) { await driver.quit(); return driver.connect(options); },
    async tool(name, args) {
      const started = performance.now(), reply = await (active ?? { send: async () => ({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }) }).send('call', { request: { name, arguments: args } });
      if (signal?.aborted && (!reply.ok || reply.result?.isError) || /effect[ -]unknown/i.test(reply.result?.text ?? '')) uncertainEffect();
      const ms = Math.round(performance.now() - started);
      return reply.ok ? { ...reply.result, ms } : { text: reply.error, isError: true, ms };
    },
    async frontApp({ bundle } = {}) {
      if (bundle !== undefined) {
        if (bundle !== 'com.apple.Terminal') throw Error('BACKGROUND_APP_UNSUPPORTED');
        otherFront = await arrangeTerminal({ exec, sleep });
      }
      if (!otherFront) throw Error('NO_OTHER_APP: the app frontmost before launch was a fixture');
      const front = await inspect({ mode: 'front' }, exec);
      if (front.front !== otherFront.front) await inspect({ mode: 'activate', pid: otherFront.front, fixturePid: current?.pid ?? 0 }, exec);
      return { pid: otherFront.front, bundle: otherFront.bundle };
    },
    async ownerInstances() { const { pids } = await inspect({ mode: 'pids', bundle: app.bundleId }, exec); return pids.filter(pid => !launched.some(l => l.pid === pid)).length; },
    async windowOwners(ids) { return (await inspect({ mode: 'owners', ids }, exec)).owners; },
    async geometry() {
      const r = await active.send('receipt'), delta = r.receipt?.cells?.delta;
      return { delta, zoomLevel: r.recipe?.zoomLevel, scaleMatch: (r.receipt?.cells?.joined ?? 0) > 0 };
    },
    async nativeSecondWindow() {
      const target = launched.find(row => row.pid === current?.pid);
      const changed = () => { throw Error('WINDOW_SETUP_IDENTITY_CHANGED'); };
      const verify = async expected => {
        if (app.key !== 'vscode' || !active || !target || !/^[1-9]\d*\.\d{6}$/.test(target.pidBirth ?? '') || !found?.executable) changed();
        const rows = (await list()).filter(row => row.pid === target.pid);
        if (rows.length !== 1) changed();
        const row = rows[0];
        if (row.uid !== process.getuid() || row.startedAtMs !== target.startedAtMs ||
            row.startedAtMs !== Math.floor(Number(target.pidBirth)) * 1000 || !row.args.startsWith(found.executable + ' ')) changed();
        const flags = [...row.args.slice(found.executable.length).matchAll(/(?:^|\s)--user-data-dir(?:=([^\s]+)|(?=\s|$))/g)];
        if (flags.length !== 1 || !flags[0][1]) changed();
        const profile = flags[0][1];
        if (normalize(profile) !== profile || !profile.startsWith(tempRoot + '/') || expected && profile !== expected) changed();
        try { if (realpathSync(tempRoot) !== tempRoot || realpathSync(profile) !== profile) changed(); }
        catch { changed(); }
        return profile;
      };
      const profile = await verify();
      try {
        const result = await electron({ mode: 'new-window', bundle: app.bundleId, pid: target.pid, pidBirth: target.pidBirth,
          appPath: found.path, profileRoot: tempRoot, profile, waitMs: 10000 });
        await verify(profile);
        if (!Array.isArray(result.windows) || result.windows.length !== 2 || new Set(result.windows).size !== 2 ||
            result.windows.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('WINDOW_SETUP_WINDOW_CHANGED');
        return result;
      } finally { await driver.frontApp({ bundle: 'com.apple.Terminal' }); }
    },
    async nativeSheetCancel() { return inspect({ mode: 'press', pid: current.pid, title: 'Cancel' }, exec); },
    readFile: name => { try { return readFileSync(join(files.root, name), 'utf8'); } catch { return ''; } },
    async appAlive() {
      const target = launched.find(row => row.pid === current?.pid);
      return !!current && await alive(current.pid, target?.startedAtMs);
    },
    async revoke() { await active.send('revoke'); },
    async resume() { await active.send('resume'); },
    // The indicator's Disconnect in the live worker, which keeps running: the cell's next call goes through that same worker,
    // so its refusal proves the disconnect. Retention and the closed worker channel come from the host's own status after it.
    async disconnect() {
      const reply = await active.send('disconnect');
      if (!reply.ok) throw Error(reply.error);
      const open = reply.status?.workers;
      if (!Array.isArray(open) || open.length) throw Error(`DISCONNECT_WORKER_CHANNEL_OPEN: ${Array.isArray(open) ? open.length : 'unknown'}`);
      return { appAlive: await driver.appAlive(), pipeRetained: pipeRetained(reply.status), parked: parkedReceipt(reply.status?.broker?.parked) };
    },
    async status() { return (await active?.send('status'))?.status ?? null; },
    // In the live worker: release and select again (a new turn, the session grant). Without one: a new worker and its card.
    async reconnect({ consentWaitMs } = {}) {
      const { w, reply } = await startWorker(consentWaitMs, session, active);
      if (reply.ok) { active = w; current = last = reply.identity; }
      else { w.kill(); if (active === w) active = undefined; }
      return reply.card ?? { shown: false, status: 'refused', error: reply.error };
    },
    async killWorker() { active?.kill(); active = undefined; return { killed: true }; },
    async killHost() {
      const status = (await active.send('status')).status;
      hostPid = status?.hostPid ?? hostPid;
      const host = (await listProcesses(exec)).find(p => p.pid === hostPid);
      if (!host || !host.args.includes(stateDir)) throw Error('HOST_PID_UNKNOWN: the host status gave no pid naming this run');
      boundary(); process.kill(hostPid, 'SIGKILL'); // the host this run started, matched by its state folder
      await active.stop(); active = undefined;
      // A temporary app has no pipe keeper. Give EOF time to reach it before probing unresolved ownership.
      await sleep(500);
      const target = launched.find(row => row.pid === current?.pid);
      if (!target?.processStartedAtMs) throw Error('FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
      const appExited = await exited(target.pid, target.processStartedAtMs);
      return { appAlive: !appExited, appExited };
    },
    // Read the restarted host's launch gate. A free gate never triggers selection, a debugger card or a replacement app.
    async secondLaunch() {
      const w = await spawnWorker();
      const reply = seen(await w.send('probe-launch', message()));
      await w.stop();
      if (!reply.ok) return { code: /[A-Z_]{6,}/.exec(reply.error)?.[0] ?? reply.error };
      const target = launched.find(row => row.pid === current?.pid);
      return { ...reply.probe, appExited: !!target && await exited(target.pid, target.processStartedAtMs) };
    },
    // The host's own ownership recovery once the app is gone; no launch, no card.
    async reconcile() {
      const w = await spawnWorker();
      const reply = await w.send('reconcile', message());
      w.kill();
      return { code: !reply.ok ? (/[A-Z_]{6,}/.exec(reply.error)?.[0] ?? reply.error) : reply.resolved ? null : 'ELECTRON_OWNERSHIP_UNRESOLVED', reason: reply.reason ?? null };
    },
    async quitByPid({ allowForce } = {}) {
      const identity = current ?? last, target = launched.find(row => row.pid === identity?.pid) ?? identity;
      if (!target?.pidBirth || !target.processStartedAtMs) throw Error('FIXTURE_LAUNCH_IDENTITY_UNCONFIRMED');
      await electron({ mode: 'quit', pid: target.pid, bundle: app.bundleId, appPath: found.path, pidBirth: target.pidBirth,
        ...(allowForce === false ? { allowForce: false } : {}) });
      return { exited: await exited(target.pid, target.processStartedAtMs) };
    },
    async collect() {
      const left = await census();
      // The restarted host must recover these original inodes before its own collect removes them.
      return { absent: left.length === 0 };
    },
    // This session keeps acting; n - 1 other sessions over the same host refuse busy, each before its card.
    async contention(n) {
      const own = await driver.tool('browser_tabs', { do: 'list' });
      const reply = n > 1 ? await active.send('contend', message(session, { count: n - 1 })) : { ok: true, row: { busy: 0, other: 0, cards: 0 } };
      if (!reply.ok) return { ok: own.isError ? 0 : 1, busy: 0, other: n - 1, cards: 0, error: reply.error };
      return { ok: own.isError ? 0 : 1, busy: reply.row.busy, other: reply.row.other + (own.isError ? 1 : 0), cards: reply.row.cards };
    },
    async quit() {
      const target = current, started = performance.now();
      const status = active ? (await active.send('status')).status : null;
      hostPid = status?.hostPid ?? hostPid;
      for (const w of workers) {
        // Deliberately killed workers stay owned until their exit is collected, but have no IPC turn left to end.
        const ended = w.lost || w.terminating ? null : await w.send('end');
        if (!await w.stop()) throw Error('WORKER_EXIT_UNCONFIRMED');
        workers.delete(w);
        if (ended && (ended.ok !== true || ended.ended !== true)) throw Error('WORKER_END_UNCONFIRMED');
      }
      active = undefined;
      // Quit through the app (the host's requestQuit: NSRunningApplication terminate after the birth matches).
      const admin = await driverAdmin();
      let quit, collected, appExited = !target;
      try {
        quit = await admin.quit();
        const owned = launched.find(row => row.pid === target?.pid);
        for (let i = 0; target && i <= 50; i++) {
          appExited = await exited(target.pid, owned?.processStartedAtMs);
          if (appExited || i === 50) break;
          await sleep(100);
        }
        // Collection needs both the parent's exit and the host's descendant census.
        if (appExited) {
          for (let i = 0; i <= 50; i++) {
            collected = await admin.collect?.();
            if (collected?.cleanup === 'removed' || i === 50) break;
            await sleep(100);
          }
        }
      } finally { await admin.close?.(); }
      const left = await census();
      current = undefined;
      return { exited: appExited, quit, collected, ms: Math.round(performance.now() - started), censusLeft: left.length, profileRemoved: readdirSync(tempRoot).length === 0 };
    },
    async cleanup() {
      // A dispatched start and its observer retain ownership until both settle.
      await pendingStartup;
      const uncertain = () => ({ confirmed: false, appExited: false, workersExited: false, hostExited: false,
        runProcessesExited: false, profileRemoved: false, errors: ['RUN_CANCELLATION_UNSETTLED'], retainedRoot: base });
      if (lifecycle?.cleanupAllowed === false) return uncertain();
      cleaning = true;
      try {
      await reaper.scan();
      const errors = [];
      const workerExits = [];
      // A host may have launched the app before selectAppConnection failed or IPC was lost.
      try { await driver.adoptRunning(); } catch (error) { errors.push(error.message); }
      for (const target of launched) {
        if (lifecycle?.cleanupAllowed === false) return uncertain();
        const live = (await list()).find(p => p.pid === target.pid);
        if (!live) continue;
        if (live.startedAtMs !== target.startedAtMs || !live.args.includes(tempRoot + '/')) { errors.push('FIXTURE_LAUNCH_IDENTITY_CHANGED'); continue; }
        if (lifecycle?.cleanupAllowed === false) return uncertain();
        try { current = target; if (!(await driver.quitByPid({ allowForce: false })).exited) errors.push('APP_EXIT_UNCONFIRMED'); } catch (error) { errors.push(error.message); }
      }
      let left = await census();
      for (let i = 0; left.length && i < 40; i++) { await sleep(250); left = await census(); }
      if (lifecycle?.cleanupAllowed === false) return uncertain();
      // Worker/host control starts only after the app and its recorded descendants are absent.
      if (!left.length && !errors.length) {
        for (const w of workers) {
          if (lifecycle?.cleanupAllowed === false) return uncertain();
          try {
            const gone = await w.stop();
            workerExits.push({ pid: w.child?.pid ?? null, exited: gone === true });
            if (gone) workers.delete(w);
            else errors.push('WORKER_EXIT_UNCONFIRMED');
          } catch (error) { errors.push(error.message); workerExits.push({ pid: w.child?.pid ?? null, exited: false }); }
        }
        active = undefined;
      }
      let host = hostPid && (await list()).find(p => p.pid === hostPid);
      if (lifecycle?.cleanupAllowed === false) return uncertain();
      if (host && !left.length && !errors.length) {
        if (host.startedAtMs !== hostIdentity?.startedAtMs || !host.args.includes(stateDir)) errors.push('HOST_IDENTITY_CHANGED');
        else {
          try { (deps.signal ?? process.kill)(hostPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message); }
          for (let i = 0; host && i < 40; i++) { await sleep(250); host = (await list()).find(p => p.pid === hostPid); }
          if (host) errors.push('HOST_EXIT_UNCONFIRMED');
        }
      }
      left = await census();
      if (lifecycle?.cleanupAllowed === false) return uncertain();
      const appExited = !left.length;
      const reaped = appExited && !errors.length ? await reaper.reap() : { confirmed: false, left: (await reaper.scan()).map(p => p.pid), errors: [] };
      errors.push(...reaped.errors);
      if (!reaped.confirmed) errors.push('RUN_PROCESS_EXIT_UNCONFIRMED');
      const workersExited = workers.size === 0 && workerExits.every(row => row.exited), confirmed = appExited && workersExited && !host && reaped.confirmed && !errors.length
        && lifecycle?.cleanupAllowed !== false;
      cleanupConfirmed = confirmed;
      if (confirmed) rmSync(base, { recursive: true, force: true });
      return { confirmed, appExited, workersExited, workerExits, hostExited: !host, runProcessesExited: reaped.confirmed, profileRemoved: confirmed && !existsSync(base), left: [...new Set([...left.map(p => p.pid), ...reaped.left])], errors,
        ...(adoptionFailures.length ? { adoptionFailures } : {}),
        ...(!confirmed ? { retainedRoot: base } : {}) };
      } finally { cleaning = false; }
    },
  };
  return driver;
}
