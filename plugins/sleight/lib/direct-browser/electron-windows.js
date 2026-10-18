// Window metadata for one Electron app process, selected by PID (EPV3-6). Sibling of ../window-identity.js, with
// its AX helpers. Content-free: frames, CG window numbers, on-screen, minimized and modal state. It never reads a
// title, document, value or description, and never requests trust. Request { pid, pidBirth }; reply
// { status: 'ok', observedAt, processStart, windows }, { status: 'denied' } or { status: 'error', message }.
// electron-windows.mjs validates the reply, compares processStart with pidBirth and numbers window epochs.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
// JXA's Ref('CGPoint') reads back as the number 0, so this fallback never matched (macOS 27.0.1, 2026-10-16).
// Copy the struct into bytes and read it back through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
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
// launch.py's birth string: proc_pidinfo(PROC_PIDTBSDINFO) start time as '%d.%06d'; null for a gone or zombie process.
function processBirth(pid) {
  const data = $.NSMutableData.dataWithLength(136);
  if (Number($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136)) !== 136) return null;
  const bytes = decode(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));
  const u32 = at => bytes[at] + bytes[at + 1] * 2 ** 8 + bytes[at + 2] * 2 ** 16 + bytes[at + 3] * 2 ** 24;
  const u64 = at => u32(at) + u32(at + 4) * 2 ** 32;
  if (u32(12) !== pid || u32(4) === 5) return null;
  return u64(120) + '.' + String(u64(128)).padStart(6, '0');
}
// AX is top-left from the primary screen; NSScreen frames are bottom-left.
function screenScale(frame) {
  const screens = $.NSScreen.screens, count = Number(screens.count);
  if (!count) return 1;
  const primary = ObjC.deepUnwrap(screens.objectAtIndex(0).frame);
  const x = frame.x + frame.width / 2, y = primary.size.height - (frame.y + frame.height / 2);
  for (let i = 0; i < count; i++) {
    const screen = screens.objectAtIndex(i), f = ObjC.deepUnwrap(screen.frame);
    if (x >= f.origin.x && x < f.origin.x + f.size.width && y >= f.origin.y && y < f.origin.y + f.size.height) return Number(screen.backingScaleFactor);
  }
  return Number(screens.objectAtIndex(0).backingScaleFactor);
}
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (!Number.isSafeInteger(request?.pid) || request.pid < 1 || typeof request.pidBirth !== 'string') throw new Error('invalid request');
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied' });
    const pid = request.pid, before = processBirth(pid);
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) throw new Error('AX deadline unavailable');
    const attr = (element, name, optional = false) => {
      const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
      if (optional && [-25205, -25212].includes(error)) return null;
      if (error) throw new Error(name + ' unavailable');
      return ObjC.castRefToObject(value[0]);
    };
    const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
    // An app with no windows yet answers AXWindows with no value.
    const windows = attr(app, 'AXWindows', true), count = windows === null ? 0 : Number(windows.count);
    if (count > 64) throw new Error('Too many windows');
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
    const cg = Array.from({ length: Number(list.count) }, (_, i) => ObjC.deepUnwrap(list.objectAtIndex(i))).filter(info => Number(info.kCGWindowOwnerPID) === pid);
    // An open menu of the app is its own window at layer 101; it covers every window of the process.
    const menu = cg.some(info => info.kCGWindowLayer === 101 && info.kCGWindowIsOnscreen === true);
    const rows = [], ids = new Set();
    for (let i = 0; i < count; i++) {
      const window = windows.objectAtIndex(i);
      const children = attr(window, 'AXChildren', true);
      let sheet = false;
      for (let j = 0; j < Math.min(Number(children?.count ?? 0), 256) && !sheet; j++) sheet = scalar(attr(children.objectAtIndex(j), 'AXRole', true)) === 'AXSheet';
      const subrole = scalar(attr(window, 'AXSubrole', true));
      const dialog = scalar(attr(window, 'AXModal', true)) === true || subrole === 'AXDialog' || subrole === 'AXSystemDialog';
      const position = attr(window, 'AXPosition', true), size = attr(window, 'AXSize', true);
      const point = position && axPair(position, 1), extent = size && axPair(size, 2);
      const frame = point && extent ? { x: point[0], y: point[1], width: extent[0], height: extent[1] } : null;
      const found = frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ? cg.filter(info => info.kCGWindowLayer === 0 &&
        ['X', 'Y', 'Width', 'Height'].every((key, k) => Math.abs(info.kCGWindowBounds?.[key] - [frame.x, frame.y, frame.width, frame.height][k]) < 0.5)) : [];
      const id = found.length === 1 ? Number(found[0].kCGWindowNumber) : null;
      // A modal window nothing can number would let a renderer join past it, so the whole read fails instead.
      if (!Number.isSafeInteger(id) || id < 1) { if (sheet || dialog) throw new Error('modal window without a number'); continue; }
      if (ids.has(id)) throw new Error('duplicate window number');
      ids.add(id);
      rows.push({ id, pid, frame, scale: screenScale(frame), onScreen: found[0].kCGWindowIsOnscreen === true,
        minimized: scalar(attr(window, 'AXMinimized', true)) === true, modal: sheet ? 'sheet' : dialog ? 'dialog' : menu ? 'menu' : false });
    }
    // A PID recycled during the read has two births; the reader then refuses the reply.
    const after = processBirth(pid);
    return JSON.stringify({ status: 'ok', observedAt: Date.now(), processStart: before !== null && before === after ? before : null, windows: rows });
  } catch (error) { return JSON.stringify({ status: 'error', message: String(error.message || error).slice(0, 200) }); }
}
