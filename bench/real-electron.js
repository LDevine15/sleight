// Quits one Electron editor instance this run launched, by pid, with native AppKit and AX calls only: no Apple events
// (LAWS: an Apple event to an app without an Automation grant raised a macOS prompt for Excel, 2026-10-17).
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);

// Same PROC_PIDTBSDINFO birth format as electron-windows.js and the pipe launcher.
// AppKit launchDate is unavailable for direct posix_spawn launches.
function processBirth(pid) {
  var data = $.NSMutableData.dataWithLength(136);
  if (Number($.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136)) !== 136) return null;
  var encoded = String(ObjC.unwrap(data.base64EncodedStringWithOptions(0))).replace(/=+$/, '');
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = [], bits = 0, value = 0;
  for (var i = 0; i < encoded.length; i++) {
    value = value << 6 | alphabet.indexOf(encoded[i]); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push(value >> bits & 255); }
  }
  function u32(at) { return bytes[at] + bytes[at + 1] * Math.pow(2, 8) + bytes[at + 2] * Math.pow(2, 16) + bytes[at + 3] * Math.pow(2, 24); }
  function u64(at) { return u32(at) + u32(at + 4) * Math.pow(2, 32); }
  if (u32(12) !== pid || u32(4) === 5) return null;
  return u64(120) + '.' + String(u64(128)).padStart(6, '0');
}

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
        request.launchedAtMs !== undefined && target.launchedAtMs !== request.launchedAtMs ||
        request.pidBirth !== undefined && target.pidBirth !== request.pidBirth) {
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

// Benchmark setup only. The driver has proved this exact birth owns a canonical
// temporary profile. Recheck native identity before either menu press and every wait.
function newWindow(request, api, clock) {
  var pid = Number(request.pid), started = clock.now(), waitMs = request.waitMs;
  var root = request.profileRoot, profile = request.profile, menu;
  if (!(pid > 0) || request.bundle !== 'com.microsoft.VSCode' || !request.appPath ||
      !/^[1-9]\d*\.\d{6}$/.test(request.pidBirth || '') || !(waitMs > 0 && waitMs <= 10000) ||
      typeof root !== 'string' || root.charAt(0) !== '/' || /(?:^|\/)\.\.?(?:\/|$)|[\0\r\n]/.test(root) ||
      typeof profile !== 'string' || profile.indexOf(root + '/') !== 0 || /(?:^|\/)\.\.?(?:\/|$)|[\0\r\n]/.test(profile))
    throw new Error('WINDOW_SETUP_REQUEST');
  function identity() {
    var target = api.running(pid);
    if (!target || target.pid !== pid || target.pidBirth !== request.pidBirth ||
        target.bundle !== request.bundle || target.path !== request.appPath) throw new Error('WINDOW_SETUP_IDENTITY_CHANGED');
  }
  function deadline() {
    if (clock.now() - started >= waitMs) throw new Error('WINDOW_SETUP_TIMEOUT');
  }
  function ids() {
    var values = api.windowIds(pid);
    if (!Array.isArray(values) || values.some(function (id, i) { return !(id > 0 && id % 1 === 0) || values.indexOf(id) !== i; }) ||
        values.length < 1 || values.length > 2) throw new Error('WINDOW_SETUP_WINDOW_CHANGED');
    return values;
  }
  identity();
  deadline();
  if (!api.trusted()) throw new Error('WINDOW_SETUP_ACCESSIBILITY');
  var before = ids();
  function done(values, created) {
    deadline(); identity(); deadline();
    var receipt = { stage: 'new-window', created: created, windows: values, elapsedMs: clock.now() - started };
    clock.emit(receipt); return receipt;
  }
  if (before.length === 2) return done(before, false);
  deadline();
  var files = api.fileMenus(pid);
  if (files.length !== 1) throw new Error('WINDOW_SETUP_MENU_AMBIGUOUS');
  deadline(); identity(); deadline(); menu = files[0];
  try {
    if (!api.press(menu)) throw new Error('WINDOW_SETUP_PRESS_FAILED');
    deadline();
    var items = api.newWindowItems(menu);
    while (!items.length && clock.now() - started < Math.min(waitMs, 1000)) {
      clock.wait(50); deadline(); identity(); deadline(); items = api.newWindowItems(menu);
    }
    deadline();
    if (items.length !== 1) throw new Error('WINDOW_SETUP_MENU_AMBIGUOUS');
    identity(); deadline();
    if (!api.press(items[0])) throw new Error('WINDOW_SETUP_PRESS_FAILED');
    deadline();
    for (;;) {
      deadline(); identity(); deadline();
      var after = ids();
      deadline();
      if (after.indexOf(before[0]) === -1) throw new Error('WINDOW_SETUP_WINDOW_CHANGED');
      if (after.length === 2) break;
      clock.wait(100);
    }
  } finally {
    // A recycled PID must not receive even a menu-cleanup action.
    try { identity(); api.cancelMenu(menu); } catch (_) {}
  }
  return done(after, true);
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
      pidBirth: processBirth(Number(app.processIdentifier)),
      terminate: function () { return !!app.terminate; }, forceTerminate: function () { return !!app.forceTerminate; } };
  }
  return {
    trusted: function () { return !!$.AXIsProcessTrusted(); },
    fileMenus: function (pid) {
      var bar = attribute($.AXUIElementCreateApplication(pid), 'AXMenuBar');
      return bar ? list(bar, 'AXChildren').filter(function (item) {
        return text(item, 'AXRole') === 'AXMenuBarItem' && text(item, 'AXTitle') === 'File';
      }) : [];
    },
    newWindowItems: function (menu) {
      var found = [];
      function walk(item, depth) {
        if (text(item, 'AXRole') === 'AXMenuItem' && text(item, 'AXTitle') === 'New Window') found.push(item);
        if (depth > 0) list(item, 'AXChildren').forEach(function (child) { walk(child, depth - 1); });
      }
      walk(menu, 3); return found;
    },
    cancelMenu: function (menu) { try { $.AXUIElementPerformAction(menu, $('AXCancel')); } catch (_) {} },
    windowIds: function (pid) {
      var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
      if (!raw || (raw.isNil && raw.isNil())) throw new Error('WINDOW_SETUP_WINDOW_CHANGED');
      return ObjC.deepUnwrap(ObjC.castRefToObject(raw)).filter(function (window) {
        return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
      }).map(function (window) { return Number(window.kCGWindowNumber); });
    },
    launch: function (request) {
      var workspace = $.NSWorkspace.sharedWorkspace, url = workspace.URLForApplicationWithBundleIdentifier(request.bundle);
      // appPath: the live runner's own copy of the bundle (electron-relaunch-live.mjs), checked to carry the same bundle id.
      if (request.appPath) {
        url = $.NSURL.fileURLWithPath(request.appPath);
        var copy = $.NSBundle.bundleWithURL(url);
        if (!copy || copy.isNil() || unwrap(copy.bundleIdentifier) !== request.bundle) throw new Error('Fixture app copy is not ' + request.bundle);
      }
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
        if (target) found.push({ pid: target.pid, bundle: target.bundle, path: target.path, launchedAtMs: target.launchedAtMs, pidBirth: target.pidBirth });
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
    press: function (button) { return Number($.AXUIElementPerformAction(button, $('AXPress'))) === 0; },
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
  if (['quit', 'ready', 'table', 'launch', 'new-window'].indexOf(request.mode) === -1) throw new Error('Invalid editor request');
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
  (request.mode === 'new-window' ? newWindow : request.mode === 'ready' ? waitReady : quitElectron)(request, nativeElectron(), {
    now: function () { return Date.now(); }, wait: function (ms) { waitSeconds(ms / 1000); },
    emit: function (value) { out.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); },
  });
  return '';
}
