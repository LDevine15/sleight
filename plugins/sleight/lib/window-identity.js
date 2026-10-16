// Read-only AX identity, retained inside the existing lazy target helper. Never requests trust.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
const windowEpoch = ObjC.unwrap($.NSUUID.UUID.UUIDString);
const windowReferences = [];
// JXA's Ref('CGPoint') reads back as the number 0, so this fallback never matched (macOS 27.0.1, 2026-10-16).
// Copy the struct into bytes and read it back through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
function run(argv) {
  try {
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied' });
    const request = JSON.parse(argv[0]);
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Expected one running app');
    const running = apps.objectAtIndex(0), pid = Number(running.processIdentifier);
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) throw new Error('AX deadline unavailable');
    const attr = (element, name, optional = false) => {
      const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
      if (optional && [-25205, -25212].includes(error)) return null;
      if (error) throw new Error(name + ' unavailable');
      return ObjC.castRefToObject(value[0]);
    };
    const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
    const windows = attr(app, 'AXWindows');
    let matches = [];
    if (Number(windows.count) > 64) throw new Error('Too many windows');
    for (let i = 0; i < Number(windows.count); i++) {
      const window = windows.objectAtIndex(i);
      if (scalar(attr(window, 'AXTitle')) === request.title && scalar(attr(window, 'AXDocument', true)) === request.url) matches.push(window);
    }
    const focused = attr(app, 'AXFocusedWindow');
    let cg;
    const number = window => {
      const direct = scalar(attr(window, 'AXWindowNumber', true));
      if (Number.isSafeInteger(direct) && direct > 0) return direct;
      try {
        if (!cg) {
          const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
          cg = Array.from({ length: Number(list.count) }, (_, i) => ObjC.deepUnwrap(list.objectAtIndex(i)));
        }
        const position = axPair(attr(window, 'AXPosition'), 1), size = axPair(attr(window, 'AXSize'), 2);
        if (!position || !size) return null;
        const bounds = [...position, ...size];
        if (!bounds.every(Number.isFinite)) return null;
        const matches = cg.filter(info => Number(info.kCGWindowOwnerPID) === pid && info.kCGWindowLayer === 0 &&
          ['X', 'Y', 'Width', 'Height'].every((key, i) => Math.abs(info.kCGWindowBounds?.[key] - bounds[i]) < 0.5));
        return matches.length === 1 ? matches[0].kCGWindowNumber : null;
      } catch { return null; }
    };
    const requestedNumber = request.windowNumber ?? request.nativeIdentity?.windowNumber;
    if (requestedNumber !== undefined && requestedNumber !== null) {
      const numbers = matches.map(number);
      matches = matches.filter((window, i) => numbers[i] === requestedNumber);
      if (!matches.length && numbers.length && numbers.every(value => Number.isSafeInteger(value) && value > 0)) {
        return JSON.stringify({ status: 'mismatch', error: 'Known window number disappeared' });
      }
    }
    else if (matches.length > 1) {
      const focusedNumber = number(focused);
      if (Number.isSafeInteger(focusedNumber) && focusedNumber > 0) matches = matches.filter(window => number(window) === focusedNumber);
    }
    if (matches.length !== 1) return JSON.stringify({ status: 'ok', matches: matches.length,
      appId: request.appId, title: request.title, url: request.url, epoch: windowEpoch, window: 0,
      pid, processStart: Number(running.launchDate.timeIntervalSince1970) });
    const window = matches[0];
    // A unique header must also describe the app's focused window. Otherwise the engine's handle
    // and Accessibility disagree about which window a background input would reach.
    if (!$.CFEqual(window, focused)) return JSON.stringify({ status: 'mismatch', error: 'Focused window differs' });
    let index = windowReferences.findIndex(other => $.CFEqual(other, window));
    if (index < 0) {
      if (windowReferences.length >= 1024) throw new Error('Window identity capacity reached');
      index = windowReferences.push(window) - 1;
    }
    return JSON.stringify({ status: 'ok', matches: 1, appId: request.appId, title: request.title,
      url: request.url, epoch: windowEpoch, window: index + 1, windowNumber: number(window), pid,
      processStart: Number(running.launchDate.timeIntervalSince1970) });
  } catch (error) { return JSON.stringify({ status: 'unknown', error: String(error.message || error) }); }
}
