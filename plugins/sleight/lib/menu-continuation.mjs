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
  // `const a = __sleightOpenedApp3`: a handle the call renames. Nothing is sent, and the rest acts on the new name.
  if (ts.length === i + 3 && isName(ts[i]) && punct(ts[i + 1], '=') && isName(ts[i + 2]) && !forbidden.has(ts[i + 2].v) &&
      ts[i + 2].v !== ts[i].v) return ts[i].v;
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
const READS = new Set(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']);
const STRING_READS = new Set(['split', 'slice', 'join', 'trim']), CALLBACK_READS = new Set(['filter', 'find', 'some']);
// tokens() can't lex a regular expression after =>, so a callback that only tests one, l => /Undo|Page/i.test(l),
// becomes a string of the same length (offsets still name the original code), then a <callback> token that only
// these reads accept.
const CALLBACK = '\u0000regex-test';
const maskCallbacks = code => code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuy]*\s*\.\s*test\s*\(\s*\1\s*\)\s*\)/g,
  (match, name) => name === undefined || match.length - 4 < CALLBACK.length ? match : '("' + CALLBACK.padEnd(match.length - 4) + '")');
const lex = text => tokens(text).map(t => t.string && t.v.trimEnd() === CALLBACK ? { v: '<callback>' } : t);
const isNumber = t => !!t && !t.string && /^\d+$/.test(t.v);
const punct = (t, v) => !!t && !t.string && t.v === v;
// The argument of nodeRepl.write, as an allowlist: a string or number, the handle's getAXState with
// literal options, or a name an earlier trailing read bound, then dots to names and calls of
// split/slice/join/trim with string or number arguments, or filter/find/some with a masked regex test.
// No brackets, ?., other handles or actions.
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
    if (CALLBACK_READS.has(member.v)) {
      if (!punct(ts[i + 1], '<callback>') || !punct(ts[i + 2], ')')) return false;
      i += 3; continue;
    }
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
// The call's value may be one of the write's expressions too ("done", or the read filtered).
function trailingRead(ts, handle, names) {
  if (ts.length === 1) return isName(ts[0]) && !forbidden.has(ts[0].v) || ts[0].string || isNumber(ts[0]) ? '' : undefined;
  if (ts[0]?.v === 'nodeRepl' && ts[1]?.v === '.' && ts[2]?.v === 'write' && ts[3]?.v === '(' && ts.at(-1)?.v === ')' &&
      !ts.slice(0, 4).some(t => t.string)) return writeArgument(ts.slice(4, -1), handle, names) ? '' : undefined;
  if (writeArgument(ts, handle, names)) return '';
  const i = declared(ts);
  return isName(ts[i]) && ts[i].v !== handle && !forbidden.has(ts[i].v) && ts[i + 1]?.v === '=' && ts[i + 2]?.v === 'await' && ts[i + 3]?.v === handle &&
    ts[i + 4]?.v === '.' && READS.has(ts[i + 5]?.v) && !ts[i + 5].string && ts[i + 6]?.v === '(' && ts.at(-1)?.v === ')' &&
    !ts.slice(i + 1, i + 7).some(t => t.string) && literalArgs(ts.slice(i + 7, -1)) ? ts[i].v : undefined;
}

