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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { BENCHMARK_ALLOWLIST, prepareWorkspace } from './electron-qualification.mjs';
import { editorIdentity, parseProcesses, profileProcesses } from './real-electron.mjs';
import { processExitConfirmed } from './real-fixture.mjs';
import { runOwned } from './preapproved-process.mjs';

const execute = promisify(execFile);
const HELPER = fileURLToPath(new URL('./electron-qualification.js', import.meta.url));
const QUIT_HELPER = fileURLToPath(new URL('./real-electron.js', import.meta.url));
const WORKER = fileURLToPath(new URL('./electron-qualification-worker.mjs', import.meta.url));
const D = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);

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
  const { stdout } = await exec('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'lstart=', '-o', 'args='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  return parseProcesses(stdout);
}
export async function helper(request, exec = execute) {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', HELPER, JSON.stringify(request)], { timeout: 15000 });
  return JSON.parse(String(stdout).trim().split('\n').at(-1));
}

// The 50 ms frontmost/pointer sampler, one osascript child for the whole run. Read-only.
function liveObserver({ spawnProcess = spawn, root }) {
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
    async samples(start, end) { await new Promise(resolve => setTimeout(resolve, 120)); return samples.filter(s => s.t >= start - 100 && s.t <= end + 100); },
    async stop() {
      writeFileSync(stop, '');
      const done = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]);
      if (done === 'timeout') child.kill('SIGTERM'); // our own child only
    },
  };
}

