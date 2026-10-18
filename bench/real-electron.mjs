import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runOwned } from './preapproved-process.mjs';
import { processExitConfirmed } from './real-fixture.mjs';
import { acquireFixture } from './real-run.mjs';

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function appRunning(bundle, { exec = execute } = {}) {
  const script = 'ObjC.import("AppKit"); const want = ' + JSON.stringify(bundle)
    + '; const running = $.NSWorkspace.sharedWorkspace.runningApplications; let n = 0;'
    + ' for (let i = 0; i < running.count; i++) { const id = running.objectAtIndex(i).bundleIdentifier;'
    + ' if (!id.isNil() && ObjC.unwrap(id) === want) n++; } String(n);';
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000 });
  return Number(String(stdout).trim()) > 0;
}

export async function openBackground(bundle, target, { exec = execute } = {}) {
  const args = ['-g', '-b', bundle];
  if (target) args.push(target);
  await exec('/usr/bin/open', args, { timeout: 15000 });
}

export async function quitBundle(bundle, { exec = execute, running = appRunning } = {}) {
  try {
    await exec('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(bundle)} to quit`], { timeout: 15000 });
  } catch {}
  for (let i = 0; i < 20; i++) {
    if (!await running(bundle, { exec })) return;
    await sleep(250);
  }
  throw new Error('Launched app quit unconfirmed');
}

export function prepareEditor(ctx) {
  ctx.document = join(ctx.dir, `${ctx.nonce}-edit.txt`);
  writeFileSync(ctx.document, 'alpha beta gamma\n');
}

export function checkEditor(ctx) {
  try {
    const text = readFileSync(ctx.document, 'utf8');
    return text.trim() === 'alpha delta gamma' || 'saved document does not contain the replaced word';
  } catch { return 'edit document is missing'; }
}

export async function openElectron(ctx, { app, bundle, target }, {
  running = appRunning, open = openBackground, quit = quitBundle,
} = {}) {
  ctx.signal?.throwIfAborted();
  const wasRunning = await running(bundle);
  const lease = {
    app, bundle, launched: !wasRunning, running: wasRunning,
    async close() {},
    async dispose() { return true; },
    async quit() {
      if (!lease.launched) return;
      await quit(bundle);
    },
  };
  (ctx.windowLeases ??= []).push(lease);
  ctx.electronLease = lease;
  if (target !== undefined) await open(bundle, target);
  return lease;
}

// The editor tasks launch their own instance with a throwaway profile: the owner's running VS Code or Cursor, their windows,
// accounts and extensions stay untouched, and no Apple event reaches the app (LAWS; the owner approved both apps for fixture
// content, 2026-10-17). VS Code 1.141.0 and Cursor 3.25.6 (a VS Code fork) define every flag below in their own main process.
export const EDITORS = {
  'com.microsoft.VSCode': { app: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app',
    names: ['Visual Studio Code', 'VS Code', 'Code', 'com.microsoft.VSCode'] },
  'com.todesktop.230313mzl4w4u92': { app: 'Cursor', path: '/Applications/Cursor.app', names: ['Cursor', 'com.todesktop.230313mzl4w4u92'] },
};
const EDITOR_FLAGS = ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry',
  '--disable-updates', '--disable-crash-reporter', '--skip-add-to-recently-opened', '--new-window'];
const EDITOR_SETTINGS = { 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false, 'workbench.enableExperiments': false, 'workbench.tips.enabled': false };
const EDITOR_HELPER = fileURLToPath(new URL('./real-electron.js', import.meta.url));

