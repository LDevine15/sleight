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
import { BENCHMARK_ALLOWLIST, SELECTORS, editorRefOf, prepareWorkspace, refOf, tabsOf } from './electron-qualification.mjs';
import { assertHostPath, helper as qualificationHelper, listProcesses, parseCodesign, recipeFromBundle, qualificationWorker } from './electron-qualification-live.mjs';
import { editorIdentity } from './real-electron.mjs';
import { processExitConfirmed } from './real-fixture.mjs';
import { runOwned } from './preapproved-process.mjs';
import { checkRunSignal } from './electron-run-cancellation.mjs';
import { createRunReaper } from './electron-run-cleanup.mjs';

const execute = promisify(execFile);
const QUIT_HELPER = fileURLToPath(new URL('./real-electron.js', import.meta.url));
const D = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const SHIPPED_REGISTRY = new URL('electron/recipes.json', D);

// The copy's own settings: no trust prompt, welcome page, updates or telemetry on the restored window.
// extensions.autoUpdate is seeded in the form VS Code 1.141.0 migrates false to at startup ("off"): the 2026-10-22 02:32Z
// run's retained profile showed that one rewrite, which failed relaunch-user-quit's byte-for-byte check at 02:47Z.
export const SEED_SETTINGS = Object.freeze({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': 'off', 'workbench.tips.enabled': false, 'files.hotExit': 'onExitAndWindowClose' });
const SCRATCH = 'a-scratch.txt';

/** Closed detail for a settings file that no longer equals the seed: seed key names and short scalar values only, never
 *  free text or paths. before is the file as user-quit found it, after as the Quit left it (null when absent). */
export function settingsChange(seed, before, after, { userData = true, matchesSeedAt = {} } = {}) {
  const parse = text => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  const shown = v => typeof v === 'boolean' || Number.isFinite(v) || typeof v === 'string' && /^[A-Za-z0-9._-]{0,32}$/.test(v) ? v : v === null ? null : typeof v;
  const expected = parse(seed) ?? {}, seen = after == null ? undefined : parse(after);
  const changed = seen ? Object.keys(expected).filter(key => JSON.stringify(seen[key]) !== JSON.stringify(expected[key]))
    .map(key => ({ key, expected: shown(expected[key]), ...(key in seen ? { seen: shown(seen[key]) } : { missing: true }) })) : [];
  return { stage: 'user-quit-profile', expected: 'the seeded settings file, byte for byte', userData, settings: after != null, parsed: !!seen,
    changedBeforeQuit: before !== seed, changedByQuit: before !== after, changed, added: seen ? Object.keys(seen).filter(key => !(key in expected)).length : 0,
    matchesSeedAt };
}

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
const realDeps = () => ({
  exec: execute, helper: qualificationHelper, list: listProcesses, forkWorker: qualificationWorker, exited: processExitConfirmed,
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

export function liveRelaunchDriver(app, { root, io = {}, cardLog, python = 'python3', qualificationDiagnosticPath, lifecycle, signal, deps: given = {} }) {
  if (!BENCHMARK_ALLOWLIST.includes(app.bundleId)) throw Error('NOT_ON_BENCHMARK_ALLOWLIST');
  const d = { ...realDeps(), ...given };
  let cleaning = false;
  const boundary = () => { if (lifecycle?.cleanupAllowed === false) throw Error('RUN_CANCELLATION_UNSETTLED'); if (!cleaning) checkRunSignal(signal); };
  const uncertainEffect = () => { if (lifecycle) { lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; lifecycle.effectUnknown = true; } };
  for (const key of ['exec', 'helper', 'electron', 'kill']) {
    const original = d[key]; d[key] = (...args) => { boundary(); return original(...args); };
  }
  const createWorker = d.forkWorker;
  d.forkWorker = async () => {
    boundary(); const worker = await createWorker({ onUnsettled: uncertainEffect });
    for (const key of ['send', 'kill', 'stop']) if (typeof worker[key] === 'function') {
      const original = worker[key].bind(worker); worker[key] = (...args) => { boundary(); return original(...args); };
    }
    return worker;
  };
  const base = mkdtempSync(join(root, 'relaunch-'));
  const appsDir = join(base, 'apps'), home = join(base, 'home'), stateDir = join(base, 'state'), tempRoot = join(base, 'profiles'), registryPath = join(base, 'recipes.json');
  const copyPath = join(appsDir, basename(app.path));
  const session = 'v3' + createHash('sha256').update(base).digest('hex').slice(0, 32);
  const workers = new Set(), launched = [];
  const reaper = createRunReaper(base, { python, list: () => d.list(d.exec), signal: (...args) => d.kill(...args), sleep: d.sleep, lifecycle });
  const appProcesses = new Map();
  const appCensus = async () => {
    const rows = await d.list(d.exec);
    for (const row of rows) if (row.uid === process.getuid() && (row.args.startsWith(copyPath + '/') || row.args.includes(appsDir + '/'))) appProcesses.set(row.pid, row.startedAtMs);
    for (let changed = true; changed;) { changed = false;
      for (const row of rows) if (row.uid === process.getuid() && !appProcesses.has(row.pid) && appProcesses.has(row.ppid) &&
        rows.some(parent => parent.pid === row.ppid && parent.startedAtMs === appProcesses.get(row.ppid))) { appProcesses.set(row.pid, row.startedAtMs); changed = true; }
    }
    return rows.filter(row => row.uid === process.getuid() && appProcesses.get(row.pid) === row.startedAtMs);
  };
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
    // The launch's own kernel birth, when it reported one, pins readiness and the quit below to this exact process.
    const birth = /^[1-9]\d*\.\d{6}$/.test(opened.pidBirth ?? '') ? { pidBirth: opened.pidBirth } : {};
    try { await d.electron({ mode: 'ready', pid: opened.pid, bundle: app.bundleId, appPath: realCopy(), waitMs: 30000, ...birth }); }
    catch (error) {
      // A launch that never became ready is quit at once (the helper rechecks pid, bundle, path and birth), as below.
      await quitCopy(opened.pid, 20000, undefined, birth).catch(() => {});
      throw error;
    }
    for (const started = d.now(); !engaged(); await d.sleep(250)) {
      if (d.now() - started > 20000) {
        await quitCopy(opened.pid, 20000).catch(() => {});
        throw Error('PORTABLE_NOT_ENGAGED: the copy wrote no logs in its portable folder; it was quit at once');
      }
    }
    markSettings('engaged');
    return opened;
  }
  // The root is a real path (the runner resolves it). NSRunningApplication may report it without /private; the helper
  // resolves this path the same way before comparing (real-electron.js expectedPath).
  const realCopy = () => copyPath;
  const quitCopy = (pid, waitMs, allowForce, extra = {}) => d.electron({ mode: 'quit', pid, bundle: app.bundleId, appPath: realCopy(), waitMs, ...extra, ...(allowForce === false ? { allowForce: false } : {}) });
  const tool = async (name, args) => {
    const started = d.now(), reply = await (active ?? { send: async () => ({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }) }).send('call', { request: { name, arguments: args } });
    if (signal?.aborted && (!reply.ok || reply.result?.isError) || /effect[ -]unknown/i.test(reply.result?.text ?? '')) uncertainEffect();
    const ms = Math.round(d.now() - started);
    return reply.ok ? { ...reply.result, ms } : { text: reply.error, isError: true, ms };
  };
  const read = async (tab, extra = {}) => { const r = await tool('browser_read', { tab, ...extra }); if (r.isError) throw Error(String(r.text).split('\n')[0]); return r.text; };
  const joinedTab = async () => tabsOf((await tool('browser_tabs', { do: 'list' })).text).find(row => !row.parked)?.tab;
  // Whether the copy's settings still equal the seed at each stage, so a PROFILE_CHANGED receipt says when it changed.
  const settingsPath = () => join(portable, 'user-data', 'User', 'settings.json');
  const settingsText = () => { try { return readFileSync(settingsPath(), 'utf8'); } catch { return null; } };
  const matchesSeedAt = {};
  const markSettings = stage => { if (portable && seeded) matchesSeedAt[stage] = settingsText() === seeded; };
  const until = async (test, timeoutMs = 5000) => {
    for (const started = d.now(); ; await d.sleep(100)) { const value = await test(); if (value) return value; if (d.now() - started >= timeoutMs) return null; }
  };
  // The scratch file's editor as VS Code 1.141.0 exposes it (2026-10-22 live reads): a row click opens a preview tab and
  // may leave focus in the tree; a tab click focuses the zero-area editor, whose one actionable ref is the keyboard-only
  // ref a find read lists. A plain read stops at its 8000-character cut before the editor, so every lookup here is a find.
  async function scratchEditor(tab) {
    const seen = { tabOpen: false, tabSelected: false, rowClicked: false, tabClicked: false, textboxes: 0, actionable: 0, active: 0, keyboardOnly: 0, reads: 0, cut: false };
    const closed = code => Object.assign(Error(code), { detail: { stage: 'host-loss-editor',
      expected: 'a selected a-scratch.txt tab and one actionable editor textbox (named or active keyboard-only)', seen: { ...seen } } });
    const scan = text => {
      const lines = String(text).split('\n'), tabs = lines.filter(line => SELECTORS.scratchTab.test(line));
      const boxes = lines.filter(line => /textbox/.test(line) && (line.includes(SCRATCH) || /Editor content/i.test(line)));
      Object.assign(seen, { tabOpen: tabs.length > 0, tabSelected: tabs.some(line => /\[selected\]/.test(line)), textboxes: boxes.length,
        actionable: boxes.filter(line => refOf(line, /textbox/)).length, active: boxes.filter(line => /\[active\]/.test(line)).length,
        keyboardOnly: boxes.filter(line => /\[keyboard-only\]/.test(line)).length, reads: seen.reads + 1, cut: seen.cut || /^# Cut:/m.test(text) });
      return text;
    };
    const click = async (ref, key) => {
      const r = await tool('browser_act', { tab, steps: [{ do: 'click', ref }], observe: 'none' });
      seen[key] = true;
      if (r.isError) throw closed('SCRATCH_CLICK_FAILED');
    };
    const editorRef = async () => editorRefOf(scan(await read(tab, { find: 'Editor content|' + SCRATCH })), SCRATCH);
    const first = scan(await read(tab, { find: SCRATCH }));
    let ref = editorRefOf(first, SCRATCH);
    if (ref) return ref;
    let tabRef = refOf(first, SELECTORS.scratchTab);
    if (!tabRef) {
      await click(refOf(first, SELECTORS.scratch) ?? (() => { throw closed('SCRATCH_ROW_NOT_FOUND'); })(), 'rowClicked');
      tabRef = await until(async () => refOf(scan(await read(tab, { find: SCRATCH })), SELECTORS.scratchTab));
    }
    if (tabRef) await click(tabRef, 'tabClicked');
    ref = await until(editorRef);
    if (!ref) throw closed('EDITOR_NOT_FOUND');
    return ref;
  }

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
      markSettings('relaunched');
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
      markSettings('hostLossStart');
      let tab = await joinedTab() ?? (() => { throw Object.assign(Error('NO_JOINED_APP_TAB'), { detail: { stage: 'host-loss-tab', expected: 'one joined app tab' } }); })();
      const editor = await scratchEditor(tab);
      const typed = await tool('browser_act', { tab, steps: [{ do: 'type', ref: editor, text: marker }], observe: 'none' });
      if (typed.isError) throw Object.assign(Error('HOST_LOSS_TYPE_FAILED'), { detail: { stage: 'host-loss-type', expected: 'the marker typed into the scratch editor',
        keyboardOnlyRef: /^x\d+$/.test(editor) } });
      const status = (await active.send('status')).status;
      hostPid = status?.hostPid ?? hostPid;
      const host = (await d.list(d.exec)).find(p => p.pid === hostPid);
      if (!host || !host.args.includes(stateDir)) throw Object.assign(Error('HOST_PID_UNKNOWN: the host status gave no pid naming this run'),
        { detail: { stage: 'host-loss-host', expected: 'a live host whose arguments name this run\'s state folder', hostPid: Number.isSafeInteger(hostPid), hostFound: !!host } });
      d.kill(hostPid, 'SIGKILL'); // the host this run started, matched by its state folder
      await d.sleep(10000);
      const appSurvived = await alive(before.pid), prompt = !!(await io.permission?.());
      const reply = await turn({ rehost: true });
      const restarted = restartOutcome(reply, before, appSurvived);
      let unsaved = 'unverified';
      if (reply.ok) {
        tab = await joinedTab();
        // A find, since the editor's text lies past a plain read's cut; only content rows count, never a header line.
        const text = tab ? await read(tab, { find: marker }) : '';
        unsaved = String(text).split('\n').some(line => !line.startsWith('#') && line.includes(marker)) ? 'kept' : 'lost';
        if (tab) await tool('browser_act', { tab, steps: [{ do: 'press', key: 'Meta+S' }], observe: 'none' });
      }
      markSettings('hostLossEnd');
      return { card: { debugger: reply.card, relaunch: reply.relaunchCard }, appSurvived, unsaved, prompt, restarted, ms: null };
    },
    // Stands in for the owner's own Quit: the app's Quit (NSRunningApplication terminate), the host's collect, the profile kept.
    async userQuit({ waitMs = 60000 } = {}) {
      const target = current ?? (() => { throw Error('NOT_RELAUNCHED'); })();
      const started = d.now();
      const before = settingsText();
      markSettings('userQuitStart');
      await active?.send('end');
      const r = await quitCopy(target.pid, waitMs);
      const exited = await d.exited(target.pid);
      const c = exited ? await active?.send('collect') : undefined;
      const userData = existsSync(join(portable, 'user-data')), after = userData ? settingsText() : null;
      markSettings('userQuitEnd');
      const profileUntouched = userData && after === seeded;
      current = undefined;
      return { exited, collected: c?.ok === true && c.status?.broker !== 'ready', recordRemoved: c?.status?.ownership === 'free', profileUntouched,
        ...(!profileUntouched ? { profile: settingsChange(seeded, before, after, { userData, matchesSeedAt: { ...matchesSeedAt } }) } : {}),
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
      const uncertain = () => ({ confirmed: false, appExited: false, profileRemoved: false, errors: ['RUN_CANCELLATION_UNSETTLED'], retainedRoot: base });
      if (lifecycle?.cleanupAllowed === false) return uncertain();
      cleaning = true;
      try {
        const errors = [];
        await reaper.scan();
        const before = await appCensus();
        for (const row of before.filter(row => row.args.startsWith(copyPath + '/'))) {
          boundary();
          try { await quitCopy(row.pid, 20000, false); } catch (error) { errors.push(String(error.message).slice(0, 200)); }
        }
        let apps = await appCensus(); boundary();
        for (let i = 0; apps.length && i < 40; i++) { await d.sleep(250); boundary(); apps = await appCensus(); boundary(); }
        // Never use infrastructure signals to finish a refused app Quit or its unresolved descendants.
        if (apps.length || errors.length) return { confirmed: false, appExited: false, profileRemoved: false, left: apps.map(row => row.pid), errors, retainedRoot: base };
        for (const w of workers) {
          boundary();
          try {
            const end = await w.send('end'); boundary();
            if (end.ok !== true || end.ended !== true || !Array.isArray(end.cleanup) || end.cleanup.length) throw Error('WORKER_DRAIN_UNCONFIRMED');
            if (w.stop) { if (!await w.stop()) throw Error('WORKER_EXIT_UNCONFIRMED'); }
            else w.kill();
          } catch (error) { errors.push(error.message); }
        }
        boundary();
        if (errors.length) return { confirmed: false, appExited: true, profileRemoved: false, errors, retainedRoot: base };
        workers.clear(); active = undefined;
        const owned = await reaper.scan(); boundary();
        const cleanup = owned.length ? await reaper.reap() : { confirmed: true, left: [], errors: [] };
        boundary();
        if (cleanup.confirmed) rmSync(base, { recursive: true, force: true });
        const removed = !existsSync(base);
        return { confirmed: cleanup.confirmed && removed, appExited: true, profileRemoved: removed, left: cleanup.left, errors: cleanup.errors,
          ...(!removed ? { retainedRoot: base } : {}) };
      } catch (error) {
        if (lifecycle?.cleanupAllowed === false) return uncertain();
        return { confirmed: false, appExited: false, profileRemoved: false, errors: [String(error.message).slice(0, 200)], retainedRoot: base };
      } finally { cleaning = false; }
    },
  };
  return driver;
}
