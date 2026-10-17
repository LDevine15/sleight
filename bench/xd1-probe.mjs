// sleight-arch runs it: node bench/xd1-probe.mjs /private/tmp/xd1-results.json
// Waits while /tmp/sleight-hold exists, then takes /tmp/sleight-live.lock. Fixture documents open and close
// through the live benchmark's own helpers (real-fixture.mjs), with no Apple events and no other window read.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { acquireLiveLock } from './live-lock.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';

const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
const unconfirmed = message => Object.assign(new Error(message), { cleanupUnconfirmed: true });

export async function runProbeTrials(driver, save = () => {}) {
  const rows = [];
  for (const variant of ['V1', 'V2', 'V3', 'V4']) {
    // The foreground control runs only when no background variant passed 3/3.
    if (variant === 'V4' && ['V1', 'V2', 'V3'].some(v => rows.filter(r => r.variant === v && r.pass).length === 3)) break;
    for (let trial = 1; trial <= 3; trial++) {
      if (driver.cancelled?.()) throw new Error('probe interrupted after owned-child collection and cleanup');
      const row = { variant, trial, pass: false }; rows.push(row); save(rows);
      let pair;
      try {
        pair = await driver.setup(variant, trial);
        row.before = await driver.snapshot(pair);
        try { row.reply = await driver.move(pair, variant); }
        catch (error) { row.error = error.message; row.uncertainInput = !!(error.killed || error.signal); }
        finally { row.after = await driver.snapshot(pair); }
        if (!row.error) row.pass = await driver.judge(pair, row.before, row.after, row.reply);
      } catch (error) {
        row.error ??= error.message; row.uncertainInput ||= !!(error.killed || error.signal);
        if (!pair) row.setupCleaned = error.cleanupConfirmed === true;
      } finally {
        // setup owns its partial failures; a returned pair is ours to close and verify.
        try { row.cleanup = pair ? !row.uncertainInput && await driver.close(pair) : row.setupCleaned === true; }
        catch (error) { row.cleanup = false; row.cleanupError = error.message; }
        save(rows);
      }
      if (!row.cleanup) throw unconfirmed('probe cleanup unconfirmed; retain the fixture and live lock, stop all later trials');
      if (!pair) throw new Error(`probe setup failed and its fixture was closed; stopping: ${row.error}`);
      if (driver.cancelled?.()) throw new Error('probe interrupted after owned-child collection and cleanup');
    }
  }
  return rows;
}