// A browser opened by this run may quit only its observed process. Existing instances stay running.
// Reuse the editor's AppKit/AX helper rather than sending an Automation event to the app.
export async function openPidFixture(ctx, { app, bundle, target }, {
  open = openBackground, run = runOwned, exited = processExitConfirmed,
} = {}) {
  const helper = async (mode, extra = {}) => {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', EDITOR_HELPER,
      JSON.stringify({ mode, bundle, ...extra })], { timeoutMs: 45000,
      signal: mode === 'table' ? ctx.signal : ctx.cleanupSignal });
    const event = receipt(result, mode);
    if (!result.groupClean || result.exit?.code !== 0 || !event) throw new Error(`${app} ${mode === 'quit' ? 'quit' : 'inventory'} unconfirmed`);
    return event;
  };
  const valid = row => row && Number.isSafeInteger(row.pid) && row.pid > 0 && row.bundle === bundle &&
    typeof row.path === 'string' && row.path.startsWith('/') && Number.isFinite(row.launchedAtMs) && row.launchedAtMs > 0;
  ctx.signal?.throwIfAborted();
  const { processes: before } = await helper('table');
  if (!Array.isArray(before) || !before.every(valid)) throw new Error(`${app} process identity unconfirmed`);
  if (before.length > 1) throw new Error(`${app} fixture launch ambiguous`);
  const lease = { app, bundle, launched: before.length === 0, running: before.length > 0,
    async close() {},
    async dispose() { return true; },
    async quit() {
      if (!lease.launched || lease.appQuit) return;
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      if (!lease.pid) throw new Error(`${app} launch identity unconfirmed; quit refused`);
      await helper('quit', { pid: lease.pid, appPath: lease.path, launchedAtMs: lease.launchedAtMs });
      let gone = false, failure;
      try { gone = await exited(lease.pid, lease.launchedAtMs); } catch (error) { failure = error.message; }
      if (!gone) {
        (ctx.exitDisagreements ??= []).push({ app, bundle, step: 'quit', pid: lease.pid });
        throw new Error(`Owned ${app} exit disagreement after quit: ${failure || `pid ${lease.pid} is still running`}; live lock kept`);
      }
      lease.appQuit = true;
    },
  };
  (ctx.windowLeases ??= []).push(lease);
  ctx.electronLease = lease;
  ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
  if (lease.launched) {
    // Keep the launch receipt even if the run is cancelled while AppKit is launching it.
    const { process: row } = await helper('launch', { target });
    if (!valid(row)) throw new Error(`${app} launch identity unconfirmed`);
    Object.assign(lease, row);
  } else if (target !== undefined) await open(bundle, target);
  ctx.signal?.throwIfAborted();
  return lease;
}

// -n starts a new instance even while the owner's runs; its own --user-data-dir keeps it from handing the file to theirs.
export function editorLaunchArgs(appPath, root, target) {
  return ['-n', '-g', '-a', appPath, '--args', `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`,
    ...EDITOR_FLAGS, target];
}

// The main process puts its sockets in the profile ("1.14-main.sock", at most 16 characters); macOS limits socket paths to 103 characters.
export function makeEditorProfile({ base = realpathSync(tmpdir()) } = {}) {
  const root = mkdtempSync(join(base, 'sleight-ed-'));
  if (join(root, 'profile', '0000-shared.sock').length > 103) {
    rmSync(root, { recursive: true, force: true });
    throw Object.assign(new Error('Editor profile path too long for its IPC socket'), { noMutation: true });
  }
  mkdirSync(join(root, 'profile', 'User'), { recursive: true });
  mkdirSync(join(root, 'extensions'));
  writeFileSync(join(root, 'profile', 'User', 'settings.json'), JSON.stringify(EDITOR_SETTINGS, null, 2));
  return root;
}

export async function editorIdentity(appPath, { exec = execute } = {}) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const read = async key => String((await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeout: 5000 })).stdout).trim();
  const path = realpathSync(appPath);
  return { path, bundle: await read('CFBundleIdentifier'), executable: join(path, 'Contents', 'MacOS', await read('CFBundleExecutable')) };
}

export function parseProcesses(stdout) {
  return String(stdout).split('\n').map(line => /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s(.*)$/.exec(line))
    .filter(Boolean).map(([, pid, start, args]) => ({ pid: Number(pid), startedAtMs: new Date(start).getTime(), args: args.trim() }));
}

async function listProcesses() {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'lstart=', '-o', 'args='],
    { env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  return parseProcesses(stdout);
}

// The fixture is the main process of this app's executable that names this run's profile and started after the launch
// (ps start times have whole seconds). The owner's instance has another profile, so it never matches.
export function editorMains(processes, { executable, profile, launchedAtMs }) {
  return processes.filter(item => item.args.startsWith(executable + ' ') && ` ${item.args} `.includes(` --user-data-dir=${profile} `) &&
    item.startedAtMs >= Math.floor(launchedAtMs / 1000) * 1000 - 1000);
}

// Every process naming the profile (main, helpers, crash handler) is this run's.
export function profileProcesses(processes, root) {
  return processes.filter(item => item.args.includes(root + '/'));
}

function receipt(result, stage) {
  return result.stdout?.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.stage === stage);
}

