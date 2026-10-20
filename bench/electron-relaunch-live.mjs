// Live driver for the relaunch cells (electron-qualification.mjs RELAUNCH_CELLS) on a benchmark copy, never the owner's app.
// - The app: an APFS clone of the installed bundle in this run's temporary folder, with the app's own portable-data folder
//   beside it (VS Code reads `<dirname of the .app>/<applicationName>-portable-data` when product.json has no `target`), so
//   the copy's own profile is that folder. Every write lands under the run's folder, and the owner's profile is never opened.
// - The relaunch flow needs exactly one running process of the bundle, so the owner's own copy must be closed; this driver
//   refuses (OWNER_APP_RUNNING) and never quits it.
// - The copy is first opened the way a person opens it (LaunchServices, no activation, no pipe). Then one turn of the
//   installed worker's path on profile 'user' shows the debugger card (Always allow is offered on a persistent profile) and
//   the relaunch card. Only a person's click answers either; the run waits and records.
// - Cleanup quits only the copy (pid and bundle path checked) and ends only processes whose arguments name this run's folder.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BENCHMARK_ALLOWLIST, SELECTORS, prepareWorkspace, refOf, tabsOf } from './electron-qualification.mjs';
import { assertHostPath, helper as qualificationHelper, listProcesses, parseCodesign, recipeFromBundle } from './electron-qualification-live.mjs';
import { editorIdentity } from './real-electron.mjs';
import { processExitConfirmed } from './real-fixture.mjs';
import { runOwned } from './preapproved-process.mjs';

const execute = promisify(execFile);
const QUIT_HELPER = fileURLToPath(new URL('./real-electron.js', import.meta.url));
const WORKER = fileURLToPath(new URL('./electron-qualification-worker.mjs', import.meta.url));
const D = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const SHIPPED_REGISTRY = new URL('electron/recipes.json', D);

// The copy's own settings: no trust prompt, welcome page, updates or telemetry on the restored window.
export const SEED_SETTINGS = Object.freeze({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'workbench.tips.enabled': false, 'files.hotExit': 'onExitAndWindowClose' });

/** The portable-data folder name the app reads beside its bundle, or a refusal when the build has no portable mode. */
export function portableName(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) throw Error('PRODUCT_UNREADABLE');
  if ('target' in product) throw Error('PORTABLE_UNSUPPORTED: this build sets product.target, so it ignores a portable folder');
  const name = product.portable || (typeof product.applicationName === 'string' && product.applicationName ? `${product.applicationName}-portable-data` : '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw Error('PRODUCT_UNREADABLE');
  return name;
}
/** The relaunch error's outcome for the relaunch-quit cell. */
export function quitOutcome(error) {
  const code = /ELECTRON_RELAUNCH_[A-Z_]+/.exec(String(error ?? ''))?.[0];
  return { ELECTRON_RELAUNCH_QUIT_REFUSED: 'refused', ELECTRON_RELAUNCH_QUIT_PENDING: 'running', ELECTRON_RELAUNCH_CHANGED: 'mismatch',
    ELECTRON_RELAUNCH_RACED: 'raced', ELECTRON_RELAUNCH_FAILED: 'not-reopened', ELECTRON_RELAUNCH_REOPENED_NATIVE: 'reopened-native',
    ELECTRON_RELAUNCH_NO_PIPE: 'no-pipe' }[code] ?? (code ? 'not-quit' : 'unknown');
}
/** host-loss: what the restarted host did with the app the keeper held. */
export function restartOutcome(reply, before, appSurvived) {
  if (reply?.ok) return reply.identity?.pid === before?.pid && reply.identity?.pidBirth === before?.pidBirth ? 'reattached' : 'changed';
  return appSurvived && /OWNERSHIP_UNRESOLVED/.test(String(reply?.error)) ? 'released' : 'failed';
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function forkedWorker() {
  return import('node:child_process').then(({ fork }) => {
    const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      env: { ...process.env, SLEIGHT_TURBO_UNQUALIFIED: '1' } });
    const pending = new Map();
    let sequence = 0, lost;
    child.on('message', msg => { const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); entry(msg); } });
    child.on('exit', () => { lost = true; for (const entry of pending.values()) entry({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); pending.clear(); });
    const send = (op, extra = {}) => new Promise(resolve => {
      if (lost) return resolve({ ok: false, error: 'V3_WORKER_UNAVAILABLE' });
      const id = ++sequence; pending.set(id, resolve);
      try { child.send({ id, op, ...extra }); } catch { pending.delete(id); resolve({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); }
    });
    return { child, send, kill: () => { if (!lost) child.kill('SIGKILL'); } };
  });
}
const realDeps = () => ({
  exec: execute, helper: qualificationHelper, list: listProcesses, forkWorker: forkedWorker, exited: processExitConfirmed,
  electron: async request => {
    const r = await runOwned('/usr/bin/osascript', ['-l', 'JavaScript', QUIT_HELPER, JSON.stringify(request)], { timeoutMs: (request.waitMs ?? 30000) + 20000 });
    if (r.exit?.code !== 0) throw Error(`ELECTRON_HELPER_FAILED: ${String(r.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200)}`);
    return String(r.stdout).trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean).at(-1);
  },
  derive: async (process) => (await import(new URL('electron-identity.mjs', D))).deriveAppInstance(process),
  secret: async () => (await import(new URL('worker.mjs', D))).serverAppSecret(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => performance.now(),
  kill: (pid, signal) => process.kill(pid, signal),
});