export const nativeProbe = String.raw`
function probePair(request) {
  const target = findApp('com.apple.TextEdit');
  if (!target) throw new Error('TextEdit is not running');
  const pid = target.processIdentifier, own = windows(true).filter(w => w.pid === pid && w.layer === 0);
  const all = axElements(axAttribute($.AXUIElementCreateApplication(pid), 'AXWindows'));
  const pair = request.paths.map(path => {
    const url = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString);
    const matches = all.filter(win => attempt(() => win.attributes.byName('AXDocument').value(), '') === url);
    if (matches.length !== 1) throw new Error('exact owned document window is missing or ambiguous: ' + path);
    const win = matches[0], bounds = frame(win);
    const native = own.filter(w => sameBounds(w.bounds, bounds) && w.title === win.name());
    if (native.length !== 1) throw new Error('owned document has no unique on-screen CG window');
    const fields = content(win, bounds).areas.filter(a => a.role === 'AXTextArea');
    if (fields.length !== 1) throw new Error('owned document has no single text area');
    return { win, main: native[0], el: fields[0].el, area: axTextArea(pid, null, fields[0].el.reference) };
  });
  return { target, pid, pair };
}
function probeSnapshot(state) {
  const [a, b] = state.pair, focused = attempt(() => axElement(axAttribute($.AXUIElementCreateApplication(state.pid), 'AXFocusedWindow')), null);
  // Only the two fixture windows are named; any other window is "other", never its title or document.
  const role = w => w.id === a.main.id ? 'source' : w.id === b.main.id ? 'destination' : w.pid === state.pid ? 'same app' : 'other';
  return { source: a.el.value(), destination: b.el.value(), selection: a.el.attributes.byName('AXSelectedText').value(),
    keyWindow: !focused ? null : $.CFEqual(focused.reference, a.win.reference) ? 'source' : $.CFEqual(focused.reference, b.win.reference) ? 'destination' : 'other',
    order: windows(true).filter(w => w.layer === 0).map(role).filter((name, i, all) => name !== all[i - 1]),
    frontmost: ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier),
    pointer: $.CGEventGetLocation($.CGEventCreate(null)),
    sourceWindow: a.main, destinationWindow: b.main };
}
function run(argv) {
  const request = JSON.parse(argv[0]);
  try {
    const checkCancelled = () => {
      if (request.cancelFile && $.NSFileManager.defaultManager.fileExistsAtPath(request.cancelFile)) throw new Error('probe interrupted');
    };
    if (request.op !== 'snapshot') checkCancelled();
    const state = probePair(request), [a, b] = state.pair;
    if (request.op === 'place') {
      ObjC.bindFunction('malloc', ['void*', ['unsigned long']]); ObjC.bindFunction('free', ['void', ['void*']]);
      const display = $.CGDisplayBounds($.CGMainDisplayID()), width = Math.min(600, (display.size.width - 100) / 2), height = Math.min(400, display.size.height - 150);
      if (width < 300 || height < 200) throw new Error('display too small for the tiled fixture');
      for (const [i, item] of state.pair.entries()) {
        const set = (name, type, boxed) => {
          const bytes = $.malloc(32);
          try { boxed.getValue(bytes); const code = Number($.AXUIElementSetAttributeValue(item.win.reference, $(name), $.AXValueCreate(type, bytes))); if (code) throw new Error('placement failed: ' + code); }
          finally { $.free(bytes); }
        };
        set('AXSize', 2, $.NSValue.valueWithSize($.NSMakeSize(width, height)));
        set('AXPosition', 1, $.NSValue.valueWithPoint($.NSMakePoint(display.origin.x + 30 + i * (width + 20), display.origin.y + 80)));
      }
      a.area.select(0, 5); b.area.select(0, 0);
      return JSON.stringify({ ok: true, pid: state.pid, windowIds: state.pair.map(item => item.main.id) });
    }
    if (request.op === 'snapshot') return JSON.stringify(probeSnapshot(state));
    if (request.op !== 'move') throw new Error('unknown probe operation');
    if (a.el.value() !== 'alpha beta\n' || b.el.value() !== 'gamma delta\n' || a.el.attributes.byName('AXSelectedText').value() !== 'alpha') throw new Error('fixture text or selection changed');
    const r = { from: 'the current text selection', to: 'end of line 1' };
    const source = semanticPoints(r, state.pid, a.win, a.main, undefined, 'from', 'selection');
    const destination = semanticPoints(r, state.pid, b.win, b.main, undefined, 'to', 'area');
    const start = at(a.main.bounds, source.from), end = at(b.main.bounds, destination.to);
    const guard = foreground => {
      const list = checkWindow(a.main, state.pid, a.win); checkWindow(b.main, state.pid, b.win);
      exposedEndpoints(list, a.main, { start, end }, !foreground, b.main);
      if (coveringApp(list, a.main, { start, end })) throw new Error('another app covers a probe endpoint; uncover it before retrying');
    };
    let previous, saved, post, release, pressed = false;
    try {
      previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      raiseWindow(a.win); delay(0.3); guard(false);
      const before = probeSnapshot(state);
      if (request.variant === 'V1') {
        checkCancelled();
        const outcome = accessibilityCrossWindowMove(a.area, b.area, { el: a.el, text: before.source, selected: before.selection, app: 'TextEdit' },
          { el: b.el, text: before.destination }, end, a.main, b.main);
        return JSON.stringify(outcome);
      }
      const foreground = request.variant === 'V4';
      if (foreground) {
        waitForIdle(); saved = $.CGEventGetLocation($.CGEventCreate(null)); state.target.activateWithOptions(0); raiseWindow(a.win); delay(0.3);
      }
      guard(foreground);
      checkCancelled();
      if (a.el.value() !== before.source || b.el.value() !== before.destination || a.el.attributes.byName('AXSelectedText').value() !== before.selection) throw new Error('owner changed the fixture before input');
      const build = foreground ? (type, p) => {
        const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft); $.CGEventSetIntegerValueField(e, 1, 1); return { event: e };
      } : backgroundBuilder();
      const event = (type, p) => build(type, p, request.variant === 'V3' && inside(b.main.bounds, p) ? b.main : a.main);
      // V2 deliberately retains A's tags even when its local x exceeds A.width.
      const sequence = [event(5, start), event(1, start), ...Array.from({ length: 25 }, (_, i) => event(6, {
        x: start.x + (end.x - start.x) * (i + 1) / 25, y: start.y + (end.y - start.y) * (i + 1) / 25,
      })), event(2, end)];
      post = item => foreground ? $.CGEventPost($.kCGHIDEventTap, item.event) : $.CGEventPostToPid(state.pid, item.event);
      release = sequence.at(-1); const focusedAt = Date.now();
      post(sequence[0]); delay(0.05); guard(foreground);
      checkCancelled();
      if (foreground && typedSince(focusedAt)) throw new Error('user typed before foreground press');
      pressed = true; post(sequence[1]); delay(0.5);
      for (const item of sequence.slice(2, -1)) { checkCancelled(); post(item); delay(0.02); }
      post(release); pressed = false; delay(0.3);
      return JSON.stringify({ ok: !foreground || !typedSince(focusedAt), variant: request.variant });
    } finally {
      if (pressed && post) post(release);
      if (saved) $.CGWarpMouseCursorPosition(saved);
      if (previous && !previous.isNil() && previous.processIdentifier !== state.pid &&
          $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === state.pid) previous.activateWithOptions(0);
    }
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}`;

