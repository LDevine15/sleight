// Owner-run only: node bench/xd1-probe.mjs /private/tmp/xd1-results.json
// Requires the owner's /tmp/sleight-live.lock. No engine, model or shared helper process.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export async function runProbeTrials(driver, save = () => {}) {
  const rows = [];
  for (const variant of ['V1', 'V2', 'V3', 'V4']) {
    if (variant === 'V4' && ['V2', 'V3'].some(v => rows.filter(r => r.variant === v && r.pass).length === 3)) break;
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
      } catch (error) { row.error ??= error.message; row.uncertainInput ||= !!(error.killed || error.signal); }
      finally {
        // setup owns its partial failures; a returned pair is ours to close and verify.
        try { row.cleanup = pair && !row.uncertainInput ? await driver.close(pair) : false; }
        catch (error) { row.cleanup = false; row.cleanupError = error.message; }
        save(rows);
      }
      if (!row.cleanup) throw new Error('probe cleanup unconfirmed; retain the fixture and live lock, stop all later trials');
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
  return { source: a.el.value(), destination: b.el.value(), selection: a.el.attributes.byName('AXSelectedText').value(),
    keyWindow: focused ? attempt(() => focused.name(), null) : null,
    order: windows(true).map(w => ({ windowId: w.id, pid: w.pid, layer: w.layer })),
    frontmost: ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier),
    pointer: $.CGEventGetLocation($.CGEventCreate(null)),
    sourceWindow: a.main, destinationWindow: b.main };
}
function run(argv) {
  const request = JSON.parse(argv[0]);
  try {
    if (request.op === 'close') {
      const target = findApp('com.apple.TextEdit');
      if (!target || target.processIdentifier !== request.pid) return JSON.stringify({ ok: true });
      if (!Array.isArray(request.windowIds) || request.windowIds.length !== 2) throw new Error('owned window IDs unavailable for closure verification');
      for (const doc of Application('TextEdit').documents()) {
        if (request.paths.includes(String(doc.path()))) doc.close({ saving: 'no' });
      }
      delay(0.3);
      return JSON.stringify({ ok: !windows(false).some(w => w.pid === request.pid && request.windowIds.includes(w.id)) });
    }
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

async function main(output) {
  if (!output || !resolve(output).startsWith('/private/tmp/')) throw new Error('pass a results path below /private/tmp');
  if (!existsSync('/tmp/sleight-live.lock')) throw new Error('sleight-arch must hold /tmp/sleight-live.lock first');
  const execute = promisify(execFile), children = new Set(), dir = mkdtempSync('/private/tmp/sleight-xd1-probe-');
  const cancelFile = join(dir, 'cancel'); let stopping = false;
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
  const native = async request => {
    const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify({ ...request, cancelFile })], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const save = rows => writeFileSync(output, JSON.stringify({ started, fixture: dir, rows }, null, 2) + '\n');
  const started = new Date().toISOString();
  const driver = {
    cancelled: () => stopping,
    async setup(variant, trial) {
      const paths = [join(dir, `${variant}-${trial}-source.txt`), join(dir, `${variant}-${trial}-destination.txt`)];
      writeFileSync(paths[0], 'alpha beta\n'); writeFileSync(paths[1], 'gamma delta\n');
      for (const path of paths) { if (stopping) throw new Error('probe interrupted during setup; retain partial fixture'); await exec('/usr/bin/open', ['-g', '-a', 'TextEdit', path], { timeout: 10000 }); }
      await new Promise(r => setTimeout(r, 1500));
      const pair = { paths };
      const placed = await native({ ...pair, op: 'place' });
      if (!placed.ok) throw new Error(`setup failed; preserve ${dir}: ${placed.error}`);
      Object.assign(pair, { pid: placed.pid, windowIds: placed.windowIds });
      await new Promise(r => setTimeout(r, 800));
      return pair;
    },
    snapshot: pair => native({ ...pair, op: 'snapshot' }),
    move: (pair, variant) => native({ ...pair, op: 'move', variant }),
    judge: (_pair, _before, after, reply) => !reply.error && reply.ok !== false &&
      /^\s*beta\s*\n$/.test(after.source ?? '') && after.destination === 'gamma delta alpha\n',
    async close(pair) {
      // Exact unique paths only; a close request is not proof. Never quit the app.
      return (await native({ ...pair, op: 'close' })).ok === true;
    },
  };
  // Any setup/cleanup uncertainty leaves the private fixture for the owner and never releases their lock.
  try {
    const rows = await runProbeTrials(driver, save);
    rmSync(dir, { recursive: true });
    process.exitCode = ['V1', 'V2', 'V3', 'V4'].some(v => rows.filter(r => r.variant === v && r.pass).length === 3) ? 0 : 1;
  } finally {
    await Promise.allSettled([...children]);
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
    if (stopping) process.exitCode = 130;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
