// Native helper for bench/electron-qualification.mjs: AppKit, CoreGraphics and AX only, never an Apple event.
// sample: frontmost pid and pointer every intervalMs, one JSON line each, until durationMs or the stop file exists. Read-only.
// activate: brings the given non-fixture pid forward (owner away only). front: the frontmost pid and bundle.
// owners: CG window number -> owner pid (metadata, no titles). pids: running pids of a bundle (counts the owner's instance, reads nothing of it).
// press: AXPress the one button titled `title` inside a sheet of the fixture pid's own windows (its Save As sheet's Cancel).
// The harness never uses press on a consent card or a macOS permission prompt.
// windows: the count of a pid's ordinary on-screen windows. card: where sleight's consent card is on screen, for the
// person who clicks it (the window server's bounds of the consent host's windows, and its card buttons by AX when this
// helper is trusted). Both read only.

var CARD_BUTTONS = ['Allow once', 'Allow this session', 'Always allow', 'Quit and reopen', 'Cancel', 'Review sleight request'];
// Window server rows of the given pids, bounds only (no titles).
function cardRows(list, pids) {
  return list.filter(function (w) { return pids.indexOf(Number(w.kCGWindowOwnerPID)) !== -1; }).map(function (w) {
    var b = w.kCGWindowBounds || {};
    return { pid: Number(w.kCGWindowOwnerPID), id: Number(w.kCGWindowNumber), layer: Number(w.kCGWindowLayer), onScreen: !!w.kCGWindowIsOnscreen,
      x: Math.round(Number(b.X)), y: Math.round(Number(b.Y)), width: Math.round(Number(b.Width)), height: Math.round(Number(b.Height)) };
  });
}

function sampleLoop(request, api, clock) {
  var started = clock.now(), interval = request.intervalMs > 0 ? request.intervalMs : 50;
  while (clock.now() - started < request.durationMs && !api.stopped()) {
    var point = api.pointer(), windowPids = api.windowPids();
    clock.emit({ t: clock.now(), front: api.front(), x: Math.round(point.x), y: Math.round(point.y), windowPids: windowPids });
    clock.wait(interval);
  }
}

