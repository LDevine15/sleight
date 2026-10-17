// Read only AXDocument and window state in an already running process. Unknown observations keep the ordinary open.
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
    if (Number($.AXUIElementCopyAttributeValue(app, $('AXHidden'), value)) !== 0 ||
        ObjC.unwrap(ObjC.castRefToObject(value[0])) !== false) throw Error('App visibility unavailable');
    if (Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value)) !== 0) throw Error('AXWindows unavailable');
    const windows = ObjC.castRefToObject(value[0]);
    if (windows.count > 64) throw Error('Too many windows');
    const expected = ObjC.unwrap($.NSURL.fileURLWithPath(request.path).absoluteString);
    for (let i = 0; i < windows.count; i++) {
      const document = Ref();
      if (Number($.AXUIElementCopyAttributeValue(windows.objectAtIndex(i), $('AXDocument'), document)) !== 0) continue;
      if (ObjC.unwrap(ObjC.castRefToObject(document[0])) !== expected) continue;
      const window = windows.objectAtIndex(i), minimized = Ref(), visible = Ref(), main = Ref();
      if (Number($.AXUIElementCopyAttributeValue(window, $('AXMinimized'), minimized)) !== 0 ||
          ObjC.unwrap(ObjC.castRefToObject(minimized[0])) !== false) continue;
      if (Number($.AXUIElementCopyAttributeValue(window, $('AXVisible'), visible)) !== 0 ||
          ObjC.unwrap(ObjC.castRefToObject(visible[0])) !== true) continue;
      // The read after open_file is of the app's main window, so another document in front still needs the open.
      if (Number($.AXUIElementCopyAttributeValue(window, $('AXMain'), main)) !== 0 ||
          ObjC.unwrap(ObjC.castRefToObject(main[0])) !== true) continue;
      return JSON.stringify({ ok: true, matches: true });
    }
    return JSON.stringify({ ok: true, matches: false });
  } catch { return JSON.stringify({ ok: false, matches: false }); }
}
