// SR1 experiment: persistent read-only AX metadata, following guard-window-observer.js.
// No AXValue, document contents, activation, input or permission request.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
const epoch = ObjC.unwrap($.NSUUID.UUID.UUIDString), identities = [];
function identity(element) {
  for (let i = 0; i < identities.length; i++) if ($.CFEqual(identities[i], element)) return i + 1;
  if (identities.length >= 4096) throw new Error('AX identity budget exceeded');
  identities.push(element); return identities.length;
}
function attribute(element, name, timeout, optional = false) {
  if (Number($.AXUIElementSetMessagingTimeout(element, timeout)) !== 0) throw new Error('AX messaging timeout unavailable');
  const out = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), out));
  if (error === 0) return ObjC.castRefToObject(out[0]);
  if (optional && [ -25205, -25212 ].includes(error)) return null;
  throw new Error(name + ': AX error ' + error);
}
const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
// macOS 27 adds a "Window" dialog holding only a WindowSharingSessionButton while the engine
// captures the app (2026-10-14). It is the system's sharing indicator, not the app's window.
const overlay = (window, read) => {
  const children = read(window, 'AXChildren', true);
  if (!children || Number(children.count) !== 1) return false;
  return scalar(read(children.objectAtIndex(0), 'AXTitle', true)) === 'WindowSharingSessionButton';
};
const dialog = (role, subrole) => ['AXSheet', 'AXDialog'].includes(role) || ['AXDialog', 'AXSystemDialog'].includes(subrole);
function run(argv) {
  if (!/^\/private\/tmp\/sleight-exact-[A-Za-z0-9]+\/exact\.txt$/.test(argv[0] ?? '')) throw new Error('Owned probe path required');
  const url = ObjC.unwrap($.NSURL.fileURLWithPath(argv[0]).absoluteString);
  let app, root, openPanel, beforeWindows = [], pid, processStart, buffer = '';
  const apps = () => $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
  const verify = () => {
    const running = apps();
    if (Number(running.count) !== 1 || Number(running.objectAtIndex(0).processIdentifier) !== pid ||
      Number(running.objectAtIndex(0).launchDate.timeIntervalSince1970) !== processStart) throw new Error('Process incarnation changed');
  };
  function answer(request) {
    if (!$.AXIsProcessTrusted()) return { status: 'denied' };
    const timeout = request.op === 'attribute' ? 1 : 0.1;
    const read = (element, name, optional = false) => attribute(element, name, timeout, optional);
    if (request.op === 'bind') {
      const running = apps(); if (Number(running.count) !== 1) return { status: 'ambiguous', running: Number(running.count) };
      pid = Number(running.objectAtIndex(0).processIdentifier);
      processStart = Number(running.objectAtIndex(0).launchDate.timeIntervalSince1970);
      app = $.AXUIElementCreateApplication(pid);
      const all = read(app, 'AXWindows'), windows = [];
      for (let i = 0; i < Number(all.count); i++) if (!overlay(all.objectAtIndex(i), read)) windows.push(all.objectAtIndex(i));
      if (windows.length !== 1) return { status: 'ambiguous', windows: windows.length, all: Number(all.count), detail: windows.map(w => { const c = read(w, 'AXChildren', true); return { title: scalar(read(w, 'AXTitle', true)), sub: scalar(read(w, 'AXSubrole', true)), kids: c ? Number(c.count) : null, first: c && Number(c.count) ? [scalar(read(c.objectAtIndex(0), 'AXRole', true)), scalar(read(c.objectAtIndex(0), 'AXTitle', true))] : null }; }) };
      root = windows[0];
      if (scalar(read(root, 'AXDocument')) !== url) { root = null; return { status: 'unowned' }; }
      beforeWindows = windows; openPanel = undefined; return { status: 'ok' };
    }
    if (!root) return { status: 'unbound' };
    verify();
    if (request.op === 'attribute') {
      // Exactly one timed attribute fetch, against the retained owned document window.
      return { status: 'ok', role: scalar(read(root, 'AXRole')) };
    }
    if (!['focus', 'prepare'].includes(request.op)) return { status: 'invalid' };
    const element = read(app, 'AXFocusedUIElement');
    const role = scalar(read(element, 'AXRole')), subrole = scalar(read(element, 'AXSubrole', true));
    const focusWindow = read(element, 'AXWindow');
    let surface = focusWindow, owned = false, node = element;
    // AXWindow sometimes names the enclosing document window for an attached sheet.
    // Use the nearest dialog ancestor as the surface, retaining both identities by CFEqual.
    let found = false; const ancestors = [];
    for (let depth = 0; node && depth < 24; depth++) {
      if (ancestors.some(old => $.CFEqual(old, node))) throw new Error('Ambiguous focus ancestry');
      ancestors.push(node);
      if ($.CFEqual(node, root)) owned = true;
      const r = scalar(read(node, 'AXRole')), s = scalar(read(node, 'AXSubrole', true));
      if (!found && dialog(r, s)) { surface = node; found = true; }
      node = read(node, 'AXParent', true);
    }
    const windowRole = scalar(read(surface, 'AXRole')), windowSubrole = scalar(read(surface, 'AXSubrole', true));
    const all = read(app, 'AXWindows'), windows = [];
    for (let i = 0; i < Number(all.count); i++) if (!overlay(all.objectAtIndex(i), read)) windows.push(all.objectAtIndex(i));
    if (windows.length > 8) return { status: 'ambiguous' };
    if (windows.length === 1 && $.CFEqual(windows[0], root)) openPanel = undefined;
    if (request.op === 'prepare') beforeWindows = windows;
    const added = windows.filter(window => !beforeWindows.some(old => $.CFEqual(old, window)));
    // The opener may create one separate standard window. Retain its AX identity, never
    // adopt a second or replacement window based on its title or dialog role.
    if (!openPanel && request.op === 'focus' && added.length === 1 && $.CFEqual(added[0], focusWindow)) openPanel = added[0];
    const rootPresent = windows.some(window => $.CFEqual(window, root));
    const foreign = windows.some(window => !$.CFEqual(window, root) && (!openPanel || !$.CFEqual(window, openPanel)));
    const inPanel = openPanel && ($.CFEqual(focusWindow, openPanel) || ancestors.some(node => $.CFEqual(node, openPanel)));
    owned = rootPresent && !foreign && !!(owned || inPanel);
    if (!$.CFEqual(element, read(app, 'AXFocusedUIElement'))) return { status: 'changed' };
    verify();
    return { status: 'ok', epoch, pid, processStart, element: identity(element), surface: identity(surface),
      role, subrole, windowRole, windowSubrole, owned, panel: inPanel ? identity(openPanel) : null };
  }
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  for (;;) {
    const data = stdin.availableData; if (Number(data.length) === 0) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) return '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let request, reply; const start = Date.now();
      try { request = JSON.parse(line); reply = answer(request); }
      catch (error) { reply = { status: 'unknown', error: String(error.message || error) }; }
      stdout.writeData($(JSON.stringify({ ...reply, id: request?.id, nativeMs: Date.now() - start }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
