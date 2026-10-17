// XL1B fixture controls, run only by xl1-probe.mjs. No Apple events to Excel.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

function attribute(element, name, optional) {
  if (Number($.AXUIElementSetMessagingTimeout(element, 0.5)) !== 0) throw new Error('AX timeout unavailable');
  var out = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), out));
  if (error === 0) return ObjC.castRefToObject(out[0]);
  if (optional && [-25205, -25212].indexOf(error) >= 0) return null;
  throw new Error(name + ': AX error ' + error);
}
function scalar(value) { return value === null ? null : ObjC.deepUnwrap(value); }
function array(value) {
  var result = [];
  for (var i = 0; i < Number(value ? value.count : 0); i++) result.push(value.objectAtIndex(i));
  return result;
}
function pointerState() {
  var point = $.CGEventGetLocation($.CGEventCreate(null));
  return { pointer: { x: Number(point.x), y: Number(point.y) },
    leftDown: !!$.CGEventSourceButtonState($.kCGEventSourceStateCombinedSessionState, $.kCGMouseButtonLeft),
    hidLeftDown: !!$.CGEventSourceButtonState($.kCGEventSourceStateHIDSystemState, $.kCGMouseButtonLeft) };
  // kCGEventSourceStatePrivate never returns from JXA (2026-10-17 live preflight hung); the session and HID states suffice.
}
function cleanupSheetStep(sheets, answeredSheet, same) {
  if (!sheets.length) return 'none';
  if (sheets.length !== 1 || answeredSheet && !same(sheets[0], answeredSheet)) throw new Error('Unexpected cleanup sheet');
  return answeredSheet ? 'wait' : 'answer';
}
// /tmp and /var are symlinks into /private; Excel may report either form, a trailing slash or percent-encoding.
function normalPath(path) {
  return String(path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
}
function filePath(url) {
  var match = typeof url === 'string' && /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(url);
  if (!match) return null;
  try { return normalPath(decodeURIComponent(match[1])); } catch (error) { return null; }
}
// Only AX roles, sizes and booleans leave the host: never a title, a document path or content.
function describeWindows(infos, path) {
  var expected = normalPath(path);
  return infos.map(function (info) {
    var hasDocument = typeof info.document === 'string';
    return { role: info.role, subrole: info.subrole, width: info.width, height: info.height,
      hasDocument: hasDocument, owned: hasDocument && filePath(info.document) === expected, indicator: !!info.indicator };
  });
}
// strict (before input): the fixture's window must be the only document window and no app dialog may be up.
// Cleanup only needs the fixture's own window, to answer its own Don't Save sheet.
function chooseOwnedWindow(infos, path, strict) {
  var windows = describeWindows(infos, path), owned = [], documents = 0, dialogs = 0;
  windows.forEach(function (window, index) {
    if (window.indicator) return;
    if (window.hasDocument || window.subrole === 'AXStandardWindow') documents++;
    if (window.subrole === 'AXDialog' || window.subrole === 'AXSystemDialog') dialogs++;
    if (window.owned) owned.push(index);
  });
  if (owned.length === 1 && (!strict || documents === 1 && !dialogs)) return { index: owned[0] };
  var error = owned.length > 1 || owned.length && documents > 1 ? 'Foreign or ambiguous app window'
    : owned.length ? 'Unexpected app dialog' : 'Owned workbook window not found';
  return { error: error + (strict ? '; no input sent' : ''), windows: windows };
}
// JXA's Ref('CGSize') reads back as 0; copy the struct into bytes (as plugins/sleight/lib/window-identity.js does).
function axSize(value) {
  if (!value) return null;
  var bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, 2, bytes.mutableBytes)) return null;
  var size = ObjC.deepUnwrap($.NSValue.valueWithBytesObjCType(bytes.bytes, '{CGSize=dd}').sizeValue);
  return [Number(size.width), Number(size.height)];
}
function windowInfos(app) {
  return array(attribute(app, 'AXWindows')).map(function (window) {
    var children = array(attribute(window, 'AXChildren', true)), size = null;
    try { size = axSize(attribute(window, 'AXSize', true)); } catch (error) { size = null; }
    return { element: window,
      indicator: children.length === 1 && scalar(attribute(children[0], 'AXTitle', true)) === 'WindowSharingSessionButton',
      role: scalar(attribute(window, 'AXRole', true)), subrole: scalar(attribute(window, 'AXSubrole', true)),
      width: size ? size[0] : null, height: size ? size[1] : null, document: scalar(attribute(window, 'AXDocument', true)) };
  });
}
function restorePointer(request) {
  if (!request.pointer || !Number.isFinite(request.pointer.x) || !Number.isFinite(request.pointer.y)) return false;
  if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== request.front) return false;
  return Number($.CGWarpMouseCursorPosition($.CGPointMake(request.pointer.x, request.pointer.y))) === 0;
}
function provenDontSave(node, request, what) {
  var labels = [], walk = function (node, depth) {
    if (depth > 10 || labels.length > 300) throw new Error('Cleanup ' + what + ' budget exceeded');
    var title = scalar(attribute(node, 'AXTitle', true)), value = scalar(attribute(node, 'AXValue', true));
    if (typeof title === 'string') labels.push(title);
    if (typeof value === 'string') labels.push(value);
    array(attribute(node, 'AXChildren', true)).forEach(function (child) { walk(child, depth + 1); });
  };
  walk(node, 0);
  var stem = request.path.split('/').pop().replace(/\.xlsx$/, '');
  if (!labels.some(function (label) { return label.indexOf(stem) >= 0; }) ||
    !labels.some(function (label) { return /^(?:Don't Save|Don’t Save)$/.test(label); })) throw new Error('Owned Don\'t Save ' + what + ' unproved');
  return stem;
}
// Excel's save prompt can also be an alert window (AXDialog, no document) naming the fixture: "Want to save your changes to
// '<fixture>.xlsx'?" (17:20Z run, where cleanup left Excel running). Answer it only when its text names this fixture.
function answerOwnedDialog(dialog, pid, request) {
  var stem = provenDontSave(dialog, request, 'dialog');
  var se = Application('System Events'), processes = se.processes.whose({ unixId: pid })();
  if (processes.length !== 1) throw new Error('System Events process identity ambiguous');
  var candidates = [];
  processes[0].windows().forEach(function (window) {
    var subrole = null, texts = [];
    try { subrole = window.subrole(); } catch (error) { subrole = null; }
    if (subrole !== 'AXDialog') return;
    try { texts = window.staticTexts().map(function (text) { return String(text.value()); }); } catch (error) { texts = []; }
    if (!texts.some(function (text) { return text.indexOf(stem) >= 0; })) return;
    window.buttons().forEach(function (button) { if (/^(?:Don't Save|Don’t Save)$/.test(button.name())) candidates.push(button); });
  });
  if (candidates.length !== 1) throw new Error('System Events Don\'t Save dialog target ambiguous');
  candidates[0].click();
}
function answerOwnedSheet(sheet, pid, request) {
  provenDontSave(sheet, request, 'sheet');
  // Only this owned process's fixture window, through the already-authorized System Events path.
  var se = Application('System Events'), processes = se.processes.whose({ unixId: pid })();
  if (processes.length !== 1) throw new Error('System Events process identity ambiguous');
  var expected = normalPath(request.path), candidates = [];
  processes[0].windows().forEach(function (window) {
    var url = null;
    try { url = window.attributes.byName('AXDocument').value(); } catch (error) { url = null; }
    if (filePath(url) !== expected) return;
    window.sheets().forEach(function (found) {
      found.buttons().forEach(function (button) { if (/^(?:Don't Save|Don’t Save)$/.test(button.name())) candidates.push(button); });
    });
  });
  if (candidates.length !== 1) throw new Error('System Events Don\'t Save target ambiguous');
  candidates[0].click();
}
// Gentle cleanup whatever the trial left: terminate the owned process, answer only the fixture's own sheet,
// and report the windows left (roles and sizes only) when exit is unconfirmed.
function quit(target, pid, request) {
  var app = $.AXUIElementCreateApplication(pid), terminateAccepted = false, answered = null, answeredDialog = false, infos = [];
  var report = function (error) {
    return { ok: false, error: error, exited: false, terminateAccepted: terminateAccepted, answered: !!answered || answeredDialog,
      left: { pid: pid, windows: describeWindows(infos, request.path) } };
  };
  var deadline = Date.now() + 30000;
  try {
    while (Date.now() < deadline) {
      var current = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (current.isNil() || current.isTerminated)
        return { ok: true, exited: true, terminateAccepted: terminateAccepted, answered: !!answered || answeredDialog, pointerRestored: restorePointer(request) };
      if (Number(current.launchDate.timeIntervalSince1970) * 1000 !== request.birth || ObjC.unwrap(current.bundleIdentifier) !== 'com.microsoft.Excel')
        throw new Error('Quit process identity changed');
      if (!terminateAccepted) terminateAccepted = !!target.terminate;
      if ($.AXIsProcessTrusted()) {
        // A quitting app can fail AX reads; keep waiting for exit rather than abandoning cleanup.
        try { infos = windowInfos(app); } catch (error) { delay(0.1); continue; }
        var choice = chooseOwnedWindow(infos, request.path, false);
        if (choice.index !== undefined) {
          var root = infos[choice.index].element, sheets = array(attribute(root, 'AXSheets', true));
          var step = cleanupSheetStep(sheets, answered, function (a, b) { return !!$.CFEqual(a, b); });
          var front = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
          // The owner's foreground app or Excel itself (a launch can activate it); never answer under another app.
          if (step === 'answer' && (front === request.front || front === pid)) { answerOwnedSheet(sheets[0], pid, request); answered = sheets[0]; }
          var dialogs = infos.filter(function (info) { return info.subrole === 'AXDialog' && typeof info.document !== 'string'; });
          if (step === 'none' && !answeredDialog && dialogs.length === 1 && (front === request.front || front === pid)) {
            answerOwnedDialog(dialogs[0].element, pid, request); answeredDialog = true;
          }
        }
      }
      delay(0.1);
    }
    return report('Excel normal exit unconfirmed; retaining fixture and lock');
  } catch (error) { return report(String(error.message || error)); }
}
function run(argv) {
  try {
    var request = JSON.parse(argv[0]);
    var running = array($.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.microsoft.Excel'));
    var front = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
    if (request.op === 'preflight') {
      if (running.length) throw new Error('Excel is already running; no fixture opened');
      return JSON.stringify(Object.assign({ ok: true, front: front }, pointerState()));
    }
    if (!/^\/private\/tmp\/sleight-xl1-[A-Za-z0-9]+\/XL1-[A-E]-[1-3]\.xlsx$/.test(request.path || '') ||
      !Number.isFinite(request.started) || !Number.isInteger(request.front)) throw new Error('Invalid owned fixture receipt');
    if (!running.length) {
      if (request.op === 'bind') return JSON.stringify({ ok: true });
      if (request.op === 'quit' && request.pid) return JSON.stringify({ ok: true, exited: true, pointerRestored: restorePointer(request) });
      throw new Error('Owned process disappeared before binding');
    }
    if (running.length !== 1) throw new Error('Ambiguous Excel processes');
    var target = running[0], pid = Number(target.processIdentifier), birth = Number(target.launchDate.timeIntervalSince1970) * 1000;
    if (birth < request.started || (request.pid && (pid !== request.pid || birth !== request.birth))) throw new Error('Process incarnation changed');
    // Cleanup runs even after a foreground change; only its sheet answer is gated on the foreground.
    if (request.op === 'quit') {
      if (!request.pid) throw new Error('Owned process unbound; quit refused');
      return JSON.stringify(quit(target, pid, request));
    }
    if (front !== request.front) throw new Error('Foreground changed; no input sent');
    if (request.op === 'bind') return JSON.stringify({ ok: true, pid: pid, birth: birth });
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission requested');
    var app = $.AXUIElementCreateApplication(pid), infos = windowInfos(app);
    var choice = chooseOwnedWindow(infos, request.path, true);
    if (choice.index === undefined) return JSON.stringify({ ok: false, error: choice.error, windows: choice.windows });
    var root = infos[choice.index].element;
    var attached = array(attribute(root, 'AXSheets', true));
    if (attached.length && !(request.op === 'verify' && request.allowRenameSheet === true && attached.length === 1))
      throw new Error('Unexpected app sheet; no input sent');
    if (request.op === 'verify' || request.op === 'sample') return JSON.stringify(Object.assign({ ok: true, pid: pid, birth: birth }, pointerState()));
    if (request.op === 'balance') {
      var location = $.CGEventGetLocation($.CGEventCreate(null));
      var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, location, $.kCGMouseButtonLeft);
      if (!up) throw new Error('Cannot create balancing leftMouseUp'); // a JXA CGEventRef has no isNil (18:31Z)
      $.CGEventPostToPid(pid, up);
      return JSON.stringify({ ok: true });
    }
    if (request.op === 'park') {
      var point = $.CGEventGetLocation($.CGEventCreate(null));
      if (Number($.CGWarpMouseCursorPosition($.CGPointMake(0, point.y))) !== 0) throw new Error('Pointer park failed');
      return JSON.stringify({ ok: true });
    }
    throw new Error('Unknown fixture operation');
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}
