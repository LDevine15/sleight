import { randomUUID } from 'node:crypto';
import { tokens } from './flow-rules.mjs';
import { statementSpans } from './text-save.mjs';
import { hasIdentifier, hasLabel, windowFromText } from './document-scope.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';

export const guardStopMark = () => `[sleight:guard-stop:${randomUUID()}]`;

const ACTIONS = ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText'];
const isName = t => !!t && !t.string && /^[A-Za-z_$][\w$]*$/.test(t.v);
const declared = ts => ['let', 'const', 'var'].includes(ts[0]?.v) && !ts[0].string ? 1 : 0;
// Literal option objects only: { disableDiffing: true }, { windowId: 12 }.
const literalArgs = args => !args.some((t, i) => !t.string && !/^(?:\d+|true|false|null|[\[\]{},:\-])$/.test(t.v) &&
  !(args[i + 1]?.v === ':' && /^[A-Za-z_$][\w$]*$/.test(t.v)));

// `let te = await cua.getApp("App")` (or { windowId: 12 }, or `app = …`) names the handle it binds.
function acquisition(ts) {
  const i = declared(ts);
  if (!isName(ts[i]) || ts[i + 1]?.v !== '=' || ts[i + 2]?.v !== 'await' || ts[i + 3]?.v !== 'cua' || ts[i + 4]?.v !== '.' ||
      ts[i + 5]?.v !== 'getApp' || ts[i + 6]?.v !== '(' || ts.at(-1)?.v !== ')' || ts.slice(i + 2, i + 7).some(t => t.string)) return;
  const args = ts.slice(i + 7, -1);
  const selector = args.length === 1 && args[0].string || args.length === 5 && args[0].v === '{' && !args[0].string &&
    args[1].v === 'windowId' && args[2].v === ':' && !args[2].string && !args[3].string && /^\d+$/.test(args[3].v) && args[4].v === '}' && !args[4].string;
  return selector ? ts[i].v : undefined;
}

// After the last action: a read of the same handle, printing it, or echoing a name. None sends input,
// and none comes before an action, so the guard's input index still names the action spans.
const forbidden = new Set(['await', 'cua', 'nodeRepl', 'import', 'require', 'eval', 'Function', 'globalThis', 'process', 'constructor',
  '__proto__', 'prototype', 'then', 'catch', 'finally', 'call', 'apply', 'bind', '<template>', '<regexp>', ...ACTIONS]);
const STRING_READS = new Set(['split', 'slice', 'join', 'trim']);
const isNumber = t => !!t && !t.string && /^\d+$/.test(t.v);
const punct = (t, v) => !!t && !t.string && t.v === v;
// The argument of nodeRepl.write, as an allowlist: a string or number, the handle's getAXState with
// literal options, or a name an earlier trailing read bound, then dots to names and calls of
// split/slice/join/trim with string or number arguments. No brackets, ?., other handles or actions.
function writeArgument(ts, handle, names) {
  let i = 0;
  const literal = () => {
    if (punct(ts[i], '-') && isNumber(ts[i + 1])) { i += 2; return true; }
    if (ts[i]?.string || isNumber(ts[i])) { i++; return true; }
    return false;
  };
  if (punct(ts[i], '-') || ts[i]?.string || isNumber(ts[i])) { if (!literal()) return false; }
  else if (isName(ts[i]) && ts[i].v === handle) {
    if (!punct(ts[i + 1], '.') || ts[i + 2]?.v !== 'getAXState' || ts[i + 2].string || !punct(ts[i + 3], '(')) return false;
    const close = ts.findIndex((t, index) => index > i + 3 && punct(t, ')'));
    if (close < 0 || !literalArgs(ts.slice(i + 4, close)) || ts.slice(i + 4, close).some(t => punct(t, '('))) return false;
    i = close + 1;
  } else if (isName(ts[i]) && names.has(ts[i].v) && !forbidden.has(ts[i].v)) i++;
  else return false;
  while (punct(ts[i], '.')) {
    const member = ts[i + 1];
    if (!isName(member) || forbidden.has(member.v) || member.v === 'getAXState') return false;
    i += 2;
    if (!punct(ts[i], '(')) continue;
    if (!STRING_READS.has(member.v)) return false;
    i++;
    if (!punct(ts[i], ')')) {
      for (;;) {
        if (!literal()) return false;
        if (!punct(ts[i], ',')) break;
        i++;
      }
    }
    if (!punct(ts[i], ')')) return false;
    i++;
  }
  return i === ts.length;
}
// Returns the name a trailing read binds ('' for one that binds none), or undefined when it isn't one.
function trailingRead(ts, handle, names) {
  if (ts.length === 1) return isName(ts[0]) && !forbidden.has(ts[0].v) ? '' : undefined;
  if (ts[0]?.v === 'nodeRepl' && ts[1]?.v === '.' && ts[2]?.v === 'write' && ts[3]?.v === '(' && ts.at(-1)?.v === ')' &&
      !ts.slice(0, 4).some(t => t.string)) return writeArgument(ts.slice(4, -1), handle, names) ? '' : undefined;
  const i = declared(ts);
  return isName(ts[i]) && ts[i].v !== handle && !forbidden.has(ts[i].v) && ts[i + 1]?.v === '=' && ts[i + 2]?.v === 'await' && ts[i + 3]?.v === handle &&
    ts[i + 4]?.v === '.' && ts[i + 5]?.v === 'getAXState' && ts[i + 6]?.v === '(' && ts.at(-1)?.v === ')' &&
    !ts.slice(i + 1, i + 7).some(t => t.string) && literalArgs(ts.slice(i + 7, -1)) ? ts[i].v : undefined;
}

