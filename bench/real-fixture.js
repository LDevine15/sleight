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
  function receipt(reason) {
    clock.emit({ stage: 'quit', quitWait: { reason: reason, accepted: accepted,
      elapsedMs: clock.now() - started, finishedLaunching: finishedLaunching } });
  }
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
    var remaining = 30000 - (clock.now() - started);
    if (remaining <= 0) break;
    clock.wait(Math.min(100, remaining));
  }
  // A launched app that accepted the quit and is still up after 30 s is stuck: TextEdit deadlocked in a save, and TextEdit and
  // Preview sat in a background menu (2026-10-16). This run launched it with only its fixtures, so it is force-terminated by
  // the same pid and bundle. Word and Excel keep the stop, because a forced end leaves recovery files that broke later runs.
  if (/^com\.microsoft\.(Word|Excel|Powerpoint)$/.test(bundle)) {
    receipt('deadline');
    throw new Error('Launched app quit unconfirmed after thirty seconds (normal quit accepted; finishedLaunching=' + finishedLaunching + ')');
  }
  if (clock.check) clock.check();
  if (!target.forceTerminate) { receipt('deadline'); throw new Error('Launched app refused force termination after thirty seconds'); }
  var forcedAt = clock.now();
  while (clock.now() - forcedAt < 5000) {
    target = application();
    if (!target) { receipt('force-terminated'); return true; }
    identity(target);
    clock.wait(100);
  }
  receipt('deadline');
  throw new Error('Launched app still running five seconds after force termination');
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