export function liveRelaunchDriver(app, { root, io = {}, cardLog, python = 'python3', qualificationDiagnosticPath, deps: given = {} }) {
  if (!BENCHMARK_ALLOWLIST.includes(app.bundleId)) throw Error('NOT_ON_BENCHMARK_ALLOWLIST');
  const d = { ...realDeps(), ...given };
  const base = mkdtempSync(join(root, 'relaunch-'));
  const appsDir = join(base, 'apps'), home = join(base, 'home'), stateDir = join(base, 'state'), tempRoot = join(base, 'profiles'), registryPath = join(base, 'recipes.json');
  const copyPath = join(appsDir, basename(app.path));
  const session = 'v3' + createHash('sha256').update(base).digest('hex').slice(0, 32);
  const workers = new Set(), launched = [];
  let files, recipe, build, portable, seeded, appSecret, active, current, last, otherFront, hostPid;

  const owners = async () => (await d.helper({ mode: 'pids', bundle: app.bundleId }, d.exec)).pids;
  async function prepare() {
    if (recipe) return;
    assertHostPath(stateDir);
    const source = await editorIdentity(app.path, { exec: d.exec });
    if (source.bundle !== app.bundleId) throw Error(`${app.path} is ${source.bundle}, not ${app.bundleId}`);
    if ((await owners()).length) throw Error('OWNER_APP_RUNNING: the relaunch cells need the owner\'s own copy closed; the runner never quits it');
    // A quarantined source would be translocated, and a translocated copy has no portable folder beside it.
    const quarantined = await d.exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app.path], { timeout: 5000 }).then(() => true, () => false);
    if (quarantined) throw Error('SOURCE_QUARANTINED: the installed bundle carries a quarantine flag; the runner leaves it as it is');
    mkdirSync(appsDir, { recursive: true }); mkdirSync(home); mkdirSync(tempRoot); mkdirSync(stateDir, { mode: 0o700 });
    await d.exec('/bin/cp', ['-cR', app.path, appsDir + '/'], { timeout: 120000 }); // an APFS clone: no second copy on disk
    const copy = await editorIdentity(copyPath, { exec: d.exec });
    if (copy.bundle !== app.bundleId || !copy.path.startsWith(base + '/')) throw Error('COPY_IDENTITY_CHANGED');
    portable = join(appsDir, portableName(JSON.parse(readFileSync(join(copy.path, 'Contents/Resources/app/product.json'), 'utf8'))));
    mkdirSync(join(portable, 'user-data', 'User'), { recursive: true });
    seeded = JSON.stringify(SEED_SETTINGS, null, 2) + '\n';
    writeFileSync(join(portable, 'user-data', 'User', 'settings.json'), seeded);
    files = prepareWorkspace(join(base, 'workspace'));
    const digest = await sha256(copy.executable);
    if (digest !== await sha256(source.executable)) throw Error('COPY_DIFFERS_FROM_SOURCE');
    // The shipped recipe's userProfile (its support folder name and empty arguments) is what the relaunch reopens with.
    const shipped = JSON.parse(readFileSync(SHIPPED_REGISTRY, 'utf8')).recipes.find(r => r.bundleId === app.bundleId)?.userProfile;
    if (!shipped) throw Error('ELECTRON_USER_PROFILE_UNSUPPORTED');
    const derived = await d.derive({ bundle: copy.path, executable: copy.executable, profile: join(home, 'Library/Application Support', shipped.supportDir), temporary: false, pid: 1, pidBirth: 'recipe' });
    const signed = parseCodesign((await d.exec('/usr/bin/codesign', ['-dv', '--verbose=4', copy.path], { timeout: 20000 })).stderr);
    build = { version: derived.version, sha256: digest, signer: signed.signer, team: derived.signer, cdhash: derived.cdhash, runtime: derived.runtime, copy: true, portable: true };
    recipe = recipeFromBundle({ app, derived, executable: copy.executable, sha256: digest, bundlePath: copy.path, workspace: files.root, userProfile: shipped });
    writeFileSync(registryPath, JSON.stringify({ version: 1, recipes: [recipe] }, null, 2), { mode: 0o600 });
    appSecret = await d.secret();
  }
  const message = (extra = {}) => ({ bundleId: app.bundleId, session, text: `Qualify the relaunch flow in ${app.name}.`, registryPath, stateDir, tempRoot,
    appSecret, python, qualificationDiagnosticPath, allowlist: [...BENCHMARK_ALLOWLIST], profile: 'user', home, ...(cardLog ? { cardLog } : {}), ...extra });
  const seen = reply => { if (reply?.ok && reply.hostPid) hostPid = reply.hostPid; return reply; };
  const alive = async pid => !!pid && (await d.list(d.exec)).some(p => p.pid === pid);
  const engaged = () => existsSync(join(portable, 'user-data', 'logs'));
  async function turn(extra = {}) {
    if (!active) { active = await d.forkWorker(); workers.add(active); }
    const reply = seen(await active.send('start', message(extra)));
    if (reply.ok) { current = last = reply.identity; if (!launched.some(l => l.pid === reply.identity.pid)) launched.push({ pid: reply.identity.pid }); }
    return reply;
  }
  // The copy as a person opens it: LaunchServices, no activation, no pipe, the fixture folder as its one argument.
  async function openCopy() {
    let opened = (await d.electron({ mode: 'launch', bundle: app.bundleId, appPath: realCopy(), target: files.root }))?.process;
    const detail = { stage: 'copy-launch', pid: opened?.pid ?? null, expected: realCopy(), actual: opened?.path ?? null, bundle: opened?.bundle ?? null };
    const matches = p => {
      try { return Number.isSafeInteger(p?.pid) && p.pid > 0 && p.bundle === app.bundleId && realpathSync(p.path) === realCopy(); }
      catch { return false; }
    };
    // If NSWorkspace returns before its process metadata exists, resolve a partial reply by the exact bundle path,
    // without a second launch or a bundle-id-only adoption. A different, fully identified app is refused below.
    if (!Number.isSafeInteger(opened?.pid) || opened.pid <= 0 || !opened.path) {
      for (const started = d.now(); ; await d.sleep(250)) {
        const table = await d.electron({ mode: 'table', bundle: app.bundleId });
        const copies = (Array.isArray(table?.processes) ? table.processes : []).filter(matches);
        if (copies.length > 1) throw Object.assign(Error('COPY_LAUNCH_AMBIGUOUS'), { detail: { ...detail, matches: copies.length } });
        if (copies.length === 1) { opened = copies[0]; break; }
        if (d.now() - started >= 5000) break;
      }
    }
    if (!Number.isSafeInteger(opened?.pid) || opened.pid <= 0) throw Object.assign(Error('COPY_LAUNCH_PID_INVALID'), { detail });
    if (!matches(opened))
      throw Object.assign(Error(`COPY_LAUNCH_IDENTITY_MISMATCH: pid ${opened.pid}, expected ${realCopy()}, got ${opened.path ?? 'no path'} (${opened.bundle ?? 'no bundle'})`), { detail });
    launched.push({ pid: opened.pid });
    await d.electron({ mode: 'ready', pid: opened.pid, bundle: app.bundleId, appPath: realCopy(), waitMs: 30000 });
    for (const started = d.now(); !engaged(); await d.sleep(250)) {
      if (d.now() - started > 20000) {
        await quitCopy(opened.pid, 20000).catch(() => {});
        throw Error('PORTABLE_NOT_ENGAGED: the copy wrote no logs in its portable folder; it was quit at once');
      }
    }
    return opened;
  }
  // The root is a real path (the runner resolves it), so the copy's path is what NSRunningApplication reports.
  const realCopy = () => copyPath;
  const quitCopy = (pid, waitMs) => d.electron({ mode: 'quit', pid, bundle: app.bundleId, appPath: realCopy(), waitMs });
  const tool = async (name, args) => {
    const started = d.now(), reply = await (active ?? { send: async () => ({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }) }).send('call', { request: { name, arguments: args } });
    const ms = Math.round(d.now() - started);
    return reply.ok ? { ...reply.result, ms } : { text: reply.error, isError: true, ms };
  };
  const read = async tab => { const r = await tool('browser_read', { tab }); if (r.isError) throw Error(String(r.text).split('\n')[0]); return r.text; };
  const joinedTab = async () => tabsOf((await tool('browser_tabs', { do: 'list' })).text).find(row => !row.parked)?.tab;

  const driver = {
    build: () => build ?? {},
    identity: () => current ?? last ?? null,
    tool,
    paths: () => ({ base, copy: copyPath, portable, stateDir }),
    async relaunch() {
      await prepare();
      if (!otherFront) { const front = await d.helper({ mode: 'front' }, d.exec); if (!BENCHMARK_ALLOWLIST.includes(front.bundle)) otherFront = front; }
      const opened = await openCopy();
      const before = { pid: opened.pid, pidBirth: String(opened.launchedAtMs), windows: (await d.helper({ mode: 'windows', pid: opened.pid }, d.exec)).windows };
      if ((await owners()).some(pid => pid !== opened.pid)) throw Error('OWNER_APP_RUNNING: another copy of the app opened; nothing was quit');
      const started = d.now(), reply = await turn();
      const ms = Math.round(d.now() - started), prompt = !!(await io.permission?.());
      const card = { debugger: reply.card ?? { shown: false, status: 'refused', error: reply.error }, relaunch: reply.relaunchCard ?? { shown: false, status: 'refused', error: reply.error } };
      if (!reply.ok) return { card, before, ms, quit: { outcome: quitOutcome(reply.error), ms: null, prompt }, error: reply.error, pipe: false, profile: { temporary: false } };
      const listeners = await d.exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(reply.identity.pid), '-iTCP', '-sTCP:LISTEN', '-t'], { timeout: 10000 })
        .then(r => String(r.stdout).trim().split('\n').filter(Boolean).length, error => (error.code === 1 ? 0 : -1));
      const rows = tabsOf((await tool('browser_tabs', { do: 'list' })).text);
      // Nothing was unsaved in the copy before its Quit (it had no pipe to type through); host-loss measures unsaved work.
      return { card, before, pid: reply.identity.pid, pidBirth: reply.identity.pidBirth, ms, quit: { outcome: 'exited', ms: reply.relaunch?.quitMs ?? null, prompt },
        launchMs: reply.relaunch?.launchMs ?? null, unsaved: 'none', pipe: true, profile: { temporary: false }, tcpListeners: listeners,
        activated: reply.relaunch?.activated === true, wasFront: reply.relaunch?.wasFront === true, joinedAfter: rows.filter(row => !row.parked).length };
    },
    async nextTurn() {
      const before = current, reply = await turn();
      if (!reply.ok) throw Error(reply.error);
      return { card: reply.card, launched: reply.identity.pid !== before?.pid || reply.identity.pidBirth !== before?.pidBirth };
    },
    // Runs before user-quit (the live order), on the app the relaunch reopened: an unsaved line, sleight's host killed, the
    // keeper holding the pipe, then the next turn's restarted host. The buffer is saved at the end so the Quit asks nothing.
    async hostLoss() {
      const before = current ?? (() => { throw Error('NOT_RELAUNCHED'); })();
      const marker = 'hl' + Math.random().toString(36).slice(2, 8);
      let tab = await joinedTab() ?? (() => { throw Error('NO_JOINED_APP_TAB'); })();
      const scratch = refOf(await read(tab), SELECTORS.scratch) ?? (() => { throw Error('SCRATCH_ROW_NOT_FOUND'); })();
      await tool('browser_act', { tab, steps: [{ do: 'click', ref: scratch }], observe: 'none' });
      const editor = refOf(await read(tab), SELECTORS.editor) ?? (() => { throw Error('EDITOR_NOT_FOUND'); })();
      const typed = await tool('browser_act', { tab, steps: [{ do: 'type', ref: editor, text: marker }], observe: 'none' });
      if (typed.isError) throw Error(String(typed.text).split('\n')[0]);
      const status = (await active.send('status')).status;
      hostPid = status?.hostPid ?? hostPid;
      const host = (await d.list(d.exec)).find(p => p.pid === hostPid);
      if (!host || !host.args.includes(stateDir)) throw Error('HOST_PID_UNKNOWN: the host status gave no pid naming this run');
      d.kill(hostPid, 'SIGKILL'); // the host this run started, matched by its state folder
      await d.sleep(10000);
      const appSurvived = await alive(before.pid), prompt = !!(await io.permission?.());
      const reply = await turn({ rehost: true });
      const restarted = restartOutcome(reply, before, appSurvived);
      let unsaved = 'unverified';
      if (reply.ok) {
        tab = await joinedTab();
        const text = tab ? await read(tab) : '';
        unsaved = text.includes(marker) ? 'kept' : 'lost';
        if (tab) await tool('browser_act', { tab, steps: [{ do: 'press', key: 'Meta+S' }], observe: 'none' });
      }
      return { card: { debugger: reply.card, relaunch: reply.relaunchCard }, appSurvived, unsaved, prompt, restarted, ms: null };
    },
    // Stands in for the owner's own Quit: the app's Quit (NSRunningApplication terminate), the host's collect, the profile kept.
    async userQuit({ waitMs = 60000 } = {}) {
      const target = current ?? (() => { throw Error('NOT_RELAUNCHED'); })();
      const started = d.now();
      await active?.send('end');
      const r = await quitCopy(target.pid, waitMs);
      const exited = await d.exited(target.pid);
      const c = exited ? await active?.send('collect') : undefined;
      const settings = join(portable, 'user-data', 'User', 'settings.json');
      const profileUntouched = existsSync(join(portable, 'user-data')) && existsSync(settings) && readFileSync(settings, 'utf8') === seeded;
      current = undefined;
      return { exited, collected: c?.ok === true && c.status?.broker !== 'ready', recordRemoved: c?.status?.ownership === 'free', profileUntouched,
        ms: Math.round(d.now() - started), forced: r?.forced === true, presses: r?.presses ?? 0 };
    },
    async frontApp() {
      if (!otherFront) throw Error('NO_OTHER_APP: the app frontmost before launch was a fixture');
      const front = await d.helper({ mode: 'front' }, d.exec);
      if (front.front !== otherFront.front) await d.helper({ mode: 'activate', pid: otherFront.front, fixturePid: current?.pid ?? 0 }, d.exec);
      return { pid: otherFront.front, bundle: otherFront.bundle };
    },
    async appAlive() { return alive(current?.pid); },
    async cleanup() {
      const errors = [];
      for (const w of workers) { try { await w.send('end'); } catch {} w.kill(); }
      workers.clear(); active = undefined;
      // The copy first, through its own Quit (forced after the wait), matched by pid and the copy's bundle path.
      for (const { pid } of launched) {
        if (!await alive(pid)) continue;
        try { await quitCopy(pid, 20000); } catch (error) { errors.push(String(error.message).slice(0, 200)); }
      }
      // Then this run's host, adapter and keeper: every process whose arguments name the run's folder.
      const mine = async () => (await d.list(d.exec)).filter(p => p.pid !== process.pid && p.args.includes(base + '/'));
      for (const p of await mine()) { try { d.kill(p.pid, 'SIGTERM'); } catch {} }
      let left = await mine();
      for (let i = 0; left.length && i < 20; i++) { await d.sleep(250); left = await mine(); }
      for (const p of left) { try { d.kill(p.pid, 'SIGKILL'); } catch {} }
      if (left.length) { await d.sleep(500); left = await mine(); }
      if (!left.length) rmSync(base, { recursive: true, force: true });
      const removed = !existsSync(base);
      return { confirmed: !left.length && removed && !errors.length, appExited: !left.length, profileRemoved: removed, left: left.map(p => p.pid), errors };
    },
  };
  return driver;
}