// Only standalone inputs on one handle, with data arguments. No assignments, calls in
// arguments, reads or control flow: the guard's input index must name exactly this span.
// The call may start by acquiring that handle and end by reading it (textedit-calculator,
// 2026-10-17: both shapes stopped on their own menu click, about 8 to 10 s a run).
export function splitMenuActions(code) {
  if (typeof code !== 'string' || code.length > 65536) return;
  const split = statementSpans(code);
  if (!split) return;
  const actions = [];
  let acquired, statements = 0, tail = false;
  const names = new Set();
  for (const [start, end] of split.spans) {
    const ts = tokens(code.slice(start, end));
    if (ts.at(-1)?.v === ';') ts.pop();
    if (!ts.length) continue;
    statements++;
    if (statements === 1 && (acquired = acquisition(ts))) continue;
    const action = ts[0]?.v === 'await' && !ts[0].string && isName(ts[1]) && ts[2]?.v === '.' && ACTIONS.includes(ts[3]?.v) &&
      !ts[3].string && ts[4]?.v === '(' && ts.at(-1)?.v === ')';
    if (!action) {
      const bound = actions.length ? trailingRead(ts, actions[0].handle, names) : undefined;
      if (bound === undefined) return;
      if (bound) names.add(bound);
      tail = true; continue;
    }
    if (tail) return;
    const args = ts.slice(5, -1);
    if (!literalArgs(args)) return;
    const handle = ts[1].v;
    if (actions.length ? handle !== actions[0].handle : acquired && handle !== acquired) return;
    let selector;
    if (ts[3].v === 'click') {
      if (args.length === 1 && args[0].string) selector = { kind: 'label', value: args[0].v };
      else if (args.length === 5 && args[0].v === '{' && ['label', 'id'].includes(args[1].v) &&
          args[2].v === ':' && args[3].string && args[4].v === '}') selector = { kind: args[1].v, value: args[3].v };
      else if (args.length === 1 && !args[0].string && /^\d+$/.test(args[0].v)) selector = { kind: 'number', value: Number(args[0].v) };
      else if (args.length === 5 && args[0].v === '[' && args[2].v === ',' && args[4].v === ']' &&
          [args[1], args[3]].every(t => !t.string && /^\d+$/.test(t.v))) selector = { kind: 'point', value: [Number(args[1].v), Number(args[3].v)] };
    }
    if (ts[3].v === 'pressKey' && args.length === 1 && args[0].string) selector = { kind: 'key', value: args[0].v };
    actions.push({ start, end, handle, selector });
  }
  return actions.length > 1 ? { code, actions } : undefined;
}

