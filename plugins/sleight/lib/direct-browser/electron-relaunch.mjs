// The relaunch flow (1.3.1, LAWS decision F3): turbo in an opted-in Electron app on the user's own app and profile.
// The app runs without the debugger pipe, so turbo needs it reopened with the pipe. Only the user's click on sleight's
// relaunch card starts that. sleight then asks the app to quit through its own Quit (NSRunningApplication terminate,
// which may show the app's unsaved-work prompt; sleight answers nothing there), waits, and has the resident host open the
// same bundle on the same profile plus the pipe. That launch is a plain posix_spawn, since a LaunchServices launch (the one
// that can skip activation) can't hand the app the pipe, so the app may come to the front briefly, as the card says. That is
// recorded, never undone. Every way this can go wrong ends on the native path with a result that says what happened to the app.
// No app names here: the recipe supplies the name, the bundle, the executable and the profile.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileSwitches } from './electron-recipes.mjs';

const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactly = (value, keys) => plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const native = name => `Use the app tools (the native path) for ${name}.`;

// What Claude reads when the flow ends on the native path. name is the reviewed recipe's, never page or app text.
const NOTICES = Object.freeze({
  ELECTRON_RELAUNCH_DECLINED: name => `The user chose Cancel on sleight's card to reopen ${name} with the debugger, so nothing was quit. ${native(name)} sleight won't ask again this session.`,
  ELECTRON_RELAUNCH_UNANSWERED: name => `Nobody answered sleight's card to reopen ${name}, so nothing was quit. ${native(name)}`,
  ELECTRON_RELAUNCH_QUIT_REFUSED: name => `${name} refused to quit, so it is still open and nothing else was done. ${native(name)}`,
  ELECTRON_RELAUNCH_QUIT_PENDING: name => `${name} is still open after sleight asked it to quit; it may be asking about unsaved work. sleight did not reopen it and won't. ${native(name)}`,
  ELECTRON_RELAUNCH_CHANGED: name => `The ${name} process changed after the user's click, so sleight quit nothing. ${native(name)}`,
  ELECTRON_RELAUNCH_RACED: name => `${name} was opened again before sleight reopened it, so it is running without the debugger. ${native(name)}`,
  ELECTRON_RELAUNCH_FAILED: name => `${name} quit but did not reopen. Tell the user to open it again, then use the app tools (the native path).`,
  ELECTRON_RELAUNCH_NO_PIPE: name => `${name} reopened without the debugger connection and is running normally. ${native(name)}`,
  ELECTRON_RELAUNCH_AMBIGUOUS: name => `More than one ${name} process is running, so sleight quits none of them. ${native(name)}`,
  ELECTRON_RELAUNCH_BUILD_CHANGED: name => `The running ${name} is not the reviewed build, so sleight leaves it alone. ${native(name)}`,
  ELECTRON_RELAUNCH_OTHER_PROFILE: name => `The running ${name} may be on a profile of its own (started with a profile switch), and sleight reopens only the default profile, so it leaves it alone. ${native(name)}`,
  ELECTRON_APP_OTHER_USER: name => `${name} is running as another macOS user, so sleight leaves it alone. ${native(name)}`,
  ELECTRON_USER_PROFILE_UNSUPPORTED: name => `Turbo isn't set up for ${name} on the user's own profile yet. ${native(name)}`,
});
export const RELAUNCH_CODES = Object.freeze(Object.keys(NOTICES));
/** An Error whose message is the code and whose notice is the text the worker returns to Claude. */
export function relaunchError(code, name) {
  if (!NOTICES[code]) fail('INVALID_NOTICE');
  return Object.assign(Error(code), { notice: code + ': ' + NOTICES[code](typeof name === 'string' && name ? name : 'The app') });
}

// The process helper (electron-apps.js): the bundle's processes in this login session with birth and uid, the app's own
// Quit for one exact process, and the frontmost app's pid. One osascript per call.
const helperScript = fileURLToPath(new URL('./electron-apps.js', import.meta.url));
const OUTCOMES = new Set(['exited', 'absent', 'running', 'refused', 'mismatch']);
const appRow = row => exactly(row, ['pid', 'birth', 'uid', 'executable']) && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.birth === 'string' &&
  /^[A-Za-z0-9._-]{1,64}$/.test(row.birth) && Number.isSafeInteger(row.uid) && row.uid >= 0 && typeof row.executable === 'string' &&
  row.executable.startsWith('/') && row.executable.length <= 4096;
