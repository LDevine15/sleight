// Quits one Electron editor instance this run launched, by pid, with native AppKit and AX calls only: no Apple events
// (LAWS: an Apple event to an app without an Automation grant raised a macOS prompt for Excel, 2026-10-17).
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

var DONT_SAVE = ["Don't Save", 'Don’t Save'];

// request: { pid, bundle, appPath, waitMs }. api: running(pid) -> null | { pid, bundle, path, terminate(), forceTerminate() },
// dontSave(pid) -> buttons, press(button). clock: now(), wait(ms), emit(value).
function quitElectron(request, api, clock) {
  var pid = Number(request.pid), started = clock.now(), waitMs = request.waitMs > 0 ? request.waitMs : 20000;
  var accepted = false, presses = 0, forced = false;
  if (!(pid > 0) || !request.bundle || !request.appPath) throw new Error('Invalid editor quit request');
  function identity(target) {
    var actual = target.pid === -1 ? pid : target.pid;
    // A reused pid belongs to some other program, and the owner's own instance has a different pid: never quit either.
    if (actual !== pid || target.bundle !== request.bundle || target.path !== request.appPath ||
        request.launchedAtMs !== undefined && target.launchedAtMs !== request.launchedAtMs) {
      throw new Error('Launched editor identity changed; quit refused (pid ' + actual + ', bundle ' + target.bundle + ')');
    }
  }
  function done(reason) {
    var receipt = { stage: 'quit', reason: reason, accepted: accepted, presses: presses, forced: forced, elapsedMs: clock.now() - started };
    clock.emit(receipt);
    return receipt;
  }
  var target = api.running(pid);
  if (!target) return done('already-exited');
  identity(target);
  accepted = !!target.terminate();
  while (clock.now() - started < waitMs) {
    target = api.running(pid);
    if (!target) return done('exited');
    identity(target);
    // The fixture profile is throwaway, so its own Don't Save sheet is answered. Anything else waits for the forced end.
    var buttons = api.dontSave(pid);
    if (buttons.length === 1 && presses < 3) { api.press(buttons[0]); presses++; }
    clock.wait(100);
  }
  target = api.running(pid);
  if (!target) return done('exited');
  identity(target);
  forced = true;
  target.forceTerminate();
  var forcedAt = clock.now();
  while (clock.now() - forcedAt < 5000) {
    target = api.running(pid);
    if (!target) return done('force-terminated');
    identity(target);
    clock.wait(100);
  }
  done('deadline');
  throw new Error('Launched editor still running five seconds after force termination');
}

// Readiness is one ordinary window of this pid, read from the window server (no AX, no window titles).
function waitReady(request, api, clock) {
  var pid = Number(request.pid), started = clock.now(), waitMs = request.waitMs > 0 ? request.waitMs : 30000;
  if (!(pid > 0) || !request.bundle || !request.appPath) throw new Error('Invalid editor readiness request');
  while (true) {
    var target = api.running(pid);
    if (!target) throw new Error('Launched editor exited before its window opened');
    if ((target.pid === -1 ? pid : target.pid) !== pid || target.bundle !== request.bundle || target.path !== request.appPath) {
      throw new Error('Launched editor identity changed before readiness');
    }
    var windows = api.windowCount(pid);
    if (windows > 0) { var receipt = { stage: 'ready', windows: windows, elapsedMs: clock.now() - started }; clock.emit(receipt); return receipt; }
    if (clock.now() - started >= waitMs) throw new Error('Launched editor window did not open within ' + Math.round(waitMs / 1000) + ' seconds');
    clock.wait(200);
  }
}

