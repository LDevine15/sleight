// JXA uses only native AppKit and AX calls. The window reference stays in this
// process until cleanup. Recovery uses only that retained reference.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

function waitForLaunch(seconds) {
  var deadline = $.NSDate.dateWithTimeIntervalSinceNow(seconds === undefined ? 0.1 : seconds);
  $.NSRunLoop.mainRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, deadline);
  var remaining = Number(deadline.timeIntervalSinceNow);
  if (remaining > 0) $.NSThread.sleepForTimeInterval(remaining);
}

function waitForApplication(application, wait) {
  for (var attempt = 0; attempt < 100; attempt++) {
    var target = application();
    if (target && target.isFinishedLaunching) return target;
    wait();
  }
  return null;
}

function runningBundle(target) {
  var raw = target && target.bundleIdentifier;
  if (raw == null) return '';
  if (raw.isNil && raw.isNil()) return '';
  var value = typeof raw === 'string' ? raw : ObjC.unwrap(raw);
  return value == null ? '' : String(value);
}

function runningPid(target) {
  var raw = target && target.processIdentifier;
  if (raw == null) return -1;
  if (raw.isNil && raw.isNil()) return -1;
  var value = typeof raw === 'number' ? raw : Number(ObjC.unwrap(raw));
  if (typeof value !== 'number' || value !== value) return -1;
  return value;
}

function inheritReadyCondition(target, app, api, control) {
  if (!target) return null;
  // DeviceHub after open -g can run for tens of seconds with isFinishedLaunching
  // still false (2026-10-11: 34 s, one unchanged pid). A booted simulator plus
  // this live viewer process is the readiness the task can actually observe.
  if (control && control.simulatorBooted === true) return 'simulator-booted';
  var finished = !!target.isFinishedLaunching;
  var focused = !!(api.focused && api.focused(app));
  var hasWindow = !!(api.mainWindow && api.mainWindow(app));
  if (!hasWindow && api.windowCount) hasWindow = api.windowCount(app) > 0;
  if (finished && focused) return 'focused-window';
  if (finished && hasWindow) return 'window';
  return null;
}

function quitFixtureApplication(pid, bundle, application, clock) {
  var started = clock.now(), accepted = false, finishedLaunching;
  pid = Number(pid);
  function identity(target) {
    var actualPid = runningPid(target), actualBundle = runningBundle(target);
    // AppKit reports -1 once a looked-up process is exiting or the property is
    // stale. The lookup was by the launched pid, so keep that identity when the
    // bundle still matches (2026-10-11: pid -1 vs 89311, DeviceHub still up).
    if (actualPid === -1) actualPid = pid;
    finishedLaunching = !!target.isFinishedLaunching;
    // An empty identifier counts only when the process runs from the expected app's own bundle:
    // a reused PID belongs to some other program, which cleanup must never quit.
    var sameBundle = actualBundle ? actualBundle === bundle : !!(clock.sameApp && clock.sameApp(target, bundle));
    if (actualPid !== pid || !sameBundle) {
      throw new Error('Launched app identity changed; quit refused (pid ' + actualPid + ' vs ' + pid +
        ', bundle ' + actualBundle + ' vs ' + bundle + ')');
    }
  }
  var windowless;
  function receipt(reason) {
    var wait = { reason: reason, accepted: accepted, elapsedMs: clock.now() - started, finishedLaunching: finishedLaunching };
    if (windowless) wait.windowless = windowless;
    clock.emit({ stage: 'quit', quitWait: wait });
  }
  // The exact process this run launched: its pid and bundle, and the launch time the setup recorded.
  function launchedByThisRun(target) {
    var date = target.launchDate;
    return clock.startedAtMs > 0 && !!date && !(date.isNil && date.isNil()) &&
      Math.abs(Number(date.timeIntervalSince1970) * 1000 - clock.startedAtMs) < 1;
  }
  function force(reason) {
    if (clock.check) clock.check();
    if (!target.forceTerminate) { receipt('deadline'); throw new Error('Launched app refused force termination after thirty seconds'); }
    var forcedAt = clock.now();
    while (clock.now() - forcedAt < 5000) {
      target = application();
      if (!target) { receipt(reason); return true; }
      identity(target);
      clock.wait(100);
    }
    receipt('deadline');
    throw new Error('Launched app still running five seconds after force termination');
  }
  var office = /^com\.microsoft\.(Word|Excel|Powerpoint)$/.test(bundle);
  if (clock.check) clock.check();
  var target = application();
  if (!target) { receipt('already-exited'); return true; }
  identity(target);
  // NSRunningApplication.terminate requests an ordinary quit. Acceptance does
  // not mean the process has exited, especially while Office is still starting.
  if (clock.check) clock.check();
  accepted = !!target.terminate;
  if (!accepted) { receipt('refused'); throw new Error('Launched app refused quit'); }
  while (true) {
    if (clock.check) clock.check();
    target = application();
    if (!target) { receipt('exited'); return true; }
    identity(target);
    // Word ignored a quit with no windows left after its fixture's Don't Save sheet was answered (2026-10-18, by hand: AX
    // press, terminate, then forceTerminate). With no window there is no document to recover, so after ten seconds the exact
    // launched process is force-terminated. With any window, or an unproven launch time, Office keeps the stop below.
    if (office && clock.windowless && clock.now() - started >= 10000 && launchedByThisRun(target)) {
      windowless = clock.windowless(target);
      if (windowless && windowless.none === true) return force('force-terminated-windowless');
    }
    var remaining = 30000 - (clock.now() - started);
    if (remaining <= 0) break;
    clock.wait(Math.min(100, remaining));
  }
  // A launched app that accepted the quit and is still up after 30 s is stuck: TextEdit deadlocked in a save, and TextEdit and
  // Preview sat in a background menu (2026-10-16). This run launched it with only its fixtures, so it is force-terminated by
  // the same pid and bundle. Word and Excel with a window keep the stop, because a forced end leaves recovery files that
  // broke later runs.
  if (office) {
    receipt('deadline');
    throw new Error('Launched app quit unconfirmed after thirty seconds (normal quit accepted; finishedLaunching=' + finishedLaunching + ')');
  }
  return force('force-terminated');
}

// No window by both counts: the app's AX window list reads as empty, and the window server shows no on-screen layer-0
// window for the pid (a sheet or alert is one). An unreadable list counts as windows present.
function windowlessProcess(pid) {
  var app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  var value = Ref(), code = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
  var list = code === 0 ? ObjC.castRefToObject(value[0]) : null;
  var axWindows = list ? Number(list.count) : -1;
  var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
  var onScreen = raw && !(raw.isNil && raw.isNil()) ? ObjC.deepUnwrap(ObjC.castRefToObject(raw)).filter(function (window) {
    return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0;
  }).length : -1;
  return { none: axWindows === 0 && onScreen === 0, axWindows: axWindows, onScreen: onScreen, axCode: code };
}

function officeDeadlineError(state) {
  var last = state.officeLastError;
  return Object.assign(new Error('Office fixture readiness timed out after thirty seconds; ' +
    (last ? 'last AX error ' + last.code + ' (' + last.attribute + ')' : 'no AX error; matching window absent')), { officeDeadline: true });
}

function waitForOfficeFixture(probe, state, clock) {
  if (!state.setup || state.actionTaken) throw new Error('Office startup wait requires untouched setup');
  var started = state.retryStarted === undefined ? clock.now() : state.retryStarted, reason = 'error';
  // Final identity validation uses setupRead after this waiter returns. Keep
  // the same deadline even when only the Office window poll needed retries.
  state.retryStarted = started;
  state.officeWaiting = true;
  state.officeDeadline = started + 30000;
  try {
    while (clock.now() < state.officeDeadline) {
      try {
        var ready = probe();
        if (clock.now() >= state.officeDeadline) break;
        if (ready) { reason = 'ready'; return true; }
      } catch (error) {
        if (error.officeDeadline) break;
        if ([-25204, -25205].indexOf(error.code) === -1) throw error;
        state.officeLastError = { code: error.code, attribute: error.attribute };
      }
      var remaining = state.officeDeadline - clock.now();
      if (remaining > 0) clock.wait(Math.min(100, remaining));
    }
    reason = 'deadline';
    throw officeDeadlineError(state);
  } finally {
    state.officeWaiting = false;
    delete state.officeDeadline;
    var last = state.officeLastError || {};
    state.launchWait = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() - started, code: last.code, attribute: last.attribute };
    clock.emit({ stage: 'office-wait', launchWait: state.launchWait });
  }
}