export async function openEditor(ctx, { app, bundle, target }, {
  exec = execute, run = runOwned, list = listProcesses, exited = processExitConfirmed, makeProfile = makeEditorProfile,
  identity = editorIdentity, remove = root => rmSync(root, { recursive: true, force: true }), now = Date.now, pause = sleep,
  appPath = EDITORS[bundle]?.path, findMs = 20000, settleMs = 10000,
} = {}) {
  const noMutation = message => Object.assign(new Error(message), { noMutation: true });
  if (!EDITORS[bundle] || !appPath) throw noMutation(`${app} is not an approved editor fixture`);
  ctx.signal?.throwIfAborted();
  let found;
  try { found = await identity(appPath, { exec }); } catch (error) { throw noMutation(`${app} not installed at ${appPath}: ${error.message}`); }
  if (found.bundle !== bundle) throw noMutation(`${appPath} is ${found.bundle}, not ${bundle}`);
  const root = makeProfile(), profile = join(root, 'profile');
  const diagnostics = { app, bundle, launched: true, running: false, profile: 'temporary', helperCollectionConfirmed: true };
  (ctx.fixtureDiagnostics ??= []).push(diagnostics);
  const helper = (mode, extra = {}) => run('/usr/bin/osascript', ['-l', 'JavaScript', EDITOR_HELPER,
    JSON.stringify({ mode, pid: lease.pid, bundle, appPath: found.path, ...extra })], { timeoutMs: 45000 });
  const lease = {
    app, bundle, launched: true, running: false, profileRoot: root,
    async close() {},
    async dispose() { return true; },
    async quit() {
      if (diagnostics.appQuit) return;
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      // A setup that stopped before it saw the pid looks once more, so a late start is still quit by its own pid.
      if (!lease.pid) {
        const late = editorMains(await list(), { executable: found.executable, profile, launchedAtMs: lease.launchedAtMs ?? now() });
        if (late.length > 1) throw new Error(`${app} fixture launch ambiguous: ${late.length} instances name its profile`);
        if (late.length === 1) Object.assign(lease, { pid: late[0].pid, processStartedAtMs: late[0].startedAtMs });
      }
      if (lease.pid) {
        const result = await helper('quit');
        const quit = receipt(result, 'quit');
        if (quit) diagnostics.quitWait = quit;
        if (!result.groupClean || result.exit?.code !== 0 || !quit) {
          throw new Error(`Launched ${app} quit unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
        }
        if (!await exited(lease.pid, lease.processStartedAtMs)) {
          (ctx.exitDisagreements ??= []).push({ app, bundle, step: 'quit', pid: lease.pid });
          throw new Error(`Owned ${app} exit disagreement after quit: pid ${lease.pid} is still running; live lock kept`);
        }
      }
      // Helpers end with the main process. The profile goes only once nothing names it.
      let left = [];
      for (const started = now(); ; await pause(250)) {
        left = profileProcesses(await list(), root);
        if (!left.length || now() - started >= settleMs) break;
      }
      if (left.length) throw new Error(`${app} fixture processes remain (${left.map(item => item.pid).join(', ')}); profile kept at ${root}`);
      remove(root);
      diagnostics.profileRemoved = true;
      diagnostics.appQuit = true;
    },
  };
  (ctx.windowLeases ??= []).push(lease);
  ctx.electronLease = lease;
  lease.launchedAtMs = now();
  await exec('/usr/bin/open', editorLaunchArgs(found.path, root, target), { timeout: 15000 });
  for (const started = now(); ; await pause(250)) {
    ctx.signal?.throwIfAborted();
    const mains = editorMains(await list(), { executable: found.executable, profile, launchedAtMs: lease.launchedAtMs });
    if (mains.length > 1) throw new Error(`${app} fixture launch ambiguous: ${mains.length} instances name its profile`);
    if (mains.length === 1) { Object.assign(lease, { pid: mains[0].pid, processStartedAtMs: mains[0].startedAtMs }); break; }
    if (now() - started >= findMs) throw new Error(`${app} fixture instance not found ${Math.round(findMs / 1000)} s after launch`);
  }
  Object.assign(diagnostics, { pid: lease.pid, processStartedAtMs: lease.processStartedAtMs });
  const result = await helper('ready');
  const ready = receipt(result, 'ready');
  if (!result.groupClean || result.exit?.code !== 0 || !ready) {
    throw new Error(`${app} fixture window unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
  }
  diagnostics.readiness = ready;
  return lease;
}

export async function setupEditor(ctx, { app, bundle }, options = {}) {
  prepareEditor(ctx);
  await acquireFixture(ctx, 'editor', () => openEditor(ctx, { app, bundle, target: ctx.document }, options));
}

export function promptEditor(ctx, app) {
  return `In the ${app} window showing ${basename(ctx.document)}, replace the word "beta" with "delta" in ${ctx.document} and save that same file. ` +
    'Leave that window open. Do not open, read, modify or close other files or windows.';
}

export async function cleanupElectron(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close?.(); } catch (error) { errors.push(error.message); }
    try {
      if (lease.running === false && lease.launched) {
        if (lease.dispose && await lease.dispose() !== true) throw new Error('Electron helper collection unconfirmed');
        await lease.quit();
      }
    } catch (error) { errors.push(error.message); }
  }
  try {
    if (ctx.closeServer) { await ctx.closeServer(); ctx.closeServer = undefined; }
  } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(errors.join('; '));
}
