// Probe-only correctness reader and exact-document cleanup. Pattern from small-fixes-textedit.js.
// AXValue reads are confined to this fixture, never used by the metadata readiness observer.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function attribute(element, name, optional = false) {
  if (Number($.AXUIElementSetMessagingTimeout(element, 1)) !== 0) throw new Error('Cannot bound fixture AX messaging');
  const out = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), out));
  if (error === 0) return ObjC.castRefToObject(out[0]);
  if (optional && [-25205, -25212].includes(error)) return null;
  throw new Error(name + ': AX error ' + error);
}
const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
// macOS 27 adds a "Window" dialog holding only a WindowSharingSessionButton while the engine
// captures the app (2026-10-14). It is the system's sharing indicator, not the app's window.
const overlay = window => {
  const children = attribute(window, 'AXChildren', true);
  if (!children || Number(children.count) !== 1) return false;
  return scalar(attribute(children.objectAtIndex(0), 'AXTitle', true)) === 'WindowSharingSessionButton';
};
const appWindows = ax => { const all = attribute(ax, 'AXWindows'), out = [];
  for (let i = 0; i < Number(all.count); i++) if (!overlay(all.objectAtIndex(i))) out.push(all.objectAtIndex(i));
  return out; };
const dialog = (role, subrole) => ['AXSheet', 'AXDialog'].includes(role) || ['AXDialog', 'AXSystemDialog'].includes(subrole);
function run(argv) {
  const path = argv[0];
  if (!/^\/private\/tmp\/sleight-exact-[A-Za-z0-9]+\/exact\.txt$/.test(path ?? '')) throw new Error('Owned probe path required');
  const url = ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString), app = Application('TextEdit');
  const front = () => Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  let ax, root, area, doc, openPanel, beforeWindows = [], openNodes = [], pid, processStart, originalFront, initiallyRunning, buffer = '';
  const running = () => $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.TextEdit');
  const documents = () => app.documents();
  function verify() {
    if (!root || !doc || String(doc.path()) !== path) throw new Error('Owned document unbound');
    if (front() !== originalFront) throw new Error('Foreground changed; stopping without input');
    const apps = running();
    if (Number(apps.count) !== 1 || Number(apps.objectAtIndex(0).processIdentifier) !== pid ||
      Number(apps.objectAtIndex(0).launchDate.timeIntervalSince1970) !== processStart) throw new Error('Process incarnation changed');
    const docs = documents();
    if (docs.length !== 1 || String(docs[0].path()) !== path || scalar(attribute(root, 'AXDocument')) !== url) throw new Error('Foreign document present');
  }
  function inventory() {
    verify();
    const windows = appWindows(ax);
    if (windows.length > 8) throw new Error('Window budget exceeded');
    let panels = 0, rootPresent = false;
    for (const window of windows) {
      if ($.CFEqual(root, window)) rootPresent = true;
      else if (openPanel && $.CFEqual(openPanel, window)) panels++;
      else throw new Error('Foreign window present; cleanup refused');
      const sheets = attribute(window, 'AXSheets', true); panels += Number(sheets?.count ?? 0);
    }
    if (!rootPresent) throw new Error('Owned window gone');
    // Focus must still be on the owned root or an attached/app-level modal surface.
    const focus = attribute(ax, 'AXFocusedUIElement'), focusWindow = attribute(focus, 'AXWindow');
    if (!$.CFEqual(root, focusWindow) && (!openPanel || (!$.CFEqual(openPanel, focusWindow) &&
      !modalChain(focus).ancestors.some(node => $.CFEqual(node, openPanel))))) throw new Error('Input focus belongs to another window');
    return { clean: panels === 0, owned: true };
  }
  function modalChain(element) {
    const result = [], seen = [];
    for (let node = element; node; node = attribute(node, 'AXParent', true)) {
      if (seen.length >= 24 || seen.some(other => $.CFEqual(other, node))) throw new Error('Ambiguous modal ancestry');
      seen.push(node);
      if ((openPanel && $.CFEqual(node, openPanel)) || dialog(scalar(attribute(node, 'AXRole')), scalar(attribute(node, 'AXSubrole', true)))) result.push(node);
    }
    // An app-level Open panel may only be named by AXWindow, rather than AXParent.
    const window = attribute(element, 'AXWindow');
    if (!result.some(node => $.CFEqual(node, window)) && ((openPanel && $.CFEqual(window, openPanel)) ||
      (!result.length && dialog(scalar(attribute(window, 'AXRole')), scalar(attribute(window, 'AXSubrole', true)))))) result.push(window);
    return { modals: result, ancestors: seen };
  }
  function descendants(surface) {
    const nodes = [], seen = [];
    const walk = (node, depth) => {
      if (nodes.length >= 400 || depth > 16 || seen.some(other => $.CFEqual(other, node))) throw new Error('Path tree budget or ancestry exceeded');
      seen.push(node); nodes.push(node);
      const children = attribute(node, 'AXChildren', true);
      for (let i = 0; i < Number(children?.count ?? 0); i++) walk(children.objectAtIndex(i), depth + 1);
    };
    walk(surface, 0); return nodes;
  }
  function pathControl(surface) {
    const fields = descendants(surface).filter(node => !openNodes.some(old => $.CFEqual(old, node)) &&
      ['AXTextField', 'AXTextArea', 'AXComboBox'].includes(scalar(attribute(node, 'AXRole'))));
    if (fields.length !== 1) throw new Error('Ambiguous new path field');
    return fields[0];
  }
  function answer(request) {
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission prompt requested');
    if (request.op === 'preflight') {
      originalFront = front(); initiallyRunning = app.running();
      if (ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier) === 'com.apple.TextEdit') return { safe: false };
      if (initiallyRunning) {
        const apps = running(); if (Number(apps.count) !== 1 || documents().length !== 0) return { safe: false };
        if (appWindows($.AXUIElementCreateApplication(Number(apps.objectAtIndex(0).processIdentifier))).length !== 0) return { safe: false };
      }
      return { safe: true, initiallyRunning };
    }
    if (request.op === 'attach') {
      if (front() !== originalFront) throw new Error('Foreground changed during launch');
      const apps = running(); if (Number(apps.count) === 0) return { attached: false };
      if (Number(apps.count) !== 1) throw new Error('Ambiguous TextEdit');
      pid = Number(apps.objectAtIndex(0).processIdentifier); processStart = Number(apps.objectAtIndex(0).launchDate.timeIntervalSince1970);
      ax = $.AXUIElementCreateApplication(pid);
      const docs = documents(); if (docs.length === 0) return { attached: false };
      if (docs.length !== 1 || String(docs[0].path()) !== path) throw new Error('Foreign document present'); doc = docs[0];
      const windows = appWindows(ax); if (windows.length === 0) return { attached: false };
      if (windows.length !== 1) throw new Error('Ambiguous fixture window');
      root = windows[0]; if (scalar(attribute(root, 'AXDocument', true)) !== url) return { attached: false };
      area = undefined; let count = 0;
      const walk = (node, depth) => {
        if (++count > 400 || depth > 16) throw new Error('Fixture tree budget exceeded');
        if (scalar(attribute(node, 'AXRole')) === 'AXTextArea') { if (area) throw new Error('Ambiguous text area'); area = node; return; }
        const children = attribute(node, 'AXChildren', true);
        for (let i = 0; i < Number(children?.count ?? 0); i++) walk(children.objectAtIndex(i), depth + 1);
      };
      walk(root, 0); if (!area) return { attached: false };
      verify(); beforeWindows = windows; return { attached: true };
    }
    if (request.op === 'inventory') return inventory();
    if (request.op === 'document') {
      const state = inventory(); if (state.clean) { openPanel = undefined; beforeWindows = appWindows(ax); }
      return { ...state, text: scalar(attribute(area, 'AXValue')) };
    }
    if (request.op === 'open') {
      verify();
      const windows = appWindows(ax), added = windows.filter(window => !beforeWindows.some(old => $.CFEqual(old, window)));
      if (added.length > 1) throw new Error('Open panel identity ambiguous');
      if (added.length === 1) openPanel = added[0];
      else {
        // Older macOS attaches the Open panel as a sheet of the retained document.
        const chain = modalChain(attribute(ax, 'AXFocusedUIElement'));
        if (chain.modals.length !== 1 || !chain.ancestors.some(node => $.CFEqual(node, root))) throw new Error('No new owned Open panel');
        openPanel = chain.modals[0];
      }
      inventory();
      const focus = attribute(ax, 'AXFocusedUIElement'), chain = modalChain(focus);
      if (!chain.modals.some(node => $.CFEqual(node, openPanel))) throw new Error('Focus outside new Open panel');
      openNodes = descendants(openPanel); return { openBound: true };
    }
    if (request.op === 'field') {
      const state = inventory(); if (state.clean) throw new Error('No owned Go to Folder sheet');
      const focus = attribute(ax, 'AXFocusedUIElement');
      if (!['AXTextField', 'AXTextArea', 'AXComboBox'].includes(scalar(attribute(focus, 'AXRole'))) || $.CFEqual(focus, area)) throw new Error('Focus is not on the owned path field');
      const chain = modalChain(focus);
      if (!openPanel || !chain.modals.some(node => $.CFEqual(node, openPanel)) ||
        (chain.ancestors.some(node => $.CFEqual(node, root)) && !chain.ancestors.some(node => $.CFEqual(node, openPanel))) ||
        scalar(attribute(focus, 'AXSubrole', true)) === 'AXSearchField') throw new Error('Focus outside bound Open panel');
      const surface = chain.modals[0];
      if (!$.CFEqual(surface, openPanel) && openNodes.some(node => $.CFEqual(node, surface))) throw new Error('Go to Folder surface is not new');
      const control = pathControl(surface);
      if (!chain.ancestors.some(node => $.CFEqual(node, control))) throw new Error('Focus is not the unique path control');
      return { value: scalar(attribute(focus, 'AXValue')), text: scalar(attribute(area, 'AXValue')) };
    }
    if (request.op === 'close') {
      if (!inventory().clean) throw new Error('Owned panels remain; close refused');
      doc.close({ saving: 'no' });
      if (documents().length !== 0) throw new Error('Document close unconfirmed');
      if (appWindows(ax).length !== 0) throw new Error('Window close unconfirmed');
      // Quit only a launch this run made, after proving no other documents/windows exist.
      if (!initiallyRunning) app.quit({ saving: 'no' });
      return { closed: true };
    }
    throw new Error('Unknown fixture operation');
  }
  const stdin = $.NSFileHandle.fileHandleWithStandardInput, stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  for (;;) {
    const data = stdin.availableData; if (Number(data.length) === 0) return '';
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    if (buffer.length > 4096) return '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); let request, reply;
      try { request = JSON.parse(line); reply = { ok: true, ...answer(request) }; }
      catch (error) { reply = { ok: false, error: String(error.message || error) }; }
      stdout.writeData($(JSON.stringify({ ...reply, id: request?.id }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    }
  }
}
