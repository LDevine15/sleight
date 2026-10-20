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
    // DP1 asks only for metadata on the already approved leased process. Never
    // resolve a different instance by bundle, or read title/document attributes.
    if (request.closeCount) {
      const { pid, processStart } = request.nativeIdentity ?? {};
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(processStart)) throw new Error('Missing leased process');
      const current = () => {
        const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        if (!running || running.isNil() || running.terminated !== false || Number(running.processIdentifier) !== pid ||
            ObjC.unwrap(running.bundleIdentifier) !== request.appId || Number(running.launchDate.timeIntervalSince1970) !== processStart) {
          throw new Error('Leased process changed');
        }
      };
      current();
      const app = $.AXUIElementCreateApplication(pid), deadline = Date.now() + 200;
      if (Number($.AXUIElementSetMessagingTimeout(app, 0.05)) !== 0) throw new Error('AX deadline unavailable');
      const attr = (element, name, optional = false) => {
        if (Date.now() >= deadline) throw new Error('AX deadline');
        const value = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
        if (optional && [-25205, -25212].includes(error)) return null;
        if (error) throw new Error('AX metadata unavailable');
        return ObjC.castRefToObject(value[0]);
      };
      const count = list => {
        if (list === null || list === undefined) throw new Error('Missing AX list');
        const n = Number(list.count);
        if (!Number.isSafeInteger(n) || n < 0 || n > 64) throw new Error('AX list bound');
        return n;
      };
      const windows = attr(app, 'AXWindows'), windowCount = count(windows);
      let modalCount = 0, seen = 0;
      if (windowCount === 0) {
        const visit = (children, depth) => {
          const n = count(children);
          if (depth > 8 || seen + n > 64) throw new Error('AX child bound');
          seen += n;
          for (let i = 0; i < n; i++) {
            const child = children.objectAtIndex(i), role = ObjC.deepUnwrap(attr(child, 'AXRole'));
            if (typeof role !== 'string') throw new Error('Missing AX role');
            const subrole = ObjC.deepUnwrap(attr(child, 'AXSubrole', true));
            if (role === 'AXSheet' || role === 'AXDialog' || subrole === 'AXDialog' || subrole === 'AXSystemDialog' ||
                ObjC.deepUnwrap(attr(child, 'AXModal', true)) === true) { modalCount++; continue; }
            if (role === 'AXWindow') throw new Error('Window missing from AXWindows');
            // Menu contents are separate from the app's window and modal children.
            if (role === 'AXMenuBar' || role === 'AXMenu') continue;
            const nested = attr(child, 'AXChildren', true);
            if (nested !== null) visit(nested, depth + 1);
          }
        };
        visit(attr(app, 'AXChildren'), 0);
      }
      current();
      if (Date.now() >= deadline) throw new Error('AX deadline');
      return JSON.stringify({ status: 'ok', appId: request.appId, pid, processStart, running: true, windowCount, modalCount });
    }
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
    const hidIdleSeconds = () => {
      try { return Number($.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)); } catch { return null; }
    };
    const windows = attr(app, 'AXWindows');
    let matches = [];
    if (Number(windows.count) > 64) throw new Error('Too many windows');
    for (let i = 0; i < Number(windows.count); i++) {
      const window = windows.objectAtIndex(i);
      // Finder's desktop window has no AXTitle (-25212), and requiring one failed every Finder identity
      // (late-alert probe, 2026-10-17: 5 of 5 baselines empty). A window without a title matches no header.
      const title = scalar(attr(window, 'AXTitle', true));
      if (title !== null && title === request.title && scalar(attr(window, 'AXDocument', true)) === request.url) matches.push(window);
    }
    // Before the number or focus narrows them: a caller with no number for the window needs exactly one.
    const headerMatches = matches.length;
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
    if (matches.length !== 1) return JSON.stringify({ status: 'ok', matches: matches.length, headerMatches,
      appId: request.appId, title: request.title, url: request.url, epoch: windowEpoch, window: 0,
      pid, processStart: Number(running.launchDate.timeIntervalSince1970), hidIdleSeconds: hidIdleSeconds() });
    const window = matches[0];
    // A unique header must also describe the app's focused window. Otherwise the engine's handle
    // and Accessibility disagree about which window a background input would reach.
    if (!$.CFEqual(window, focused)) return JSON.stringify({ status: 'mismatch', error: 'Focused window differs' });
    let index = windowReferences.findIndex(other => $.CFEqual(other, window));
    if (index < 0) {
      if (windowReferences.length >= 1024) throw new Error('Window identity capacity reached');
      index = windowReferences.push(window) - 1;
    }
    // The guard's light check after Return (SLEIGHT_GUARD_LIGHT_RETURN): sheets on this window, and the
    // focused element's role and subrole (AXSecureTextField refuses it) and whether it sits in this
    // window, by AXWindow or else its parents.
    let focus;
    if (request.focus) {
      const children = attr(window, 'AXChildren', true);
      let sheets = 0;
      for (let i = 0; i < Math.min(Number(children?.count ?? 0), 256); i++) {
        if (scalar(attr(children.objectAtIndex(i), 'AXRole', true)) === 'AXSheet') sheets++;
      }
      const element = attr(app, 'AXFocusedUIElement', true);
      let inWindow = false;
      if (element) {
        const owner = attr(element, 'AXWindow', true);
        if (owner) inWindow = !!$.CFEqual(owner, window);
        else for (let node = element, depth = 0; node && depth < 40 && !inWindow; depth++) {
          inWindow = !!$.CFEqual(node, window);
          node = attr(node, 'AXParent', true);
        }
      }
      // A web area above the focused element (Gecko names it HTML content) puts it in a page, where a tab continuation's
      // typing must not land. Walks up to the window, like the search above.
      let inPage = false;
      for (let node = element, depth = 0; node && depth < 40 && !inPage && !$.CFEqual(node, window); depth++) {
        const role = scalar(attr(node, 'AXRole', true)), description = scalar(attr(node, 'AXRoleDescription', true));
        inPage = role === 'AXWebArea' || /html content/i.test(String(role ?? '')) || /html content/i.test(String(description ?? ''));
        node = attr(node, 'AXParent', true);
      }
      focus = { sheets, role: element ? scalar(attr(element, 'AXRole', true)) : null,
        subrole: element ? scalar(attr(element, 'AXSubrole', true)) ?? null : null, inWindow, inPage };
    }
    return JSON.stringify({ status: 'ok', matches: 1, headerMatches, appId: request.appId, title: request.title,
      url: request.url, epoch: windowEpoch, window: index + 1, windowNumber: number(window), pid,
      // The parent lease takes only a standard window (SLEIGHT_PARENT_LEASE), read before HID idle is sampled.
      windowSubrole: scalar(attr(window, 'AXSubrole', true)) ?? null,
      processStart: Number(running.launchDate.timeIntervalSince1970), hidIdleSeconds: hidIdleSeconds(), ...(focus ? { focus } : {}) });
  } catch (error) { return JSON.stringify({ status: 'unknown', error: String(error.message || error) }); }
}