export function takeGuardStop(content, mark) {
  let receipt, count = 0, input = false, adopted;
  const head = [];
  const cleaned = content.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string') { if (!count) head.push(item); return [item]; }
    const text = item.text.split('\n').filter(line => {
      if (!line.startsWith(mark)) { if (!count) head.push({ ...item, text: line }); return true; }
      let record;
      try { record = JSON.parse(line.slice(mark.length)); } catch { /* An invalid receipt proves nothing. */ }
      if (record?.input === true) { input = true; return false; }
      // The guard moved to a window in another app this call acquired; the last one counts.
      if (record?.adopted) { adopted = record.adopted; return false; }
      count++; receipt = record;
      return false;
    }).join('\n');
    return text ? [{ ...item, text }] : [];
  });
  return { content: cleaned, head, receipt: count === 1 ? receipt : undefined, input, adopted };
}

export function menuRemainder(plan, receipt, expected, content) {
  const n = receipt?.index, prev = receipt?.prev;
  if (!plan || receipt?.windowStop === false || !Number.isSafeInteger(n) || n < 1 || n >= plan.actions.length || !prev) return;
  const selector = plan.actions[n - 1].selector;
  if (!selector || JSON.stringify(selector.value) !== JSON.stringify(prev.value) ||
      !['label', 'id', 'key', 'number', 'point'].includes(prev.kind) ||
      (selector.kind === 'label' ? !['label', 'id'].includes(prev.kind) : selector.kind !== prev.kind)) return;
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const window = windowFromText(text);
  if (!window || window.app !== expected.app) return;
  const at = text.indexOf('Window: '), tree = text.slice(at);
  const root = /^\d+ (.*)$/m.exec(tree);
  if (!root || receipt.root !== root[0]) return;
  const line = root[1];
  if (/^standard window(?: |,|$)/.test(line)) {
    if (window.title === expected.title || /^\s*\d+ (?:sheet|dialog)\b/m.test(tree)) return;
    // Only windows without editable document content: nothing proves this call's key caused the retitle, and a
    // retitle into a document (Return opening a file, a tab switch) would put the rest of the call's input there.
    if (/^\t*\d+ (?:text area|text entry area|web area|HTML content)\b/m.test(tree)) return;
    return { code: plan.code.slice(plan.actions[n].start).trim(), window, tree, navigation: true };
  }
  if (!['label', 'id'].includes(prev.kind)) return;
  // Some engine menus have a named parent at the root and an unnamed menu below it.
  const role = /^menu(?: |,|$)/.test(line), secondary = /(?:^|, )Secondary Actions: Cancel(?:,|$)/.test(line);
  if (!role && !(secondary && /^\t+\d+ menu(?: |$)/m.test(tree))) return;
  const title = (role ? line.replace(/^menu(?: |$)/, '') : line).split(/, (?:Secondary Actions|ID|Description|Help): /)[0];
  if (!title || /^(?:Secondary Actions|ID|Description|Help):/.test(title)) return;
  const named = prev.kind === 'label' ? title === prev.value : typeof prev.line === 'string' &&
    hasIdentifier(prev.line, prev.value) && hasLabel(prev.line, title) &&
    (!/^[a-z]+(?: [a-z]+)* /.test(prev.line) || /^(?:menu item|menu bar item|menu button|pop up button) /.test(prev.line));
  if (!named) return;
  return { code: plan.code.slice(plan.actions[n].start).trim(), window, tree };
}

export async function menuIdentity(identity, expected, timeoutMs = 600) {
  let timer;
  try {
    const observed = await Promise.race([Promise.resolve().then(() => identity(expected)),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    return verifyWindowIdentity(expected, observed);
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

export function unchangedMenuWindow(expected, baseline, observed, forwardedAt) {
  if (!baseline || !observed || !Number.isSafeInteger(baseline.windowNumber) || baseline.windowNumber <= 0 ||
      observed.windowNumber !== baseline.windowNumber || !Number.isFinite(observed.hidIdleSeconds) ||
      !Number.isFinite(forwardedAt) || observed.hidIdleSeconds < (performance.now() - forwardedAt) / 1000 + 0.05) return false;
  try { verifyWindowIdentity({ ...expected, nativeIdentity: baseline }, observed); return true; }
  catch { return false; }
}
