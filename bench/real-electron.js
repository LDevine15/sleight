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

// Same native struct bridge as the product's electron-windows.js; Ref('CGPoint') does not read back reliably.
function axPair(value, type) {
  var bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  var boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  var pair = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [pair.x, pair.y] : [pair.width, pair.height];
}

var DONT_SAVE = ["Don't Save", 'Don’t Save'];

// The expected bundle path in the same form running() reports. NSURL symlink resolution drops a leading /private
// from an existing path, so a copy under realpath('/tmp') (/private/tmp/...) comes back as /tmp/... (2026-10-22 relaunch).
// Both sides resolve to the same existing file; a different bundle still differs.
function expectedPath(request, api) {
  return typeof api.canonicalPath === 'function' ? api.canonicalPath(request.appPath) : request.appPath;
}

// How long a live pid may stay without a LaunchServices bundle id before its Quit is refused.
var REGISTRATION_WAIT_MS = 5000;

// request: { pid, bundle, appPath, waitMs, pidBirth? }. api: running(pid) -> null | { pid, bundle, path, pidBirth, terminate(),
// forceTerminate() }, dontSave(pid) -> buttons, press(button). clock: now(), wait(ms), emit(value).
// An entry with an empty bundle id and no path is the same pid not (yet, or no longer) registered with LaunchServices:
// 2026-10-22 03:00Z, VS Code's entry lost its bundle id 0.2 s into its own exit, after terminate was accepted. It is never a
// different identity, and never acted on unless its kernel birth equals the one a fully matching read pinned.
function quitElectron(request, api, clock) {
  var pid = Number(request.pid), started = clock.now(), waitMs = request.waitMs > 0 ? request.waitMs : 20000;
  var accepted = false, presses = 0, forced = false, unregisteredReads = 0, pinned = null;
  if (!(pid > 0) || !request.bundle || !request.appPath) throw new Error('Invalid editor quit request');
  var appPath = expectedPath(request, api);
  function refuse(actual, field) {
    throw new Error('Launched editor identity changed; quit refused (pid ' + actual + ', ' + field + ')');
  }
  // 'same' (every field matches), or 'unregistered' (empty bundle id, same pid, no conflicting birth). Anything else throws.
  function identity(target) {
    var actual = target.pid === -1 ? pid : target.pid, birth = typeof target.pidBirth === 'string' && target.pidBirth ? target.pidBirth : null;
    // A reused pid belongs to some other program, and the owner's own instance has a different pid: never quit either.
    if (actual !== pid) refuse(actual, 'pid');
    if (birth && (request.pidBirth !== undefined && birth !== request.pidBirth || pinned && birth !== pinned)) refuse(actual, 'birth');
    if (!target.bundle) {
      if (target.path && target.path !== appPath) refuse(actual, 'path');
      unregisteredReads++;
      return 'unregistered';
    }
    if (target.bundle !== request.bundle) refuse(actual, 'bundle');
    if (target.path !== appPath) refuse(actual, 'path');
    if (request.launchedAtMs !== undefined && target.launchedAtMs !== request.launchedAtMs) refuse(actual, 'launch date');
    if (request.pidBirth !== undefined && birth !== request.pidBirth) refuse(actual, 'birth');
    if (birth) pinned = birth;
    return 'same';
  }
  // An action on an unregistered entry needs the birth a fully matching read pinned.
  function actionable(target) {
    var kind = identity(target);
    return kind === 'same' || !!pinned && target.pidBirth === pinned;
  }
  function done(reason) {
    var receipt = { stage: 'quit', reason: reason, accepted: accepted, presses: presses, forced: forced, elapsedMs: clock.now() - started,
      unregisteredReads: unregisteredReads };
    clock.emit(receipt);
    return receipt;
  }
  var target = api.running(pid);
  if (!target) return done('already-exited');
  // Before the Quit: a live pid without its bundle id yet is waited for, boundedly, and only a full match is terminated.
  var registrationWait = Math.min(waitMs, REGISTRATION_WAIT_MS);
  while (identity(target) !== 'same') {
    if (clock.now() - started >= registrationWait)
      throw new Error('Launched editor not registered; quit refused (pid ' + pid + ', no bundle id after ' + Math.round(registrationWait / 1000) + ' seconds)');
    clock.wait(100);
    target = api.running(pid);
    if (!target) return done('already-exited');
  }
  accepted = !!target.terminate();
  while (clock.now() - started < waitMs) {
    target = api.running(pid);
    if (!target) return done('exited');
    // The fixture profile is throwaway, so its own Don't Save sheet is answered. Anything else waits for the forced end.
    if (identity(target) === 'same') {
      var buttons = api.dontSave(pid);
      if (buttons.length === 1 && presses < 3) { api.press(buttons[0]); presses++; }
    }
    clock.wait(100);
  }
  target = api.running(pid);
  if (!target) return done('exited');
  if (!actionable(target)) throw new Error('Launched editor not registered and its birth unproved; force quit refused (pid ' + pid + ')');
  if (request.allowForce === false) throw new Error('FIXTURE_NORMAL_QUIT_UNCONFIRMED');
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
  var appPath = expectedPath(request, api);
  while (true) {
    var target = api.running(pid);
    if (!target) throw new Error('Launched editor exited before its window opened');
    // The field that differed is a fixed name, so the receipt says which check refused without carrying the path.
    // A live pid with no bundle id yet is not ready and not another app: it is polled like a missing window.
    var unregistered = !target.bundle && !target.path;
    var changed = (target.pid === -1 ? pid : target.pid) !== pid ? 'pid' :
      request.pidBirth !== undefined && target.pidBirth && target.pidBirth !== request.pidBirth ? 'birth' : unregistered ? '' :
      target.bundle !== request.bundle ? 'bundle' : target.path !== appPath ? 'path' : request.pidBirth !== undefined && target.pidBirth !== request.pidBirth ? 'birth' : '';
    if (changed) throw new Error('Launched editor identity changed before readiness (' + changed + ')');
    var windows = unregistered ? 0 : api.windowCount(pid);
    if (windows > 0) { var receipt = { stage: 'ready', windows: windows, elapsedMs: clock.now() - started }; clock.emit(receipt); return receipt; }
    if (clock.now() - started >= waitMs) throw new Error(unregistered ? 'Launched editor not registered within ' + Math.round(waitMs / 1000) + ' seconds'
      : 'Launched editor window did not open within ' + Math.round(waitMs / 1000) + ' seconds');
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
  var appPath = expectedPath(request, api);
  function identity() {
    var target = api.running(pid);
    if (!target || target.pid !== pid || target.pidBirth !== request.pidBirth ||
        target.bundle !== request.bundle || target.path !== appPath) throw new Error('WINDOW_SETUP_IDENTITY_CHANGED');
  }
  function deadline() {
    if (clock.now() - started >= waitMs) throw new Error('WINDOW_SETUP_TIMEOUT');
  }
  function reportCensus(phase, reason, values, original) {
    clock.emit({ stage: 'new-window-failure', census: { phase: phase, reason: reason,
      count: Array.isArray(values) ? Math.min(values.length, 65) : null,
      originalPresent: original === undefined || !Array.isArray(values) ? null : values.indexOf(original) !== -1 } });
  }
  function censusFailure(phase, reason, values, original) {
    reportCensus(phase, reason, values, original);
    throw new Error('WINDOW_SETUP_WINDOW_CHANGED');
  }
  function ids(phase, original, allowUnavailable) {
    var values;
    try { values = api.windowIds(pid, request.pidBirth); }
    catch (error) {
      if (error && error.message === 'WINDOW_SETUP_IDENTITY_CHANGED') throw error;
      if (allowUnavailable) return null;
      censusFailure(phase, 'unavailable', null, original);
    }
    if (values == null && allowUnavailable) return null;
    if (!Array.isArray(values)) censusFailure(phase, 'unavailable', null, original);
    if (values.some(function (id) { return !(id > 0 && id % 1 === 0); })) censusFailure(phase, 'invalid', values, original);
    if (values.some(function (id, i) { return values.indexOf(id) !== i; })) censusFailure(phase, 'duplicate', values, original);
    if (values.length < 1 || values.length > 2) censusFailure(phase, 'count', values, original);
    return values;
  }
  identity();
  deadline();
  if (!api.trusted()) throw new Error('WINDOW_SETUP_ACCESSIBILITY');
  var before = ids('initial');
  function done(values, created) {
    deadline(); identity(); deadline();
    var receipt = { stage: 'new-window', created: created, windows: values, elapsedMs: clock.now() - started };
    clock.emit(receipt); return receipt;
  }
  if (before.length === 2) return done(before, false);
  deadline();
  // One exact File item or nothing. The census holds counts and fixed enums only and runs after the refusal is decided.
  function menuFailure(phase, reason, values, owner) {
    var census = null;
    try { census = api.menuCensus ? api.menuCensus(pid, owner) : null; } catch (_) { census = null; }
    clock.emit({ stage: 'new-window-failure', menu: { phase: phase, reason: reason,
      count: Math.min(values.length, 65), elapsedMs: Math.max(0, Math.min(clock.now() - started, waitMs)), census: census } });
    throw new Error('WINDOW_SETUP_MENU_AMBIGUOUS');
  }
  var files = api.fileMenus(pid);
  // Zero may be a transient AX read (menu bar not answering yet). Poll only reads, re-prove identity each round,
  // and never act on more than one. Two or more is final at once.
  while (!files.length && clock.now() - started < Math.min(waitMs, 1000)) {
    clock.wait(50); deadline(); identity(); deadline(); files = api.fileMenus(pid);
  }
  deadline();
  if (files.length !== 1) menuFailure('file-menu', files.length ? 'multiple' : 'none', files);
  deadline(); identity(); deadline(); menu = files[0];
  try {
    if (!api.press(menu)) throw new Error('WINDOW_SETUP_PRESS_FAILED');
    deadline();
    var items = api.newWindowItems(menu);
    while (!items.length && clock.now() - started < Math.min(waitMs, 1000)) {
      clock.wait(50); deadline(); identity(); deadline(); items = api.newWindowItems(menu);
    }
    deadline();
    if (items.length !== 1) menuFailure('new-window-item', items.length ? 'multiple' : 'none', items, menu);
    identity(); deadline();
    if (!api.press(items[0])) throw new Error('WINDOW_SETUP_PRESS_FAILED');
    deadline();
    var unavailable = false;
    function pollDeadline() {
      if (unavailable && clock.now() - started >= waitMs) reportCensus('after-new-window', 'unavailable', null, before[0]);
      deadline();
    }
    for (;;) {
      pollDeadline(); identity(); pollDeadline();
      // The one menu action may briefly leave AX/CG metadata unavailable while the new window opens.
      // Poll only reads; a fresh valid census must still prove both unique IDs and the original window.
      var after = ids('after-new-window', before[0], true);
      unavailable = after === null;
      pollDeadline();
      if (after) {
        if (after.indexOf(before[0]) === -1) censusFailure('after-new-window', 'original-missing', after, before[0]);
        if (after.length === 2) break;
      }
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
  // An attribute read that keeps the AX status as a fixed enum, so "no menu bar" and "AX refused" stay apart.
  function statusClass(status) {
    return status === 0 ? 'ok' : status === -25212 ? 'no-value' : status === -25204 ? 'cannot-complete' :
      status === -25211 ? 'api-disabled' : status === -25205 ? 'unsupported' : status === -25202 ? 'invalid-element' : 'other';
  }
  function read(element, name) {
    var value = Ref(), status = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
    return { status: statusClass(status), value: status === 0 ? ObjC.castRefToObject(value[0]) : null };
  }
  function listOf(array) { var items = []; for (var i = 0; i < Number(array.count); i++) items.push(array.objectAtIndex(i)); return items; }
  // AXEnabled is absent on some items, which counts as enabled; only an explicit false disables.
  function enabled(element) { var got = read(element, 'AXEnabled'); if (got.status !== 'ok') return true; var plain = ObjC.unwrap(got.value); return plain !== false && plain !== 0; }
  function buttons(element, depth, found) {
    if (text(element, 'AXRole') === 'AXButton' && DONT_SAVE.indexOf(text(element, 'AXTitle')) !== -1) found.push(element);
    if (depth > 0) list(element, 'AXChildren').forEach(function (child) { buttons(child, depth - 1, found); });
    return found;
  }
  function resolved(url) { return url && !url.isNil() ? unwrap(url.URLByResolvingSymlinksInPath.path) : ''; }
  function describe(app) {
    return { pid: Number(app.processIdentifier), bundle: unwrap(app.bundleIdentifier),
      path: resolved(app.bundleURL),
      launchedAtMs: app.launchDate && !app.launchDate.isNil() ? Number(app.launchDate.timeIntervalSince1970) * 1000 : null,
      pidBirth: processBirth(Number(app.processIdentifier)),
      terminate: function () { return !!app.terminate; }, forceTerminate: function () { return !!app.forceTerminate; } };
  }
  return {
    // The same resolution describe() applies to bundleURL, for the request's expected path.
    canonicalPath: function (path) { return resolved($.NSURL.fileURLWithPath(path)); },
    trusted: function () { return !!$.AXIsProcessTrusted(); },
    // Exact identity: this process's own menu bar, role AXMenuBarItem, title exactly "File", enabled.
    // The element comes from AXUIElementCreateApplication(pid), so the owning process is fixed by construction.
    fileMenus: function (pid) {
      var bar = attribute($.AXUIElementCreateApplication(pid), 'AXMenuBar');
      return bar ? list(bar, 'AXChildren').filter(function (item) {
        return text(item, 'AXRole') === 'AXMenuBarItem' && text(item, 'AXTitle') === 'File' && enabled(item);
      }) : [];
    },
    // Exact identity: AXMenuItem titled exactly "New Window", enabled, a direct item of this File item's own AXMenu.
    // Submenus are never entered, so "New Window with Profile" children cannot match.
    newWindowItems: function (menu) {
      var found = [];
      list(menu, 'AXChildren').forEach(function (popup) {
        if (text(popup, 'AXRole') !== 'AXMenu') return;
        list(popup, 'AXChildren').forEach(function (item) {
          if (text(item, 'AXRole') === 'AXMenuItem' && text(item, 'AXTitle') === 'New Window' && enabled(item)) found.push(item);
        });
      });
      return found;
    },
    // Failure-only diagnostics: counts, booleans and fixed enums. No title, path or document text leaves this function.
    menuCensus: function (pid, menu) {
      var bar = read($.AXUIElementCreateApplication(pid), 'AXMenuBar'), out = { barStatus: bar.status, bar: null, popup: null };
      if (bar.value) {
        var kids = read(bar.value, 'AXChildren'), rows = kids.value ? listOf(kids.value) : [];
        var exact = 0, fileLike = 0, disabledExact = 0, items = 0;
        rows.forEach(function (row) {
          if (text(row, 'AXRole') !== 'AXMenuBarItem') return;
          items++; var title = text(row, 'AXTitle');
          if (title === 'File') { exact++; if (!enabled(row)) disabledExact++; }
          else if (/file/i.test(title)) fileLike++;
        });
        out.bar = { childrenStatus: kids.status, children: Math.min(rows.length, 65), menuBarItems: Math.min(items, 65),
          exactFile: Math.min(exact, 65), disabledExactFile: Math.min(disabledExact, 65), fileLike: Math.min(fileLike, 65) };
      }
      if (menu) {
        var popups = read(menu, 'AXChildren'), pops = popups.value ? listOf(popups.value) : [];
        var menus = 0, rowsTotal = 0, exactNew = 0, disabledNew = 0, prefixed = 0, separators = 0, cmdN = 0, status = 'ok';
        pops.forEach(function (popup) {
          if (text(popup, 'AXRole') !== 'AXMenu') return;
          menus++; var children = read(popup, 'AXChildren'); if (children.status !== 'ok') status = children.status;
          (children.value ? listOf(children.value) : []).forEach(function (item) {
            rowsTotal++; var role = text(item, 'AXRole'), title = text(item, 'AXTitle');
            if (role !== 'AXMenuItem') return;
            if (title === 'New Window') { exactNew++; if (!enabled(item)) disabledNew++; if (text(item, 'AXMenuItemCmdChar').toLowerCase() === 'n') cmdN++; }
            else if (title.indexOf('New Window') === 0) prefixed++;
            else if (title === '') separators++;
          });
        });
        out.popup = { childrenStatus: popups.status, popupStatus: status, popups: Math.min(menus, 65), rows: Math.min(rowsTotal, 65),
          exactNewWindow: Math.min(exactNew, 65), disabledExactNewWindow: Math.min(disabledNew, 65),
          newWindowPrefixed: Math.min(prefixed, 65), untitled: Math.min(separators, 65), exactWithCmdN: Math.min(cmdN, 65) };
      }
      return out;
    },
    cancelMenu: function (menu) { try { $.AXUIElementPerformAction(menu, $('AXCancel')); } catch (_) {} },
    windowIds: function (pid, expectedBirth) {
      function invalid() { throw new Error('WINDOW_SETUP_CENSUS_INVALID'); }
      if (processBirth(pid) !== expectedBirth) throw new Error('WINDOW_SETUP_IDENTITY_CHANGED');
      if (!$.AXIsProcessTrusted()) invalid();
      var app = $.AXUIElementCreateApplication(pid);
      if (Number($.AXUIElementSetMessagingTimeout(app, 0.1)) !== 0) invalid();
      function strictAttribute(element, name, optional) {
        var value = Ref(), status = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
        if (optional && (status === -25205 || status === -25212)) return null;
        if (status !== 0) invalid();
        return ObjC.castRefToObject(value[0]);
      }
      function scalar(value) { return value === null ? null : ObjC.deepUnwrap(value); }
      // CG also lists Electron utility surfaces at layer zero. Only a standard AX document window
      // with one unique matching CG rectangle may contribute an ID, as in the product's window reader.
      var windows = strictAttribute(app, 'AXWindows'), count = windows && Number(windows.count);
      if (!(count > 0 && count <= 64 && count % 1 === 0)) invalid();
      var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
      if (!raw || (raw.isNil && raw.isNil())) invalid();
      var all = ObjC.deepUnwrap(ObjC.castRefToObject(raw));
      if (!Array.isArray(all) || all.length > 8192) invalid();
      var cg = all.filter(function (window) {
        return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
      });
      if (cg.length > 256) invalid();
      var cgIds = [], ids = [];
      cg.forEach(function (window) {
        var id = Number(window.kCGWindowNumber);
        if (!(id > 0 && id <= 2147483647 && id % 1 === 0) || cgIds.indexOf(id) !== -1) invalid();
        cgIds.push(id);
      });
      for (var i = 0; i < count; i++) {
        var window = windows.objectAtIndex(i);
        if (scalar(strictAttribute(window, 'AXRole')) !== 'AXWindow' ||
            scalar(strictAttribute(window, 'AXSubrole')) !== 'AXStandardWindow') invalid();
        var modal = scalar(strictAttribute(window, 'AXModal', true));
        if (modal !== null && modal !== false) invalid();
        var position = strictAttribute(window, 'AXPosition'), size = strictAttribute(window, 'AXSize');
        var point = position && axPair(position, 1), extent = size && axPair(size, 2);
        var frame = point && extent && [point[0], point[1], extent[0], extent[1]];
        if (!frame || frame.some(function (value) { return !Number.isFinite(value) || Math.abs(value) > 1000000; }) || frame[2] <= 0 || frame[3] <= 0) invalid();
        var found = cg.filter(function (info) {
          return ['X', 'Y', 'Width', 'Height'].every(function (key, k) {
            var value = info.kCGWindowBounds && info.kCGWindowBounds[key];
            return Number.isFinite(value) && Math.abs(value - frame[k]) < 0.5;
          });
        });
        // Unlike the general reader, setup may not omit an ambiguous or unnumbered AX document:
        // doing so could hide a third real document and weaken the exact two-window precondition.
        if (found.length !== 1) invalid();
        var id = Number(found[0].kCGWindowNumber);
        if (ids.indexOf(id) !== -1) invalid();
        ids.push(id);
      }
      if (processBirth(pid) !== expectedBirth) throw new Error('WINDOW_SETUP_IDENTITY_CHANGED');
      return ids;
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
  if (['quit', 'ready', 'table', 'launch', 'new-window', 'births'].indexOf(request.mode) === -1) throw new Error('Invalid editor request');
  var allowed = ['com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'org.mozilla.firefox'];
  if (allowed.indexOf(request.bundle) === -1) throw new Error('Invalid editor quit request');
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  if (request.mode === 'births') {
    if (!Array.isArray(request.pids) || !request.pids.length || request.pids.length > 64 || request.pids.some(function (pid, index) {
      return !(pid > 0 && pid <= 2147483647 && pid % 1 === 0) || request.pids.indexOf(pid) !== index;
    })) throw new Error('Invalid process birth request');
    out.writeData($(JSON.stringify({ stage: 'births', processes: request.pids.map(function (pid) {
      return { pid: pid, pidBirth: processBirth(pid) };
    }) }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    return '';
  }
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