// Each trial opens its own two nonce documents through openFixture, the call live passes use, and closes them
// with closeFixtures, which closes only those windows and quits TextEdit only when this trial launched it.
export function fixtureDriver({ dir, nonce, native, cancelled, open = openFixture, close = closeFixtures, settleMs = 800 }) {
  return {
    cancelled,
    async setup(variant, trial) {
      const ctx = { dir: join(dir, `${variant}-${trial}`), nonce, windowLeases: [] };
      mkdirSync(ctx.dir, { mode: 0o700 });
      const paths = [join(ctx.dir, `Source-${nonce}-${variant}-${trial}.txt`), join(ctx.dir, `Target-${nonce}-${variant}-${trial}.txt`)];
      writeFileSync(paths[0], 'alpha beta\n'); writeFileSync(paths[1], 'gamma delta\n');
      const pair = { paths, ctx };
      try {
        for (const path of paths) {
          if (cancelled?.()) throw new Error('probe interrupted during setup');
          await open(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', target: path, token: basename(path), mode: 'document', stopOnLiveHold: true });
        }
        const placed = await native({ paths, op: 'place' });
        if (!placed.ok) throw new Error(`setup failed: ${placed.error}`);
        Object.assign(pair, { pid: placed.pid, windowIds: placed.windowIds });
        await new Promise(r => setTimeout(r, settleMs));
        return pair;
      } catch (error) {
        // Setup owns its partial fixture: close what opened, or stop with the evidence kept.
        try { await close(ctx); } catch (cleanup) { throw unconfirmed(`${error.message}; fixture cleanup unconfirmed: ${cleanup.message}`); }
        throw Object.assign(error, { cleanupConfirmed: true });
      }
    },
    snapshot: pair => native({ paths: pair.paths, op: 'snapshot' }),
    move: (pair, variant) => native({ paths: pair.paths, op: 'move', variant }),
    judge: (_pair, _before, after, reply) => !reply.error && reply.ok !== false &&
      /^\s*beta\s*\n$/.test(after.source ?? '') && after.destination === 'gamma delta alpha\n',
    async close(pair) { await close(pair.ctx); return true; },
  };
}

export async function main(output, {
  exists = existsSync, sleep = ms => new Promise(r => setTimeout(r, ms)), takeLock = acquireLiveLock,
  open = openFixture, close = closeFixtures, native: nativeOverride, log = message => console.error(message),
  makeDir = () => mkdtempSync('/private/tmp/sleight-xd1-probe-'), settleMs,
} = {}) {
  if (!output || !resolve(output).startsWith('/private/tmp/')) throw new Error('pass a results path below /private/tmp');
  if (exists(HOLD)) log(`waiting while ${HOLD} exists`);
  while (exists(HOLD)) await sleep(30000);
  const release = await takeLock(LOCK, { wait: true, interval: 15000 });
  let dir;
  try { dir = makeDir(); } catch (error) { await release(); throw error; }
  const execute = promisify(execFile), children = new Set();
  const cancelFile = join(dir, 'cancel'); let stopping = false, keepLock = false;
  const interrupt = () => { stopping = true; writeFileSync(cancelFile, 'interrupted\n'); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
  const exec = async (command, args, options = {}) => {
    // A separate child group lets the marker unwind JXA's release finally before collection.
    // execFile's bounded timeout remains the last resort; uncertainty preserves fixtures and lock.
    const pending = execute(command, args, { detached: true, ...options }); children.add(pending);
    try { return await pending; } finally { children.delete(pending); }
  };
  const script = join(dir, 'probe.js');
  writeFileSync(script, readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8').replace('function run(argv)', 'function productRun(argv)') + nativeProbe);
  const native = nativeOverride ?? (async request => {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify({ ...request, cancelFile })], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  });
  const started = new Date().toISOString();
  const save = rows => writeFileSync(output, JSON.stringify({ started, fixture: dir, rows }, null, 2) + '\n');
  // A hold that appears mid-run stops before the next trial, like an interrupt.
  const driver = fixtureDriver({ dir, nonce: randomBytes(6).toString('hex'), native, open, close, settleMs,
    cancelled: () => stopping || exists(HOLD) });
  // Any setup/cleanup uncertainty leaves the private fixture and keeps the live lock.
  try {
    const rows = await runProbeTrials(driver, save);
    rmSync(dir, { recursive: true });
    process.exitCode = ['V1', 'V2', 'V3', 'V4'].some(v => rows.filter(r => r.variant === v && r.pass).length === 3) ? 0 : 1;
    return rows;
  } catch (error) {
    keepLock = error.cleanupUnconfirmed === true;
    throw error;
  } finally {
    await Promise.allSettled([...children]);
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
    if (stopping) process.exitCode = 130;
    if (keepLock) log(`fixture cleanup unconfirmed; ${LOCK} stays held and ${dir} stays for inspection`);
    else await release();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
