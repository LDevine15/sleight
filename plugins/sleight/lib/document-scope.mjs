import { promptNotice } from './prompt-notice.mjs';
import { elementWait } from './element-wait.mjs';
// Header identity is a cooperative runtime observation, not an OS capability.
// Mark full trees the guard writes, which the relay compacts (compact-reads.mjs).
export const GUARD_MARK = '[sleight:guard-read]\n';
export const GUARD_OMIT_MARK = '[sleight:guard-read-omitted]\n';
export const GUARD_END = '\n[/sleight:guard-read]\n';
export const GUARD_READY = '[sleight:guard-ready]';

// The engine's window header line: `Window: "<title>", App: <name>.` windowFromText repeats it, as the
// guard runs that function's source in the engine.
export const WINDOW_HEADER = /^Window: (.*), App: (.+)\r?$/m;

export function windowFromText(text) {
  // The title is one JSON string. Safari writes a raw inch mark inside it (bestbuy.com, 2026-10-11:
  // 23.8"), which is not JSON, so take the quotes off when parsing throws. Two headers still disagree.
  const headers = [...text.matchAll(/^Window: (.*), App: (.+)\r?$/gm)];
  const windows = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const section = text.slice(header.index + header[0].length, headers[i + 1]?.index);
    const urls = [...section.matchAll(/^(?:URL: (.+)|0 [^\r\n]*?\bURL: (.*?)(?:, (?:Secondary Actions|ID|Help):.*)?)\r?$/gm)];
    if (urls.length > 1) return undefined;
    let title;
    try {
      const value = JSON.parse(header[1]);
      if (typeof value === 'string') title = value;
    } catch { /* A raw quote in the title is not a JSON string. */ }
    if (title === undefined && header[1].startsWith('"') && header[1].endsWith('"')) title = header[1].slice(1, -1);
    if (title === undefined) return undefined;
    windows.push({ title, app: header[2].trim().replace(/\.$/, ''), url: (urls[0]?.[1] ?? urls[0]?.[2])?.trim() || null });
  }
  if (!windows.length || windows.some(w => !w.app)) return undefined;
  if (windows.some(w => JSON.stringify(w) !== JSON.stringify(windows[0]))) return undefined;
  return windows[0];
}

// Element number -> line text without the number, for one tree.
export function elementLines(text) {
  return new Map(text.split('\n').map(line => /^(\t*)(\d+) (.*)$/.exec(line)).filter(Boolean).map(m => [Number(m[2]), m[3]]));
}

// Parent and ancestry come from indentation, never words in a control's label.
function elementContexts(text) {
  const stack = [], contexts = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    if (!m) { stack.length = 0; continue; }
    const depth = m[1].length;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1), menu = /^menu bar(?:$|,| (?!item\b))/.test(m[3]) || !!parent?.menu;
    const content = !menu && !!(parent?.content || parent?.window);
    contexts.set(Number(m[2]), { parent: parent?.line ?? 'unknown (root)', menu, content });
    const label = m[3].split(/(?:, | )(?=(?:Value|ID|Help|Secondary Actions):)/)[0];
    stack.push({ depth, line: label, menu, content, window: /^(?:standard window|sheet|dialog)(?: |,|$)/.test(m[3]) });
  }
  return contexts;
}

// Whether an element line carries exactly this AX identifier, as `ID: Seven`
// ending the line or followed by a comma. Identifiers can hold colons and
// semicolons ("Mode: scientific; unitConversion: false").
export function hasIdentifier(line, id) {
  for (let at = line.indexOf('ID: ' + id); at >= 0; at = line.indexOf('ID: ' + id, at + 1)) {
    const end = at + 4 + id.length;
    if ((at === 0 || line[at - 1] === ' ') && (end === line.length || line[end] === ',')) return true;
  }
  return false;
}

// Whether an element line is labeled this, by its description
// ("button Description: 7, ID: Seven") or its title after the lowercase role
// ("button Multiply", "toggle button Bold").
export function hasLabel(line, label) {
  const ends = at => at === line.length || line[at] === ',';
  // A menu bar item's line is its name alone ("Edit"), with no role (finder-files, 2026-10-09).
  if (line.startsWith(label) && ends(label.length)) return true;
  const described = line.indexOf('Description: ' + label);
  if (described >= 0 && ends(described + 13 + label.length)) return true;
  // The role is one or more lowercase words, so try each space in that run. States in parentheses
  // can come between the role and the title: "text field (settable) Email" (safari-form).
  const role = /^[a-z][a-z ]*/.exec(line)?.[0] ?? '';
  for (let at = role.indexOf(' '); at >= 0; at = role.indexOf(' ', at + 1)) {
    let start = at + 1;
    for (let state; (state = /^\([^()]*\) /.exec(line.slice(start)));) start += state[0].length;
    if (line.startsWith(label, start) && ends(start + label.length)) return true;
  }
  return false;
}

// A label that only a disabled element carries: which element, and the enabled elements beside it.
// "no element with label" for Finder's disabled Cut and Move Item Here cost four calls before Copy
// (finder-move-2, 2026-10-17). A role-less menu item reads "(disabled) Cut".
export function disabledLabelNote(text, label) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\t*)(\d+) (.*)$/.exec(line);
    rows.push(m ? { depth: m[1].length, number: Number(m[2]), body: m[3] } : undefined);
  }
  const disabled = body => /^(?:[a-z][a-z ]* )?\([^()]*\bdisabled\b[^()]*\)/.test(body);
  const named = body => hasLabel(body, label) || hasLabel(body.replace(/^\([^()]*\) /, ''), label);
  const hits = rows.map((row, at) => [row, at]).filter(([row]) => row && disabled(row.body) && named(row.body));
  if (hits.length !== 1) return undefined;
  const [hit, at] = hits[0], beside = [];
  const name = body => body.replace(/^(?:[a-z][a-z ]* )?(?:\([^()]*\) )*/, '')
    .split(/(?:^|, )(?:Value|ID|Help|Secondary Actions|URL):/)[0].replace(/^Description: /, '');
  for (const step of [-1, 1]) {
    for (let i = at + step; rows[i] && rows[i].depth >= hit.depth; i += step) {
      if (rows[i].depth === hit.depth && !disabled(rows[i].body) && name(rows[i].body)) beside.push({ ...rows[i], distance: Math.abs(i - at) });
    }
  }
  // The eight nearest, in tree order, each name cut to 40 characters.
  const near = [...beside].sort((a, b) => a.distance - b.distance).slice(0, 8).sort((a, b) => a.number - b.number);
  const cut = value => value.length > 40 ? value.slice(0, 37) + '...' : value;
  const shown = near.map(row => row.number + ' ' + cut(name(row.body))).join(', ');
  return /* notice */ JSON.stringify(label) + ' is element ' + hit.number + ', and it is disabled.' +
    (shown ? ' Enabled beside it: ' + shown + (beside.length > near.length ? ' and ' + (beside.length - near.length) + ' more' : '') + '.' : '') +
    ' A disabled item needs a selection or an earlier step, such as Copy before Paste or Move.';
}