function worker() {
  const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
  const pending = new Map();
  let sequence = 0, lost;
  child.on('message', msg => { const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); entry(msg); } });
  child.on('exit', () => { lost = true; for (const entry of pending.values()) entry({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); pending.clear(); });
  const send = (op, extra = {}) => new Promise(resolve => {
    if (lost) return resolve({ ok: false, error: 'V3_WORKER_UNAVAILABLE' });
    const id = ++sequence; pending.set(id, resolve);
    try { child.send({ id, op, ...extra }); } catch { pending.delete(id); resolve({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); }
  });
  return { child, send, kill: () => { if (!lost) child.kill('SIGKILL'); }, get lost() { return lost; } };
}

export async function liveRuntime(options, { io } = {}, deps = {}) {
  const exec = deps.exec ?? execute;
  const missing = await missingContract(deps.load);
  if (missing.length) throw Error(`ELECTRON_RUNTIME_MISSING: ${missing.join(', ')}. Merge EPV3-4 to 7 first; nothing was launched`);
  if (process.platform !== 'darwin') throw Error('MACOS_REQUIRED');
  if (!io?.permission) throw Error('PERMISSION_OBSERVER_REQUIRED');
  await io.permission(); // throws when codex-macos-inspect is missing, before anything starts
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-eq-'));
  const observer = liveObserver({ spawnProcess: deps.spawn, root });
  return { observer, driverFor: (app, extra = {}) => liveDriver(app, { root, exec, observer, ...extra }), async close() { rmSync(root, { recursive: true, force: true }); } };
}

// forkWorker: the seam the unit tests use for a fake worker; the run forks electron-qualification-worker.mjs.
// cardLog: the live runner's card log (electron-qualification-worker.mjs cardLine), passed to every worker.
export function liveDriver(app, { root, exec, observer, forkWorker = worker, cardLog }) {
  if (!BENCHMARK_ALLOWLIST.includes(app.bundleId)) throw Error('NOT_ON_BENCHMARK_ALLOWLIST');
  const base = mkdtempSync(join(root, app.key + '-'));
  const tempRoot = join(base, 'profiles'), stateDir = join(base, 'state'), registryPath = join(base, 'recipes.json');
  mkdirSync(tempRoot); mkdirSync(stateDir, { mode: 0o700 });
  const files = prepareWorkspace(join(base, 'workspace'));
  const session = 'v3' + randomBytes(16).toString('hex');
  const launched = [], workers = new Set();
  let found, build, recipe, active, current, last, otherFront, hostPid, appSecret;

  async function prepare() {
    if (recipe) return;
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
    registryPath, stateDir, tempRoot, appSecret, allowlist: [...BENCHMARK_ALLOWLIST], ...(cardLog ? { cardLog } : {}), ...extra });
  const seen = reply => { if (reply.ok && reply.hostPid) hostPid = reply.hostPid; return reply; };
  // A turn in the given worker, or in a new one (a new consent instance, so a new card).
  async function startWorker(consentWaitMs, sessionId = session, w) {
    if (!w) { w = forkWorker(); workers.add(w); }
    const reply = seen(await w.send('start', message(sessionId, { consentWaitMs })));
    return { w, reply };
  }
  // The driver's own admin connection, once the workers' channels have closed (the host takes one administrator at a time).
  async function driverAdmin() {
    const { ensureHost } = await import(new URL('electron-admin.mjs', D));
    for (let i = 0; ; i++) {
      try { return await ensureHost({ stateDir, registryPath, tempRoot, build: recipe.build, secret: appSecret }); }
      catch (error) { if (error.message !== 'ELECTRON_HOST_FOREIGN' || i >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  }
  const alive = async (pid, birth) => (await listProcesses(exec)).some(p => p.pid === pid && String(p.startedAtMs) === String(birth ?? p.startedAtMs));
  const census = async () => profileProcesses(await listProcesses(exec), tempRoot);

  const driver = {
    build: () => build ?? {},
    prepare,
    // What the live runner's Claude Code arm needs to reach this run's host through its own worker (electron-arm-server.mjs).
    armConfig: () => ({ bundleId: app.bundleId, name: app.name, session: 'v3' + randomBytes(16).toString('hex'), registryPath, stateDir, tempRoot, appSecret,
      allowlist: [...BENCHMARK_ALLOWLIST], workspace: files.root, ...(cardLog ? { cardLog } : {}) }),
    // The arm's worker launched the app, not this driver: the main process naming this run's temporary root joins the
    // launched list, so cleanup quits it like its own. Nothing else is adopted.
    async adoptRunning() {
      const all = await listProcesses(exec), mains = profileProcesses(all, tempRoot).filter(p => found && p.args.startsWith(found.executable + ' '));
      for (const p of mains) if (!launched.some(l => l.pid === p.pid)) launched.push({ pid: p.pid, pidBirth: String(p.startedAtMs) });
      if (mains.length) last = { pid: mains[0].pid };
      // The arm's host, by its own state folder argument, so cleanup ends it once the app is gone.
      hostPid ??= all.find(p => ` ${p.args} `.includes(` --state-dir ${stateDir} `))?.pid;
      return mains.length;
    },
    identity: () => current ?? last ?? null,
    async connect({ consentWaitMs } = {}) {
      await prepare();
      if (!otherFront) { const front = await helper({ mode: 'front' }, exec); if (!BENCHMARK_ALLOWLIST.includes(front.bundle)) otherFront = front; }
      const started = performance.now();
      const { w, reply } = await startWorker(consentWaitMs, session, active);
      if (!reply.ok) {
        const card = reply.card ?? { shown: false, status: /DEBUGGER_REQUIRED/.test(reply.error) ? 'timeout' : 'refused', error: reply.error };
        w.kill(); workers.delete(w); if (active === w) active = undefined;
        return { card, launch: {}, connect: {} };
      }
      active = w; current = last = reply.identity;
      launched.push({ pid: reply.identity.pid, pidBirth: reply.identity.pidBirth });
      const listeners = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(reply.identity.pid), '-iTCP', '-sTCP:LISTEN', '-t'], { timeout: 10000 })
        .then(r => String(r.stdout).trim().split('\n').filter(Boolean).length, error => (error.code === 1 ? 0 : -1));
      return { card: reply.card, launch: { ...reply.launch, ms: reply.launch.ms ?? Math.round(performance.now() - started) }, connect: { ms: reply.connectMs, tcpListeners: listeners } };
    },
    async restart(options) { await driver.quit(); return driver.connect(options); },
    async tool(name, args) {
      const started = performance.now(), reply = await (active ?? { send: async () => ({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }) }).send('call', { request: { name, arguments: args } });
      const ms = Math.round(performance.now() - started);
      return reply.ok ? { ...reply.result, ms } : { text: reply.error, isError: true, ms };
    },
    async frontApp() {
      if (!otherFront) throw Error('NO_OTHER_APP: the app frontmost before launch was a fixture');
      const front = await helper({ mode: 'front' }, exec);
      if (front.front !== otherFront.front) await helper({ mode: 'activate', pid: otherFront.front, fixturePid: current?.pid ?? 0 }, exec);
      return { pid: otherFront.front, bundle: otherFront.bundle };
    },
    async ownerInstances() { const { pids } = await helper({ mode: 'pids', bundle: app.bundleId }, exec); return pids.filter(pid => !launched.some(l => l.pid === pid)).length; },
    async windowOwners(ids) { return (await helper({ mode: 'owners', ids }, exec)).owners; },
    async geometry() {
      const r = await active.send('receipt'), delta = r.receipt?.cells?.delta;
      return { delta, zoomLevel: r.recipe?.zoomLevel, scaleMatch: (r.receipt?.cells?.joined ?? 0) > 0 };
    },
    async nativeSheetCancel() { return helper({ mode: 'press', pid: current.pid, title: 'Cancel' }, exec); },
    readFile: name => { try { return readFileSync(join(files.root, name), 'utf8'); } catch { return ''; } },
    async appAlive() { return !!current && await alive(current.pid); },
    async revoke() { await active.send('revoke'); },
    async resume() { await active.send('resume'); },
    // The indicator's Disconnect in the live worker, which keeps running: the cell's next call goes through that same worker,
    // so its refusal proves the disconnect. Retention and the closed worker channel come from the host's own status after it.
    async disconnect() {
      const reply = await active.send('disconnect');
      if (!reply.ok) throw Error(reply.error);
      const open = reply.status?.workers;
      if (!Array.isArray(open) || open.length) throw Error(`DISCONNECT_WORKER_CHANNEL_OPEN: ${Array.isArray(open) ? open.length : 'unknown'}`);
      return { appAlive: await driver.appAlive(), pipeRetained: pipeRetained(reply.status) };
    },
    // In the live worker: release and select again (a new turn, the session grant). Without one: a new worker and its card.
    async reconnect({ consentWaitMs } = {}) {
      const { w, reply } = await startWorker(consentWaitMs, session, active);
      if (reply.ok) { active = w; current = last = reply.identity; }
      else { w.kill(); workers.delete(w); if (active === w) active = undefined; }
      return reply.card ?? { shown: false, status: 'refused', error: reply.error };
    },
    async killWorker() { active?.kill(); workers.delete(active); active = undefined; return { killed: true }; },
    async killHost() {
      const status = (await active.send('status')).status;
      hostPid = status?.hostPid ?? hostPid;
      const host = (await listProcesses(exec)).find(p => p.pid === hostPid);
      if (!host || !host.args.includes(stateDir)) throw Error('HOST_PID_UNKNOWN: the host status gave no pid naming this run');
      process.kill(hostPid, 'SIGKILL'); // the host this run started, matched by its state folder
      active.kill(); workers.delete(active); active = undefined;
      return { appAlive: await driver.appAlive() };
    },
    // A new worker asks for the app while the dead host's ownership is unresolved: refused before any card or launch.
    async secondLaunch() {
      const { w, reply } = await startWorker(0);
      if (reply.ok) await w.send('end');
      w.kill(); workers.delete(w);
      return { code: reply.ok ? null : (/[A-Z_]{6,}/.exec(reply.error)?.[0] ?? reply.error) };
    },
    // The host's own ownership recovery once the app is gone; no launch, no card.
    async reconcile() {
      const w = forkWorker(); workers.add(w);
      const reply = await w.send('reconcile', message());
      w.kill(); workers.delete(w);
      return { code: !reply.ok ? (/[A-Z_]{6,}/.exec(reply.error)?.[0] ?? reply.error) : reply.resolved ? null : 'ELECTRON_OWNERSHIP_UNRESOLVED', reason: reply.reason ?? null };
    },
    async quitByPid() {
      const target = current ?? last;
      const result = await runOwned('/usr/bin/osascript', ['-l', 'JavaScript', QUIT_HELPER, JSON.stringify({ mode: 'quit', pid: target.pid, bundle: app.bundleId, appPath: found.path })], { timeoutMs: 45000 });
      return { exited: result.exit?.code === 0 && await processExitConfirmed(target.pid) };
    },
    async collect() {
      const left = await census();
      if (!left.length) for (const name of readdirSync(tempRoot)) rmSync(join(tempRoot, name), { recursive: true, force: true });
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
      for (const w of workers) { await w.send('end'); w.kill(); }
      workers.clear(); active = undefined;
      // Quit through the app (the host's requestQuit: NSRunningApplication terminate after the birth matches).
      const admin = await driverAdmin();
      await admin.quit();
      const exited = target ? await processExitConfirmed(target.pid) : true;
      await admin.collect?.();
      await admin.close?.();
      const left = await census();
      current = undefined;
      return { exited, ms: Math.round(performance.now() - started), censusLeft: left.length, profileRemoved: readdirSync(tempRoot).length === 0 };
    },
    async cleanup() {
      for (const w of workers) w.kill();
      workers.clear(); active = undefined;
      const errors = [];
      for (const { pid } of launched) {
        if (!(await listProcesses(exec)).some(p => p.pid === pid && p.args.includes(tempRoot))) continue;
        try { current = { pid }; await driver.quitByPid(); } catch (error) { errors.push(error.message); }
      }
      let left = await census();
      for (let i = 0; left.length && i < 40; i++) { await new Promise(resolve => setTimeout(resolve, 250)); left = await census(); }
      const host = hostPid && (await listProcesses(exec)).find(p => p.pid === hostPid && p.args.includes(stateDir));
      if (host && !left.length) process.kill(hostPid, 'SIGTERM');
      const appExited = !left.length;
      if (appExited) rmSync(base, { recursive: true, force: true });
      return { confirmed: appExited && !errors.length, appExited, profileRemoved: appExited && !existsSync(base), left: left.map(p => p.pid), errors };
    },
  };
  return driver;
}