function validateOwnedFixture(window, request, app, api, focus, sibling) {
  var epoch;
  do {
    epoch = api.readEpoch ? api.readEpoch() : 0;
    if (!api.exists(window) || !api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
    if (focus) {
      var focused = api.focused(app);
      if (!api.equal(focused, window) && !(sibling && api.equal(focused, sibling) &&
          api.text(sibling, 'AXTitle').indexOf(request.token) !== -1)) throw new Error('Owned document lost focus; cleanup refused');
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

function closeOwnedWindowSteps(window, request, app, api, step) {
  if (request.mode === 'document' && request.stopOnAppDialog) request = Object.assign({}, request, { refuseDialogs: true });
  if (!window || !api.exists(window) || closedUnderUs(window, app, api)) return;
  step('identity');
  if (!api.matches(window, request, true)) throw new Error('Owned fixture document identity changed');
  var noDialog = function () {
    if (request.refuseDialogs && api.dialog(app, window, request).length) throw new Error('Application dialog present; fixture cleanup refused');
  };
  var identity = function () { noDialog(); validateOwnedFixture(window, request, app, api, false); };
  var discardIdentity = function () {
    var epoch;
    do {
      epoch = api.readEpoch ? api.readEpoch() : 0;
      identity();
      if (request.mode === 'document') {
        var focused = api.focused(app), sheet = api.discardable(window, request);
        if (!api.equal(focused, window) && !api.equal(focused, sheet)) throw new Error('Owned document lost focus; cleanup refused');
      }
    } while (api.readEpoch && api.readEpoch() !== epoch);
  };
  step('close');
  if (request.refuseDialogs && api.discardable && api.discardable(window, request)) {
    api.discard(window, discardIdentity, request);
  } else if (request.mode === 'document') {
    var sibling = raiseOverSibling(window, request, app, api);
    var validate = function () {
      noDialog();
      // A cold-launch button targets this window even when its sibling keeps focus. A menu still requires this window.
      validateOwnedFixture(window, request, app, api, true,
        api.closesDocumentByButton && api.closesDocumentByButton() ? sibling : null);
    };
    validate();
    api.closeDocument(app, validate, request, window);
  } else api.closeButton(window, identity);
  for (var attempt = 0; attempt < 30; attempt++) {
    step('wait-' + attempt);
    api.wait();
    if (!api.exists(window) || closedUnderUs(window, app, api)) return;
    if (request.mode === 'document' && !api.matches(window, request, true)) return;
    noDialog();
    if (!request.refuseDialogs || (api.discardable && api.discardable(window, request))) {
      api.discard(window, request.refuseDialogs ? discardIdentity : identity, request);
    }
  }
  throw new Error('Owned fixture window is still open');
}

// File > Close acts on the focused document, and a task with two fixture windows can leave the other one focused
// (textedit-window-drag, 2026-10-16). Only when the focused window is a fixture of this run (its title carries the run's
// nonce) is this one raised in the background. Any other focused window keeps the lost-focus refusal.
function raiseOverSibling(window, request, app, api) {
  if (!api.raise || !request.token) return;
  var focused = api.focused(app);
  if (!focused || api.equal(focused, window) || api.text(focused, 'AXTitle').indexOf(request.token) === -1) return;
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

// Only an attached save sheet on the exact nonce-bearing file can bypass a dialog refusal.
function fixtureDiscardSheet(window, request, api) {
  var token = request.runToken || request.token;
  if (!window || !token || !request.target || request.target[0] !== '/') return null;
  var document = api.path(api.text(window, 'AXDocument')), expected = api.path(request.target);
  if (!document || document !== expected || api.text(window, 'AXTitle').indexOf(token) === -1) return null;
  var sheets = api.children(window, 'AXSheets');
  if (sheets.length !== 1 || api.text(sheets[0], 'AXRole') !== 'AXSheet') return null;
  var content = dialogContents(sheets[0], api), buttons = content.buttons;
  if (buttons.length !== 3 || buttons.filter(function (title) { return title === 'Save'; }).length !== 1 ||
      buttons.filter(function (title) { return title === 'Cancel'; }).length !== 1 ||
      buttons.filter(function (title) { return title === "Don't Save" || title === 'Don’t Save'; }).length !== 1 ||
      appDialogCategory({ subrole: 'AXDialog', title: api.text(sheets[0], 'AXTitle'), text: content.text, buttons: buttons }) !== 'application-result') return null;
  return sheets[0];
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
      return { pid: pid, app: app, windows: windows };
    });
    return plans;
  }
  var plans = inventory();
  original = plans.map(function (plan) { return plan.pid; });
  plans.forEach(function (plan) {
    plan.windows.forEach(function (item) {
      inventory();
      // Every action rechecks the whole app set as well as the retained window.
      var guarded = Object.create(api);
      guarded.closeButton = function (window, validate) {
        api.closeButton(window, function () { inventory(); validate(); });
      };
      guarded.discard = function (window, validate, closeRequest) {
        api.discard(window, function () { inventory(); validate(); }, closeRequest);
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
  return original;
}

function nativeAX(state, clock) {
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
    try { safeSheet = state.cleanup && owned && fixtureDiscardSheet(owned, request, { text: text, children: children, path: path }); }
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
    closesDocumentByButton: function () { return !!(state && state.setupCase === 'cold-launch'); },
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
    discardable: function (window, request) { return fixtureDiscardSheet(window, request, { text: text, children: children, path: path }); },
    discard: function (window, validate, request) {
      var sheets = children(window, 'AXSheets');
      if (!sheets.length) return;
      if (sheets.length !== 1) throw new Error('Unexpected owned fixture sheets');
      if (request && request.refuseDialogs && !this.discardable(window, request)) throw new Error('Unexpected owned fixture sheet; cleanup refused');
      var discardButtons = buttons(sheets[0], ["Don't Save", 'Don’t Save'], 6);
      if (discardButtons.length !== 1) throw new Error('Unexpected owned fixture sheet; cleanup refused');
      if (validate) validate();
      if (request && request.refuseDialogs) {
        var current = this.discardable(window, request);
        if (!current || !$.CFEqual(sheets[0], current)) throw new Error('Owned fixture sheet identity changed');
      }
      press(discardButtons[0]);
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
  var allowed = ['com.apple.Safari', 'com.apple.Preview', 'com.apple.finder',
    'com.apple.TextEdit', 'com.apple.calculator', 'com.apple.Chess', 'com.apple.dt.Devices', 'com.apple.iphonesimulator', 'net.imput.helium',
    'com.microsoft.Word', 'com.microsoft.Excel', 'com.microsoft.Powerpoint', 'com.apple.mail'];
  var webFixture = request.fixtureKind === 'web-page' && /^http:\/\/127\.0\.0\.1:[1-9]\d*\/[A-Za-z0-9_-]{1,80}\/$/.test(request.target || '');
  if (request.mode === 'recover') {
    if (allowed.indexOf(request.bundle) === -1 || request.bundle === 'com.apple.finder' || !$.AXIsProcessTrusted()) throw new Error('Invalid fixture recovery request');
    var recoveryClock = { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit };
    var recovered = recoverFixtureApplications(request, nativeAX({ cleanup: true, bundle: request.bundle }, recoveryClock), recoveryClock);
    emit({ stage: 'recovered', pids: recovered });
    return true;
  }
  if (request.mode === 'quit') {
    if ((allowed.indexOf(request.bundle) === -1 && !webFixture) || request.bundle === 'com.apple.finder' || !(request.pid > 0)) throw new Error('Invalid launched app quit request');
    return quitFixtureApplication(request.pid, request.bundle, function () {
      var value = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      return value.isNil() || value.isTerminated ? null : value;
    }, { check: free, now: function () { return Date.now(); }, wait: function (ms) { free(); waitForLaunch(ms / 1000); }, emit: emit,
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
  var pids = [], processHandoff, handoffPending = false, launchStarted = clock.now();
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
    pids.push(pid);
    emit({ stage: processHandoff ? 'process-handoff' : 'identified-process', pid: pid,
      bundle: runningBundle(value) || request.bundle, pids: pids.slice(), processHandoff: processHandoff });
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
  emit({ stage: 'ready', pid: pid, pids: pids.slice(), processHandoff: processHandoff,
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
  target = application();
  if (target && runningPid(target) !== pid && runningPid(target) !== -1) throw new Error('Fixture process changed before cleanup');
  if (target && !inherited) closeOwnedWindow(owned, request, app, api);
  emit({ stage: 'closed' });
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