// Only standalone inputs on one handle, with data arguments. No assignments, calls in
// arguments, reads or control flow: the guard's input index must name exactly this span.
// The call may start by acquiring that handle and end by reading it (textedit-calculator,
// 2026-10-17: both shapes stopped on their own menu click, about 8 to 10 s a run).
export function splitMenuActions(code) {
  if (typeof code !== 'string' || code.length > 65536) return;
  const masked = maskCallbacks(code), split = statementSpans(masked);
  if (!split) return;
  const actions = [];
  let acquired, statements = 0, tail = false;
  const names = new Set();
  for (const [start, end] of split.spans) {
    const ts = lex(masked.slice(start, end));
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

// The stop came right after plan action n - 1, the one the receipt names, so n indexes the rest.
function stoppedAfter(plan, receipt) {
  const n = receipt?.index, prev = receipt?.prev;
  if (!plan || receipt?.windowStop === false || !Number.isSafeInteger(n) || n < 1 || n >= plan.actions.length || !prev) return;
  const selector = plan.actions[n - 1].selector;
  if (!selector || JSON.stringify(selector.value) !== JSON.stringify(prev.value) ||
      !['label', 'id', 'key', 'number', 'point'].includes(prev.kind) ||
      (selector.kind === 'label' ? !['label', 'id'].includes(prev.kind) : selector.kind !== prev.kind)) return;
  return n;
}
const stopTree = (receipt, content) => {
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const window = windowFromText(text), tree = text.slice(text.indexOf('Window: ')), root = /^\d+ (.*)$/m.exec(tree);
  return window && root && receipt.root === root[0] ? { window, tree, line: root[1] } : undefined;
};

export function menuRemainder(plan, receipt, expected, content) {
  const n = stoppedAfter(plan, receipt), prev = receipt?.prev;
  if (n === undefined) return;
  const stopped = stopTree(receipt, content);
  if (!stopped || stopped.window.app !== expected.app) return;
  const { window, tree, line } = stopped;
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

// The lease held a dialog or sheet, the call's own action closed it, and the window in front is the one the lease
// held before it appeared: same app, title and URL. Word's Replace All alert stopped 7 of 8 word-edit runs on its
// OK this way (2026-10-17). Anything else (another document, app or new window) is not the covered window.
export function dialogRemainder(plan, receipt, covered, content) {
  const n = stoppedAfter(plan, receipt);
  if (n === undefined || receipt.windowStop !== true || !covered) return;
  const stopped = stopTree(receipt, content);
  if (!stopped || ['title', 'app', 'url'].some(key => stopped.window[key] !== covered[key])) return;
  return { code: plan.code.slice(plan.actions[n].start).trim(), window: stopped.window, tree: stopped.tree, dialog: true };
}

const idle = (observed, since) => Number.isFinite(observed.hidIdleSeconds) && Number.isFinite(since) &&
  observed.hidIdleSeconds >= (performance.now() - since) / 1000 + 0.05;

// The covered window is the app's focused one again: one match for its title and URL, the process the dialog's
// baseline had, its certified native window when it had one, and no user input since the call was sampled.
export function returnedWindow(covered, baseline, observed, since) {
  if (!covered || !observed || !Number.isSafeInteger(observed.windowNumber) || observed.windowNumber <= 0 || !idle(observed, since)) return false;
  if (baseline && ['epoch', 'pid', 'processStart'].some(key => observed[key] !== baseline[key])) return false;
  const certified = covered.nativeIdentity;
  try {
    verifyWindowIdentity({ appId: covered.appId, title: covered.title, url: covered.url,
      ...(certified ? { windowNumber: certified.windowNumber, nativeIdentity: certified } : {}) }, observed);
    return true;
  } catch { return false; }
}

// What a lease stop sent and didn't, so Claude needn't take a screenshot to find out. Method names, keys and
// selectors only: typed or set text stays out.
export function stopNote(receipt, plan, earlier = 0) {
  if (receipt?.windowStop !== true || /: app changed\./.test(receipt.error ?? '')) return;
  const count = n => `${n} action${n === 1 ? '' : 's'}`;
  const n = receipt.index;
  if (plan && !earlier && Number.isSafeInteger(n) && n >= 0 && n < plan.actions.length) {
    const name = action => {
      const method = tokens(plan.code.slice(action.start, action.end))[3]?.v, value = action.selector?.value;
      return value === undefined ? method : `${method} ${JSON.stringify(typeof value === 'string' && value.length > 30 ? value.slice(0, 29) + '…' : value)}`;
    };
    const list = actions => actions.slice(0, 4).map(name).join(', ') + (actions.length > 4 ? ` and ${actions.length - 4} more` : '');
    const ran = plan.actions.slice(0, n);
    return `sleight: this call ran ${count(n)}${n ? ` (${list(ran)})` : ''}; not sent: ${list(plan.actions.slice(n))}.`;
  }
  const ran = (Number.isSafeInteger(receipt.completed) ? receipt.completed : 0) + earlier;
  return `sleight: this call ran ${count(ran)}; the stopped ${typeof receipt.name === 'string' ? receipt.name : 'action'} and everything after it were not sent.`;
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
      observed.windowNumber !== baseline.windowNumber || !idle(observed, forwardedAt)) return false;
  try { verifyWindowIdentity({ ...expected, nativeIdentity: baseline }, observed); return true; }
  catch { return false; }
}