// Whether two lines for one element number are the same element. A read on a busy Mac can drop an
// element's attributes and keep only its role and a name: "button Two" for "button Description: 2,
// ID: Two" (5 of 5 batched calls under load, 2026-10-09). A bare line matches a fuller one when the
// role is the same and the name is the fuller line's ID or label.
export function sameElement(was, now) {
  if (was === now) return true;
  if (typeof was !== 'string' || typeof now !== 'string') return false;
  const [full, bare] = was.length > now.length ? [was, now] : [now, was];
  const role = /^[a-z][a-z ]*/.exec(bare)?.[0] ?? '';
  for (let at = role.indexOf(' '); at >= 0; at = role.indexOf(' ', at + 1)) {
    const name = bare.slice(at + 1);
    if (!name || /,|: /.test(name) || !full.startsWith(bare.slice(0, at + 1))) continue;
    if (hasIdentifier(full, name) || hasLabel(full, name)) return true;
  }
  return false;
}

// Only a resolved focus outside the clicked field's subtree proves a mismatch.
// Missing rows or focus leave the existing misplaced-text observation to report it.
function differentFocusTarget(text, before) {
  const focus = /^The focused UI element is (\d+) (.+)\r?$/m.exec(text ?? '');
  if (!focus) return;
  const rows = (text ?? '').split('\n').map(line => /^(\t*)(\d+) (.*)\r?$/.exec(line)).filter(Boolean)
    .map(m => ({ depth: m[1].length, number: Number(m[2]), line: m[3] }));
  const resolve = (number, line) => {
    const numbered = rows.find(row => row.number === number && sameElement(line, row.line));
    if (numbered) return numbered;
    const matches = rows.filter(row => sameElement(line, row.line));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const clicked = resolve(before.number, before.line), focused = resolve(Number(focus[1]), focus[2]);
  if (!clicked || !focused) return;
  const start = rows.indexOf(clicked);
  for (let i = start; i < rows.length; i++) {
    if (i > start && rows[i].depth <= clicked.depth) break;
    if (rows[i] === focused) return;
  }
  return clicked.number;
}

export const documentKey = window => window && JSON.stringify(window);
export const documentLabel = window => `${JSON.stringify(window.title)} in ${window.app}${window.url ? ` (${window.url})` : ''}`;

// A menu open in front of a window: its header has the window's title and app but no URL, and the root is
// the menu ("0 menu …") or its named parent with an unnamed menu below ("0 Format, Secondary Actions:
// Cancel, Pick" then "\t1 menu").
export function menuRoot(text) {
  const lines = String(text ?? '').split('\n'), at = lines.findIndex(line => /^0 /.test(line));
  if (at < 0) return false;
  return /^0 menu(?: (?!bar\b)|,|$)/.test(lines[at]) ||
    (/(?:^0 |, )Secondary Actions: (?:[^,]*, )*Cancel(?:,|$)/.test(lines[at]) && /^\t1 menu(?: |,|$)/.test(lines[at + 1] ?? ''));
}

// Title always; URL only when the expected window named one.
export function windowMatches(expected, observed) {
  if (!expected || !observed || expected.title !== observed.title) return false;
  return !expected.url || expected.url === observed.url;
}

export function isCancelAction(name, args, text = '') {
  if (name === 'pressKey') return /^(?:Escape|esc)$/i.test(args[0]);
  if (name !== 'click' || !Number.isInteger(Number(args[0]))) return false;
  return text.split('\n').some(line => {
    const button = /^\s*(\d+) button(?: \(.*?\))? Cancel(?:,|$)/.exec(line);
    return button && Number(button[1]) === Number(args[0]);
  });
}

// Only a standalone acquisition or inventory read can cross a closed gate.
// No comments, arbitrary acquisition arguments or extra statements.
// An acquisition followed only by printing its own handle (`let app = await cua.getApp("X"); app`,
// or console.log(app)) is still just a read: 42 of 101 guard reads after a call followed one of
// these, though the engine's output already had the window header (2026-10-10 study).
export function withoutEcho(code = '') {
  const text = String(code).trim();
  const m = /^((?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\([^;]*\))\s*;\s*(?:console\.log\(\s*([A-Za-z_$][\w$]*)\s*\)|nodeRepl\.write\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*;?$/.exec(text);
  return m && [m[3], m[4], m[5]].includes(m[2]) ? m[1] : text;
}

export function isDocumentRead(code = '') {
  code = withoutEcho(code);
  return /^(?:(?:(?:let|const|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*(?:windowId|"windowId")\s*:\s*\d+\s*\})\s*\)\s*;?$/.test(code.trim()) ||
    /^await\s+cua\.(?:getState|listApps|listWindows)\(\s*\)\s*;?$/.test(code.trim());
}

// Marks the window inventory an acquisition writes, which the relay keeps and strips.
export const WINDOWS_MARK = '[sleight:windows]';
const ACQUISITION = /^(?:(?:let|const|var)\s+)?(?:[A-Za-z_$][\w$]*\s*=\s*)?await\s+cua\.getApp\([^;]*\)\s*;?$/;

export function readCode(code, options = {}) {
  // Every acquired handle, including const bindings, must receive the proxy
  // before it escapes. A bare acquisition also restores the conventional handle.
  const read = /^await\s+cua\.getApp\(/.test(code.trim()) ? 'globalThis.app = ' + code.trim() : code;
  // Before an acquisition, the windows of every app as the inventory lists them (about 11 ms), so
  // the next call's guard can reuse this read if they haven't changed. It goes first: listApps after
  // getApp drops the app from the result's metadata, where the relay finds its bundle ID.
  const inventory = ACQUISITION.test(withoutEcho(code)) ? `try { nodeRepl.write(${JSON.stringify(WINDOWS_MARK)} + JSON.stringify((await cua.listApps({ emit: false })).filter(a => a.windows?.length).map(a => ({ id: a.id, windows: a.windows }))) + '\\n'); } catch {}\n` : '';
  return guardSetup(undefined, options) + '\n' + inventory + read;
}

// Advisory only: all of this runs in the same mutable JS realm as Claude's code.
export function guardedCode(code, window, reason = /* notice */ 'Document scope stopped this action: window or URL changed. Read the window and ask the user with document_scope.', lease, options = {}) {
  // The lease needs a full header after the call. A read Claude made after its
  // last action already wrote one, so the guard reads again only without it.
  const { reuseSetup, acknowledge, prompt, ...checks } = options;
  return guardSetup({ window, reason, lease, ...checks }, { reuseSetup, acknowledge, prompt }) +
    (options.browserCandidate ? '\nglobalThis.__sleightDocumentGuard.activeApp = undefined;' : '') + /* generated code */ `\n${code}
{
  const guard = globalThis.__sleightDocumentGuard, last = guard.activeApp && guard.reads.get(guard.activeApp);
  // The call finished, so any failed action was one it didn't await or caught itself.
  if (guard.failures?.length) nodeRepl.write('sleight: an action in this call failed, and the call went on without it: ' + guard.failures.join('; ') + '. Read the window, then redo it with await.\\n');
  // A caught getApp failure sent no input, so it isn't a failed action; a later getApp that worked cleared it.
  if (guard.getAppFailures?.length) {
    const caught = guard.getAppFailures.join('; ');
    nodeRepl.write('sleight: ' + caught + (caught.endsWith('.') ? '' : '.') + '\\n');
  }
  if (guard.activeApp && !last?.emitted && !last?.omit) {
    const split = !guard.acted && guard.activeApp === guard.startApp && guard.prior?.split;
    const text = last?.text ?? (split ? guard.prior.text : await guard.readAfter(guard.activeApp));
    nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
  }
  if (guard.resultMark && guard.typed.length) nodeRepl.write(guard.resultMark + JSON.stringify({ typed: guard.typed }) + '\\n');
}`;
}

function guardSetup(update, { reuseSetup = false, acknowledge = false, prompt } = {}) {
  // Notice text the guard throws or writes, in its SLEIGHT_PROMPT wording.
  const quoted = text => JSON.stringify(promptNotice(text, prompt));
  // Keep executable code in the runtime, never observations. The relay selects the small form
  // only after a completed installation, and a missing setup stops before the caller's code.
  const install = reuseSetup ? '' : /* generated code */ `globalThis.__sleightDocumentGuardSetup = update => {
    const parse = ${windowFromText.toString()};
    const isCancel = ${isCancelAction.toString()};
    const state = globalThis.__sleightDocumentGuard ||= {
      getApp: typeof cua.getApp === 'function' ? cua.getApp.bind(cua) : undefined, proxies: new WeakSet(), wrapped: new WeakMap()
    };
    if (update) {
      state.guarded = true; state.expected = update.window; state.reason = update.reason;
      state.lease = update.lease;
      state.fileOnly = !!update.fileOnly; state.cancelOnly = !!update.cancelOnly;
      state.adoptUrl = !!update.adoptUrl;
    }
    state.nativeDenied = update?.nativeDenied;
    state.timing = !!update?.timing;
    state.careful = !!update?.careful;
    state.firstOff = !!update?.firstOff && !!update?.focused && !state.careful && !state.fileOnly && !state.cancelOnly;
    state.quietEdits = !!update?.quietEdits && !state.careful;
    state.bind = !!update?.bind && !state.careful && !state.fileOnly && !state.cancelOnly;
    // The relay's native observations after a key press (light-return.mjs), for the light check below.
    state.light = update?.lightReturn?.path && !state.careful && !state.fileOnly && !state.cancelOnly ? { ...update.lightReturn } : undefined;
    state.binding = undefined;
    state.boundNumbers = new WeakMap();
    // The previous call's read, when the relay judged it reusable for this call's first action.
    state.prior = update?.prior;
    // Whether this call has acted, and the handle it started on. A call that took no action after the
    // relay split off its acquisition takes that read as its header instead of reading again: 53
    // such reads cost 27 s across the benchmark runs of 2026-10-09.
    state.acted = false; state.startApp = state.activeApp;
    state.actionVersion ??= 0;
    state.actionIndex = 0; state.completedActions = 0; state.ran = []; state.unknown = []; state.lastAction = null; state.guardStopMark = update?.guardStopMark;
    state.inputSent = false;
    // Text this call typed, pasted or set, so a window it named (a saved or opened file) is its own.
    state.typed = [];
    state.resultMark = update?.resultMark;
    // What Claude was last shown for the numbers this call acts on (number -> line).
    state.seenLines = update?.seenLines;
    // Numbers written as literals in this call's code. Any other number was computed, usually from a
    // read the code made itself, and refers to that read (codeReads: handle -> its latest element lines).
    // Without the list (a caller other than the relay), every number counts as a literal, as before.
    state.literals = update?.literals ? new Set(update.literals) : undefined;
    state.codeReads = new WeakMap();
    // Literal numbers whose line was unique in the tree Claude saw (the relay's view of it).
    state.uniqueSeen = new Set(update?.uniqueSeen ?? []);
    const clock = () => globalThis.performance?.now() ?? Date.now();
    const timedRead = async (raw, phase) => {
      const start = clock();
      let text;
      try { return text = await raw.getAXState({ disableDiffing: true, emit: false }); }
      finally {
        if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase,
          ms: clock() - start, chars: typeof text === 'string' ? text.length : 0, failed: text === undefined }) + '\\n');
      }
    };
    state.readAfter = proxy => timedRead(state.raws.get(proxy), 'after-call');
    state.raws ||= new WeakMap();
    // Full reads taken in this call since the handle's last action. A new call
    // always reads again, because the user may have changed the window between.
    state.reads = new WeakMap();
    // Each handle's latest window header in this call. It survives actions, so a later key, text
    // or coordinate action can go ahead on it without a read.
    state.callHeaders = new WeakMap();
    // Each handle's previous action in this call, which decides whether the next may skip its read.
    state.previous = new WeakMap();
    const hasModal = text => /^\\s*\\d+ (?:sheet|dialog)\\b/m.test(text ?? '');
    const clickOpenedModal = (proxy, text) => {
      const before = state.previous.get(proxy);
      if (!before) return false;
      const current = parse(text);
      if (before.observed) return !!before.opened && !!current && hasModal(text) &&
        ['title', 'app', 'url'].every(key => current[key] === before.opened[key]);
      // Only the first tree after the click can establish its sheet. Later reads may retain
      // that same identity, but cannot attribute a newly appearing sheet to an old click.
      before.observed = true;
      if (before.name === 'click' && before.modal === false && hasModal(text)) before.opened = current;
      return !!before.opened;
    };
    state.failures = []; state.getAppFailures = [];
    // Element lines at this call's first action, which Claude's numbers refer to.
    state.callElements = new WeakMap();
    const elements = ${elementLines.toString()};
    const contexts = ${elementContexts.toString()};
    const hasIdentifier = ${hasIdentifier.toString()};
    const hasLabel = ${hasLabel.toString()};
    const disabledLabelNote = ${disabledLabelNote.toString()};
    const sameElement = ${sameElement.toString()};
    const differentFocusTarget = ${differentFocusTarget.toString()};
    const wait = ${elementWait.toString()};
    const checkNative = () => { if (state.nativeDenied) throw new Error(state.nativeDenied); };
    // After Return, Enter, Tab, Escape or Space, typeText or paste goes ahead without the settled tree
    // read (about 470 ms in Excel, 2026-10-17) when two native observations that began at least waitMs
    // after the key, and gapMs apart, show the expected title and URL in the app's focused window (and
    // its certified number, which the relay asks for), no sheet on it, and focus on a text or cell
    // element inside it that isn't a password field. The newest must have ended within freshMs, and the
    // key must be less than windowMs old (the observer stops then), so a wait or a slow call between the
    // key and the typing reads. So does any other call on an app handle in between. Any other
    // observation, or none before deadlineMs, reads the whole tree as before. A call stops trying after
    // a wait that got no observation at all, or after two refusals.
    const lightRole = /^AX(?:TextField|TextArea|ComboBox|SearchField|Cell|Table|Grid|LayoutArea)$/;
    const lightCheck = async before => {
      const light = state.light, start = clock(), entered = Date.now();
      const windowMs = light.windowMs ?? 700, gap = light.gapMs ?? 50, freshMs = light.freshMs ?? 150;
      const since = before.done + (light.waitMs ?? 250), deadline = before.done + Math.min(light.deadlineMs ?? 600, windowMs);
      const good = o => o?.status === 'ok' && o.matches === 1 && o.window > 0 && o.title === state.expected?.title &&
        (o.url ?? null) === (state.expected?.url ?? null) && o.focus?.sheets === 0 && o.focus.inWindow === true &&
        lightRole.test(o.focus.role ?? '') && o.focus.subrole !== 'AXSecureTextField' && typeof o.end === 'number';
      let passed = false, seen = false, polled = false;
      // One touch since the key: this typeText or paste. A read, wait, screenshot or other handle in
      // between is another.
      if (state.touches === before.touches + 1) try {
        const fs = await import('node:fs/promises');
        for (;;) {
          if (Date.now() - before.done >= windowMs) break;
          polled = true;
          let observations = [];
          try { observations = JSON.parse(await fs.readFile(light.path, 'utf8')).observations ?? []; } catch {}
          const late = observations.filter(o => typeof o?.start === 'number' && o.start >= since);
          if (late.length) seen = true;
          if (observations.some(o => typeof o?.end === 'number' && o.end >= since && !good(o))) { seen = true; break; }
          const newest = late.at(-1), now = Date.now();
          if (late.length >= 2 && newest.start - late[0].start >= gap && now - newest.end <= freshMs && now - before.done < windowMs) { passed = true; break; }
          if (now >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, light.pollMs ?? 10));
        }
      } catch {}
      if (polled && !seen && entered < deadline) light.off = true;
      if (!passed && (light.refusals = (light.refusals ?? 0) + 1) >= 2) light.off = true;
      if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: passed ? 'light' : 'light-refused',
        ms: clock() - start, chars: 0, failed: false }) + '\\n');
      return passed;
    };
    const input = () => {
      if (!state.inputSent && state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ input: true }) + '\\n');
      state.inputSent = true;
    };
    const checkLease = async () => {
      if (!state.lease) return;
      const fs = await import('node:fs/promises');
      let record;
      try { record = JSON.parse(await fs.readFile(state.lease.path, 'utf8')); }
      catch { throw new Error('Input lease stopped this action: the lease file is unavailable. End the turn and read the window again.'); }
      if (record.token !== state.lease.token || record.expires <= Date.now()) {
        throw new Error('Input lease stopped this action: ownership lost or expired. End the turn and read the window again.');
      }
    };
    const wrap = target => {
      if (state.proxies.has(target)) return target;
      if (state.wrapped.has(target)) return state.wrapped.get(target);
      const proxy = new Proxy(target, { get(raw, name) {
        // Every use of a handle, for the light check's "nothing between the key and the typing".
        state.touches = (state.touches ?? 0) + 1;
        if (name === 'waitFor') return (() => {
          let pending;
          const checkCurrent = () => {
            if (state.reads !== pending.reads || pending.reads.get(proxy) !== pending.reading) {
              throw new Error('waitFor stopped: another action or read superseded this poll. Read the window again.');
            }
          };
          return wait({
          read: async () => {
            checkNative();
            state.binding = undefined;
            const reads = state.reads, reading = {};
            reads.set(proxy, reading); pending = { reads, reading };
            const text = await timedRead(raw, 'wait');
            checkCurrent();
            pending.modalOpened = clickOpenedModal(proxy, text);
            return text;
          },
          parse, elements, hasIdentifier, hasLabel, expected: state.guarded ? state.expected : undefined,
          acceptWindow: (current, text) => {
            checkCurrent();
            const before = state.previous.get(proxy);
            const shortcut = before?.name === 'pressKey' && typeof before.key === 'string' &&
              (before.key.includes('+') || /^(?:return|enter)$/i.test(before.key));
            const opener = before?.name === 'click' || shortcut;
            if (!state.adoptUrl || current.app !== state.expected?.app) return false;
            const adoptedUrl = state.expected.url == null && current.url && current.title === state.expected.title;
            const panel = current.title === '' && !current.url && !hasModal(text);
            const modal = !current.url && hasModal(text) && (shortcut || pending.modalOpened);
            const named = state.typed.some(typed => {
              const base = typed.trim().split('/').pop();
              if (base.length < 3) return false;
              let file;
              try { file = current.url?.startsWith('file://') ? decodeURIComponent(new URL(current.url).pathname).split('/').pop() : undefined; } catch {}
              return current.title === base || file === base;
            });
            if (!adoptedUrl && !panel && !(opener && (hasModal(text) ? modal :
                /^0 [^\\n]*\\bID: (?:save|open)-panel\\b/m.test(text) ||
                (!current.url && /^Untitled(?: \\d+)?$/.test(current.title)) || named))) return false;
            state.expected = current;
            return true;
          },
          observe: text => {
            checkCurrent();
            state.activeApp = proxy;
            state.reads.set(proxy, { text, emitted: true, modalOpened: pending.modalOpened });
          }
        }); })();
        const value = Reflect.get(raw, name);
        if (typeof value !== 'function') return value;
        // Claude's tree reads are full reads the relay turns into changed lines,
        // and they double as the guard's own read until the next action.
        if (name === 'getAXState') return async (options = {}) => {
          checkNative();
          state.binding = undefined;
          const reads = state.reads, reading = {}, version = state.actionVersion;
          reads.set(proxy, reading);
          const text = await raw.getAXState({ ...options, disableDiffing: true, emit: false });
          const emitted = options?.emit !== false;
          if (emitted) nodeRepl.write(${JSON.stringify(GUARD_MARK)} + text + ${JSON.stringify(GUARD_END)});
          else nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + text + ${JSON.stringify(GUARD_END)});
          // Input replaces the map; a newer observation replaces this entry.
          if (state.reads === reads && reads.get(proxy) === reading) reads.set(proxy, { text, emitted, omit: !emitted, version, modalOpened: clickOpenedModal(proxy, text) });
          if (typeof text === 'string' && parse(text)) state.codeReads.set(proxy, elements(text));
          state.activeApp = proxy;
          return text;
        };
        if (name === 'getAXStateAndScreenshot') return async (options = {}) => {
          checkNative();
          state.binding = undefined;
          // The combined observation already paid for a full AX walk. Keep its
          // state just as we keep getAXState, until the next action or call.
          const reads = state.reads, reading = {};
          reads.set(proxy, reading);
          const result = await value.call(raw, { ...options, disableDiffing: true });
          if (options?.emit === false && typeof result?.state === 'string') {
            nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + result.state + ${JSON.stringify(GUARD_END)});
          }
          if (state.reads === reads && reads.get(proxy) === reading) {
            const modalOpened = clickOpenedModal(proxy, result?.state);
            if (typeof result?.state === 'string' && parse(result.state)) reads.set(proxy, { text: result.state, emitted: options?.emit !== false, omit: options?.emit === false, modalOpened });
          }
          if (typeof result?.state === 'string' && parse(result.state)) state.codeReads.set(proxy, elements(result.state));
          state.activeApp = proxy;
          return result;
        };
        if (name === 'getScreenshot') return async (options = {}) => {
          checkNative();
          state.binding = undefined;
          const reads = state.reads, reading = {};
          reads.set(proxy, reading);
          // macOS captures AX and pixels together even for a screenshot. Ask
          // for both so that capture can also supply the guard's fresh header
          // and selectors, while returning/emitting only the requested image.
          if (typeof raw.getAXStateAndScreenshot === 'function') {
            const result = await raw.getAXStateAndScreenshot({ ...options, disableDiffing: true, emit: false });
            if (!result?.screenshot) throw new Error('Screenshot unavailable for this window.');
            if (options?.emit !== false) await nodeRepl.emitImage(result.screenshot);
            else if (typeof result.state === 'string') nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + result.state + ${JSON.stringify(GUARD_END)});
            if (state.reads === reads && reads.get(proxy) === reading) {
              const modalOpened = clickOpenedModal(proxy, result.state);
              if (typeof result.state === 'string' && parse(result.state)) reads.set(proxy, { text: result.state, emitted: false, omit: options?.emit === false, modalOpened });
            }
            state.activeApp = proxy;
            return result.screenshot;
          }
          const result = await value.call(raw, options);
          if (options?.emit === false) {
            const text = await state.readAfter(proxy);
            nodeRepl.write(${JSON.stringify(GUARD_OMIT_MARK)} + text + ${JSON.stringify(GUARD_END)});
            if (state.reads === reads && reads.get(proxy) === reading) reads.set(proxy, { text, emitted: false, omit: true });
          }
          state.activeApp = proxy;
          return result;
        };
        if (!['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction',
          'paste', 'pressKey', 'typeText'].includes(name)) return (...args) => { checkNative(); return value.apply(raw, args); };
        const act = async (attempt, ...args) => {
          checkNative();
          // The action as Claude wrote it, for a stop that lists what ran.
          // Typed, pasted, set or selected text shows as its length only.
          const textAt = ['typeText', 'paste'].includes(name) ? 0 : ['setValue', 'selectText'].includes(name) ? 1 : -1;
          const shown = name + '(' + args.slice(0, 2).map((arg, at) => {
            if (at === textAt && typeof arg === 'string') return '<' + arg.length + ' characters>';
            let text; try { text = JSON.stringify(arg); } catch {}
            text ??= String(arg);
            return text.length > 40 ? text.slice(0, 37) + '...' : text;
          }).join(', ') + ')';
          // click({ ref: 45 }) reached the engine as "elementIndex must be an integer" (finder-move-2, 2026-10-17).
          const locator = args[0];
          if (['click', 'scroll', 'selectText', 'setValue', 'performSecondaryAction'].includes(name) && locator && typeof locator === 'object' &&
              !Array.isArray(locator) && !['id', 'label', 'line'].some(key => typeof locator[key] === 'string')) {
            const number = Object.values(locator).find(value => Number.isInteger(value));
            throw new Error('sleight stopped before ' + shown + ': that object names no element. Pass an element number' +
              (number === undefined ? '' : ', as in ' + name + '(' + number + ')') + ${quoted(/* lean notice */ ', an [x, y] point, a label or ID string, or { id: "<ID>" }, { label: "<label>" }, both together, or { line: "<whole line after the number>" }.')});
          }
          const firstAction = !state.acted;
          state.acted = true;
          state.actionVersion++;
          await checkLease();
          if (state.fileOnly && name === 'pressKey' && isCancel(name, args)) {
            state.activeApp = proxy;
            state.reads = new WeakMap();
            input();
            let result;
            try { result = await value.apply(raw, args); } catch (error) { state.unknown.push(shown); throw error; }
            state.completedActions++;
            state.ran.push(shown);
            return result;
          }
          const cached = state.reads.get(proxy);
          let text = cached?.text, modalOpened = cached?.modalOpened ?? false;
          const treeFree = ['pressKey', 'typeText', 'paste'].includes(name) ||
            (['click', 'drag', 'scroll'].includes(name) && Array.isArray(args[0]));
          const skipFirst = firstAction && state.firstOff && proxy === state.startApp && treeFree &&
            typeof args[0] !== 'number' && !(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]));
          if (skipFirst) state.prior = undefined;
          // The acquisition just before this call read the whole tree. A launching app can take 15 s
          // per read under load (2026-10-09), so reuse it when the app's windows, as the inventory
          // lists them, are exactly what they were then.
          if (text === undefined && !skipFirst && state.prior && proxy === state.startApp) {
            const prior = state.prior; state.prior = undefined;
            const start = clock();
            // A read Claude made in the call just before, less than 10 s ago (the relay checks), is
            // used as it is: Claude chose this action from it. One that came with an inventory is
            // reused only while the app's windows match it: unchanged windows, or an app the
            // acquisition launched whose one window is the read's. Engine 26.1002.52244 lists no
            // windows at all, and two empty lists prove nothing, so then the guard reads.
            const now = prior.windows === null ? null
              : await cua.listApps({ emit: false }).then(apps => apps.filter(a => a.id === prior.id).map(a => a.windows ?? []), () => null);
            const same = prior.windows === null || (now?.length === 1 && now[0].length > 0 && (JSON.stringify(now[0]) === JSON.stringify(prior.windows) ||
              (prior.windows.length === 0 && now[0].length === 1 && now[0][0].title === prior.title)));
            if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: same ? 'reused' : 'reuse-refused', ms: clock() - start, chars: same ? prior.text.length : 0, failed: false }) + '\\n');
            if (same) text = prior.text;
          }
          // A read right after an action waits for the UI to settle: about 400 ms against 50 ms
          // for one before it, and tens of seconds on a loaded Mac (load-cost, 2026-10-09). Codex
          // makes no such read, and the owner chose speed (2026-10-09): keys, text and coordinates
          // after the call's first action go ahead on the header that action was checked against.
          // Numbered and named actions still read, since that is what catches renumbering, and
          // SLEIGHT_GUARD=careful reads before every action.
          // The read also waits for the UI to settle. After a click, a shortcut, Return, Escape, Tab or
          // Space, which can open a panel or sheet, the next action needs that wait: Cmd+O, then
          // Cmd+Shift+G, then typing a path outran the Open panel without it (textedit-drag, 2026-10-09).
          // Typing, pasting and plain keys change no window, so the action after them goes ahead.
          const before = state.previous.get(proxy);
          const checkFocus = ['typeText', 'paste'].includes(name) && before?.editable && before.completed;
          const spec = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : undefined;
          const bare = name === 'click' && typeof args[0] === 'string' && !/^\\d+$/.test(args[0]) ? args[0] : undefined;
          const byId = typeof spec?.id === 'string' || typeof spec?.label === 'string' || typeof spec?.line === 'string' || bare !== undefined;
          // { id, label } together: the elements with both (excel-edit-5, 2026-10-17: ten menu items shared the ID).
          const [kind, target, match] = bare !== undefined ? ['label or ID', bare, hasLabel]
            : typeof spec?.id === 'string' && typeof spec?.label === 'string' ? ['ID ' + JSON.stringify(spec.id) + ' and label', spec.label, (line, value) => hasIdentifier(line, spec.id) && hasLabel(line, value)]
            : typeof spec?.id === 'string' ? ['ID', spec.id, hasIdentifier]
            : typeof spec?.label === 'string' ? ['label', spec.label, hasLabel] : ['line', spec?.line, (line, value) => line === value];
          const findTarget = lines => {
            let found = [...lines].filter(([, line]) => match(line, target));
            if (bare !== undefined && !found.length) found = [...lines].filter(([, line]) => hasIdentifier(line, target));
            // A bare line carries no ID, so it can't satisfy { id, label }.
            if (!found.length && kind !== 'line' && !kind.endsWith(' and label')) found = [...lines].filter(([, line]) => /^[a-z][a-z ]* /.test(line) &&
              !/,|: /.test(line) && line.slice(/^[a-z][a-z ]*? (?=[^a-z ]|$)/.exec(line)?.[0].length ?? line.length) === target);
            return found;
          };
          const codeRead = typeof args[0] === 'number' && !byId && state.literals && !state.literals.has(args[0]) ? state.codeReads.get(proxy) : undefined;
          const literal = typeof args[0] === 'number' && !byId && !codeRead ? args[0] : undefined;
          if (state.bind && literal !== undefined && state.boundNumbers.get(proxy)?.has(literal)) {
            args = [state.boundNumbers.get(proxy).get(literal).number, ...args.slice(1)];
          }
          // Keep the engine's capture until an opener or the caller's own read replaces it. Unknown
          // selectors still read; unique selectors use the numbers of the last capture we took.
          const firstTree = state.callElements.get(proxy);
          const bind = state.bind && !treeFree && firstTree && state.binding?.proxy === proxy && !before?.opens && !codeRead &&
            (byId ? findTarget(firstTree).length === 1 : literal !== undefined && firstTree.has(literal));
          // setValue changes a field and no window, like typing: Return after setValue({ id }) in a
          // Save sheet skipped its 54,000-character read (owner, 2026-10-10, 1.85 s a save).
          const quiet = before && (['typeText', 'paste', 'setValue'].includes(before.name) || (before.name === 'pressKey' &&
            typeof before.key === 'string' && !before.key.includes('+') && !/^(?:return|enter|escape|esc|tab|space)$/i.test(before.key)) ||
            state.quietEdits && (before.editKey || before.editable && ['typeText', 'paste'].includes(name)));
          let observed;
          if (text === undefined && bind) text = state.binding.text;
          const header = state.callHeaders.get(proxy);
          const light = text === undefined && !checkFocus && !skipFirst && state.light && !state.light.off && !state.careful && state.guarded &&
            ['typeText', 'paste'].includes(name) && before?.name === 'pressKey' && typeof before.key === 'string' &&
            /^(?:return|enter|escape|esc|tab|space)$/i.test(before.key) && typeof before.done === 'number' &&
            header && state.expected && state.expected.app === state.light.app && ['title', 'app', 'url'].every(key => header[key] === state.expected[key]);
          if (text === undefined && !checkFocus && (skipFirst || treeFree && quiet && !state.careful && state.callHeaders.has(proxy))) {
            observed = skipFirst ? state.expected : state.callHeaders.get(proxy);
            if (state.timing) nodeRepl.write('[sleight:guard-timing]' + JSON.stringify({ phase: 'skipped', ms: 0, chars: 0, failed: false }) + '\\n');
          } else if (light && await lightCheck(before)) {
            observed = header;
          } else {
            text ??= await timedRead(raw, 'before-action');
            if (cached?.text === undefined) modalOpened = clickOpenedModal(proxy, text);
            observed = parse(text);
          }
          if (observed) state.callHeaders.set(proxy, observed);
          attempt.text = text;
          // A stop carries this fresh read, header and tree, so the relay keeps the lease and Claude
          // can retry with current numbers. With only the header, each stop cost Claude a turn to
          // read again (2 of safari-form's 13, 2026-10-09). The relay's compactor shows it as a diff.
          const stop = message => new Error(message + (text === undefined ? '' : '\\n' + text.slice(Math.max(0, text.indexOf('Window: ')))));
          // A window change is the stop to report, ahead of element checks against the window the call left: Word's OK
          // closed its alert and the next numbered click stopped as a renumbering no continuation reads (word-edit,
          // 2026-10-17). Change review keeps the late check alone: its Cancel test needs the resolved element.
          const checkWindow = cancel => {
            const dialog = state.fileOnly && observed?.app === state.expected?.app && !observed.url?.startsWith('file://');
            // An untitled document that autosave gives a URL mid-call is the same
            // window. Document scope and change review stay strict about URLs.
            if (state.adoptUrl && observed && state.expected && state.expected.url == null && observed.url &&
              observed.app === state.expected.app && observed.title === state.expected.title) state.expected = observed;
            // A sheet or panel this call opened in the same app has no title (Go to Folder
            // in a Save panel: 18 stopped calls in two benchmark passes, 2026-10-07). It
            // isn't another document, so the lease alone lets it through.
            const panel = state.adoptUrl && observed?.app === state.expected?.app && observed.title === '' && !observed.url && !hasModal(text);
            // A window this call's own shortcut, Return or click just opened or renamed in the same app
            // becomes the expected one (owner's call, 2026-10-09): the Save or Open panel, a new untitled
            // window, or a document titled or saved with a name this call typed. Stopping there cost
            // TextEdit save and edit about three calls a run. A window the user opens in that app at that
            // moment would pass too. Document scope and change review stay strict.
            const shortcut = before?.name === 'pressKey' && typeof before.key === 'string' &&
              (before.key.includes('+') || /^(?:return|enter)$/i.test(before.key));
            const opener = before?.name === 'click' || shortcut;
            const modal = observed && !observed.url && hasModal(text) && (shortcut || modalOpened);
            const named = observed && state.typed.some(typed => {
              const base = typed.trim().split('/').pop();
              if (base.length < 3) return false;
              let file;
              try { file = observed.url?.startsWith('file://') ? decodeURIComponent(new URL(observed.url).pathname).split('/').pop() : undefined; } catch {}
              return observed.title === base || file === base;
            });
            if (state.adoptUrl && opener && observed && state.expected && observed.app === state.expected.app &&
              (hasModal(text) ? modal : /^0 [^\\n]*\\bID: (?:save|open)-panel\\b/m.test(text ?? '') || (!observed.url && /^Untitled(?: \\d+)?$/.test(observed.title)) || named)) {
              state.expected = observed;
            }
            // A relay without a lease, document scope or change review forwards actions
            // unguarded, yet handles a read acquired are still proxies. No guarded call
            // has configured the guard then, so there is nothing to compare. A guarded
            // call with no expected window still stops.
            if (state.guarded && !cancel && !dialog && !panel && (!observed || ['title', 'app', 'url'].some(key => observed[key] !== state.expected?.[key]))) {
              // Without document scope or change review, the stop carries the window it saw, so the
              // relay can lease that window for Claude's retry (Chess retitles itself on each move).
              attempt.windowStop = true;
              const reason = /* notice */ state.adoptUrl && observed && state.expected && observed.app !== state.expected.app
                // Which actions ran and which didn't, by name, and the call that switches without a stop:
                // two app-switch stops cost textedit-calculator-2 two calls (2026-10-17).
                ? 'Input lease stopped this action: app changed. ' + state.completedActions + ' earlier action' + (state.completedActions === 1 ? '' : 's') + ' in this call ran' +
                  (state.ran.length ? ', in ' + state.expected.app + ': ' + state.ran.slice(0, 10).join(', ') + (state.ran.length > 10 ? ' and ' + (state.ran.length - 10) + ' more' : '') : '') +
                  (state.unknown.length ? '; sent to ' + state.expected.app + ' with the result unknown: ' + state.unknown.slice(0, 10).join(', ') : '') +
                  '. Not run: this ' + shown + ' and every action after it; nothing was sent to ' + observed.app + '. The lease moves to ' + observed.app +
                  ${quoted(/* lean notice */ ". Send the actions that didn't run in a new call that starts with let <handle> = await cua.getApp(")} + JSON.stringify(observed.app) +
                  ${quoted(/* lean notice */ ") and acts through that handle, without select_window. One call acts in one app: to switch apps, end the call and start the next with that app's getApp.")}
                : state.reason;
              throw (state.adoptUrl ? stop : message => new Error(message))(reason + ' Observed ' + JSON.stringify(observed));
            }
          };
          if (!state.fileOnly) checkWindow(false);
          // app.click({ id: "Seven" }) or ({ label: "Multiply" }): the one element with
          // that AX identifier or label in this read, so numbers an earlier action in
          // the call shifted don't matter.
          // ({ line: "Scientific, ID: menuAction:" }) is the element whose whole line, after its number,
          // is exactly that: a replayed step names an element this way when no ID or label is unique.
          // click("Multiply"): the engine takes only numbers or points, and a bare name failed there, so
          // Claude redid the batch over two calls (calculator-click, 2026-10-10). It is the one element
          // with that label, else with that ID.
          if (byId) {
            // A read on a busy Mac can drop attributes: "button One" for "button Description: 1,
            // ID: One" (2026-10-09). With no match at all, one bare line named exactly that is it.
            let found = findTarget(elements(text));
            const ancestry = found.length > 1 ? contexts(text) : undefined;
            if (found.length > 1 && (kind === 'label' || bare !== undefined && found.every(([, line]) => hasLabel(line, target)))) {
              const enabled = found.filter(([, line]) => !/^[a-z][a-z ]* \\([^()]*\\bdisabled\\b[^()]*\\)/.test(line));
              if (enabled.length === 1) found = enabled;
              const content = found.filter(([number]) => ancestry.get(number)?.content);
              if (content.length === 1 && found.every(([number]) => number === content[0][0] || ancestry.get(number)?.menu)) found = content;
            }
            const disabledNote = !found.length && (kind === 'label' || kind === 'label or ID') ? disabledLabelNote(text, target) : undefined;
            if (disabledNote) throw stop('sleight stopped before ' + name + ': ' + disabledNote);
            if (found.length !== 1) {
              const candidates = found.map(([number]) => 'candidate ' + number + ': parent ' + ancestry.get(number).parent).join('; ');
              throw stop('sleight stopped before ' + name + ': ' + (found.length ? found.length + ' elements' : 'no element') + ' with ' + kind + ' ' + JSON.stringify(target) + ' in this window.' + (candidates ? ' ' + candidates + '.' : '') + ${quoted(/* lean notice */ ' Use an element number or another ID from the window below.')});
            }
            args = [found[0][0], ...args.slice(1)];
          }
          // An earlier action in this call can renumber the window (Calculator closes
          // its history and every button shifts), so a batch of numbers goes stale.
          // The one element whose whole line is exactly this, unless the line is a bare role
          // ("container"), which says nothing about which element it was.
          const sameLine = line => typeof line === 'string' && !/^[a-z][a-z ]*(?: \\([^)]*\\))*$/.test(line)
            ? [...elements(text ?? '')].filter(([, other]) => other === line) : [];
          const goTo = (to, line, why) => {
            nodeRepl.write('sleight: ' + name + '(' + args[0] + ') went to element ' + to + ', the same ' + JSON.stringify(line) + ': ' + why + '.\\n');
            if (state.bind && literal !== undefined) {
              if (!state.boundNumbers.has(proxy)) state.boundNumbers.set(proxy, new Map());
              state.boundNumbers.get(proxy).set(literal, { number: to, line });
            }
            args = [to, ...args.slice(1)];
          };
          // A number the code computed from its own read in this call (a match over getAXState) means
          // that read's element. Checked against the tree from before the call, correct clicks stopped,
          // and Claude fell back to one action per call in ZCode (2026-10-12).
          if (codeRead) {
            if (!state.callElements.has(proxy)) state.callElements.set(proxy, elements(text ?? ''));
            const was = codeRead.get(args[0]), now = elements(text ?? '').get(args[0]);
            if (!sameElement(was, now)) {
              const moved = [...codeRead.values()].filter(line => line === was).length === 1 ? sameLine(was) : [];
              if (moved.length === 1) goTo(moved[0][0], was, 'the window renumbered after this call read it');
              else throw stop('sleight stopped before ' + name + '(' + args[0] + '): element ' + args[0] + ' changed since this call read the window (was ' + JSON.stringify(was ?? 'missing') + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
            }
          }
          else if (!state.callElements.has(proxy)) {
            if (text !== undefined || !state.firstOff) state.callElements.set(proxy, elements(text ?? ''));
            // The window can renumber between Claude's read and this call: TextEdit gave a saved
            // document a URL and 14 became File (textedit-save, 2026-10-09). When the line Claude saw
            // is now on exactly one element, act there, as the relay's remap does between calls: a
            // one-line shift in ZCode's sidebar cost a turn (2026-10-12).
            const seen = typeof args[0] === 'number' && !byId ? state.seenLines?.[args[0]] : undefined;
            const now = seen !== undefined && text !== undefined ? elements(text).get(args[0]) : undefined;
            if (seen !== undefined && text !== undefined && !sameElement(seen, now)) {
              // Only for a call with one literal number: the call's other numbers shifted too, and
              // nothing after this action would catch them.
              const moved = state.literals?.size === 1 && state.uniqueSeen.has(args[0]) ? sameLine(seen) : [];
              if (moved.length === 1) goTo(moved[0][0], seen, 'the window renumbered since you read it');
              else throw stop('sleight stopped before ' + name + '(' + args[0] + '): element ' + args[0] + ' changed since you read the window (was ' + JSON.stringify(seen) + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
            }
          }
          else if (typeof args[0] === 'number' && !byId) {
            const was = (state.bind ? state.boundNumbers.get(proxy)?.get(literal)?.line : undefined) ?? state.callElements.get(proxy).get(args[0]), now = elements(text).get(args[0]);
            // Calculator renumbers every button when its first click closes the history, so a batch
            // of numbers from one read went stale and Claude rewrote it as an ID lookup over four calls
            // (calculator-click, 2026-10-10). The element Claude meant is the line it saw: when that
            // line, with an ID, description or help, is in the new tree exactly once, act on it there.
            const moved = sameElement(was, now) || typeof was !== 'string' || !/\\b(?:ID|Description|Help): /.test(was) ? []
              : [...elements(text)].filter(([, line]) => sameElement(was, line));
            if (moved.length === 1) {
              nodeRepl.write('sleight: ' + name + '(' + args[0] + ') went to element ' + moved[0][0] + ', the same ' + JSON.stringify(was) + ': an earlier action in this call renumbered the window.\\n');
              args = [moved[0][0], ...args.slice(1)];
              if (state.bind && literal !== undefined) {
                if (!state.boundNumbers.has(proxy)) state.boundNumbers.set(proxy, new Map());
                state.boundNumbers.get(proxy).set(literal, { number: moved[0][0], line: was });
              }
            } else if (!sameElement(was, now)) throw stop('sleight stopped before ' + name + '(' + args[0] + '): an earlier action in this call changed what element ' + args[0] + ' is (was ' + JSON.stringify(was ?? 'missing') + ', now ' + JSON.stringify(now ?? 'missing') + ')' + ${quoted(/* lean notice */ '. Use the current numbers in the window below.')});
          }
          const cancel = state.fileOnly && isCancel(name, args, text ?? '');
          if (state.cancelOnly && !cancel) throw new Error('Change review: Cancel target changed. Read the current window before retrying.');
          checkWindow(cancel);
          // The engine names focus after the tree. Reuse the guard's fresh read; a field's inner
          // node can hold focus too. Only positive evidence of focus elsewhere stops the text.
          if (checkFocus) {
            const number = differentFocusTarget(text, before);
            if (number !== undefined) {
              throw new Error("sleight stopped before " + name + ": another element has focus. Use app.setValue(" + number + ", <text>) instead.");
            }
          }
          await checkLease();
          state.activeApp = proxy;
          // Only the resolved target's role makes a field click quiet; coordinates and words in a
          // button's description say nothing about whether it takes text input.
          const line = name === 'click' && typeof args[0] === 'number' ? elements(text ?? '').get(args[0]) : undefined;
          if (!byId && /^close button(?: |,|$)/i.test(line ?? '')) {
            throw stop('element ' + args[0] + " is the window's close button; close a window by label or with Cmd+W");
          }
          const editable = typeof line === 'string' && /^(?:text field|text area|text entry area|search (?:text )?field|combo box)(?: |$)/i.test(line);
          const keys = name === 'pressKey' && typeof args[0] === 'string' ? args[0].toLowerCase().split('+') : [];
          const key = keys.pop(), modifiers = keys.every(k => ['super', 'cmd', 'command', 'meta', 'shift', 'alt', 'option', 'ctrl', 'control'].includes(k));
          const textEditing = editable || before?.textEditing || ['typeText', 'paste'].includes(name);
          const command = keys.some(k => ['super', 'cmd', 'command', 'meta', 'ctrl', 'control'].includes(k));
          const editKey = modifiers && (/^(?:arrow)?(?:left|right|up|down)$/.test(key ?? '') && (!command || textEditing) ||
            keys.length === 1 && ['super', 'cmd', 'command', 'meta'].includes(keys[0]) && (['a', 'c', 'x', 'z'].includes(key) || textEditing && ['b', 'i', 'u'].includes(key)) ||
            keys.length === 2 && keys.includes('shift') && keys.some(k => ['super', 'cmd', 'command', 'meta'].includes(k)) && key === 'z');
          // Description is the displayed name in field rows; Help, IDs and secondary actions
          // cannot turn an ordinary button into a confirming control.
          const button = /^button(?: \\([^)]*\\))* (.*)$/i.exec(line ?? '')?.[1];
          const label = /(?:^|, )Description: (.*?)(?=, (?:Value|ID|Help|Secondary Actions): |$)/.exec(button ?? '')?.[1] ??
            button?.split(/(?:^|, )(?:Description|Value|ID|Help|Secondary Actions): /)[0];
          const opens = name === 'click' && (line === undefined || /^(?:menu button|pop up button|menu bar item|menu item|link|tab|disclosure triangle|close button)(?: |,|$)/i.test(line) ||
            /(?:…|\\.\\.\\.)$/.test(label ?? '') || /^(?:Delete|Remove|Revert|Discard|Erase|Empty|Close|Quit|Exit|Sign Out|Log Out|Reset|Clear|Replace|Don't Save|Do Not Save|Save|OK|Done|Apply|Continue|Proceed|Next|Back|Finish|Confirm|Accept|Cancel|Dismiss)\\b/i.test(label ?? '')) ||
            ['performSecondaryAction', 'setValue', 'scroll'].includes(name) || name === 'pressKey' &&
            (keys.length > 0 || /^(?:return|enter|escape|esc|tab|space)$/i.test(key ?? ''));
          const previous = { name, key: name === 'pressKey' ? args[0] : undefined, editable, editKey, number: editable ? args[0] : undefined, line,
            textEditing: textEditing && (editable || ['typeText', 'paste'].includes(name) || editKey), opens, modal: text === undefined ? undefined : hasModal(text),
            touches: state.touches };
          state.previous.set(proxy, previous);
          if (text !== undefined && !bind) state.binding = { proxy, text };
          else if (state.binding?.proxy !== proxy) state.binding = undefined;
          const typed = name === 'setValue' ? args[1] : ['typeText', 'paste'].includes(name) ? args[0] : undefined;
          if (typeof typed === 'string') state.typed.push(typed);
          // A second handle may refer to this same app/window. Every input
          // invalidates the call's observations, including reads on that alias.
          state.reads = new WeakMap();
          // No Shift settle after setValue here, as drag.js does after its own text writes: the
          // engine refuses a key press with only modifiers (-10005, 2/2 live, 2026-10-11).
          input();
          // Input went out before the engine answered, so a rejected action may have acted.
          let result;
          try { result = await value.apply(raw, args); } catch (error) { state.unknown.push(shown); throw error; }
          previous.done = Date.now();
          if (editable) previous.completed = true;
          state.completedActions++;
          state.ran.push(shown);
          state.lastAction = name === 'click' && byId && kind !== 'line'
            ? { kind: kind === 'ID' || bare !== undefined && !hasLabel(line ?? '', target) ? 'id' : 'label', value: target, line }
            : name === 'pressKey' && typeof args[0] === 'string' ? { kind: 'key', value: args[0] }
            : name === 'click' && typeof args[0] === 'number' ? { kind: 'number', value: literal ?? args[0] }
            : name === 'click' && Array.isArray(args[0]) ? { kind: 'point', value: args[0] } : null;
          return result;
        };
        // An action Claude didn't await that fails would reject with no handler, and that ends the
        // engine's JavaScript session with every handle (3/3, 2026-10-07). Handle every action's
        // promise here, still returning it, so an await sees the error and nothing is unhandled.
        return (...args) => {
          const attempt = { index: state.actionIndex++ };
          const pending = act(attempt, ...args);
          pending.catch(error => {
            if (state.guardStopMark) nodeRepl.write(state.guardStopMark + JSON.stringify({ index: attempt.index,
              prev: state.lastAction, root: /^\\d+ .*$/m.exec(attempt.text ?? '')?.[0] ?? null,
              attempts: state.actionIndex, windowStop: !!attempt.windowStop, name, completed: state.completedActions,
              error: String(error?.message ?? error).split('\\n')[0] }) + '\\n');
            state.failures.push(name + ': ' + (error?.message ?? error));
          });
          return pending;
        };
      } });
      state.proxies.add(proxy); state.wrapped.set(target, proxy); state.raws.set(proxy, target);
      return proxy;
    };
    // A failed acquisition the code caught itself still shows in the result: getApp({ windowId: 0 })
    // inside .catch(() => null) left Claude reading the wrong window (finder-move-2, 2026-10-17).
    if (state.getApp) cua.getApp = async (...args) => {
      checkNative(); state.touches = (state.touches ?? 0) + 1;
      const windowId = args[0] && typeof args[0] === 'object' ? args[0].windowId : undefined;
      try {
        if (windowId !== undefined && !(Number.isSafeInteger(windowId) && windowId > 0)) {
          throw new Error('cua.getApp({ windowId: ' + JSON.stringify(windowId) + ' }) names no window: a window ID is a positive number. ' +
            ${quoted(/* lean notice */ 'For one window of an app, call select_window with the app and its exact title or file URL, then let <handle> = await cua.getApp("<app>").')});
        }
        const handle = wrap(await state.getApp(...args));
        state.getAppFailures = [];
        return state.activeApp = handle;
      } catch (error) {
        let shown; try { shown = JSON.stringify(args[0]); } catch {}
        state.getAppFailures?.push('getApp(' + (shown ?? String(args[0])) + ') failed (your code caught it): ' + (error?.message ?? error));
        throw error;
      }
    };
    state.wrap = wrap;
  };`;
  return install + /* generated code */ `
{
  if (typeof globalThis.__sleightDocumentGuardSetup !== 'function'${reuseSetup ? ' || !globalThis.__sleightDocumentGuard' : ''}) {
    throw new Error('Sleight guard setup is missing. Send a standalone app acquisition before acting.');
  }
  globalThis.__sleightDocumentGuardSetup(${JSON.stringify(update) ?? 'undefined'});
  ${/* A call that declares app itself (let app = await cua.getApp(…)) has it in its temporal dead zone
     here, and even typeof throws: "Cannot access 'app' before initialization" cost turns in h2h-3
     (2026-10-10). That app comes from cua.getApp, which is already wrapped, so skip it. */
    update && !update.skipAppWrap ? "const state = globalThis.__sleightDocumentGuard; try { if (typeof app !== 'undefined' && app && typeof app.getAXState === 'function' && !state.proxies.has(app)) { app = state.wrap(app); state.activeApp ||= app; state.startApp ||= app; } } catch (error) { if (!(error instanceof ReferenceError)) throw error; }" : ''}
  ${acknowledge && !reuseSetup ? `nodeRepl.write(${JSON.stringify(GUARD_READY + '\n')});` : ''}
}`;
}

export const DOCUMENT_TOOL = {
  name: 'document_scope',
  description: 'Ask the user to approve the last observed document or window for this session. ' +
    'First use js with only let app = await cua.getApp("App") or let app = await cua.getApp({ windowId: 123 }). ' +
    'Actions require an approved matching Window and URL. Window changes stop further actions. ' +
    'This is a mistake guard, not isolation from arbitrary JavaScript.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
