// Selection metadata only. Never read AXValue or AXSelectedText, and never activate or raise a window.
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
    if (matches.length !== 1 || Number(matches[0].processIdentifier) !== request.pid) throw Error('app identity changed');
    const read = (el, key, optional = false) => {
      const out = Ref(), status = Number($.AXUIElementCopyAttributeValue(el, $(key), out));
      if (optional && status === -25205) return null;
      if (status !== 0) throw Error('selection census incomplete');
      return ObjC.castRefToObject(out[0]);
    };
    const ax = $.AXUIElementCreateApplication(request.pid);
    if (Number($.AXUIElementSetMessagingTimeout(ax, 0.5)) !== 0) throw Error('AX deadline unavailable');
    const windows = read(ax, 'AXWindows'), selected = [];
    if (windows.count > 64) throw Error('too many windows');
    let remaining = 4096;
    for (let i = 0; i < windows.count; i++) {
      const window = windows.objectAtIndex(i), queue = [window];
      let holdsSelection = false;
      while (queue.length) {
        const el = queue.pop();
        if (--remaining < 0) throw Error('selection census incomplete');
        const role = ObjC.unwrap(read(el, 'AXRole'));
        const range = read(el, 'AXSelectedTextRange', true);
        if (!range && ['AXTextArea', 'AXTextField', 'AXComboBox'].includes(role)) throw Error('selection range unavailable');
        if (range) {
          const value = /location:(\d+) length:(\d+)/.exec(ObjC.unwrap(range.description));
          if (!value) throw Error('selection range unavailable');
          const location = Number(value[1]), length = Number(value[2]);
          if (!Number.isSafeInteger(location) || location < 0 || !Number.isSafeInteger(length) || length < 0) throw Error('invalid selection range');
          if (length > 0) holdsSelection = true;
        }
        const children = read(el, 'AXChildren', true);
        if (children) {
          if (children.count > remaining) throw Error('selection census incomplete');
          for (let j = 0; j < children.count; j++) queue.push(children.objectAtIndex(j));
        }
      }
      if (holdsSelection) {
        const title = ObjC.unwrap(read(window, 'AXTitle'));
        const url = ObjC.unwrap(read(window, 'AXDocument', true)) || null;
        if (typeof title !== 'string') throw Error('window title unavailable');
        const windowNumber = Number(ObjC.unwrap(read(window, 'AXWindowNumber')));
        if (!Number.isSafeInteger(windowNumber) || windowNumber <= 0) throw Error('window number unavailable');
        selected.push({ appId: request.appId, app: request.app, title, url, windowNumber });
      }
    }
    if (selected.length !== 1) throw Error('selection is not unique across app windows');
    return JSON.stringify({ ok: true, pid: request.pid, target: selected[0] });
  } catch { return JSON.stringify({ ok: false }); }
}
