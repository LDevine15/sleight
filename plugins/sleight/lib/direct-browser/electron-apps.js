// The relaunch flow's process helper (electron-relaunch.mjs). Sibling of electron-windows.js, with its birth reader.
// Request { op: 'list', bundleId } → { status: 'ok', apps: [{ pid, birth, uid, executable }] }: the bundle's processes in
// this login session. { op: 'quit', pid, birth, executable, waitMs } → { status: 'ok', outcome, ms }: the app's own Quit
// (NSRunningApplication terminate, which may show the app's unsaved-work prompt) for that exact process only, then a
// wait of up to waitMs for it to end: 'exited', 'absent', 'running' (still open at the deadline), 'refused' (the app
// declined the request) or 'mismatch' (not that process). { op: 'front' } → { status: 'ok', pid }. It never signals,
// force-quits, activates, hides or answers anything, reads no window, title or document, and sends no Apple event of its own.
ObjC.import('AppKit');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
ObjC.bindFunction('getuid', ['unsigned int', []]);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(text) {
  const out = [];
  let bits = 0, value = 0;
  for (const char of text.replace(/=+$/, '')) {
    value = value << 6 | BASE64.indexOf(char); bits += 6;
    if (bits >= 8) { bits -= 8; out.push(value >> bits & 255); }
  }
  return out;
}
// launch.py's birth string and the owner uid, from proc_pidinfo(PROC_PIDTBSDINFO); null for a gone or zombie process.
function processInfo(pid) {
  const data = $.NSMutableData.dataWithLength(136);
  if (Number($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136)) !== 136) return null;
  const bytes = decode(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));
  const u32 = at => bytes[at] + bytes[at + 1] * 2 ** 8 + bytes[at + 2] * 2 ** 16 + bytes[at + 3] * 2 ** 24;
  const u64 = at => u32(at) + u32(at + 4) * 2 ** 32;
  if (u32(12) !== pid || u32(4) === 5) return null;
  return { birth: u64(120) + '.' + String(u64(128)).padStart(6, '0'), uid: u32(20) };
}
const pathOf = app => { const url = app.executableURL; return !url || url.isNil() ? null : ObjC.unwrap(url.path); };
function list(bundleId) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId), rows = [];
  for (let i = 0; i < Math.min(Number(apps.count), 64); i++) {
    const app = apps.objectAtIndex(i), pid = Number(app.processIdentifier), info = processInfo(pid), executable = pathOf(app);
    if (info && executable) rows.push({ pid, birth: info.birth, uid: info.uid, executable });
  }
  return { status: 'ok', apps: rows };
}
function quit(request) {
  const started = Date.now();
  const done = outcome => ({ status: 'ok', outcome, ms: Date.now() - started });
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
  const info = processInfo(request.pid);
  if (!app || app.isNil() || !info) return done('absent');
  if (info.birth !== request.birth || info.uid !== Number($.getuid()) || pathOf(app) !== request.executable) return done('mismatch');
  // JXA calls a zero-argument method on property access (terminate() would call its boolean). This is the app's own Quit.
  const sent = app.terminate;
  if (sent !== true) return done('refused');
  while (Date.now() - started < request.waitMs) {
    const now = processInfo(request.pid);
    if (!now || now.birth !== request.birth) return done('exited');
    delay(0.2);
  }
  return done('running');
}
function front() {
  // The workspace's frontmost app updates on the run loop.
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return { status: 'ok', pid: !app || app.isNil() ? null : Number(app.processIdentifier) };
}
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request?.op === 'list' && typeof request.bundleId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(request.bundleId)) return JSON.stringify(list(request.bundleId));
    if (request?.op === 'quit' && Number.isSafeInteger(request.pid) && request.pid > 1 && typeof request.birth === 'string' && typeof request.executable === 'string' &&
        request.executable.startsWith('/') && Number.isSafeInteger(request.waitMs) && request.waitMs >= 0 && request.waitMs <= 600000) return JSON.stringify(quit(request));
    if (request?.op === 'front') return JSON.stringify(front());
    throw new Error('invalid request');
  } catch (error) {
    return JSON.stringify({ status: 'error', message: String(error && error.message || error).slice(0, 200) });
  }
}
