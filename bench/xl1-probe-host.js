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
    hidLeftDown: !!$.CGEventSourceButtonState($.kCGEventSourceStateHIDSystemState, $.kCGMouseButtonLeft),
    privateLeftDown: !!$.CGEventSourceButtonState($.kCGEventSourceStatePrivate, $.kCGMouseButtonLeft) };
}
function cleanupSheetStep(sheets, answeredSheet, same) {
  if (!sheets.length) return 'none';
  if (sheets.length !== 1 || answeredSheet && !same(sheets[0], answeredSheet)) throw new Error('Unexpected cleanup sheet');
  return answeredSheet ? 'wait' : 'answer';
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
      if (request.op === 'quit' && request.pid) return JSON.stringify({ ok: true, exited: true, pointerRestored: restorePointer() });
      throw new Error('Owned process disappeared before binding');
    }
    if (running.length !== 1) throw new Error('Ambiguous Excel processes');
    var target = running[0], pid = Number(target.processIdentifier), birth = Number(target.launchDate.timeIntervalSince1970) * 1000;
    if (birth < request.started || (request.pid && (pid !== request.pid || birth !== request.birth))) throw new Error('Process incarnation changed');
    if (front !== request.front) throw new Error('Foreground changed; no input sent');
    if (request.op === 'bind') return JSON.stringify({ ok: true, pid: pid, birth: birth });
    if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission requested');
    var app = $.AXUIElementCreateApplication(pid), windows = array(attribute(app, 'AXWindows'));
    // Ignore only the system's capture indicator, never an app dialog.
    windows = windows.filter(function (window) {
      var children = array(attribute(window, 'AXChildren', true));
      return !(children.length === 1 && scalar(attribute(children[0], 'AXTitle', true)) === 'WindowSharingSessionButton');
    });
    if (windows.length !== 1) throw new Error('Foreign or ambiguous app window; no input sent');
    var root = windows[0], url = scalar(attribute(root, 'AXDocument', true));
    var expected = ObjC.unwrap($.NSURL.fileURLWithPath(request.path).absoluteString);
    var normalize = function (value) { return String(value).replace('file:///private/var/', 'file:///var/'); };
    if (normalize(url) !== normalize(expected)) throw new Error('Owned workbook URL changed');
    var attached = array(attribute(root, 'AXSheets', true));
    if (attached.length && !(request.op === 'verify' && request.allowRenameSheet === true && attached.length === 1))
      throw new Error('Unexpected app sheet; no input sent');
    if (request.op === 'verify' || request.op === 'sample') return JSON.stringify(Object.assign({ ok: true, pid: pid, birth: birth }, pointerState()));
    if (request.op === 'balance') {
      var location = $.CGEventGetLocation($.CGEventCreate(null));
      var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, location, $.kCGMouseButtonLeft);
      if (!up || up.isNil()) throw new Error('Cannot create balancing leftMouseUp');
      $.CGEventPostToPid(pid, up);
      return JSON.stringify({ ok: true });
    }
    if (request.op === 'park') {
      var point = $.CGEventGetLocation($.CGEventCreate(null));
      if (Number($.CGWarpMouseCursorPosition($.CGPointMake(0, point.y))) !== 0) throw new Error('Pointer park failed');
      return JSON.stringify({ ok: true });
    }
    function restorePointer() {
      if (!request.pointer || !Number.isFinite(request.pointer.x) || !Number.isFinite(request.pointer.y)) return false;
      if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== request.front) return false;
      return Number($.CGWarpMouseCursorPosition($.CGPointMake(request.pointer.x, request.pointer.y))) === 0;
    }
    if (request.op !== 'quit') throw new Error('Unknown fixture operation');
    if (!target.terminate) throw new Error('Normal quit refused');
    var deadline = Date.now() + 30000, answeredSheet = null;
    while (Date.now() < deadline) {
      var current = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (current.isNil() || current.isTerminated) return JSON.stringify({ ok: true, exited: true, pointerRestored: restorePointer() });
      if (Number(current.launchDate.timeIntervalSince1970) * 1000 !== request.birth || ObjC.unwrap(current.bundleIdentifier) !== 'com.microsoft.Excel')
        throw new Error('Quit process identity changed');
      if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== request.front) throw new Error('Foreground changed during cleanup');
      var sheets = array(attribute(root, 'AXSheets', true));
      var step = cleanupSheetStep(sheets, answeredSheet, function (a, b) { return !!$.CFEqual(a, b); });
      if (step === 'answer') {
        var labels = [], walk = function (node, depth) {
          if (depth > 10 || labels.length > 300) throw new Error('Cleanup sheet budget exceeded');
          var title = scalar(attribute(node, 'AXTitle', true)), value = scalar(attribute(node, 'AXValue', true));
          if (typeof title === 'string') labels.push(title);
          if (typeof value === 'string') labels.push(value);
          array(attribute(node, 'AXChildren', true)).forEach(function (child) { walk(child, depth + 1); });
        };
        walk(sheets[0], 0);
        var stem = request.path.split('/').pop().replace(/\.xlsx$/, '');
        if (!labels.some(function (label) { return label.indexOf(stem) >= 0; }) ||
          !labels.some(function (label) { return /^(?:Don't Save|Don’t Save)$/.test(label); })) throw new Error('Owned Don\'t Save sheet unproved');
        // Only this owned process's own Don't Save sheet, through the already-authorized System Events path.
        var se = Application('System Events'), processes = se.processes.whose({ unixId: pid })();
        if (processes.length !== 1) throw new Error('System Events process identity ambiguous');
        var candidates = [];
        processes[0].windows().forEach(function (window) {
          window.sheets().forEach(function (sheet) {
            sheet.buttons().forEach(function (button) { if (/^(?:Don't Save|Don’t Save)$/.test(button.name())) candidates.push(button); });
          });
        });
        if (candidates.length !== 1) throw new Error('System Events Don\'t Save target ambiguous');
        candidates[0].click(); answeredSheet = sheets[0];
      }
      delay(0.1);
    }
    throw new Error('Excel normal exit unconfirmed; retaining fixture and lock');
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}