function native(request) {
  ObjC.import('AppKit');
  ObjC.import('ApplicationServices');
  ObjC.import('CoreGraphics');
  function unwrap(value) { return value == null || (value.isNil && value.isNil()) ? '' : String(ObjC.unwrap(value)); }
  function attribute(element, name) {
    var value = Ref();
    return Number($.AXUIElementCopyAttributeValue(element, $(name), value)) === 0 ? ObjC.castRefToObject(value[0]) : null;
  }
  function list(element, name) {
    var value = attribute(element, name), items = [];
    if (value) for (var i = 0; i < Number(value.count); i++) items.push(value.objectAtIndex(i));
    return items;
  }
  function text(element, name) { var value = attribute(element, name); return value ? unwrap(value) : ''; }
  function buttons(element, title, depth, found) {
    if (text(element, 'AXRole') === 'AXButton' && text(element, 'AXTitle') === title) found.push(element);
    if (depth > 0) list(element, 'AXChildren').forEach(function (child) { buttons(child, title, depth - 1, found); });
    return found;
  }
  function windows() {
    var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
    if (!raw || (raw.isNil && raw.isNil())) throw new Error('Window inventory unavailable');
    return ObjC.deepUnwrap(ObjC.castRefToObject(raw));
  }
  return {
    front: function () { return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier); },
    frontBundle: function () { return unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier); },
    pointer: function () { return $.CGEventGetLocation($.CGEventCreate(null)); },
    windowPids: function () {
      var pids = [];
      windows().forEach(function (w) {
        var pid = Number(w.kCGWindowOwnerPID);
        if (Number(w.kCGWindowLayer) === 0 && !!w.kCGWindowIsOnscreen && pids.indexOf(pid) === -1) pids.push(pid);
      });
      return pids;
    },
    stopped: function () { return !!request.stop && $.NSFileManager.defaultManager.fileExistsAtPath($(request.stop)); },
    activate: function (pid) {
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      return !app.isNil() && !app.isTerminated && !!app.activateWithOptions(0);
    },
    owners: function (ids) {
      var map = {};
      windows().forEach(function (w) { if (ids.indexOf(Number(w.kCGWindowNumber)) !== -1) map[Number(w.kCGWindowNumber)] = Number(w.kCGWindowOwnerPID); });
      return map;
    },
    pids: function (bundle) {
      var running = $.NSWorkspace.sharedWorkspace.runningApplications, out = [];
      for (var i = 0; i < running.count; i++) { var app = running.objectAtIndex(i); if (unwrap(app.bundleIdentifier) === bundle) out.push(Number(app.processIdentifier)); }
      return out;
    },
    windowCount: function (pid) {
      return windows().filter(function (w) { return Number(w.kCGWindowOwnerPID) === pid && Number(w.kCGWindowLayer) === 0 && !!w.kCGWindowIsOnscreen; }).length;
    },
    card: function (pids) {
      var out = { windows: cardRows(windows(), pids), buttons: [], ax: !!$.AXIsProcessTrusted() };
      if (!out.ax) return out;
      function pair(value, type) {
        var bytes = $.NSMutableData.dataWithLength(16);
        if (!value || !$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
        var boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
        var s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
        return type === 1 ? [s.x, s.y] : [s.width, s.height];
      }
      function walk(element, pid, depth) {
        var title = text(element, 'AXTitle');
        if (text(element, 'AXRole') === 'AXButton' && CARD_BUTTONS.indexOf(title) !== -1) {
          var at = pair(attribute(element, 'AXPosition'), 1), size = pair(attribute(element, 'AXSize'), 2);
          if (at && size) out.buttons.push({ pid: pid, title: title, x: Math.round(at[0]), y: Math.round(at[1]), width: Math.round(size[0]), height: Math.round(size[1]) });
        }
        if (depth > 0) list(element, 'AXChildren').forEach(function (child) { walk(child, pid, depth - 1); });
      }
      pids.forEach(function (pid) { list($.AXUIElementCreateApplication(pid), 'AXWindows').forEach(function (w) { walk(w, pid, 8); }); });
      return out;
    },
    pressInSheet: function (pid, title) {
      if (!$.AXIsProcessTrusted()) return { pressed: false, reason: 'accessibility-denied' };
      var found = [];
      list($.AXUIElementCreateApplication(pid), 'AXWindows').forEach(function (window) {
        list(window, 'AXChildren').forEach(function (child) { if (text(child, 'AXRole') === 'AXSheet') buttons(child, title, 6, found); });
      });
      if (found.length !== 1) return { pressed: false, reason: 'buttons-' + found.length };
      return { pressed: Number($.AXUIElementPerformAction(found[0], $('AXPress'))) === 0 };
    },
  };
}

function run(argv) {
  var request = JSON.parse(argv[0]), api = native(request), out = $.NSFileHandle.fileHandleWithStandardOutput;
  function emit(value) { out.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  function wait(ms) {
    var deadline = $.NSDate.dateWithTimeIntervalSinceNow(ms / 1000);
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, deadline);
    var remaining = Number(deadline.timeIntervalSinceNow);
    if (remaining > 0) $.NSThread.sleepForTimeInterval(remaining);
  }
  if (request.mode === 'sample') sampleLoop(request, api, { now: function () { return Date.now(); }, wait: wait, emit: emit });
  else if (request.mode === 'front') emit({ front: api.front(), bundle: api.frontBundle() });
  else if (request.mode === 'activate') {
    if (!(request.pid > 0) || request.pid === request.fixturePid) throw new Error('Refusing to activate the fixture');
    emit({ activated: api.activate(request.pid) });
  } else if (request.mode === 'owners') emit({ owners: api.owners(request.ids.map(Number)) });
  else if (request.mode === 'pids') emit({ pids: api.pids(request.bundle) });
  else if (request.mode === 'windows') emit({ windows: api.windowCount(Number(request.pid)) });
  else if (request.mode === 'card') emit(api.card(request.pids.map(Number).filter(function (pid) { return pid > 0; })));
  else if (request.mode === 'press') {
    if (request.title !== 'Cancel') throw new Error('Only the fixture sheet\'s Cancel is pressed');
    emit(api.pressInSheet(Number(request.pid), request.title));
  } else throw new Error('Invalid qualification helper request');
  return '';
}
