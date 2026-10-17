// Fixture controls for late-alert-probe.mjs only. Reads through Accessibility, quits through
// NSRunningApplication, and sends one kind of Apple event: System Events clicking an owned fixture's
// own Don't Save at quit. Never an Apple event to the fixture app itself, never the pointer.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');

var BANK = /^\/private\/tmp\/sleight-late-alert-[A-Za-z0-9]{6}$/;
var DONT_SAVE = /^(?:Don't Save|Don’t Save)$/;

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
function pointer() {
  var point = $.CGEventGetLocation($.CGEventCreate(null));
  return { x: Number(point.x), y: Number(point.y) };
}
function frontPid() { return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier); }
// /tmp is a symlink into /private; apps report either form.
function normalPath(path) {
  return String(path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '');
}
function filePath(url) {
  var match = typeof url === 'string' && /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(url);
  if (!match) return null;
  try { return normalPath(decodeURIComponent(match[1])); } catch (error) { return null; }
}
function underBank(url, bank) {
  var path = filePath(url), root = normalPath(bank);
  return path !== null && (path === root || path.indexOf(root + '/') === 0);
}
// A window is the probe's when its document lies in the bank, or when it has no document and carries the
// title the probe gave it (the unique Finder folder, or TextEdit's Untitled in a TextEdit the probe launched).
function owned(doc, title, request) {
  if (typeof doc === 'string') return underBank(doc, request.bank);
  return typeof request.title === 'string' && title === request.title;
}
function sheetCount(window) {
  var count = 0;
  array(attribute(window, 'AXChildren', true)).slice(0, 256).forEach(function (child) {
    if (scalar(attribute(child, 'AXRole', true)) === 'AXSheet') count++;
  });
  return count;
}
function process(request) {
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
  if (!running || running.isNil() || running.isTerminated) return null;
  if (ObjC.unwrap(running.bundleIdentifier) !== request.bundle) throw new Error('Process identity changed');
  if (request.birth && Number(running.launchDate.timeIntervalSince1970) * 1000 !== request.birth) throw new Error('Process incarnation changed');
  return running;
}
function windows(request) {
  var app = $.AXUIElementCreateApplication(request.pid), focused = attribute(app, 'AXFocusedWindow', true);
  return array(attribute(app, 'AXWindows')).slice(0, 64).map(function (window) {
    var doc = scalar(attribute(window, 'AXDocument', true)), title = scalar(attribute(window, 'AXTitle', true));
    return { element: window, doc: doc, title: title, owned: owned(doc, title, request),
      subrole: scalar(attribute(window, 'AXSubrole', true)), focused: !!focused && !!$.CFEqual(window, focused) };
  });
}
// Titles and paths leave the host only for the probe's own windows; other windows are counted.
function state(request) {
  if (!process(request)) return { ok: true, running: false };
  var all = windows(request), mine = all.filter(function (w) { return w.owned; });
  return { ok: true, running: true, front: frontPid(), pointer: pointer(),
    dialogs: all.filter(function (w) { return !w.owned && (w.subrole === 'AXDialog' || w.subrole === 'AXSystemDialog'); }).length,
    others: all.length - mine.length, focusedOther: all.some(function (w) { return w.focused && !w.owned; }),
    windows: mine.map(function (w) {
      return { title: w.title, url: w.doc, subrole: w.subrole, focused: w.focused, sheets: sheetCount(w.element),
        edited: scalar(attribute(w.element, 'AXEdited', true)) === true };
    }) };
}
function labels(node) {
  var found = [], walk = function (node, depth) {
    if (depth > 10 || found.length > 300) return;
    ['AXTitle', 'AXValue', 'AXDescription'].forEach(function (name) {
      var value = scalar(attribute(node, name, true));
      if (typeof value === 'string') found.push(value);
    });
    array(attribute(node, 'AXChildren', true)).forEach(function (child) { walk(child, depth + 1); });
  };
  walk(node, 0);
  return found;
}
function pressButton(node, pattern, depth) {
  if (depth > 10) return false;
  if (scalar(attribute(node, 'AXRole', true)) === 'AXButton' && pattern.test(String(scalar(attribute(node, 'AXTitle', true))))) {
    return Number($.AXUIElementPerformAction(node, $('AXPress'))) === 0;
  }
  return array(attribute(node, 'AXChildren', true)).some(function (child) { return pressButton(child, pattern, depth + 1); });
}
// The owned fixture's own Don't Save, proved by its text naming the fixture, clicked through System Events.
function answerDontSave(request, element) {
  var text = labels(element);
  if (!text.some(function (t) { return t.indexOf(request.stem) >= 0; }) || !text.some(function (t) { return DONT_SAVE.test(t); })) return false;
  var se = Application('System Events'), procs = se.processes.whose({ unixId: request.pid })();
  if (procs.length !== 1) throw new Error('System Events process identity ambiguous');
  var buttons = [], collect = function (group) {
    try { group.buttons().forEach(function (b) { if (DONT_SAVE.test(b.name())) buttons.push(b); }); } catch (error) {}
  };
  procs[0].windows().forEach(function (window) {
    var subrole = null, url = null, texts = [];
    try { subrole = window.subrole(); } catch (error) {}
    try { url = window.attributes.byName('AXDocument').value(); } catch (error) {}
    // A sheet on an owned document window, or an alert window whose text names the fixture.
    if (underBank(url, request.bank)) { try { window.sheets().forEach(collect); } catch (error) {} }
    else if (subrole === 'AXDialog') {
      try { texts = window.staticTexts().map(function (t) { return String(t.value()); }); } catch (error) {}
      if (texts.some(function (t) { return t.indexOf(request.stem) >= 0; })) collect(window);
    }
  });
  if (buttons.length !== 1) throw new Error('Owned Don\'t Save target ambiguous');
  buttons[0].click();
  return true;
}
function gone(request) {
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
  return !running || running.isNil() || running.isTerminated;
}
function edited(w) { return scalar(attribute(w.element, 'AXEdited', true)) === true; }
// With closeOwn (TextEdit): close the probe's own document windows by their close buttons first, answering only
// their own Don't Save, and confirm they are gone. Quit only if no remaining window is edited: an edited untitled
// document autosaves into the owner's iCloud folder when TextEdit quits, so it is left for a person.
function quit(request) {
  if (!process(request)) return { ok: true, exited: true };
  var answered = false, terminated = false, closed = 0, others = 0, pressedAt = 0, deadline = Date.now() + 30000;
  if (request.closeOwn) {
    for (;;) {
      if (Date.now() > deadline) return { ok: false, exited: false, closed: closed, error: 'Owned document close unconfirmed' };
      var mine;
      try { mine = windows(request).filter(function (w) { return w.owned; }); } catch (error) { delay(0.1); continue; }
      if (!mine.length) break;
      try {
        var w = mine[0];
        if (sheetCount(w.element)) {
          if (!answered && !(answered = answerDontSave(request, w.element))) return { ok: false, exited: false, error: 'A sheet other than Don\'t Save is on the owned document; close refused' };
        } else if (Date.now() - pressedAt > 2000) {
          pressedAt = Date.now();
          if (Number($.AXUIElementPerformAction(attribute(w.element, 'AXCloseButton'), $('AXPress'))) !== 0) throw new Error('Owned close failed');
          closed++;
        }
      } catch (error) { if (/Owned|ambiguous/.test(error.message)) return { ok: false, exited: false, error: error.message }; }
      delay(0.2);
    }
    var rest;
    try { rest = windows(request); } catch (error) { return { ok: false, exited: false, closed: closed, error: 'Remaining windows unreadable; quit refused' }; }
    others = rest.length;
    if (rest.some(edited)) return { ok: false, exited: false, closed: closed, others: others, error: 'Another window is edited; quit refused, app left running' };
  }
  while (Date.now() < deadline) {
    if (gone(request)) return { ok: true, exited: true, answered: answered, closed: closed, others: others };
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
    if (!terminated) terminated = !!running.terminate;
    var front = frontPid();
    // A quitting app can fail AX reads (Excel answered -25204 on 2026-10-17); keep waiting for exit.
    try {
      if (!answered && (front === request.front || front === request.pid)) {
        windows(request).forEach(function (w) {
          if (answered) return;
          if ((w.owned && sheetCount(w.element)) || (!w.owned && w.subrole === 'AXDialog' && w.doc === null)) answered = answerDontSave(request, w.element);
        });
      }
    } catch (error) { if (/ambiguous/.test(error.message)) return { ok: false, exited: false, error: error.message }; }
    delay(0.1);
  }
  return { ok: false, exited: false, answered: answered, error: 'Fixture app exit unconfirmed' };
}
// Finder stays running: close only the probe's own folder window, by its close button.
function finderClose(request) {
  var all = windows(request), mine = all.filter(function (w) { return w.owned; });
  if (all.some(function (w) { return !w.owned && w.subrole === 'AXDialog'; })) throw new Error('A Finder dialog is up; close refused');
  mine.forEach(function (w) {
    if (sheetCount(w.element)) throw new Error('A sheet is on the owned Finder window; close refused');
    var close = attribute(w.element, 'AXCloseButton');
    if (Number($.AXUIElementPerformAction(close, $('AXPress'))) !== 0) throw new Error('Owned Finder close failed');
  });
  for (var deadline = Date.now() + 5000; windows(request).some(function (w) { return w.owned; });) {
    if (Date.now() > deadline) throw new Error('Owned Finder close unconfirmed');
    delay(0.1);
  }
  return { ok: true, closed: mine.length };
}
// Fallback only: the Finder alert naming the probe's file, answered with its OK button through Accessibility.
function finderDismiss(request) {
  var pressed = 0;
  windows(request).forEach(function (w) {
    if (w.owned || w.subrole !== 'AXDialog') return;
    if (!labels(w.element).some(function (t) { return t.indexOf(request.text) >= 0; })) return;
    if (pressButton(w.element, /^OK$/, 0)) pressed++;
  });
  return { ok: true, pressed: pressed };
}
function run(argv) {
  try {
    var request = JSON.parse(argv[0]);
    if (request.op === 'preflight') {
      if (!$.AXIsProcessTrusted()) throw new Error('Accessibility unavailable; no permission requested');
      var running = {};
      (request.bundles || []).forEach(function (bundle) {
        running[bundle] = Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle).count);
      });
      return JSON.stringify({ ok: true, front: frontPid(), pointer: pointer(), running: running });
    }
    if (!BANK.test(request.bank || '')) throw new Error('Invalid fixture bank');
    if (request.op === 'bind') {
      var apps = array($.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.bundle)).filter(function (app) {
        return Number(app.launchDate.timeIntervalSince1970) * 1000 >= request.started - 1000;
      });
      if (apps.length > 1) throw new Error('Ambiguous fixture launch');
      return JSON.stringify(apps.length ? { ok: true, pid: Number(apps[0].processIdentifier),
        birth: Number(apps[0].launchDate.timeIntervalSince1970) * 1000 } : { ok: true });
    }
    if (request.op === 'finder-pid') {
      var finders = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder');
      if (Number(finders.count) !== 1) throw new Error('Expected one Finder');
      return JSON.stringify({ ok: true, pid: Number(finders.objectAtIndex(0).processIdentifier) });
    }
    if (!Number.isInteger(request.pid) || request.pid < 1) throw new Error('Fixture process unbound');
    if (request.op === 'state') return JSON.stringify(state(request));
    if (request.op === 'quit') return JSON.stringify(quit(request));
    if (request.op === 'finder-close') return JSON.stringify(finderClose(request));
    if (request.op === 'finder-dismiss') return JSON.stringify(finderDismiss(request));
    throw new Error('Unknown fixture operation');
  } catch (error) { return JSON.stringify({ ok: false, error: String(error.message || error) }); }
}
