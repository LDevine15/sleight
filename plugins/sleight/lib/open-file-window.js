// Read only AXDocument in an already running process. Unknown observations keep the ordinary open.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications, matches = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      if (ObjC.unwrap(app.bundleIdentifier) === request.appId) matches.push(app);
    }
    if (matches.length !== 1) return JSON.stringify({ ok: true, matches: false });
    const app = $.AXUIElementCreateApplication(Number(matches[0].processIdentifier));
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw Error('AX deadline unavailable');
    const value = Ref();
    if (Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value)) !== 0) throw Error('AXWindows unavailable');
    const windows = ObjC.castRefToObject(value[0]);
    if (windows.count > 64) throw Error('Too many windows');
    const expected = ObjC.unwrap($.NSURL.fileURLWithPath(request.path).absoluteString);
    for (let i = 0; i < windows.count; i++) {
      const document = Ref();
      if (Number($.AXUIElementCopyAttributeValue(windows.objectAtIndex(i), $('AXDocument'), document)) !== 0) continue;
      if (ObjC.unwrap(ObjC.castRefToObject(document[0])) === expected) return JSON.stringify({ ok: true, matches: true });
    }
    return JSON.stringify({ ok: true, matches: false });
  } catch { return JSON.stringify({ ok: false, matches: false }); }
}
