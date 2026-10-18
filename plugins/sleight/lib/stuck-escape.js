// One Escape key down and up posted to the leased app's pid, for a menu stuck in menu tracking (stuck-escape.mjs).
// CGEventPostToPid reaches only that process: no activation, pointer move or focus change. `op: "check"` only reads
// the app's menu bar.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
const ESCAPE = 53, POSTED_MARK = '[sleight:stuck-escape-posted]';
function run(argv) {
  let posted = false;
  try {
    const request = JSON.parse(argv[0]), check = request.op === 'check';
    if (typeof request.appId !== 'string' || !request.appId || !Number.isSafeInteger(request.pid) || request.pid <= 0 ||
        !Number.isFinite(request.processStart) || !check && (typeof request.lease?.path !== 'string' || !request.lease.token ||
        !(request.quietSeconds >= 0.5 && request.quietSeconds <= 5) || !(request.waitSeconds >= 0 && request.waitSeconds <= 2))) throw new Error('Invalid stuck-menu Escape target');
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Stuck-menu Escape needs one running app');
    const app = apps.objectAtIndex(0);
    if (Number(app.processIdentifier) !== request.pid || Number(app.launchDate.timeIntervalSince1970) !== request.processStart) throw new Error('The target process changed');
    if (check) return JSON.stringify({ ok: true, ...menuState(request.pid) });
    // A Stop clicked or typed during the wait is HID input, so it ends the wait with nothing posted.
    waitForQuiet(request.quietSeconds, request.waitSeconds);
    const raw = $.NSString.stringWithContentsOfFileEncodingError(request.lease.path, $.NSUTF8StringEncoding, null);
    if (!raw || raw.isNil()) throw new Error('The input lease is unavailable');
    const record = JSON.parse(ObjC.unwrap(raw));
    if (record.token !== request.lease.token || record.expires <= Date.now() || record.window?.appId !== request.appId) throw new Error('Input lease ownership lost or expired');
    // The relay's trigger is result text, which Claude's code can print too, so the app's own menu bar decides.
    const before = menuState(request.pid);
    if (before.selected !== true || before.open !== false) throw new Error('The menu bar shows no stuck menu');
    const events = [true, false].map(down => {
      const event = $.CGEventCreateKeyboardEvent(null, ESCAPE, down);
      if (!event) throw new Error('Cannot create Escape event');
      $.CGEventSetFlags(event, 0); // no modifier the user holds rides along
      return event;
    });
    try {
      $.CGEventPostToPid(request.pid, events[0]); posted = true;
      // On stderr at once, so a timeout kill after this point still reports the post.
      try { $.NSFileHandle.fileHandleWithStandardError.writeData($(POSTED_MARK + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); } catch {}
      delay(0.03);
    } finally {
      if (posted) $.CGEventPostToPid(request.pid, events[1]);
    }
    delay(0.15);
    return JSON.stringify({ ok: true, posted: true, selected: menuState(request.pid).selected });
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
// The app's menu bar: whether a title is selected, and whether a menu is open (an AXMenu among the app's children or
// focused). Each is null when it can't be read.
function menuState(pid) {
  const state = { selected: null, open: null };
  try {
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.2)) !== 0) return state;
    const attr = (element, name) => {
      const value = Ref();
      if (Number($.AXUIElementCopyAttributeValue(element, $(name), value))) return undefined;
      return ObjC.castRefToObject(value[0]);
    };
    const role = element => { const value = element && attr(element, 'AXRole'); return value === undefined ? undefined : ObjC.unwrap(value); };
    const list = value => value ? Array.from({ length: Number(value.count) }, (_, i) => value.objectAtIndex(i)) : undefined;
    const bar = attr(app, 'AXMenuBar'), items = list(bar && attr(bar, 'AXChildren'));
    if (items) state.selected = items.some(item => { const selected = attr(item, 'AXSelected'); return selected !== undefined && ObjC.deepUnwrap(selected) === true; });
    const children = list(attr(app, 'AXChildren'));
    if (children) state.open = children.some(child => role(child) === 'AXMenu') || ['AXMenu', 'AXMenuItem'].includes(role(attr(app, 'AXFocusedUIElement')));
  } catch {}
  return state;
}