function nativeElectron() {
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
  function buttons(element, depth, found) {
    if (text(element, 'AXRole') === 'AXButton' && DONT_SAVE.indexOf(text(element, 'AXTitle')) !== -1) found.push(element);
    if (depth > 0) list(element, 'AXChildren').forEach(function (child) { buttons(child, depth - 1, found); });
    return found;
  }
  function describe(app) {
    var url = app.bundleURL;
    return { pid: Number(app.processIdentifier), bundle: unwrap(app.bundleIdentifier),
      path: url && !url.isNil() ? unwrap(url.URLByResolvingSymlinksInPath.path) : '',
      launchedAtMs: app.launchDate && !app.launchDate.isNil() ? Number(app.launchDate.timeIntervalSince1970) * 1000 : null,
      terminate: function () { return !!app.terminate; }, forceTerminate: function () { return !!app.forceTerminate; } };
  }
  return {
    launch: function (request) {
      var workspace = $.NSWorkspace.sharedWorkspace, url = workspace.URLForApplicationWithBundleIdentifier(request.bundle);
      if (!url || url.isNil()) throw new Error('Fixture app not installed');
      var error = Ref();
      // A new instance gives this request its own returned process even if another instance races startup.
      var app = workspace.launchApplicationAtURLOptionsConfigurationError(url,
        $.NSWorkspaceLaunchWithoutActivation | $.NSWorkspaceLaunchNewInstance,
        $({ NSWorkspaceLaunchConfigurationArguments: request.target ? [request.target] : [] }), error);
      if (!app || app.isNil()) throw new Error('Fixture app launch failed');
      return describe(app);
    },
    table: function (bundle) {
      var apps = $.NSWorkspace.sharedWorkspace.runningApplications, found = [];
      for (var i = 0; i < apps.count; i++) {
        var app = apps.objectAtIndex(i);
        if (unwrap(app.bundleIdentifier) !== bundle) continue;
        var target = this.running(Number(app.processIdentifier));
        if (target) found.push({ pid: target.pid, bundle: target.bundle, path: target.path, launchedAtMs: target.launchedAtMs });
      }
      return found;
    },
    running: function (pid) {
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (app.isNil() || app.isTerminated) return null;
      return describe(app);
    },
    // Sheets and dialogs of this pid's own windows only. Without Accessibility there is nothing to press, and the wait ends forced.
    dontSave: function (pid) {
      if (!$.AXIsProcessTrusted()) return [];
      var found = [];
      list($.AXUIElementCreateApplication(pid), 'AXWindows').forEach(function (window) {
        if (text(window, 'AXSubrole') === 'AXDialog') buttons(window, 6, found);
        list(window, 'AXChildren').forEach(function (child) { if (text(child, 'AXRole') === 'AXSheet') buttons(child, 6, found); });
      });
      return found;
    },
    press: function (button) { $.AXUIElementPerformAction(button, $('AXPress')); },
    windowCount: function (pid) {
      var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
      if (!raw || (raw.isNil && raw.isNil())) throw new Error('Window inventory unavailable');
      return ObjC.deepUnwrap(ObjC.castRefToObject(raw)).filter(function (window) {
        return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
      }).length;
    },
  };
}

function waitSeconds(seconds) {
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(seconds);
  $.NSRunLoop.mainRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, deadline);
  var remaining = Number(deadline.timeIntervalSinceNow);
  if (remaining > 0) $.NSThread.sleepForTimeInterval(remaining);
}

function run(argv) {
  var request = JSON.parse(argv[0]);
  if (['quit', 'ready', 'table', 'launch'].indexOf(request.mode) === -1) throw new Error('Invalid editor request');
  var allowed = ['com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'org.mozilla.firefox'];
  if (allowed.indexOf(request.bundle) === -1) throw new Error('Invalid editor quit request');
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  if (request.mode === 'launch') {
    out.writeData($(JSON.stringify({ stage: 'launch', process: nativeElectron().launch(request) }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    return '';
  }
  if (request.mode === 'table') {
    out.writeData($(JSON.stringify({ stage: 'table', processes: nativeElectron().table(request.bundle) }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    return '';
  }
  (request.mode === 'ready' ? waitReady : quitElectron)(request, nativeElectron(), {
    now: function () { return Date.now(); }, wait: function (ms) { waitSeconds(ms / 1000); },
    emit: function (value) { out.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); },
  });
  return '';
}