function setupRead(operation, state, clock) {
  var lastError;
  function receipt(reason) {
    if (!lastError) return;
    state.readWait = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() - state.retryStarted,
      code: lastError.code, attribute: lastError.attribute };
    clock.emit({ stage: 'read-wait', readWait: state.readWait });
  }
  while (true) {
    if (state && state.setup && !state.actionTaken && state.retryStarted !== undefined && clock.now() - state.retryStarted >= 30000) {
      lastError = state.retryError || officeDeadlineError(state); receipt('deadline'); throw lastError;
    }
    try { var value = operation(); receipt('ready'); return value; }
    catch (error) {
      if (!state || !state.setup || state.actionTaken || [-25204, -25205].indexOf(error.code) === -1) {
        if (lastError) lastError = error;
        receipt('error'); throw error;
      }
      if (state.retryStarted === undefined) state.retryStarted = clock.now();
      lastError = state.retryError = error;
      if (state.office) state.officeLastError = { code: error.code, attribute: error.attribute };
      state.retryWaitMs = clock.now() - state.retryStarted;
      var remaining = 30000 - (clock.now() - state.retryStarted);
      if (remaining <= 0) { receipt('deadline'); throw error; }
      var delay = Math.min(100, remaining), before = clock.now();
      clock.wait(delay);
      state.retryWaitMs = clock.now() - state.retryStarted;
      clock.emit({ stage: 'retry', code: error.code, waitMs: clock.now() - before,
        totalWaitMs: state.retryWaitMs, setupCase: state.setupCase });
    }
  }
}

function beginCleanup(state) {
  if (state.cleanup) return;
  state.cleanup = true;
  if (state.observation) {
    state.cleanupRetryStarted = state.observation.cleanupRetryStarted;
    state.cleanupRetryError = state.observation.cleanupRetryError;
  }
}

function cleanupRead(operation, state, clock) {
  var lastError, episode;
  function currentEpisode() {
    // A close request may arrive during a ready-state observation or its wait.
    // Carry that episode's spent budget into cleanup instead of starting over.
    if (state.observation && !state.cleanup && clock.cleanupRequested()) {
      beginCleanup(state);
    }
    return state.cleanup ? state : state.observation;
  }
  function receipt(reason) {
    if (!lastError) return;
    var phase = state.cleanup ? 'cleanup' : 'observation', key = phase + 'ReadWait';
    state[key] = { reason: reason, setupCase: state.setupCase, elapsedMs: clock.now() - episode.cleanupRetryStarted,
      code: lastError.code, attribute: lastError.attribute };
    var event = { stage: phase + '-read-wait' }; event[key] = state[key]; clock.emit(event);
  }
  while (true) {
    episode = currentEpisode();
    if (episode.cleanupRetryStarted !== undefined && clock.now() - episode.cleanupRetryStarted >= 15000) {
      lastError = episode.cleanupRetryError; receipt('deadline'); throw lastError;
    }
    try { var value = operation(); episode = currentEpisode(); receipt('ready'); return value; }
    catch (error) {
      episode = currentEpisode();
      if (error.code !== -25204) {
        if (episode.cleanupRetryError) lastError = error;
        receipt('error'); throw error;
      }
      if (episode.cleanupRetryStarted === undefined) episode.cleanupRetryStarted = clock.now();
      lastError = episode.cleanupRetryError = error;
      var remaining = 15000 - (clock.now() - episode.cleanupRetryStarted);
      if (remaining <= 0) { receipt('deadline'); throw error; }
      var before = clock.now();
      state.readEpoch = (state.readEpoch || 0) + 1;
      clock.wait(Math.min(100, remaining));
      episode = currentEpisode();
      clock.emit({ stage: 'retry', phase: state.cleanup ? 'cleanup' : 'observation', code: error.code, waitMs: clock.now() - before,
        totalWaitMs: clock.now() - episode.cleanupRetryStarted, setupCase: state.setupCase });
    }
  }
}

// This helper lives through the whole task, and a long-lived JXA host read an owned Excel process as gone while the same
// pid was alive (Office investigation, 2026-10-17). An empty bundle listing is looked up again by pid before the close is
// skipped, and a skipped close says so, so the parent confirms the exit with the kernel before counting it clean.
function cleanupTarget(listed, pid, bundle, byPid) {
  if (listed) return listed;
  var again = pid > 0 ? byPid(pid) : null;
  return again && runningBundle(again) === bundle ? again : null;
}

