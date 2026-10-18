// What each native action did, from sleight's own read before it and the read after it (SLEIGHT_OUTCOMES=1),
// and the opt-in JSON Lines action log (SLEIGHT_ACTION_LOG). Only structure, roles, names and the acted-on
// control's own value line count; typed text, secure values and document text never leave the engine's tree.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

// The account's short and full names, as receipts scrub them: once per log, on its first write.
function ownerNames() {
  const names = [userInfo().username];
  try { names.push(execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  return names;
}

// Runs inside the engine: the guard injects its source, so it uses nothing from outside itself. recs are the
// actions one read settles (several when none read in between); the last with a target names the control.
export function actionOutcome(recs, before, after) {
  const ROLES = ['standard window', 'floating window', 'system dialog', 'dialog', 'sheet', 'popover', 'menu bar item', 'menu bar',
    'menu button', 'menu item', 'menu', 'pop up button', 'radio button', 'check box', 'checkbox', 'toggle button', 'switch',
    'disclosure triangle', 'secure text field', 'search text field', 'search field', 'text entry area', 'text area', 'text field',
    'combo box', 'close button', 'full screen button', 'minimize button', 'zoom button', 'button', 'tab group', 'tab', 'scroll area',
    'scroll bar', 'slider', 'stepper', 'incrementor', 'value indicator', 'date field', 'time field', 'link', 'row', 'cell',
    'column header', 'static text', 'text', 'heading', 'image', 'group', 'toolbar', 'list', 'table', 'outline', 'web area', 'window']
    .sort((a, b) => b.length - a.length);
  const FIELDS = 'Description|Value|ID|Help|Secondary Actions|URL|Placeholder|Details|Selected text';
  const FIELD = Object.fromEntries(['Description', 'Value', 'ID'].map(key => [key, new RegExp('(?:^|, )' + key + ': ?(.*?)(?=, (?:' + FIELDS + '): |$)')]));
  const TITLE_END = new RegExp('(?:^|, )(?:' + FIELDS + '):');
  const cap = (text, n = 40) => text.length > n ? text.slice(0, n - 1) + '…' : text;
  const describe = body => {
    if (typeof body !== 'string') return;
    const role = ROLES.find(r => body === r || body.startsWith(r + ' ') || body.startsWith(r + ',')) ?? /^[a-z]*/.exec(body)[0];
    let rest = body.slice(role.length).replace(/^,?\s*/, '');
    const flagged = /^\(([^)]*)\)\s*/.exec(rest);
    if (flagged) rest = rest.slice(flagged[0].length);
    const field = key => FIELD[key].exec(rest)?.[1];
    const flags = flagged ? flagged[1].split(/,\s*/) : [];
    const id = field('ID'), name = (field('Description') || rest.split(TITLE_END)[0].trim() || id || '').trim();
    return { role, flags, name, id, value: field('Value'),
      secure: /secure/.test(role) || flags.includes('secure') || /password|passcode/i.test(name + ' ' + (id ?? '')) };
  };
  const view = text => {
    if (typeof text !== 'string') return;
    const header = /^Window: (.*), App: (.+?)\.?\r?$/m.exec(text);
    if (!header) return;
    const els = new Map();
    let focus;
    for (const line of text.split('\n')) {
      const m = /^\t*(\d+) (.*?)\r?$/.exec(line);
      if (m) { els.set(Number(m[1]), m[2]); continue; }
      const f = /^The focused UI element is (\d+) (.*?)\r?$/.exec(line);
      if (f) focus = { n: Number(f[1]), body: f[2] };
    }
    let title;
    try { title = JSON.parse(header[1]); } catch { title = header[1].replace(/^"|"$/g, ''); }
    return { title: String(title), app: header[2], url: /\bURL: (\S+)/.exec(els.get(0) ?? '')?.[1] ?? '', els, focus };
  };
  const label = d => d.role + (d.name ? ' "' + cap(d.name, 30) + '"' : '');
  const key = d => d.role + '|' + (d.id || d.name);
  const targets = recs.map(rec => {
    const d = describe(rec.body);
    return d && { r: d.role, ...(d.name && !d.secure ? { m: cap(d.name) } : {}), ...(d.secure ? { s: true } : {}) };
  });
  const b = view(before), a = view(after);
  if (!b || !a) return { targets };
  const facts = [];
  if (a.app !== b.app) facts.push({ o: 'app', d: cap(a.app) });
  // A menu tree's root has no URL, so only two reads that both show one can say it changed.
  else if (a.title !== b.title || a.url && b.url && a.url !== b.url) facts.push({ o: 'window', d: cap(a.title) });
  // Word trees run to thousands of lines, so only matching lines get parsed: this runs between actions.
  const bodies = (v, pattern) => [...v.els.values()].filter(body => pattern.test(body));
  // The root is the window itself: Word's turns from standard window to dialog while a pane is open.
  const modal = v => [...v.els].filter(([n, body]) => n !== 0 && /^(?:sheet|dialog|system dialog|popover)(?: |,|$)/.test(body)).map(([, body]) => label(describe(body)));
  const wasModal = modal(b), nowModal = modal(a);
  for (const m of nowModal) if (!wasModal.includes(m)) facts.push({ o: 'opened', d: m });
  for (const m of wasModal) if (!nowModal.includes(m)) facts.push({ o: 'closed', d: m.split(' "')[0] });
  const MENU = /^menu(?:,|$| (?!bar\b|item\b|button\b))/, ITEM = /^menu item(?: |,|$)/;
  // An open menu is a menu element, or a tree whose root is the menu itself (a menu-bar title that Cancel closes).
  const open = v => bodies(v, MENU).length + (/\bSecondary Actions: Cancel\b/.test(v.els.get(0) ?? '') &&
    !/^(?:standard window|floating window|window|dialog|sheet|system dialog)(?: |,|$)/.test(v.els.get(0)) ? 1 : 0);
  const menus = open(a) - open(b);
  if (menus > 0) facts.push({ o: 'menu', d: String(bodies(a, ITEM).length - bodies(b, ITEM).length) });
  else if (menus < 0) facts.push({ o: 'menu-' });
  let rec;
  for (const item of recs) if (item.body !== undefined) rec = item;
  const old = rec && describe(rec.body), number = rec?.n ?? rec?.focus;
  if (old) {
    let now = number !== undefined && describe(a.els.get(number));
    if (!now || now.role !== old.role) {
      const same = [...a.els.values()].filter(body => body.startsWith(old.role)).map(describe).filter(d => key(d) === key(old));
      now = same.length === 1 ? same[0] : undefined;
    }
    // A control that went away with the window or sheet it was in says nothing more.
    if (!now) { if (rec.n !== undefined && !facts.length) facts.push({ o: 'gone' }); }
    else {
      const on = d => ['1', 'true', 'on'].includes(String(d.value).toLowerCase());
      const toggle = /^(?:check box|checkbox|switch|toggle button)$/.test(old.role) ? ['checked', 'unchecked']
        : old.role === 'radio button' ? ['selected', 'unselected'] : old.role === 'disclosure triangle' ? ['expanded', 'collapsed'] : undefined;
      // Only a single-line control's own value, never a text area's or a secure field's, and never typed text.
      const shown = !/^(?:typeText|paste)$/.test(rec.a) && !old.secure && !now.secure &&
        /^(?:text field|search text field|search field|combo box|slider|stepper|incrementor|value indicator|pop up button|date field|time field)$/.test(now.role) &&
        (now.value ?? '').length <= 40;
      // A secure field shows bullets, so whether it holds what was set is unknown.
      const want = typeof rec.want === 'string' && !old.secure && !now.secure ? { m: now.value === rec.want } : {};
      if (toggle && on(old) !== on(now)) facts.push({ o: 'state', d: on(now) ? toggle[0] : toggle[1] });
      else if (old.value !== now.value || want.m) facts.push({ o: 'value', ...want, ...(shown ? { d: now.value ?? '' } : {}) });
      for (const flag of ['selected', 'expanded', 'disabled']) {
        if (!toggle && old.flags.includes(flag) !== now.flags.includes(flag)) facts.push({ o: 'state', d: (now.flags.includes(flag) ? '' : 'not ') + flag });
      }
    }
  }
  const focusOf = v => v.focus && describe(v.focus.body);
  if (a.focus && b.focus && a.focus.n !== b.focus.n && key(focusOf(a)) !== key(focusOf(b)) && a.focus.n !== number) {
    facts.push({ o: 'focus', d: label(focusOf(a)) });
  }
  if (!facts.length) {
    const left = new Map();
    for (const body of b.els.values()) left.set(body, (left.get(body) ?? 0) + 1);
    let changed = 0;
    for (const body of a.els.values()) { const n = left.get(body); if (n) left.set(body, n - 1); else changed++; }
    for (const n of left.values()) changed += n;
    facts.push(changed ? { o: 'lines', d: String(changed) } : { o: 'none' });
  }
  return { targets, facts: facts.slice(0, 2) };
}

const said = fact => ({
  app: /* lean notice */ `now in ${fact.d}`, window: /* lean notice */ `window now "${fact.d}"`, opened: /* lean notice */ `${fact.d} opened`,
  closed: /* lean notice */ `${fact.d} closed`, menu: /* lean notice */ fact.d && fact.d !== '0' ? `menu opened (${fact.d} items)` : 'menu opened',
  'menu-': /* lean notice */ 'menu closed',
  value: /* lean notice */ fact.m === true ? 'holds the value' : fact.d !== undefined ? `value reads "${fact.d}"` : fact.m === false ? 'value differs' : 'value changed',
  state: /* lean notice */ `now ${fact.d}`, gone: /* lean notice */ 'element gone', focus: /* lean notice */ `focus on ${fact.d}`,
  lines: /* lean notice */ `${fact.d} other lines changed`, none: /* lean notice */ 'no visible change',
})[fact?.o];
function actionLabel(rec, i) {
  const typed = /^(?:typeText|paste)$/.test(rec.a) && rec.t?.r;
  return `${i + 1} ${rec.a}` + (rec.l !== undefined ? ' ' + JSON.stringify(rec.l) : rec.n !== undefined ? ' ' + rec.n : '') +
    (rec.k ? ' ' + JSON.stringify(rec.k) : '') + (Number.isSafeInteger(rec.c) ? ` ${rec.c} chars` : '') +
    (typed ? ` into ${rec.t.r}${rec.t.m ? ` "${rec.t.m}"` : ''}` : '');
}
function actionResult(rec) {
  if (rec.x === 'refused') return /* lean notice */ `not run (${rec.r ?? 'stopped'})`;
  if (rec.x === 'failed') return /* lean notice */ 'failed; partial input possible';
  const facts = Array.isArray(rec.f) ? rec.f.map(said).filter(Boolean) : [];
  return facts.length ? facts.join('; ') : /* lean notice */ 'ran, unverified';
}

// One line per action for Claude. Actions that shared one read share its line. notSent: the stop note already lists the
// rest. continuing: sleight sends the rest, the stopped action first, so neither shows here; start: lines shown before.
export function renderOutcomes(record, { notSent = false, continuing = false, start = 0 } = {}) {
  const recs = Array.isArray(record?.outcomes) ? record.outcomes.filter(rec => rec && typeof rec.a === 'string' && !(continuing && rec.x === 'refused')) : [];
  if (!recs.length) return;
  const lines = [];
  let group = [];
  recs.forEach((rec, i) => {
    group.push(actionLabel(rec, start + i));
    if (rec.g && !rec.x && i < recs.length - 1) return;
    lines.push(group.join(', ') + ': ' + actionResult(rec));
    group = [];
  });
  const stopped = recs.findIndex(rec => rec.x), planned = record.planned;
  if (!notSent && !continuing && !start && stopped >= 0 && Number.isSafeInteger(planned) && planned > recs.length) {
    lines.push(`${recs.length + 1}${planned > recs.length + 1 ? '-' + planned : ''}: ` + /* lean notice */ `not run (stopped after ${stopped})`);
  }
  return /* lean notice */ 'sleight outcomes:\n' + lines.join('\n');
}

// The log's words for a fact: structure only, no titles, names or values.
const logged = fact => ({
  app: 'app changed', window: 'window changed', opened: `${String(fact.d ?? '').split(' "')[0] || 'window'} opened`,
  closed: `${fact.d || 'window'} closed`, menu: 'menu opened', 'menu-': 'menu closed',
  value: fact.m === true ? 'value matches' : fact.m === false ? 'value differs' : 'value changed',
  state: /^(?:not )?(?:checked|unchecked|selected|unselected|expanded|collapsed|disabled)$/.test(fact.d) ? `now ${fact.d}` : 'state changed',
  gone: 'element gone', focus: 'focus moved', lines: 'other lines changed', none: 'no visible change',
})[fact?.o];
// Names of these roles are labels of controls; the names of rows, cells, text and areas can be document content.
const NAMED_ROLE = /^(?:button|menu button|menu item|menu bar item|pop up button|radio button|check box|checkbox|toggle button|switch|disclosure triangle|tab|text field|search text field|search field|combo box|slider|stepper|incrementor|link|close button|full screen button|minimize button|zoom button)$/;
const NAMED_KEY = /^(?:return|enter|escape|esc|tab|space|backspace|delete|forwarddelete|left|right|up|down|home|end|pageup|pagedown|f\d{1,2})$/i;

// Why a call or action didn't run, as a category: the notice itself can quote titles and element lines.
export function refusalReason(text = '') {
  const reasons = [[/app changed/, 'app changed'], [/window or URL changed|Selected window changed|nothing from this call ran|window changed/i, 'window changed'],
    [/^Input lease|Input lease/, 'input lease'], [/Document scope/, 'document scope'], [/Change review/, 'change review'],
    [/rule '.*' stopped a transfer|flow rule/i, 'flow rule'], [/\b(?:declined|denied|not approved)\b/i, 'approval declined'],
    [/payment|purchase|checkout/i, 'payment confirmation'], [/changed since|changed what element/, 'element changed'],
    [/no element with|elements with/, 'element not found'], [/the user (?:changed|switched)/, 'user changed the app'],
    [/sleight stopped|stopped this call/, 'stopped by sleight']];
  return reasons.find(([pattern]) => pattern.test(text))?.[1];
}

// A turbo step's outcome as a category: the outcome text quotes addresses and dialogs from the page.
function turboOutcome(text) {
  return [[/^navigated/, 'navigated'], [/^new document/, 'new document'], [/^dialog /, 'dialog opened'], [/opened (?:a |background )?tab/, 'tab opened'],
    [/^tab closed/, 'tab closed'], [/unconfirmed/, 'unconfirmed'], [/^form changed/, 'form changed'], [/lines changed/, 'changed'],
    [/no visible change/, 'no visible change'], [/^set$/, 'set'], [/^request finished/, 'request finished']].find(([pattern]) => pattern.test(text))?.[1] ?? 'sent';
}

export function actionLogPath(value, home = homedir()) {
  if (typeof value !== 'string' || !value.trim()) return;
  const path = value.startsWith('~/') ? join(home, value.slice(2)) : value;
  return isAbsolute(path) ? path : undefined;
}

export class ActionLog {
  constructor({ path, maxBytes = 5 * 1024 * 1024, keep = 2, now = () => new Date(), home = homedir(), names } = {}) {
    this.path = path; this.maxBytes = maxBytes; this.keep = keep; this.now = now; this.home = home;
    this.names = names; this.calls = new Map(); this.origins = new Map(); this.failures = 0;
  }
  scrub(text) {
    this.names ??= ownerNames().filter(Boolean).sort((a, b) => b.length - a.length);
    let clean = String(text).replaceAll(this.home, '~');
    for (const name of this.names) clean = clean.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '[owner]');
    return clean.slice(0, 60);
  }
  request(msg) {
    if (msg?.method !== 'tools/call' || msg.id === undefined) return;
    const name = msg.params?.name, args = msg.params?.arguments ?? {};
    if (typeof name !== 'string' || name === 'turn_ended' || name === 'js_reset') return;
    // A call the user stopped gets no reply here, so the oldest entries go once 200 wait.
    if (this.calls.size >= 200) this.calls.delete(this.calls.keys().next().value);
    this.calls.set(msg.id, { name, args, outcomes: [] });
  }
  // A guarded call's records; a continued call adds the rest's.
  outcomes(id, record) {
    const call = this.calls.get(id);
    if (!call || !Array.isArray(record?.outcomes)) return;
    call.outcomes.push(...record.outcomes);
    call.planned = record.planned; call.app = typeof record.app === 'string' ? record.app : call.app;
  }
  reply(msg) {
    const call = msg?.method === undefined && this.calls.get(msg?.id);
    if (!call) return;
    this.calls.delete(msg.id);
    const text = (msg.result?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    const error = !!msg.error || !!msg.result?.isError, base = { call: msg.id, tool: call.name };
    // A category means sleight or the user refused it; anything else is an error from the engine or the app.
    const refused = row => {
      const reason = refusalReason(msg.error?.message ?? text);
      return { ...row, result: reason ? 'refused' : 'failed', reason: reason ?? 'error' };
    };
    const rows = [];
    if (call.name === 'js') {
      const app = call.app ? { app: this.scrub(call.app) } : {};
      call.outcomes.forEach((rec, i) => {
        const target = rec.t?.r ? { role: rec.t.r, ...(rec.t.s ? { secure: true } : rec.t.m && NAMED_ROLE.test(rec.t.r) ? { name: this.scrub(rec.t.m) } : {}) } : undefined;
        const facts = Array.isArray(rec.f) ? rec.f.map(logged).filter(Boolean) : [];
        rows.push({ ...base, ...app, kind: rec.a, ...(target ? { target } : {}), ...(Number.isSafeInteger(rec.c) ? { chars: rec.c } : {}),
          ...(rec.k && (NAMED_KEY.test(rec.k) || /(?:^|\+)(?:super|cmd|command|ctrl|control)\+/i.test(rec.k)) ? { key: rec.k } : {}),
          ...(rec.x === 'refused' ? { result: 'refused', reason: rec.r ?? 'stopped by sleight' } : rec.x === 'failed' ? { result: 'failed', reason: 'engine error' }
            : { result: 'ok', outcome: facts.length ? facts.join('; ') : rec.g && call.outcomes[i + 1] ? 'checked with the next action' : 'unverified' }) });
      });
      const stopped = call.outcomes.findIndex(rec => rec.x);
      if (stopped >= 0 && Number.isSafeInteger(call.planned) && call.planned > call.outcomes.length) {
        rows.push({ ...base, ...app, kind: 'rest', count: call.planned - call.outcomes.length, result: 'not run', reason: `stopped after ${stopped}` });
      }
      if (!rows.length && error) rows.push(refused({ ...base, ...app, kind: 'call' }));
    } else if (/^browser_/.test(call.name)) {
      rows.push(...this.turbo(call, text, error, base, refused));
    } else {
      const { args } = call;
      const read = (call.name === 'menu_bar' && args.op === 'apps') || (['notifications', 'review_changes'].includes(call.name) && args.op === 'list');
      if (!read) rows.push({ ...base, ...(typeof args.app === 'string' ? { app: this.scrub(args.app) } : {}), kind: args.op ? `${call.name} ${args.op}` : call.name,
        ...(error ? refused({}) : { result: 'ok', outcome: 'done' }) });
    }
    this.write(rows);
  }
  turbo(call, text, error, base, refused) {
    const { args } = call;
    const opened = /^(t[\w-]+) (https?:\/\/\S+)/m.exec(text);
    const origin = url => { try { return new URL(url).origin; } catch { return undefined; } };
    if (opened && origin(opened[2])) this.origins.set(opened[1], origin(opened[2]));
    const tab = args.tab ?? opened?.[1];
    let at = this.origins.get(tab) ?? (call.name === 'browser_open' ? origin(args.url) : undefined);
    let where = at ? { origin: at } : {};
    if (call.name === 'browser_read' || (call.name === 'browser_tabs' && args.do === 'list')) return [];
    if (call.name === 'browser_open') return [{ ...base, ...where, kind: 'open', ...(error ? refused({}) : { result: 'ok', outcome: 'opened' }) }];
    const rows = [];
    for (const line of text.split('\n')) {
      const step = /^(\d+) (\w+)(?: ((?:f\d+)?e\d+|s\d+))?: (.*)$/.exec(line) ?? (call.name === 'browser_fill' && /^()()((?:f\d+)?e\d+|s\d+): (.*)$/.exec(line));
      if (!step) continue;
      const outcome = step[4].trim(), kind = step[2] || 'fill', target = step[3] ? { target: { ref: step[3] } } : {};
      const row = { ...base, ...where, kind, ...target };
      // Steps after a navigation act on the new page: only its origin is kept, never the path.
      const moved = /^navigated\b/.test(outcome) && origin(/https?:\/\/\S+/.exec(outcome)?.[0]);
      if (moved) { at = moved; where = { origin: at }; if (tab) this.origins.set(tab, at); }
      rows.push({ ...row,
        ...(/^not reached/.test(outcome) ? { result: 'not run', reason: 'earlier step stopped' }
          : /^not run/.test(outcome) ? { result: 'refused', reason: /covered/.test(outcome) ? 'covered' : 'stopped by sleight' }
          : { result: 'ok', outcome: turboOutcome(outcome) }) });
    }
    if (!rows.length && error) rows.push(refused({ ...base, ...where, kind: call.name.slice(8) }));
    if (!rows.length && call.name === 'browser_tabs') rows.push({ ...base, ...where, kind: `tabs ${args.do}`, result: 'ok', outcome: 'done' });
    return rows;
  }
  write(rows) {
    if (!rows.length || !this.path) return;
    const time = this.now().toISOString();
    const text = rows.map(row => JSON.stringify({ time, ...row })).join('\n') + '\n';
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        const stat = lstatSync(this.path);
        if (stat.isFile() && stat.size + text.length > this.maxBytes) {
          for (let n = this.keep - 1; n >= 1; n--) try { renameSync(`${this.path}.${n}`, `${this.path}.${n + 1}`); } catch {}
          renameSync(this.path, `${this.path}.1`);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // O_NOFOLLOW: a symlink at the path can't send the log elsewhere.
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if (fstatSync(fd).uid !== process.getuid()) throw new Error('action log has another owner');
        writeSync(fd, text);
      } finally { closeSync(fd); }
    } catch { this.failures++; }
  }
}