export function createAppProcesses({ run = execFile, script = helperScript } = {}) {
  const call = (request, timeoutMs) => new Promise((resolve, reject) => {
    run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(request)], { timeout: timeoutMs, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      if (error) { reject(Error('ELECTRON_APPS_UNAVAILABLE')); return; }
      let reply; try { reply = JSON.parse(String(stdout)); } catch { reject(Error('ELECTRON_APPS_INVALID')); return; }
      if (reply?.status !== 'ok') { reject(Error('ELECTRON_APPS_UNAVAILABLE')); return; }
      resolve(reply);
    });
  });
  return Object.freeze({
    async list(bundleId) {
      const reply = await call({ op: 'list', bundleId }, 5000);
      if (!exactly(reply, ['status', 'apps']) || !Array.isArray(reply.apps) || reply.apps.length > 64 || !reply.apps.every(appRow)) fail('ELECTRON_APPS_INVALID');
      return reply.apps.map(row => Object.freeze({ ...row }));
    },
    // waitMs bounds how long the helper waits for the process to end; the app's own prompt may hold it open longer.
    async quit({ pid, birth, executable }, { waitMs }) {
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600000) fail('ELECTRON_APPS_INVALID');
      const reply = await call({ op: 'quit', pid, birth, executable, waitMs }, waitMs + 10000);
      if (!exactly(reply, ['status', 'outcome', 'ms']) || !OUTCOMES.has(reply.outcome) || !Number.isFinite(reply.ms)) fail('ELECTRON_APPS_INVALID');
      return Object.freeze({ outcome: reply.outcome, ms: reply.ms });
    },
    // The process's command line, for the profile-switch check only. ps prints the arguments joined by spaces.
    args(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) return Promise.reject(Error('ELECTRON_APPS_INVALID'));
      return new Promise((resolve, reject) => {
        run('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 5000, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
          const line = String(stdout ?? '').trim();
          if (error || !line) reject(Error('ELECTRON_APPS_UNAVAILABLE')); else resolve(line);
        });
      });
    },
    async front() {
      const reply = await call({ op: 'front' }, 5000);
      if (!exactly(reply, ['status', 'pid']) || reply.pid !== null && !Number.isSafeInteger(reply.pid)) fail('ELECTRON_APPS_INVALID');
      return reply.pid;
    },
  });
}

/** The user's own running copy of the recipe's app, or undefined when none runs. Refuses before any card for another
 * user's process, more than one process, a copy whose executable is not the reviewed build's, and a copy started on a
 * profile of its own (a profile switch among its arguments, or arguments sleight can't read): reopening it would land on
 * the default profile instead. */
export async function runningCopy({ recipe, processes, uid }) {
  const rows = await processes.list(recipe.bundleId);
  if (!rows.length) return undefined;
  if (rows.some(row => row.uid !== uid)) throw relaunchError('ELECTRON_APP_OTHER_USER', recipe.name);
  if (rows.length > 1) throw relaunchError('ELECTRON_RELAUNCH_AMBIGUOUS', recipe.name);
  if (rows[0].executable !== recipe.executable) throw relaunchError('ELECTRON_RELAUNCH_BUILD_CHANGED', recipe.name);
  let line;
  try { line = await processes.args(rows[0].pid); } catch { line = undefined; }
  const switches = profileSwitches(recipe), tokens = typeof line === 'string' ? line.split(/\s+/) : undefined;
  if (!tokens || tokens.some(token => switches.some(name => token === name || token.startsWith(name + '='))))
    throw relaunchError('ELECTRON_RELAUNCH_OTHER_PROFILE', recipe.name);
  return rows[0];
}

const ready = status => status?.broker?.state === 'ready' && plain(status.broker.identity);

/** After the debugger grant: the relaunch card for the exact running process (copy, as `instance` names it), and on the
 * user's click the app's own Quit, then the host's launch of the same build on the user's profile with the pipe.
 * Resolves { status, quitMs, launchMs, wasFront } with the host's status once its broker is ready. declined: this
 * session's Set of bundle ids whose card the user cancelled. */
export async function quitAndReopen({ recipe, copy, instance, session, turn, consent, admin, processes, uid, quitWaitMs = 60000, declined, now = Date.now }) {
  const name = recipe.name, same = row => row.pid === copy.pid && row.birth === copy.birth && row.uid === uid && row.executable === copy.executable;
  const answer = await consent.requestRelaunch(instance, { session, turn });
  if (answer?.status !== 'approved' || !answer.ticket) {
    if (answer?.status === 'declined') { declined?.add(recipe.bundleId); throw relaunchError('ELECTRON_RELAUNCH_DECLINED', name); }
    throw relaunchError('ELECTRON_RELAUNCH_UNANSWERED', name);
  }
  // One use, this exact process, session and turn.
  consent.consumeRelaunch(answer.ticket, instance, { session, turn });
  const again = await processes.list(recipe.bundleId);
  if (again.length !== 1 || !same(again[0])) throw relaunchError('ELECTRON_RELAUNCH_CHANGED', name);
  const before = await processes.front().catch(() => null);
  const quitting = now();
  const quit = await processes.quit({ pid: copy.pid, birth: copy.birth, executable: copy.executable }, { waitMs: quitWaitMs });
  if (quit.outcome === 'refused') throw relaunchError('ELECTRON_RELAUNCH_QUIT_REFUSED', name);
  if (quit.outcome === 'mismatch') throw relaunchError('ELECTRON_RELAUNCH_CHANGED', name);
  if (quit.outcome === 'running') throw relaunchError('ELECTRON_RELAUNCH_QUIT_PENDING', name);
  const quitMs = now() - quitting;
  if ((await processes.list(recipe.bundleId)).length) throw relaunchError('ELECTRON_RELAUNCH_RACED', name);
  const launching = now();
  let status;
  try {
    await admin.start({ build: recipe.build, profile: 'user' });
    status = await admin.status();
  } catch { status = undefined; }
  if (ready(status)) return { status, quitMs, launchMs: now() - launching, wasFront: before === copy.pid };
  // Not reopened with the pipe. A copy running now is the user's app as it normally runs; nothing touches it. With none,
  // sleight's own launch record (a folder of its own, never the profile) is collected so the next turn can launch.
  const after = await processes.list(recipe.bundleId).catch(() => undefined);
  if (after?.length) throw relaunchError('ELECTRON_RELAUNCH_NO_PIPE', name);
  if (after) await Promise.resolve().then(() => admin.collect?.()).catch(() => {});
  throw relaunchError('ELECTRON_RELAUNCH_FAILED', name);
}