function validateOwnedFixture(window, request, app, api, focus, sibling) {
  var epoch;
  do {
    epoch = api.readEpoch ? api.readEpoch() : 0;
    if (!api.exists(window) || !api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
    if (focus) {
      var focused = api.focused(app);
      if (!api.equal(focused, window) && !(sibling && api.equal(focused, sibling) &&
          api.text(sibling, 'AXTitle').indexOf(siblingToken(request)) !== -1)) throw new Error('Owned document lost focus; cleanup refused');
    }
    // Any waited read may have made an earlier check stale. Repeat all checks
    // before allowing the existing action to use the retained reference.
  } while (api.readEpoch && api.readEpoch() !== epoch);
}

function recoverSetup(window, request, api) {
  if (!window) return 'unconfirmed';
  if (!api.exists(window)) return 'closed retained fixture';
  if (!api.matches(window, request, true)) return 'unconfirmed';
  api.closeButton(window, function () { validateOwnedFixture(window, request, null, api, false); });
  for (var attempt = 0; attempt < 30; attempt++) {
    api.wait();
    if (!api.exists(window)) return 'closed retained fixture';
  }
  throw new Error('Retained fixture window cleanup unconfirmed');
}

function chooseFileMenu(file, titles, api) {
  var menus = [];
  try {
    api.press(file);
    menus = api.children(file).filter(function (child) { return api.text(child, 'AXRole') === 'AXMenu'; });
    var items = [], allItems = [];
    menus.forEach(function (menu) {
      var children = api.children(menu);
      api.inspect && api.inspect(children);
      allItems = allItems.concat(children);
    });
    for (var index = 0; index < titles.length; index++) {
      items = allItems.filter(function (item) { return api.text(item, 'AXTitle') === titles[index] && (!api.enabled || api.enabled(item)); });
      if (items.length) break;
    }
    if (items.length !== 1) throw new Error('Fixture menu item unavailable or ambiguous');
    if (api.beforePress) api.beforePress();
    api.press(items[0]);
  } catch (error) {
    try { api.cancel(menus.length === 1 ? menus[0] : file); }
    catch (failure) { error.menuCleanupError = failure.message; }
    throw error;
  }
}

// A window the task already closed can keep answering AXRole while its title is unsupported (-25205): Chess and Word did after
// their tasks saved and closed them (2026-10-16). It counts as closed only when the app's own window list, read successfully,
// no longer holds it. Any other read failure, or a window still listed, keeps the stop.
function closedUnderUs(window, app, api) {
  if (!api.text || !api.listed) return false;
  try { api.text(window, 'AXTitle'); return false; }
  catch (error) {
    if (error.code !== -25205) throw error;
    var listed = api.listed(app, window);
    if (listed === false) return true;
    // Still listed (or the list is unreadable): say what the window looks like, so the next fix is measured, not guessed.
    var probe = function (attribute) { try { var v = api.read(window, attribute); return v === null ? 'null' : 'ok'; } catch (e) { return String(e.code); } };
    error.message += ' [listed=' + listed + ' role=' + probe('AXRole') + ' subrole=' + probe('AXSubrole') + ' document=' + probe('AXDocument') +
      ' sheets=' + probe('AXSheets') + ' children=' + probe('AXChildren') + ' minimized=' + probe('AXMinimized') + ']';
    throw error;
  }
}

function closeOwnedWindow(window, request, app, api) {
  var phase = 'start';
  try { return closeOwnedWindowSteps(window, request, app, api, function (name) { phase = name; }); }
  catch (error) {
    // A stop says which step failed and what the window answered then, so a fix is measured (Chess and Word, 2026-10-16).
    if (error && (error.code === -25205 || error.code === -25202) && api.read && error.message.indexOf('[phase=') === -1) {
      var probe = function (attribute) { try { var v = api.read(window, attribute); return v === null ? 'null' : 'ok'; } catch (e) { return String(e.code); } };
      var listed; try { listed = api.listed ? api.listed(app, window) : 'n/a'; } catch (e) { listed = String(e.code); }
      error.message += ' [phase=' + phase + ' listed=' + listed + ' role=' + probe('AXRole') + ' subrole=' + probe('AXSubrole') +
        ' sheets=' + probe('AXSheets') + ' children=' + probe('AXChildren') + ' minimized=' + probe('AXMinimized') + ']';
    }
    throw error;
  }
}

// Word put an untitled document's Don't Save sheet only behind AXFocusedUIElement, absent from AXWindows and AXSheets
// (Office investigation, 2026-10-17). A window that reads as gone counts as closed only when no such sheet is left.
var HIDDEN_SHEET = 'Owned fixture save sheet left outside AXSheets; cleanup unconfirmed';
function closedWithoutSheet(app, window, api) { return !(api.hiddenSheet && api.hiddenSheet(app, window)); }

function closeOwnedWindowSteps(window, request, app, api, step) {
  if (request.mode === 'document' && request.stopOnAppDialog) request = Object.assign({}, request, { refuseDialogs: true });
  if (!window) return;
  if (!api.exists(window) || closedUnderUs(window, app, api)) {
    if (closedWithoutSheet(app, window, api)) return;
    throw new Error(HIDDEN_SHEET);
  }
  step('identity');
  if (!api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
  var noDialog = function () {
    var found = request.refuseDialogs ? api.dialog(app, window, request) : [];
    // The refusal names what it saw, so the next fix is measured (Word's save sheets, 2026-10-18).
    if (found.length) throw new Error('Application dialog present; fixture cleanup refused (' + found.map(function (item) {
      return item.category + ' "' + item.title + '" [' + (item.buttons || []).join(', ') + ']';
    }).join('; ') + ')');
  };
  var identity = function () { noDialog(); validateOwnedFixture(window, request, app, api, false); };
  var discardIdentity = function () {
    var epoch;
    do {
      epoch = api.readEpoch ? api.readEpoch() : 0;
      identity();
      if (request.mode === 'document') {
        var focused = api.focused(app), sheet = api.discardable(window, request, app);
        if (!api.equal(focused, window) && !api.equal(focused, sheet)) throw new Error('Owned document lost focus; cleanup refused');
      }
    } while (api.readEpoch && api.readEpoch() !== epoch);
  };
  step('close');
  if (request.refuseDialogs && api.discardable && api.discardable(window, request, app)) {
    api.discard(window, discardIdentity, request, app);
  } else if (request.mode === 'document') {
    var sibling = raiseOverSibling(window, request, app, api);
    var validate = function () {
      noDialog();
      // A run-launched app's button targets this window even when its sibling keeps focus. A menu still requires this window.
      validateOwnedFixture(window, request, app, api, true,
        api.closesDocumentByButton && api.closesDocumentByButton() ? sibling : null);
    };
    validate();
    api.closeDocument(app, validate, request, window);
  } else api.closeButton(window, identity);
  var sheetLeft = false;
  for (var attempt = 0; attempt < 30; attempt++) {
    step('wait-' + attempt);
    api.wait();
    try {
      if (!api.exists(window) || closedUnderUs(window, app, api) || (request.mode === 'document' && !api.matches(window, request, true))) {
        if (closedWithoutSheet(app, window, api)) return;
        sheetLeft = true;
        continue;
      }
      noDialog();
      if (!request.refuseDialogs || (api.discardable && api.discardable(window, request, app))) {
        api.discard(window, request.refuseDialogs ? discardIdentity : identity, request, app);
      }
    } catch (error) {
      // The close can finish between two reads of one check: the window answers AXRole, then is an invalid element (-25202)
      // for AXDocument, AXSheets or AXRole (3 TextEdit stops on 2026-10-19, every probe -25202, listed=false). Only the
      // retained window reading as gone continues the wait, and the next turn still requires no save sheet left behind.
      if (!error || error.code !== -25202 || api.exists(window)) throw error;
    }
  }
  throw new Error(sheetLeft ? HIDDEN_SHEET : 'Owned fixture window is still open');
}

// A task that drags between two fixture windows needs both uncovered: TextEdit cascades a second document over the first,
// and sleight's drag refused the drop as covered by the sibling in all 4 textedit-window-drag runs of 2026-10-19. Each
// window gets its own slot in the primary display's visible frame (menu bar and Dock excluded), side by side with a gap,
// so the slots never overlap on any display size. AX coordinates, origin at the primary display's top left.
var PLACEMENT_GAP = 16;
function fixtureFrame(visible, slot, count) {
  if (!(count >= 1) || !(slot >= 0) || slot >= count || slot !== Math.floor(slot)) throw new Error('Fixture placement slot invalid');
  var width = Math.floor(Math.min(720, (visible.width - PLACEMENT_GAP * (count + 1)) / count));
  var height = Math.floor(Math.min(560, visible.height - PLACEMENT_GAP * 2));
  if (!(width >= 320) || !(height >= 240)) throw new Error('Display too small for side-by-side fixture windows');
  return { x: Math.round(visible.x + PLACEMENT_GAP + slot * (width + PLACEMENT_GAP)), y: Math.round(visible.y + PLACEMENT_GAP), width: width, height: height };
}

// The window must end inside its slot (half a gap of slack) and inside the visible frame, or setup fails before the task starts.
function placeFixtureWindow(window, placement, api) {
  var visible = api.visibleFrame(), frame = fixtureFrame(visible, placement.slot, placement.count);
  api.place(window, frame);
  var actual = api.frame(window), slack = PLACEMENT_GAP / 2;
  var inSlot = actual && actual.x >= frame.x - slack && actual.x + actual.width <= frame.x + frame.width + slack &&
    actual.y >= visible.y - 1 && actual.y + actual.height <= visible.y + visible.height + 1;
  if (!inSlot) throw new Error('Fixture window placement unconfirmed (wanted ' + JSON.stringify(frame) + ', read ' + JSON.stringify(actual) + ')');
  return { slot: placement.slot, count: placement.count, visible: visible, frame: frame, actual: actual };
}

// File > Close acts on the focused document, and a task with two fixture windows can leave the other one focused
// (textedit-window-drag, 2026-10-16). Only when the focused window is a fixture of this run (its title carries the run's
// nonce) is this one raised in the background. Any other focused window keeps the lost-focus refusal.
// The nonce is the run token. A document's own token is its file name (Target-<nonce>.txt), which its sibling
// (Source-<nonce>.txt) never carries: that check refused every sibling and stopped 4 native passes on 2026-10-19.
function siblingToken(request) { return request.runToken || request.token; }
function raiseOverSibling(window, request, app, api) {
  if (!api.raise || !siblingToken(request)) return;
  var focused = api.focused(app);
  if (!focused || api.equal(focused, window) || api.text(focused, 'AXTitle').indexOf(siblingToken(request)) === -1) return;
  api.raise(window);
  for (var attempt = 0; attempt < 20 && !api.equal(api.focused(app), window); attempt++) api.wait();
  return focused;
}

function closeDocumentSafely(app, request, validate, api) {
  // In an app this run launched, the validated window's own close button closes only the fixture, in the background. The
  // File menu is never opened there: macOS checks Close against a key window a background app may never set, and a menu
  // opened by Accessibility can stay in its tracking loop, after which the app ignores quit (TextEdit, Preview and Word,
  // 2026-10-16; TextEdit's sample showed NSMenuTrackingSession).
  if (api.button) return api.button(validate);
  try { api.menu(app, validate); }
  catch (error) {
    var disabled = !error.menuCleanupError && error.message === 'Fixture menu item unavailable or ambiguous';
    if (request.ownerAway !== true || !disabled) throw error;
    validate();
    api.activate(app);
    validate();
    api.menu(app, validate);
  }
}

function appDialogCategory(info) {
  var modal = ['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1;
  if (info.document && !modal) return null;
  var startup = /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail)$/.test(info.title || '');
  var text = [info.title || ''].concat(modal || startup ? (info.buttons || []).concat(info.text || []) : []).join('\n');
  if (/(?:activate|activation|licen[cs][ei]|subscription|product key)/i.test(text)) return 'activation';
  if (/\b(?:sign[ -]?in|log[ -]?in)\b/i.test(text)) return 'sign-in';
  if (/\b(?:grant access|allow access|needs? access|permission|would like to access|don.t allow)\b/i.test(text)) return 'permission';
  if (/\b(?:welcome|what.s new|getting started|first run|get started)\b/i.test(text)) return 'first-run';
  return modal ? 'application-result' : null;
}

function appDialogInfo(info, app, refuseDialogs) {
  var category = appDialogCategory(info);
  if (!category) return null;
  return { app: app, category: category, title: info.title || '', buttons: info.buttons || [],
    stop: refuseDialogs === true || ['activation', 'sign-in', 'permission'].indexOf(category) !== -1,
    description: category + ' application dialog' };
}

function cancelFixtureMenu(menu, api, refuseDialogs) {
  if (refuseDialogs && api.role(menu) !== 'AXMenu') throw new Error('Fixture cancellation target is not an observed menu');
  if (api.cancel(menu)) return 'AXCancel';
  if (refuseDialogs) throw new Error('Fixture menu cancellation failed; Escape refused');
  api.escape();
  return 'Escape';
}

function dialogContents(element, api) {
  var result = { buttons: [], text: [] }, visited = 0;
  function visit(current, depth) {
    if (depth < 0 || ++visited > 512) throw new Error('Application dialog inspection exceeded its bound');
    api.children(current).forEach(function (child) {
      var role = api.text(child, 'AXRole');
      if (role === 'AXButton') result.buttons.push(api.text(child, 'AXTitle'));
      if (role === 'AXStaticText') result.text.push(api.text(child, 'AXValue'), api.text(child, 'AXTitle'));
      visit(child, depth - 1);
    });
  }
  visit(element, 8);
  return result;
}

var DISCARD_TITLES = ["Don't Save", 'Don’t Save'];
// Buttons a save prompt may carry besides Don't Save. Untitled buttons are icons and help; any other title keeps the refusal.
var SAVE_PROMPT_TITLES = DISCARD_TITLES.concat(['Save', 'Save…', 'Save...', 'Save As…', 'Save As...', 'Cancel', '']);

// Four Word cleanups refused the fixture's own save sheet as an app dialog (2026-10-18 claim runs), and Word answered -25205
// for a window's AXSheets at launch (2026-10-17). Where its sheet sits isn't measured, so a sheet counts as attached when
// AXSheets lists it, the window's children hold it, or the focused window is a sheet whose parent is this window. A focused
// alert (AXDialog) is marked as one, and must name the fixture file and nonce in its text.
function attachedSheets(window, app, api) {
  var sheets = api.children(window, 'AXSheets');
  if (sheets.length) return { sheets: sheets, source: 'AXSheets' };
  sheets = api.children(window).filter(function (child) { return api.text(child, 'AXRole') === 'AXSheet'; });
  if (sheets.length) return { sheets: sheets, source: 'AXChildren' };
  var focused = app && api.read ? api.read(app, 'AXFocusedWindow') : null;
  if (!focused || api.equal(focused, window)) return { sheets: [], source: null };
  var parent = function () { try { return api.read(focused, 'AXParent'); } catch (error) { if (error.code === -25205) return null; throw error; } };
  if (api.text(focused, 'AXRole') === 'AXSheet' && api.equal(parent(), window)) return { sheets: [focused], source: 'focused sheet' };
  if (api.text(focused, 'AXSubrole') === 'AXDialog') return { sheets: [focused], source: 'focused alert', alert: true };
  return { sheets: [], source: null };
}

// Only a save prompt attached to the exact nonce-bearing file can bypass a dialog refusal: the window's AXDocument is the
// fixture path, its title carries the run nonce, and the prompt has exactly one Don't Save and no unknown button.
function fixtureDiscardSheet(window, request, api, app) {
  var located = fixtureDiscardPrompt(window, request, api, app);
  return located ? located.sheet : null;
}

function fixtureDiscardPrompt(window, request, api, app) {
  var token = request.runToken || request.token;
  if (!window || !token || !request.target || request.target[0] !== '/') return null;
  var document = api.path(api.text(window, 'AXDocument')), expected = api.path(request.target), title = api.text(window, 'AXTitle');
  if (!document || document !== expected || title.indexOf(token) === -1) return null;
  var found = attachedSheets(window, app, api);
  if (found.sheets.length !== 1) return null;
  var sheet = found.sheets[0];
  if (!found.alert && api.text(sheet, 'AXRole') !== 'AXSheet') return null;
  var content = dialogContents(sheet, api), buttons = content.buttons;
  if (buttons.filter(function (name) { return DISCARD_TITLES.indexOf(name) !== -1; }).length !== 1 ||
      buttons.some(function (name) { return SAVE_PROMPT_TITLES.indexOf(name) === -1; }) ||
      appDialogCategory({ subrole: 'AXDialog', title: api.text(sheet, 'AXTitle'), text: content.text, buttons: buttons }) !== 'application-result') return null;
  if (found.alert) {
    var name = request.target.split('/').pop(), stem = name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
    var said = content.text.join('\n');
    if (said.indexOf(stem) === -1 || said.indexOf(token) === -1) return null;
  }
  return { sheet: sheet, source: found.source, windowTitle: title, buttons: buttons };
}

function discardButtons(sheet, api) {
  var result = [], visited = 0;
  (function visit(current, depth) {
    if (depth < 0 || ++visited > 512) throw new Error('Application dialog inspection exceeded its bound');
    api.children(current).forEach(function (child) {
      if (api.text(child, 'AXRole') === 'AXButton' && DISCARD_TITLES.indexOf(api.text(child, 'AXTitle')) !== -1) result.push(child);
      visit(child, depth - 1);
    });
  })(sheet, 8);
  return result;
}

function recoverFixtureApplications(request, api, clock) {
  var root = api.path(request.fixtureDir);
  if (request.fixtureMode !== 'document' || request.running !== false || request.launched !== true || !(request.startedAtMs > 0) || !request.runToken || !root || root === '/') {
    throw new Error('Owned fixture recovery identity unconfirmed');
  }
  var original;
  function inventory() {
    if (clock.check) clock.check();
    var plans = api.applications().map(function (target) {
      var pid = runningPid(target), date = target.launchDate;
      if (!(pid > 0) || runningBundle(target) !== request.bundle || !date || date.isNil() ||
          !(Number(date.timeIntervalSince1970) * 1000 >= request.startedAtMs)) throw new Error('Fixture process ownership unconfirmed');
      if (original && original.indexOf(pid) === -1) throw new Error('Fixture process identity changed during recovery');
      var app = api.app(target), windows = api.windows(app).map(function (window) {
        var path = api.path(api.text(window, 'AXDocument'));
        if (!path || path.indexOf(root + '/') !== 0 || api.text(window, 'AXTitle').indexOf(request.runToken) === -1) {
          throw new Error('Fixture window outside owned run directory');
        }
        var closeRequest = Object.assign({}, request, { mode: 'window', target: path, token: request.runToken, refuseDialogs: true });
        if (api.dialog(app, window, closeRequest).length) throw new Error('Application dialog present; fixture recovery refused');
        return { window: window, request: closeRequest };
      });
      if (!windows.length && (!request.pids || request.pids.indexOf(pid) === -1)) throw new Error('Empty fixture process ownership unconfirmed; recorded pid required');
      if (!windows.length && api.dialog(app, null, Object.assign({}, request, { refuseDialogs: true })).length) throw new Error('Application dialog present; fixture recovery refused');
      if (api.cgWindowCount(pid) > windows.length) throw new Error('Extra window in fixture process inventory; recovery refused');
      return { pid: pid, processStartedAtMs: Number(date.timeIntervalSince1970) * 1000, app: app, windows: windows };
    });
    return plans;
  }
  var plans = inventory();
  original = plans.map(function (plan) { return plan.pid; });
  var processes = plans.map(function (plan) { return { pid: plan.pid, processStartedAtMs: plan.processStartedAtMs }; });
  plans.forEach(function (plan) {
    plan.windows.forEach(function (item) {
      inventory();
      // Every action rechecks the whole app set as well as the retained window.
      var guarded = Object.create(api);
      guarded.closeButton = function (window, validate) {
        api.closeButton(window, function () { inventory(); validate(); });
      };
      guarded.discard = function (window, validate, closeRequest, app) {
        api.discard(window, function () { inventory(); validate(); }, closeRequest, app);
      };
      closeOwnedWindow(item.window, item.request, plan.app, guarded);
    });
  });
  inventory().forEach(function (plan) {
    quitFixtureApplication(plan.pid, request.bundle, function () { return api.application(plan.pid); }, {
      now: clock.now, wait: clock.wait, emit: clock.emit,
      check: function () {
        var remaining = inventory();
        if (remaining.some(function (item) { return item.windows.length; })) throw new Error('Owned fixture windows remain; quit refused');
      },
    });
  });
  if (inventory().length) throw new Error('Owned fixture processes still running');
  return { pids: original, processes: processes };
}

function nativeAX(state, clock) {
  var placementBound = false;
  function read(element, attribute) {
    var operation = function () {
      if (clock && clock.check) clock.check();
      if (state && state.officeWaiting && clock.now() >= state.officeDeadline) throw officeDeadlineError(state);
      var value = Ref();
      var code = Number($.AXUIElementCopyAttributeValue(element, $(attribute), value));
      // These optional attributes can remain unsupported on a valid app
      // window. Their absence allows the existing nonce-title identity fallback.
      if (code === -25205 && state && (state.setup || state.cleanup || state.observation) &&
          ['AXDocument', 'AXSheets', 'AXSubrole', 'AXMainWindow', 'AXWindows', 'AXChildren', 'AXValue'].indexOf(attribute) !== -1) {
        if (state.office) state.officeLastError = { code: code, attribute: attribute };
        return null;
      }
      if (code === -25212 || (code === -25205 && !(state && (state.setup || state.cleanup || state.observation)))) return null;
      if (code !== 0) throw Object.assign(new Error('AX fixture read failed: ' + code + ' (' + attribute + ')'), { code: code, attribute: attribute });
      return ObjC.castRefToObject(value[0]);
    };
    if (state && (state.cleanup || state.observation)) return cleanupRead(operation, state, clock);
    return state && state.officeWaiting ? operation() : setupRead(operation, state, clock);
  }
  function text(element, attribute) { var value = read(element, attribute); return value ? String(ObjC.unwrap(value)) : ''; }
  var textOf = text;
  function children(element, attribute) {
    var values = read(element, attribute || 'AXChildren'), result = [];
    if (values) for (var index = 0; index < Number(values.count); index++) result.push(values.objectAtIndex(index));
    return result;
  }
  function press(element) {
    if (clock && clock.check) clock.check();
    if (state && state.setup) { state.actionTaken = true; clock.emit({ stage: 'action', actionTaken: true }); }
    var code = Number($.AXUIElementPerformAction(element, $('AXPress')));
    if (code !== 0) throw new Error('AX fixture press failed: ' + code);
  }
  function buttons(element, wanted, depth) {
    if (depth < 0) return [];
    var result = [];
    children(element).forEach(function (child) {
      var role = text(child, 'AXRole');
      if (role === 'AXButton' && wanted.indexOf(text(child, 'AXTitle')) !== -1) result.push(child);
      if (['AXGroup', 'AXSheet'].indexOf(role) !== -1) result = result.concat(buttons(child, wanted, depth - 1));
    });
    return result;
  }
  function dialog(app, owned, request) {
    if (!request.stopOnAppDialog && !request.refuseDialogs) return [];
    // Another window of the app can lack a title (Chess, 2026-10-16: -25205 on AXTitle of the focused window at cleanup). In this
    // scan a missing title reads as empty, so that window is still classified as a candidate instead of stopping the pass.
    var text = function (element, attribute) {
      try { return textOf(element, attribute); }
      catch (error) { if (error.code === -25205 && attribute === 'AXTitle') return ''; throw error; }
    };
    var matches = function (window, request) {
      try { return matchesOf(window, request); }
      catch (error) { if (error.code === -25205 && error.attribute === 'AXTitle') return false; throw error; }
    };
    var focused = read(app, 'AXFocusedWindow');
    var candidates = [];
    // A fixture window the task already closed is an invalid element (-25202, TextEdit 2026-10-16): it has no sheets left to scan.
    if (owned) { try { candidates = candidates.concat(children(owned, 'AXSheets')); } catch (error) { if (error.code !== -25202) throw error; } }
    if (focused && (!owned || !$.CFEqual(focused, owned))) {
      if (['AXDialog', 'AXSystemDialog'].indexOf(text(focused, 'AXSubrole')) !== -1 || text(focused, 'AXRole') === 'AXSheet') candidates.push(focused);
      else if (matches(focused, request)) candidates = candidates.concat(children(focused, 'AXSheets'));
      else if (!text(focused, 'AXDocument')) candidates.push(focused);
    }
    var found = [];
    var safeSheet;
    try { safeSheet = state.cleanup && owned && fixtureDiscardSheet(owned, request, { text: text, children: children, path: path, read: read, equal: equal }, app); }
    catch (error) { if (error.code !== -25202) throw error; }
    for (var index = 0; index < candidates.length; index++) {
      var candidate = candidates[index];
      if (safeSheet && $.CFEqual(candidate, safeSheet)) continue;
      // A dialog dismissed while it is read becomes an invalid element (-25202, Word's "All done" alert at cleanup,
      // 2026-10-16). It no longer exists, so it can't block cleanup.
      try {
        var info = { title: text(candidate, 'AXTitle'), subrole: text(candidate, 'AXSubrole'),
          document: text(candidate, 'AXDocument') };
        if (text(candidate, 'AXRole') === 'AXSheet') info.subrole = 'AXDialog';
        if (['AXDialog', 'AXSystemDialog'].indexOf(info.subrole) !== -1 || /^(?:Microsoft )?(?:Word|Excel|PowerPoint|Mail)$/.test(info.title)) {
          var content = dialogContents(candidate, { children: children, text: text });
          info.buttons = content.buttons; info.text = content.text;
        }
      } catch (error) { if (error.code === -25202) continue; throw error; }
      var record = appDialogInfo(info, request.app, request.refuseDialogs);
      if (record) found.push(record);
    }
    return found;
  }
  function equal(a, b) { return !!a && !!b && !!$.CFEqual(a, b); }
  function fileMenu(app, titles, beforePress, refuseDialogs) {
    var bar = read(app, 'AXMenuBar');
    var files = children(bar).filter(function (item) { return text(item, 'AXTitle') === 'File'; });
    if (files.length !== 1) throw new Error('Fixture needs the File menu');
    chooseFileMenu(files[0], titles, { press: press, children: children, text: text, beforePress: beforePress,
      enabled: function (item) { return Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1; }, cancel: function (menu) {
      if (clock && clock.check) clock.check();
      var method = cancelFixtureMenu(menu, { role: function (target) { return text(target, 'AXRole'); },
        cancel: function (target) { return Number($.AXUIElementPerformAction(target, $('AXCancel'))) === 0; },
        escape: function () {
        var pidRef = Ref();
        if (Number($.AXUIElementGetPid(app, pidRef)) !== 0) throw new Error('File-menu cancellation lost the app identity');
        var down = $.CGEventCreateKeyboardEvent(null, 53, true), up = $.CGEventCreateKeyboardEvent(null, 53, false);
        if (!down || down.isNil() || !up || up.isNil()) throw new Error('File-menu Escape could not be created');
        if (clock && clock.check) clock.check();
        $.CGEventPostToPid(Number(pidRef[0]), down); $.CGEventPostToPid(Number(pidRef[0]), up);
      } }, refuseDialogs === true || state.refuseDialogs);
      clock.emit({ stage: 'menu-cancel', menuCancelled: true, menuCancelMethod: method });
    }, inspect: function (items) {
      clock.emit({ stage: 'menu-items', menuItems: items.map(function (item) {
        var title = text(item, 'AXTitle');
        return /^New .+ Window$/.test(title) && title !== 'New Private Window' ? 'New <profile> Window' : title;
      }), menuCommands: items.map(function (item) { return { title: text(item, 'AXTitle'), enabled: Number(ObjC.unwrap(read(item, 'AXEnabled'))) === 1 }; }) });
    } });
  }
  function path(value) {
    if (value && value[0] === '/') value = String(ObjC.unwrap($.NSURL.fileURLWithPath(value).absoluteString));
    if (!value || value.indexOf('file://') !== 0) return null;
    var url = $.NSURL.URLWithString(value);
    return url.isNil() || !url.isFileURL ? null : ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
  }
  function matchesOf(window, request, retained) { return matches(window, request, retained); }
  function matches(window, request, retained) {
    var document = text(window, 'AXDocument');
    if (document) {
      if (request.target && request.target.indexOf('http://') === 0) return document.indexOf(request.target) === 0;
      if (request.target && request.target.indexOf('https://') === 0) {
        var expected = $.NSURL.URLWithString(request.target), current = $.NSURL.URLWithString(document);
        if (expected.isNil() || current.isNil()) return false;
        var host = ObjC.unwrap(expected.host), scheme = ObjC.unwrap(expected.scheme);
        return scheme === 'https' && ObjC.unwrap(current.scheme) === 'https' && ObjC.unwrap(current.host) === host &&
          (host === 'www.target.com' || host === 'www.bestbuy.com');
      }
      var current = path(document), expected = request.target && request.target[0] === '/' ?
        path(String(ObjC.unwrap($.NSURL.fileURLWithPath(request.target).absoluteString))) : null;
      if (current && expected) return current === expected ||
        (request.mode === 'folder' && current.indexOf(expected + '/') === 0);
      return false;
    }
    var title = text(window, 'AXTitle');
    return request.mode === 'inherit' || title.indexOf(request.token) !== -1 ||
      (retained === true && request.mode === 'folder' && title === 'Archive');
  }
  var promptApi = { text: text, children: children, path: path, read: read, equal: equal };
  return {
    read: read, text: text, press: press, fileMenu: fileMenu, path: path,
    applications: function () {
      var values = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(state.bundle), result = [];
      for (var i = 0; i < Number(values.count); i++) result.push(values.objectAtIndex(i));
      return result;
    },
    application: function (pid) {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      return value.isNil() || value.isTerminated ? null : value;
    },
    app: function (target) {
      var app = $.AXUIElementCreateApplication(runningPid(target));
      $.AXUIElementSetMessagingTimeout(app, 0.5);
      return app;
    },
    windows: function (app) {
      var values = read(app, 'AXWindows');
      if (!values) throw new Error('Fixture window inventory unavailable');
      var result = [];
      for (var i = 0; i < Number(values.count); i++) result.push(values.objectAtIndex(i));
      return result;
    },
    cgWindowCount: function (pid) {
      if (clock && clock.check) clock.check();
      var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);
      if (!raw || raw.isNil && raw.isNil()) throw new Error('Fixture CG window inventory unavailable');
      var windows = ObjC.deepUnwrap(ObjC.castRefToObject(raw));
      return windows.filter(function (window) { return Number(window.kCGWindowOwnerPID) === pid && Number(window.kCGWindowLayer) === 0; }).length;
    },
    readEpoch: function () { return state && state.readEpoch || 0; },
    wait: function () { $.NSThread.sleepForTimeInterval(0.1); },
    equal: function (a, b) { return !!a && !!b && !!$.CFEqual(a, b); },
    focused: function (app) { return read(app, 'AXFocusedWindow'); },
    mainWindow: function (app) { return read(app, 'AXMainWindow'); },
    windowCount: function (app) { return children(app, 'AXWindows').length; },
    // true or false only when the app's window list was read; undefined when it couldn't be.
    listed: function (app, window) {
      var values = read(app, 'AXWindows');
      if (!values) return undefined;
      for (var index = 0; index < Number(values.count); index++) if ($.CFEqual(values.objectAtIndex(index), window)) return true;
      return false;
    },
    exists: function (window) {
      try { return text(window, 'AXRole') === 'AXWindow'; }
      catch (error) { if (error.code === -25202) return false; throw error; }
    },
    matches: matches, dialog: dialog,
    readiness: function (app, request) {
      function describe(window) {
        if (!window) return { present: false };
        var document = text(window, 'AXDocument');
        var current = path(document), normalizedTarget = request.target && request.target[0] === '/' ?
          path(String(ObjC.unwrap($.NSURL.fileURLWithPath(request.target).absoluteString))) : null;
        return { present: true, matches: matches(window, request),
          documentKind: document.indexOf('file://') === 0 ? 'file-url' : document.indexOf('http') === 0 ? 'web-url' : document ? 'other' : 'absent',
          titleMatches: text(window, 'AXTitle').indexOf(request.token) !== -1,
          pathAvailable: !!current, pathMatchesNormalizedTarget: !!current && current === normalizedTarget };
      }
      return { focused: describe(read(app, 'AXFocusedWindow')), main: describe(read(app, 'AXMainWindow')) };
    },
    visibleFrame: function () {
      var screens = $.NSScreen.screens;
      if (!screens || Number(screens.count) < 1) throw new Error('Fixture display unavailable');
      var primary = screens.objectAtIndex(0), full = primary.frame, area = primary.visibleFrame;
      return { x: Number(area.origin.x), y: Number(full.size.height) - (Number(area.origin.y) + Number(area.size.height)),
        width: Number(area.size.width), height: Number(area.size.height) };
    },
    place: function (window, frame) {
      if (clock && clock.check) clock.check();
      if (!placementBound) {
        ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
        ObjC.bindFunction('free', ['void', ['void*']]);
        ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void*']]);
        placementBound = true;
      }
      var set = function (attribute, type, boxed) {
        var bytes = $.malloc(32);
        try {
          boxed.getValue(bytes);
          var code = Number($.AXUIElementSetAttributeValue(window, $(attribute), $.AXValueCreate(type, bytes)));
          if (code !== 0) throw Object.assign(new Error('Fixture window placement failed: ' + code + ' (' + attribute + ')'), { code: code });
        } finally { $.free(bytes); }
      };
      set('AXSize', 2, $.NSValue.valueWithSize($.NSMakeSize(frame.width, frame.height)));
      set('AXPosition', 1, $.NSValue.valueWithPoint($.NSMakePoint(frame.x, frame.y)));
    },
    // JXA's Ref('CGPoint') reads back as 0: copy the struct into bytes (plugins/sleight/lib/element-visibility.js).
    frame: function (window) {
      var pair = function (attribute, type) {
        var value = read(window, attribute);
        if (!value) return null;
        var bytes = $.NSMutableData.dataWithLength(16);
        if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
        var boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
        var unwrapped = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
        return type === 1 ? [Number(unwrapped.x), Number(unwrapped.y)] : [Number(unwrapped.width), Number(unwrapped.height)];
      };
      var position = pair('AXPosition', 1), size = pair('AXSize', 2);
      return position && size ? { x: position[0], y: position[1], width: size[0], height: size[1] } : null;
    },
    raise: function (window) {
      if (clock && clock.check) clock.check();
      if (Number($.AXUIElementPerformAction(window, $('AXRaise'))) !== 0) throw new Error('Owned fixture window raise failed');
      $.AXUIElementSetAttributeValue(window, $('AXMain'), $.kCFBooleanTrue);
    },
    closeButton: function (window, validate) {
      var button = read(window, 'AXCloseButton');
      if (!button) throw new Error('Owned window has no close button');
      if (validate) validate();
      press(button);
    },
    closesDocumentByButton: function () { return !!(state && (state.setupCase === 'cold-launch' || state.launchedByRun)); },
    closeDocument: function (app, validate, request, window) {
      var closeButton = this.closeButton;
      closeDocumentSafely(app, request, validate, {
        button: window && this.closesDocumentByButton() ? function (check) { closeButton(window, check); } : undefined,
        menu: function (target, beforePress) { fileMenu(target, ['Close Selected PDF Document', 'Close'], beforePress, request.refuseDialogs); },
        activate: function (target) {
          if (clock && clock.check) clock.check();
          var pidRef = Ref();
          if (Number($.AXUIElementGetPid(target, pidRef)) !== 0) throw new Error('Document activation lost the app identity');
          var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pidRef[0]));
          if (running.isNil() || !running.activateWithOptions(0)) throw new Error('Owned document app activation failed');
          clock.emit({ stage: 'foreground-fallback', foregroundFallback: true });
          waitForLaunch();
        },
      });
    },
    // A sheet among the window's children, or one the app's focused element sits in whose ancestry reaches this window or no
    // window at all. A sheet on another window is that window's. Single raw reads: an app that already quit has no sheet.
    hiddenSheet: function (app, window) {
      function raw(element, attribute) {
        if (clock && clock.check) clock.check();
        var value = Ref();
        return Number($.AXUIElementCopyAttributeValue(element, $(attribute), value)) === 0 ? ObjC.castRefToObject(value[0]) : null;
      }
      function role(element) { var value = raw(element, 'AXRole'); return value ? String(ObjC.unwrap(value)) : ''; }
      var kids = window && raw(window, 'AXChildren');
      if (kids) for (var index = 0; index < Number(kids.count); index++) if (role(kids.objectAtIndex(index)) === 'AXSheet') return kids.objectAtIndex(index);
      var node = raw(app, 'AXFocusedUIElement'), sheet = null;
      for (var depth = 0; node && depth < 12 && !sheet; depth++) {
        if (role(node) === 'AXSheet') sheet = node;
        else node = raw(node, 'AXParent');
      }
      if (!sheet) return null;
      for (var up = raw(sheet, 'AXParent'), level = 0; up && level < 12; up = raw(up, 'AXParent'), level++) {
        if (window && $.CFEqual(up, window)) return sheet;
        if (role(up) === 'AXWindow') return null;
      }
      return sheet;
    },
    discardable: function (window, request, app) { return fixtureDiscardSheet(window, request, promptApi, app); },
    discard: function (window, validate, request, app) {
      if (request && request.refuseDialogs) {
        var prompt = fixtureDiscardPrompt(window, request, promptApi, app);
        if (!prompt) {
          if (!attachedSheets(window, app, promptApi).sheets.length) return;
          throw new Error('Unexpected owned fixture sheet; cleanup refused');
        }
        var discardButton = discardButtons(prompt.sheet, promptApi);
        if (discardButton.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
        if (validate) validate();
        var current = this.discardable(window, request, app);
        if (!current || !$.CFEqual(prompt.sheet, current)) throw new Error('Owned fixture sheet identity changed');
        var pressed = text(discardButton[0], 'AXTitle');
        press(discardButton[0]);
        if (clock && clock.emit) clock.emit({ stage: 'fixture-sheet', fixtureSheet: { pressed: pressed, source: prompt.source,
          windowTitle: prompt.windowTitle, buttons: prompt.buttons } });
        return;
      }
      var sheets = children(window, 'AXSheets');
      if (!sheets.length) return;
      if (sheets.length !== 1) throw new Error('Unexpected owned fixture sheets');
      var plain = buttons(sheets[0], DISCARD_TITLES, 6);
      if (plain.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
      if (validate) validate();
      press(plain[0]);
    },
  };
}

function run(argv) {
  var request = JSON.parse(argv[0]);
  function free() { if (request.stopOnLiveHold === true && $.NSFileManager.defaultManager.fileExistsAtPath('/tmp/sleight-hold')) throw new Error('Live hold exists; fixture stopped'); }
  free();
  if (request.mode === 'self-test') {
    var terminated = false;
    var fake = { processIdentifier: 42, bundleIdentifier: $('com.apple.Preview'),
      get terminate() { terminated = true; return true; } };
    return JSON.stringify({ quit: quitFixtureApplication(42, 'com.apple.Preview', function () {
      return terminated ? null : fake;
    }, { now: function () { return 0; }, wait: function () {}, emit: function () {} }), path: request.path ? String(ObjC.unwrap($.NSURL.fileURLWithPath(request.path).URLByResolvingSymlinksInPath.path)) : undefined });
  }
  if (request.bundle === 'com.apple.Safari' && ['quit', 'recover'].indexOf(request.mode) === -1) throw new Error('Safari setup requires the profile-proven created-window helper');
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.Chess', 'com.apple.dt.Devices', 'com.apple.iphonesimulator', 'net.imput.helium',
    'com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint', 'com.apple.mail'];
  var webFixture = request.fixtureKind === 'web-page' && /^http:\/\/127\.0\.0\.1:[1-9]\d*\/[A-Za-z0-9_-]{1,80}\/$/.test(request.target || '');
  if (request.mode === 'recover') {
    if (allowed.indexOf(request.bundle) === -1 || request.bundle === 'com.apple.finder' || !$.AXIsProcessTrusted()) throw new Error('Invalid fixture recovery request');
    var recoveryClock = { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit };
    var recovered = recoverFixtureApplications(request, nativeAX({ cleanup: true, bundle: request.bundle }, recoveryClock), recoveryClock);
    emit({ stage: 'recovered', pids: recovered.pids, processes: recovered.processes });
    return true;
  }
  if (request.mode === 'quit') {
    if ((allowed.indexOf(request.bundle) === -1 && !webFixture) || request.bundle === 'com.apple.finder' || !(request.pid > 0)) throw new Error('Invalid launched app quit request');
    return quitFixtureApplication(request.pid, request.bundle, function () {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      return value.isNil() || value.isTerminated ? null : value;
    }, { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit,
      startedAtMs: Number(request.processStartedAtMs) || 0,
      windowless: function () { return windowlessProcess(request.pid); },
      sameApp: function (target, bundle) {
        var url = target.bundleURL, expected = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundle);
        if (!url || url.isNil() || !expected || expected.isNil()) return false;
        return ObjC.unwrap(url.URLByResolvingSymlinksInPath.path) === ObjC.unwrap(expected.URLByResolvingSymlinksInPath.path);
      } });
  }
  if ((allowed.indexOf(request.bundle) === -1 && !webFixture) || !request.control || !request.mode || (webFixture && request.mode !== 'window')) throw new Error('Invalid fixture request');
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility is unavailable; fixture not opened');
  function emit(value) {
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
  function controlData() {
    free();
    var data = $.NSData.dataWithContentsOfFile(request.control);
    if (data.isNil()) return {};
    var string = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    try { return JSON.parse(ObjC.unwrap(string)); } catch (error) { return {}; }
  }
  function command() { return controlData().command || ''; }
  function application() {
    free();
    var matches = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle);
    // During a launch handoff the original and its successor can both be listed for a moment:
    // keep the original until it exits rather than failing setup.
    if (Number(matches.count) === 2 && state.setup && pid && !running && controlData().launched === true) {
      for (var i = 0; i < 2; i++) if (runningPid(matches.objectAtIndex(i)) === pid) return matches.objectAtIndex(i);
    }
    if (Number(matches.count) > 1) throw new Error('Ambiguous fixture process');
    return Number(matches.count) === 1 ? matches.objectAtIndex(0) : null;
  }
  var state = { setup: true, fresh: false, fixtureExists: false, actionTaken: false, retryWaitMs: 0, refuseDialogs: request.refuseDialogs === true };
  var clock = { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit,
    cleanupRequested: function () { return command() === 'close'; } };
  var api = nativeAX(state, clock);
  var target, running, pid, app, previous, owned, observedDialogs = [];
  var pids = [], processHandoff, processStartedAtMs, handoffPending = false, launchStarted = clock.now();
  function processStart(value) {
    var date = value && value.launchDate;
    return date && !date.isNil() ? Number(date.timeIntervalSince1970) * 1000 : null;
  }
  function recordProcess(value) {
    var nextPid = runningPid(value);
    if (!(nextPid > 0) || pid === nextPid) return;
    if (pid) {
      if (!state.setup || running || controlData().launched !== true || processHandoff || owned || state.actionTaken ||
        String(ObjC.unwrap(value.bundleIdentifier)) !== request.bundle) throw new Error('Fixture process changed');
      var original = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      // DeviceHub listed its successor while the original was still exiting (2026-10-10 10:31 UTC):
      // wait for the original to exit, within setup's own limits, rather than refusing the handoff.
      if (!original.isNil() && !original.isTerminated) { handoffPending = true; return; }
      // Adopt only a successor launched after this setup began, never an app someone opened before.
      var launched = value.launchDate;
      if (launched.isNil() || Number(launched.timeIntervalSince1970) * 1000 < launchStarted) throw new Error('Fixture successor predates this launch');
      processHandoff = { fromPid: pid, toPid: nextPid, elapsedMs: clock.now() - launchStarted };
      handoffPending = false;
      previous = null;
    }
    pid = nextPid;
    processStartedAtMs = processStart(value);
    // A recent launchDate alone proves nothing: only an earlier cold-launch
    // lease in this run can supply the exact process receipt.
    state.launchedByRun = processStartedAtMs > 0 && (request.launchedProcesses || []).some(function (process) {
      return process.pid === pid && process.bundle === request.bundle && runningBundle(value) === request.bundle &&
        process.processStartedAtMs === processStartedAtMs;
    });
    pids.push(pid);
    emit({ stage: processHandoff ? 'process-handoff' : 'identified-process', pid: pid,
      bundle: runningBundle(value) || request.bundle, processStartedAtMs: processStartedAtMs,
      pids: pids.slice(), processHandoff: processHandoff });
  }
  function checkOpening() {
    var control = controlData();
    if (control.command !== 'close') return;
    // Ordinary cancellation may coincide with the launcher's exit. Record only
    // an eligible owned successor before ending setup, without any AX action.
    if (control.launched === true && !running) {
      var current = application();
      if (current) recordProcess(current);
    }
    throw new Error('Fixture opening interrupted before identity was recorded');
  }
  function checkAppDialog() {
    var found = app && api.dialog(app, owned, request) || [];
    var blocking;
    found.forEach(function (dialog) {
      var key = JSON.stringify(dialog);
      if (observedDialogs.indexOf(key) === -1) {
        observedDialogs.push(key);
        emit({ stage: 'app-dialog', appDialog: dialog, pid: pid, running: running });
      }
      if (dialog.stop) blocking = dialog;
    });
    if (blocking) throw Object.assign(new Error(blocking.app + ' ' + blocking.category + ' dialog: stopped'), { appDialog: blocking });
  }
  try {
  target = application();
  running = !!target;
  state.fresh = !target || !!(target.launchDate && !target.launchDate.isNil() &&
    Number(target.launchDate.timeIntervalSince1970) * 1000 >= request.startedAtMs);
  state.setupCase = running ? 'already-running' : 'cold-launch';
  state.office = ['com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint'].indexOf(request.bundle) !== -1;
  if (webFixture || request.bundle === 'com.apple.Safari') {
    emit({ stage: 'launch', running: running });
    target = waitForApplication(application, waitForLaunch);
  }
  if (target) {
    recordProcess(target); app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    if (!state.office || running) previous = api.focused(app);
  }
  emit({ stage: 'identified', running: running, pid: pid, setupCase: state.setupCase });
  if (!state.office || running) checkAppDialog();
  if (webFixture || request.bundle === 'com.apple.Safari') {
    if (!target) {
      emit({ stage: 'untouched' });
      throw new Error('Browser process did not finish launching within ten seconds');
    }
    api.fileMenu(app, ['New Window']);
    for (var newTry = 0; newTry < 30; newTry++) {
      owned = api.focused(app);
      if (owned && !api.equal(owned, previous)) { state.fixtureExists = true; break; }
      owned = null; api.wait();
    }
    if (!owned) throw new Error('New browser fixture window unconfirmed');
  }
  emit({ stage: 'armed', running: running, pid: pid });
  var inherited = request.mode === 'inherit';
  while (command() !== 'opened') {
    checkOpening();
    // A launch can open the app, then fail before its remaining setup finishes.
    // Record that process while launch is pending, before cleanup can interrupt it.
    if (command() === 'launching') {
      target = application();
      if (target) recordProcess(target);
    }
    waitForLaunch();
  }
  function probeReadiness(attempt) {
    checkOpening();
    target = application();
    if (!target) return false;
    recordProcess(target);
    if (handoffPending) return false; // the original is still exiting: not ready, and never ready on it
    app = $.AXUIElementCreateApplication(pid);
    $.AXUIElementSetMessagingTimeout(app, 0.5);
    checkAppDialog();
    if (inherited) {
      var control = controlData();
      var condition = inheritReadyCondition(target, app, api, control);
      if (attempt === 0 || attempt === 199) emit({ stage: 'readiness', readiness: {
        finished: !!target.isFinishedLaunching,
        simulatorBooted: !!(control && control.simulatorBooted === true),
        pid: pid, inheritReady: condition || null,
      } });
      if (condition) { state.inheritReady = condition; return true; }
      return false;
    }
    if (attempt === 0 || attempt === 199) emit({ stage: 'readiness', readiness: api.readiness(app, request) });
    var current = owned || api.focused(app);
    if (!current) return false;
    if (request.mode === 'folder' && api.equal(current, previous)) {
      return false;
    }
    if (api.matches(current, request)) { owned = current; state.fixtureExists = true; return true; }
    return false;
  }
  var applicationReady = false;
  if (state.office) {
    var officeAttempt = 0;
    applicationReady = waitForOfficeFixture(function () { return probeReadiness(officeAttempt++); }, state, clock);
  } else {
    for (var attempt = 0; attempt < 200; attempt++) {
      if (probeReadiness(attempt)) { applicationReady = true; break; }
      if (inherited && target) waitForLaunch();
      else api.wait();
    }
  }
  if (!applicationReady) throw new Error('Fixture application readiness unconfirmed');
  if (!inherited && !owned) throw new Error('Fixture identity could not be established without a window inventory');
  if (!inherited && !api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
  if (request.placement && !inherited) {
    var placement = placeFixtureWindow(owned, request.placement, api);
    if (!api.matches(owned, request)) throw new Error('Fixture document identity unconfirmed');
    emit({ stage: 'placement', placement: placement });
  }
  emit({ stage: 'ready', pid: pid, pids: pids.slice(), processHandoff: processHandoff,
    processStartedAtMs: processStartedAtMs,
    inheritReady: state.inheritReady, bundle: runningBundle(target) || request.bundle,
    fresh: state.fresh, totalWaitMs: state.retryWaitMs, setupCase: state.setupCase });
  state.setup = false;
  while (command() !== 'close') {
    state.observation = {};
    try { checkAppDialog(); } finally {
      if (clock.cleanupRequested()) beginCleanup(state);
      state.observation = null;
    }
    api.wait();
  }
  beginCleanup(state);
  checkAppDialog();
  target = cleanupTarget(application(), pid, request.bundle, function (value) {
    var found = $.NSRunningApplication.runningApplicationWithProcessIdentifier(value);
    return found.isNil() || found.isTerminated ? null : found;
  });
  if (target && runningPid(target) !== pid && runningPid(target) !== -1) throw new Error('Fixture process changed before cleanup');
  if (target && state.launchedByRun && processStart(target) !== processStartedAtMs) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit(target || inherited ? { stage: 'closed' } : { stage: 'closed', appAbsent: true, pid: pid });
  } catch (error) {
    if (state.setup) {
      state.setup = false;
      state.cleanup = true;
      var cleanup, cleanupError = error.menuCleanupError;
      try {
        cleanup = error.appDialog ? 'unconfirmed' : recoverSetup(owned, request, api);
      } catch (failure) { cleanupError = [cleanupError, failure.message].filter(Boolean).join('; '); }
      emit({ stage: 'setup-failure', fresh: state.fresh, running: running, setupCase: state.setupCase, actionTaken: state.actionTaken, pid: pid,
        pids: pids.slice(), processHandoff: processHandoff, cleanup: cleanup, cleanupError: cleanupError,
        totalWaitMs: state.retryWaitMs, readWait: state.readWait, launchWait: state.launchWait });
    }
    throw error;
  }
}
