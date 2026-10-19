// Generic native lifecycle and 200 ms focus observer. Never emits titles or text.
ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv) {
  var request = JSON.parse(argv[0]), started = Date.now(), retained = [], samples = [];
  var wasRunning = false, target = null, pid = null, launched = false, ready = false;
  var expected = request.targetURL, baselineFront, baselineOwnerWindows;
  var hostStage = 'baseline', windowCount = null, windowsWaitUntil = null, cleanupReported = false, startWait = null;
  // One startup budget, set by the runtime, covers launch, a busy accessibility tree and a window whose identity reads late.
  var startupMs = Number(request.startupMs) > 0 ? Number(request.startupMs) : 60000;
  var armedAt = null, sawLaunch = false;
  function emit(data) { if (data.stage === 'cleanup') cleanupReported = true; $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(data) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  function wait() { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2)); }
  function active() {
    var raw = $.NSString.stringWithContentsOfFileEncodingError(request.control, $.NSUTF8StringEncoding, null);
    if (raw && JSON.parse(ObjC.unwrap(raw)).command === 'abort') throw new Error('HOST_STOP');
  }
  function readAttribute(element, name) {
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(element, $(name), value));
    return { code: code, value: code === 0 ? value[0] : null };
  }
  function attribute(element, name) { return readAttribute(element, name).value; }
  // Cleanup can't wait for the next poll: a busy element (-25204) gets up to a second before its answer counts.
  function patientRead(element, name) {
    var read = readAttribute(element, name);
    for (var tries = 0; read.code === -25204 && tries < 5; tries++) { active(); sample(); wait(); read = readAttribute(element, name); }
    return read;
  }
  // An element that answers illegal-argument (-25201) or invalid-element (-25202) no longer exists.
  function invalidCode(code) { return code === -25201 || code === -25202; }
  function readWindows() {
    return readAttribute(ObjC.castRefToObject($.AXUIElementCreateApplication(pid)), 'AXWindows');
  }
  function windowList(read) {
    if (read.code !== 0 || !read.value) {
      var error = new Error('WINDOWS_READ_FAILED'); error.axStatus = read.code; throw error;
    }
    var list = ObjC.castRefToObject(read.value), out = [];
    for (var n = 0; n < list.count; n++) out.push(list.objectAtIndex(n));
    windowCount = out.length;
    return out;
  }
  function windows() {
    windowCount = null;
    if (!pid) { windowCount = 0; return []; }
    var read = readWindows();
    // Only a busy tree (-25204, cannot complete) is retried, and only within a wait the caller set.
    while (read.code === -25204 && windowsWaitUntil !== null && Date.now() < windowsWaitUntil) {
      active(); sample(); wait(); read = readWindows();
    }
    return windowList(read);
  }
  // Running instances of the bundle. A terminated instance can stay listed for a moment.
  function liveInstances() {
    var list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle), out = [];
    for (var n = 0; n < list.count; n++) if (!list.objectAtIndex(n).terminated) out.push(list.objectAtIndex(n));
    return out;
  }
  // Only a process that started after the host armed, that is after the run's own open, can be the run's launch.
  function launchedAfterArm(app) {
    var date = app.launchDate;
    if (!date || typeof date.isNil === 'function' && date.isNil()) return false;
    return Number(date.timeIntervalSince1970) * 1000 >= armedAt;
  }
  // Apps that embed Electron, CEF or a Chromium framework parse argv themselves and can misread AppKit's switches.
  function ownArgv() {
    try {
      var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(request.bundle);
      if (!url || typeof url.isNil === 'function' && url.isNil()) return null;
      var dir = String(ObjC.unwrap(url.path)) + '/Contents/Frameworks', files = $.NSFileManager.defaultManager;
      var names = files.contentsOfDirectoryAtPathError(dir, null);
      if (!names || typeof names.isNil === 'function' && names.isNil()) return false;
      for (var n = 0; n < names.count; n++) {
        var name = String(ObjC.unwrap(names.objectAtIndex(n)));
        if (name === 'Electron Framework.framework' || name === 'Chromium Embedded Framework.framework' ||
          /\.framework$/.test(name) && files.fileExistsAtPath(dir + '/' + name + '/Versions/Current/Helpers')) return true;
      }
      return false;
    } catch (_) { return null; }
  }
  function same(a, b) { return !!$.CFEqual(a, b); }
  function markerMatches(w, doc) {
    var document = doc.value ? String(ObjC.unwrap(ObjC.castRefToObject(doc.value))) : '';
    if (!request.windowMarker || document || [0, -25205, -25212].indexOf(doc.code) < 0) return false;
    var title = readAttribute(w, 'AXTitle');
    return title.code === 0 && title.value && String(ObjC.unwrap(ObjC.castRefToObject(title.value))).indexOf(request.windowMarker) >= 0;
  }
  function fileURL(value) {
    var url = String(value).replace(/^file:\/\/localhost\//, 'file:///').replace(/^file:\/\/\/tmp\//, 'file:///private/tmp/');
    try { url = decodeURI(url); } catch (_) {}
    return url.length > 8 && url.slice(-1) === '/' ? url.slice(0, -1) : url;
  }
  // The fixture's own document, or a document inside the fixture folder (a unique private temp path).
  function ownDocument(document) {
    if (!expected || !document) return false;
    var own = fileURL(expected), url = fileURL(document);
    return url === own || url.indexOf(own + '/') === 0;
  }
  // match: the fixture window. foreign: a readable different document. pending: identity not readable yet.
  function identify(w, patient) {
    var doc = (patient ? patientRead : readAttribute)(w, 'AXDocument');
    var document = doc.value ? String(ObjC.unwrap(ObjC.castRefToObject(doc.value))) : null;
    if (doc.code === 0 && ownDocument(document) || markerMatches(w, doc)) return { kind: 'match' };
    if (doc.code === 0 && document) return { kind: 'foreign', document: document, documentStatus: doc.code };
    return { kind: 'pending', documentStatus: doc.code, titleStatus: readAttribute(w, 'AXTitle').code };
  }
  var before = [];
  function known(w) {
    return before.some(function(old) { return same(w, old); }) || retained.some(function(old) { return same(w, old); });
  }
  function ambiguous(current) {
    if (request.windowMarker && current.filter(function(w) {
      return markerMatches(w, readAttribute(w, 'AXDocument'));
    }).length > 1) {
      emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['FIXTURE_WINDOW_AMBIGUOUS'], windows: [] } });
      throw new Error('FIXTURE_WINDOW_AMBIGUOUS');
    }
  }
  // Startup: decide each new window once its identity reads, and wait while any window is pending.
  function settle(current) {
    ambiguous(current);
    var foreign = [], pending = [];
    current.forEach(function(w, index) {
      if (known(w)) return;
      // Each read can block for the 6 s messaging timeout; past the budget, leave the rest undecided.
      if (Date.now() - startWait.startedAt >= startupMs) { if (launched) pending.push({ documentStatus: null, titleStatus: null }); return; }
      if (launched && !expected) { retained.push(w); return; }
      var seen = identify(w);
      if (seen.kind === 'match') retained.push(w);
      // An app that was already running may open other windows; only a launch makes them foreign.
      else if (launched && seen.kind === 'foreign') foreign.push({ index: index, retained: false, expectedURL: expected,
        document: seen.document, documentStatus: seen.documentStatus, documentReads: [{ document: seen.document, status: seen.documentStatus }],
        reasons: ['WINDOW_NOT_RETAINED', 'DOCUMENT_NOT_MATCHED'], present: true });
      else if (launched) pending.push(seen);
    });
    if (foreign.length) {
      emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['FOREIGN_WINDOW_ON_START'], windows: foreign } });
      throw new Error('FOREIGN_WINDOW_ON_START');
    }
    startWait.pending = pending.length;
    if (pending.length) {
      // Keep the codes of the last window actually read; a window skipped at the deadline has none.
      var read = pending.filter(function(row) { return row.documentStatus !== null; })[0];
      if (read) { startWait.pendingDocumentStatus = read.documentStatus; startWait.pendingTitleStatus = read.titleStatus; }
    }
    // An app that was already running may reuse a window (a browser tab); it is ready on its windows, as before.
    if (!expected || !launched) return !pending.length && current.length > 0;
    // Readiness follows the fixture match. A window still unidentified is never retained, so cleanup leaves it alone.
    return retained.some(function(w) { return current.some(function(now) { return same(w, now); }); });
  }
  function startupStep() {
    startWait.polls++;
    if (!wasRunning) {
      var listed = liveInstances(), live = listed.filter(launchedAfterArm);
      startWait.instances = live.length; startWait.olderInstances = listed.length - live.length;
      if (live.length > 1) { startWait.ambiguousPolls++; return false; }
      if (!live.length) { if (pid) startWait.exited = true; return false; }
      var current = Number(live[0].processIdentifier);
      // A launched process can hand over to a new instance of itself; the old pid answers -25204 for good. Only a
      // fixture target lets the new instance prove its windows, so without one a handover counts as an exit.
      if (pid && current !== pid && !expected) { startWait.exited = true; startWait.instances = 0; return false; }
      if (pid && current !== pid) {
        startWait.relaunches++; retained = []; startWait.finishedLaunching = false; startWait.lastWindowsStatus = null;
      }
      target = live[0]; pid = current; launched = true; startWait.exited = false;
    } else if (target.terminated) { startWait.exited = true; startWait.instances = 0; return false; }
    if (!target.isFinishedLaunching) { startWait.launchingPolls++; return false; }
    startWait.finishedLaunching = true;
    var read = readWindows(), key = String(read.code);
    startWait.windowsStatus[key] = (startWait.windowsStatus[key] || 0) + 1;
    startWait.lastWindowsStatus = read.code;
    if (read.code === -25204) return false;
    var list = windowList(read);
    startWait.windowCount = list.length;
    return settle(list);
  }
  function startupSummary() {
    var summary = {};
    for (var key in startWait) if (key !== 'startedAt') summary[key] = startWait[key];
    summary.elapsedMs = Date.now() - startWait.startedAt;
    return summary;
  }
  function startupError() {
    var w = startWait, code = w.exited && !w.instances ? 'APP_EXITED' : w.instances === 0 ? 'APP_NOT_RUNNING' :
      w.instances > 1 ? 'APP_INSTANCE_AMBIGUOUS' : !w.finishedLaunching ? 'APP_NOT_FINISHED_LAUNCHING' :
      w.lastWindowsStatus !== 0 ? 'WINDOWS_READ_FAILED' : w.pending ? 'FIXTURE_WINDOW_UNIDENTIFIED' : 'FIXTURE_WINDOW_ABSENT';
    var error = new Error(code);
    if (code === 'WINDOWS_READ_FAILED') error.axStatus = w.lastWindowsStatus;
    return error;
  }
  // After a failed setup, take only windows that prove they are the fixture.
  function adopt(current, matchesOnly) {
    var found = current.filter(function(w) { return !known(w) && (launched && !expected && !matchesOnly || identify(w, true).kind === 'match'); });
    if (request.windowMarker && found.length > 1) return;
    found.forEach(function(w) { retained.push(w); });
  }
  function retain(current) {
    if (!current) {
      if (!pid) return;
      var read = readWindows();
      // After readiness a busy tree skips one observation instead of ending the host.
      if (read.code === -25204) return;
      current = windowList(read);
    }
    if (request.windowMarker && current.filter(function(w) {
      var doc = readAttribute(w, 'AXDocument');
      return markerMatches(w, doc);
    }).length > 1) {
      emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['FIXTURE_WINDOW_AMBIGUOUS'], windows: [] } });
      throw new Error('FIXTURE_WINDOW_AMBIGUOUS');
    }
    var foreign = [];
    current.forEach(function(w, index) {
      if (known(w)) return;
      var doc = readAttribute(w, 'AXDocument');
      var document = doc.value ? String(ObjC.unwrap(ObjC.castRefToObject(doc.value))) : null;
      var match = doc.code === 0 && ownDocument(document) || markerMatches(w, doc);
      // A launch does not grant ownership of restored documents.
      if (match || (launched && !ready && !expected)) retained.push(w);
      else if (launched && !ready && expected) foreign.push({ index: index, retained: false, expectedURL: expected,
        document: document, documentStatus: doc.code, documentReads: [{ document: document, status: doc.code }],
        reasons: ['WINDOW_NOT_RETAINED', 'DOCUMENT_NOT_MATCHED'], present: true });
    });
    if (foreign.length) {
      emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['FOREIGN_WINDOW_ON_START'], windows: foreign } });
      throw new Error('FOREIGN_WINDOW_ON_START');
    }
  }
  function sample() {
    var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
    var order = [];
    for (var i = 0; i < list.count; i++) {
      var w = list.objectAtIndex(i);
      if (Number(ObjC.unwrap(w.objectForKey('kCGWindowLayer'))) !== 0) continue;
      var ownerPID = Number(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')));
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(ownerPID);
      var bundle = app && app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : null;
      order.push({ id: Number(ObjC.unwrap(w.objectForKey('kCGWindowNumber'))), pid: ownerPID, bundle: bundle,
        bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) });
    }
    var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    var frontBundle = front && front.bundleIdentifier ? ObjC.unwrap(front.bundleIdentifier) : null;
    if (baselineFront === undefined) {
      baselineFront = frontBundle;
      baselineOwnerWindows = order.filter(function(w) { return w.bundle === baselineFront; }).map(function(w) { return w.id; });
    }
    var targetIndex = order.findIndex(function(w) { return w.bundle === request.bundle; });
    var overOwner = targetIndex >= 0 && order.some(function(w, i) {
      if (i <= targetIndex || baselineOwnerWindows.indexOf(w.id) < 0) return false;
      var a = order[targetIndex].bounds, b = w.bounds;
      return a.X < b.X + b.Width && b.X < a.X + a.Width && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;
    });
    var row = { atMs: Date.now() - started, stage: hostStage, front: frontBundle, order: order,
      focusChanged: frontBundle !== baselineFront, targetOverOwner: overOwner };
    samples.push(row); emit({ stage: 'sample', sample: row });
  }
  function cleanup(recover) {
    hostStage = 'cleanup';
    var details = { reasons: [], windows: [] }, clean = true, failedWindows = [], invalidWindows = [];
    function reason(row, code) { if (row.reasons.indexOf(code) < 0) row.reasons.push(code); }
    function present(w, current) { return current.some(function(now) { return same(w, now); }); }
    function inspect(w, row) {
      var doc = patientRead(w, 'AXDocument');
      row.document = doc.value ? String(ObjC.unwrap(ObjC.castRefToObject(doc.value))) : null;
      row.documentStatus = doc.code;
      row.documentReads.push({ document: row.document, status: doc.code });
      row.matched = doc.code === 0 && ownDocument(row.document) || !!markerMatches(w, doc);
      var sheets = patientRead(w, 'AXSheets');
      var sheetsReadable = [0, -25205, -25212].indexOf(sheets.code) >= 0;
      row.sheetStatus = sheets.code;
      row.sheet = !!sheets.value && ObjC.castRefToObject(sheets.value).count > 0;
      if (row.documentReads.length === 1 && invalidCode(doc.code) && invalidCode(sheets.code)) invalidWindows.push(row);
      if (expected && !row.matched) reason(row, 'DOCUMENT_NOT_MATCHED');
      if (row.sheet) reason(row, 'SHEET_PRESENT');
      if (!sheetsReadable) reason(row, 'SHEETS_READ_FAILED');
      return (!expected || row.matched) && !row.sheet && sheetsReadable;
    }
    function ownFixture() {
      var path = request.fixturePath, root = request.fixtureRoot;
      return path && root && root.indexOf('/private/tmp/sleight-battery-') === 0 &&
        path.slice(0, path.lastIndexOf('/')) === root && !/(^|\/)\.\.?($|\/)/.test(path) &&
        String(ObjC.unwrap($.NSURL.fileURLWithPath(path).absoluteString)) === expected;
    }
    function quote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'; }
    function recordNew(current, entries) {
      current.forEach(function(w) {
        if (present(w, before) || entries.some(function(entry) { return same(w, entry.window); })) return;
        var row = { index: entries.length, retained: false, expectedURL: expected || null,
          reasons: ['WINDOW_NOT_RETAINED'], documentReads: [], present: true };
        inspect(w, row); failedWindows.push(row);
        details.windows.push(row); entries.push({ window: w, retained: false, row: row });
      });
    }
    function pollWindows() {
      var current = windows(); recordNew(current, entries); return current;
    }
    try {
      if (recover && launched && !wasRunning && !liveInstances().some(function(app) { return Number(app.processIdentifier) === pid; })) {
        // Recovery never switches instance. Allow a second for a handover to show before calling the launch exited.
        for (var tick = 0; tick < 5 && !liveInstances().length; tick++) { active(); sample(); wait(); }
        if (liveInstances().length) {
          reason(details, 'APP_REPLACED'); details.app = { pid: pid, exited: true, terminated: false };
          emit({ stage: 'cleanup', confirmed: false, details: details }); return;
        }
        // The app this run launched has exited: none of its windows or processes is left to close.
        details.app = { pid: pid, exited: true, terminated: true };
        emit({ stage: 'cleanup', confirmed: true, details: details }); return;
      }
      // A setup timeout has a separate bounded chance to establish fixture ownership for cleanup.
      if (recover) windowsWaitUntil = Date.now() + 10000;
      var current = windows();
      windowsWaitUntil = null;
      // A fixture window can appear, or be re-created by the app, after the last observation retained it. Take it now
      // if it proves to be the fixture by the same rule as setup; anything unproven stays a failure, untouched.
      adopt(current, !recover);
      if (expected && !retained.length) reason(details, 'FIXTURE_WINDOW_NOT_RETAINED');
      var entries = retained.map(function(w) { return { window: w, retained: true }; });
      current.forEach(function(w) {
        if (!present(w, before) && !present(w, retained)) entries.push({ window: w, retained: false });
      });
      entries.forEach(function(entry, index) {
        var w = entry.window, row = { index: index, retained: entry.retained, expectedURL: expected || null,
          reasons: [], documentReads: [], present: present(w, current) };
        entry.row = row; details.windows.push(row);
        if (!row.present) return;
        active();
        var safe = inspect(w, row);
        if (!entry.retained) { reason(row, 'WINDOW_NOT_RETAINED'); failedWindows.push(row); return; }
        if (!safe) { failedWindows.push(row); return; }
        var close = attribute(w, 'AXCloseButton');
        if (!close) reason(row, 'CLOSE_BUTTON_MISSING');
        else {
          // A raw Ref value throws "Ref has incompatible type" here; the cast object presses (live, 2026-10-11).
          row.axPressStatus = Number($.AXUIElementPerformAction(ObjC.castRefToObject(close), $('AXPress')));
          if (row.axPressStatus !== 0) reason(row, 'AXPRESS_FAILED');
        }
      });
      var closeDeadline = Date.now() + 10000;
      current = pollWindows();
      while (retained.some(function(w) { return present(w, current); }) && Date.now() < closeDeadline) {
        active(); sample(); wait(); current = pollWindows();
      }
      entries.forEach(function(entry) {
        var w = entry.window, row = entry.row;
        // One document-level close can remove several retained windows.
        current = pollWindows();
        row.stillPresentAfter10s = present(w, current);
        if (!row.stillPresentAfter10s) return;
        reason(row, 'WINDOW_STILL_PRESENT_AFTER_10S');
        // Revalidate the retained reference after waiting, immediately before scripting.
        active();
        if (!inspect(w, row)) { failedWindows.push(row); return; }
        if (!entry.retained || !clean || failedWindows.length) return;
        if (!ownFixture()) { reason(row, 'SCRIPTING_NOT_OWN_FIXTURE'); return; }
        row.scriptingPath = request.fixturePath;
        var script = 'tell application id ' + quote(request.bundle) + '\nclose (documents whose path is ' + quote(request.fixturePath) + ') saving no\nend tell';
        var error = Ref();
        try {
          var result = $.NSAppleScript.alloc.initWithSource($(script)).executeAndReturnError(error);
          row.scriptingStatus = result ? 0 : Number((ObjC.deepUnwrap(error[0]) || {}).NSAppleScriptErrorNumber) || null;
        } catch (_) { row.scriptingStatus = null; }
        if (row.scriptingStatus !== 0) reason(row, 'SCRIPTING_FAILED');
      });
      var scriptDeadline = Date.now() + 10000;
      current = pollWindows();
      while (entries.some(function(entry) { return entry.row.scriptingPath && present(entry.window, current); }) && Date.now() < scriptDeadline) {
        active(); sample(); wait(); current = pollWindows();
      }
      entries.forEach(function(entry) {
        var row = entry.row; row.present = present(entry.window, current);
        // An unretained AX element can expire between the window list and its attribute reads.
        // Only an invalid pair (-25201 or -25202) plus final absence excuses it; readable foreign windows latch the stop.
        if (!entry.retained && !row.present && invalidWindows.indexOf(row) >= 0 && invalidCode(row.sheetStatus) &&
          row.documentReads.every(function(read) { return invalidCode(read.status); })) row.gone = true;
        if (row.present) { failedWindows.push(row); if (row.scriptingPath) reason(row, 'WINDOW_STILL_PRESENT_AFTER_SCRIPTING'); }
        if (row.reasons.indexOf('SCRIPTING_FAILED') >= 0) failedWindows.push(row);
      });
      if (failedWindows.some(function(row) { return !row.gone; })) clean = false;
      if (details.reasons.length) clean = false;
      if (launched && clean) {
        active();
        var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        details.app = { pid: pid, terminated: false };
        if (!app || ObjC.unwrap(app.bundleIdentifier) !== request.bundle) { reason(details, 'APP_IDENTITY_UNCONFIRMED'); clean = false; }
        else if (pollWindows().length) { reason(details, 'APP_HAS_WINDOWS'); clean = false; }
        else {
          details.app.terminateRequested = !!app.terminate;
          var deadline = Date.now() + 30000;
          while (!app.terminated && Date.now() < deadline) { active(); sample(); wait(); }
          details.app.terminated = !!app.terminated;
          if (!app.terminated) { reason(details, 'APP_NOT_TERMINATED'); clean = false; }
        }
      }
    } catch (error) {
      clean = false;
      reason(details, error.message === 'WINDOWS_READ_FAILED' ? error.message : error.message === 'HOST_STOP' ? 'HOST_ABORTED' : 'CLEANUP_FAILED');
      if (error.axStatus !== undefined) details.axStatus = error.axStatus;
      details.error = String(error.message || error).slice(0, 200);
    }
    emit({ stage: 'cleanup', confirmed: clean, details: details });
  }
  try {
    var initial = liveInstances();
    wasRunning = initial.length > 0; target = wasRunning ? initial[0] : null;
    pid = target ? Number(target.processIdentifier) : null;
    before = windows();
    sample(); armedAt = Date.now(); emit({ stage: 'armed', wasRunning: wasRunning, windowCount: windowCount, ownArgv: ownArgv() });
    var end = Date.now() + 600000;
    while (Date.now() < end) {
      var raw = $.NSString.stringWithContentsOfFileEncodingError(request.control, $.NSUTF8StringEncoding, null);
      var command = raw ? JSON.parse(ObjC.unwrap(raw)).command : '';
      if (command === 'abort') { emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['HOST_ABORTED'], windows: [] } }); return ''; }
      if (command === 'launched') sawLaunch = true;
      // finish without a launch command means the runtime's open never completed: nothing here is proven to be ours.
      if (command === 'finish' && !sawLaunch) {
        emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['LAUNCH_UNCONFIRMED'], windows: [] } }); return '';
      }
      if ((command === 'launched' || command === 'finish') && !ready) {
        hostStage = 'retain';
        if (!startWait) startWait = { budgetMs: startupMs, startedAt: Date.now(), polls: 0, instances: null, relaunches: 0, exited: false,
          ambiguousPolls: 0, launchingPolls: 0, finishedLaunching: false, windowsStatus: {}, lastWindowsStatus: null, windowCount: null, pending: 0 };
        if (startupStep()) {
          ready = true; hostStage = 'ready';
          emit({ stage: 'ready', launched: launched, pid: pid, windowCount: windowCount, relaunches: startWait.relaunches,
            waitMs: Date.now() - startWait.startedAt });
        } else if (command !== 'finish' && Date.now() - startWait.startedAt >= startupMs) throw startupError();
      } else if (ready) retain();
      if (command === 'finish') {
        cleanup(!ready); return '';
      }
      sample(); wait();
    }
    emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['HOST_TIMEOUT'], windows: [] } });
    return '';
  } catch (error) {
    var details = { message: String(error.message || error).slice(0, 500), stage: hostStage, windowCount: windowCount };
    if (error.axStatus !== undefined) details.axStatus = error.axStatus;
    if (startWait && !ready) details.startWait = startupSummary();
    emit({ stage: 'error', error: details });
    // A failed setup still owns its launched fixture. Keep the observer alive to close it.
    if (!cleanupReported) {
      windowsWaitUntil = null;
      if (pid && hostStage !== 'baseline') cleanup(true);
      else emit({ stage: 'cleanup', confirmed: false, details: { reasons: ['CLEANUP_FAILED'], windows: [] } });
    }
    return '';
  }
}
