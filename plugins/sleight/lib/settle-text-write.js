// Same pid-targeted Shift settle as drag.js, after a verified Accessibility text write.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (typeof request.appId !== 'string' || !request.appId || !Number.isSafeInteger(request.pid) || request.pid <= 0 ||
        !Number.isFinite(request.processStart) || typeof request.lease?.path !== 'string' || !request.lease.token) throw new Error('Invalid text-write settle target');
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId);
    if (Number(apps.count) !== 1) throw new Error('Text-write settle needs one running app');
    const app = apps.objectAtIndex(0);
    if (Number(app.processIdentifier) !== request.pid || Number(app.launchDate.timeIntervalSince1970) !== request.processStart) throw new Error('The target process changed');
    const raw = $.NSString.stringWithContentsOfFileEncodingError(request.lease.path, $.NSUTF8StringEncoding, null);
    if (!raw || raw.isNil()) throw new Error('The input lease is unavailable');
    const record = JSON.parse(ObjC.unwrap(raw));
    if (record.token !== request.lease.token || record.expires <= Date.now() || record.window?.appId !== request.appId) throw new Error('Input lease ownership lost or expired');
    const events = [true, false].map(down => {
      const event = $.CGEventCreateKeyboardEvent(null, 56, down);
      if (!event || event.isNil()) throw new Error('Cannot create Shift event');
      $.CGEventSetFlags(event, down ? $.kCGEventFlagMaskShift : 0);
      $.CGEventSetType(event, $.kCGEventFlagsChanged);
      return event;
    });
    try {
      $.CGEventPostToPid(request.pid, events[0]); delay(0.05);
    } finally {
      $.CGEventPostToPid(request.pid, events[1]); delay(0.05);
    }
    return JSON.stringify({ ok: true });
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}
