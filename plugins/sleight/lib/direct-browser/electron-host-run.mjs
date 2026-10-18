// The resident Electron host as its own process, spawned detached by electron-admin.mjs's ensureHost:
//   node electron-host-run.mjs --state-dir D --registry R --temp-root T --builds B --admin-fd 3
// The parent writes its per-start admin secret on descriptor 3 and closes it. Every authority this process has comes
// through that admin channel (start, issue, revoke, resume, quit), so the trusted callbacks below answer for the
// admin's request and decide only what the host itself can check: the build is a reviewed registry build this host
// was started for, an attached target is a page of that recipe, and quit goes through the app's own Quit.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './electron-targets.mjs';
import { readRecipeRegistry } from './electron-recipes.mjs';
import { parseHostArguments, runHostEntry } from './electron-host-entry.mjs';

const fail = code => { throw Error(code); };

// NSRunningApplication.terminate is the app's own Quit (it may show the app's unsaved-work prompt). Never a signal,
// never forceTerminate. The executable check refuses a recycled PID that now belongs to another app.
const QUIT_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (!app || app.isNil()) return 'absent';
  const url = app.executableURL;
  if (!url || url.isNil() || ObjC.unwrap(url.path) !== argv[1]) return 'mismatch';
  return app.terminate ? 'sent' : 'refused';
}`;
const osascript = args => new Promise((resolve, reject) => {
  execFile('/usr/bin/osascript', args, { timeout: 5000, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => error ? reject(Error('QUIT_FAILED')) : resolve(String(stdout).trim()));
});

/** The host rechecks the birth right before this (electron-host.mjs). */
export async function quitThroughApp(identity, executable, { run = osascript } = {}) {
  if (!Number.isSafeInteger(identity?.pid) || identity.pid < 1 || typeof executable !== 'string' || !executable.startsWith('/')) fail('QUIT_TARGET_INVALID');
  const outcome = await run(['-l', 'JavaScript', '-e', QUIT_SCRIPT, String(identity.pid), executable]);
  if (outcome === 'sent' || outcome === 'absent') return outcome;
  fail(outcome === 'mismatch' ? 'QUIT_TARGET_MISMATCH' : 'QUIT_REFUSED');
}

export function hostDependencies({ registry, builds, run } = {}) {
  const reviewed = build => builds.includes(build) ? registry.recipes.find(recipe => recipe.build === build && recipe.sha256 !== null) : undefined;
  let launched;
  return Object.freeze({
    // Satisfied by an admin start that names a reviewed registry build of this host (the worker checked the debugger grant first).
    async authorizeLaunch(spec) {
      const recipe = reviewed(spec?.build);
      if (!recipe) return false;
      launched = recipe;
      return true;
    },
    // Tickets and resume are reachable only through the authenticated admin channel: the parent asked.
    authorizeIssue: async () => true,
    resumeAuthority: async () => true,
    // The app's own target info, classified against the launched recipe. Nothing is admitted before a launch.
    admitTarget: async info => !!launched && classifyTarget(info, launched).kind === 'member',
    requestQuit: identity => launched ? quitThroughApp(identity, launched.executable, run ? { run } : {}) : Promise.reject(Error('QUIT_TARGET_INVALID')),
  });
}

// The parked reasons that mean the app's process ended (broker.mjs): collecting then needs only the census.
const APP_GONE = new Set(['child exited', 'pipe EOF']);

/** The host process exits once ownership is free and no channel has been open for idleMs (10 min). An app that exited
 * (the user quit it) while no worker was connected is collected first, census-proved, so its host can go. */
export function createExitRule({ status, close, exit, collect, now = Date.now, idleMs = 600000 }) {
  let busySince = now(), exiting = false;
  return Object.freeze({
    async check() {
      if (exiting) return;
      let current = status();
      if (collect && current.channels === 0 && current.ownership?.state === 'owned' && current.broker?.state === 'parked' &&
          APP_GONE.has(current.broker.parked?.reason)) {
        try { await collect(); } catch { /* retained: tried again on the next check */ }
        current = status();
      }
      if (current.channels > 0 || current.ownership?.state !== 'free') { busySince = now(); return; }
      if (now() - busySince < idleMs) return;
      exiting = true;
      try { await close(); } finally { exit(0); }
    },
  });
}

async function main(argv) {
  const config = parseHostArguments(argv);
  if (config.adminFd === undefined) fail('ADMIN_FD_REQUIRED');
  const registry = readRecipeRegistry(config.registryPath);
  const host = await runHostEntry({ argv, deps: hostDependencies({ registry, builds: config.builds }) });
  const rule = createExitRule({ status: () => host.status(), close: () => host.close(), collect: () => host.collect(), exit: code => process.exit(code) });
  setInterval(() => { rule.check().catch(() => {}); }, 30000);
  host.events.on('parked', () => { setTimeout(() => { rule.check().catch(() => {}); }, 1000); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'HOST_START_FAILED';
    try { process.stdout.write(JSON.stringify({ ready: false, code }) + '\n'); } catch { /* parent gone */ }
    process.exit(1);
  });
}
