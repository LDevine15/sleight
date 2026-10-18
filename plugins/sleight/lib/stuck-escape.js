// One Escape key down and up posted to the leased app's pid, for a menu stuck in menu tracking (stuck-escape.mjs).
// CGEventPostToPid reaches only that process: no activation, pointer move or focus change.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
const ESCAPE = 53;
function run(argv) {
  let posted = false;
  try {
    const request = JSON.parse(argv[0]);
    if (typeof request.appId !== 'string' || !request.appId || !Number.isSafeInteger(request.pid) || request.pid <= 0 ||
        !Number.isFinite(request.processStart) || typeof request.lease?.path !== 'string' || !request.lease.token ||
        !(request.quietSeconds >= 0.5 && request.quietSeconds <= 5) || !(request.waitSeconds >= 0 && request.waitSeconds <= 2)) throw new Error('Invalid stuck-menu Escape target');
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Stuck-menu Escape needs one running app');
    const app = apps.objectAtIndex(0);
    if (Number(app.processIdentifier) !== request.pid || Number(app.launchDate.timeIntervalSince1970) !== request.processStart) throw new Error('The target process changed');
    // A Stop clicked or typed during the wait is HID input, so it ends the wait with nothing posted.
    waitForQuiet(request.quietSeconds, request.waitSeconds);
    const raw = $.NSString.stringWithContentsOfFileEncodingError(request.lease.path, $.NSUTF8StringEncoding, null);
    if (!raw || raw.isNil()) throw new Error('The input lease is unavailable');
    const record = JSON.parse(ObjC.unwrap(raw));
    if (record.token !== request.lease.token || record.expires <= Date.now() || record.window?.appId !== request.appId) throw new Error('Input lease ownership lost or expired');
    const events = [true, false].map(down => {
      const event = $.CGEventCreateKeyboardEvent(null, ESCAPE, down);
      if (!event) throw new Error('Cannot create Escape event');
      $.CGEventSetFlags(event, 0); // no modifier the user holds rides along
      return event;
    });
    try {
      $.CGEventPostToPid(request.pid, events[0]); posted = true; delay(0.03);
    } finally {
      if (posted) $.CGEventPostToPid(request.pid, events[1]);
    }
    delay(0.15);
    return JSON.stringify({ ok: true, posted: true, selected: menuBarSelected(request.pid) });
  } catch (error) { return JSON.stringify({ ok: false, posted, error: String(error.message || error) }); }
}
// No key or mouse input for `quiet` seconds (HID state, any event type), waiting up to `wait` seconds for it.
function waitForQuiet(quiet, wait) {
  for (let waited = 0; ;) {
    const idle = Number($.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF));
    if (idle >= quiet) return;
    const step = Math.max(0.1, quiet - (Number.isFinite(idle) ? idle : 0));
    if (waited + step > wait) throw new Error('User input at the Mac');
    delay(step);
    waited += step;
  }
}
// Whether a menu-bar title is still selected after the Escape, or null when the bar can't be read.
function menuBarSelected(pid) {
  try {
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.2)) !== 0) return null;
    const attr = (element, name) => {
      const value = Ref();
      if (Number($.AXUIElementCopyAttributeValue(element, $(name), value))) return undefined;
      return ObjC.castRefToObject(value[0]);
    };
    const bar = attr(app, 'AXMenuBar'), items = bar && attr(bar, 'AXChildren');
    if (!items) return null;
    for (let i = 0; i < Number(items.count); i++) {
      const selected = attr(items.objectAtIndex(i), 'AXSelected');
      if (selected !== undefined && ObjC.deepUnwrap(selected) === true) return true;
    }
    return false;
  } catch { return null; }
}
