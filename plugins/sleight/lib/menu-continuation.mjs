import { randomUUID } from 'node:crypto';
import { tokens } from './flow-rules.mjs';
import { statementSpans } from './text-save.mjs';
import { hasIdentifier, hasLabel, windowFromText } from './document-scope.mjs';
import { verifyWindowIdentity } from './window-identity.mjs';

export const guardStopMark = () => `[sleight:guard-stop:${randomUUID()}]`;

// Only standalone inputs on one handle, with data arguments. No assignments, calls in
// arguments, reads or control flow: the guard's input index must name exactly this span.
export function splitMenuActions(code) {
  if (typeof code !== 'string' || code.length > 65536) return;
  const split = statementSpans(code);
  if (!split) return;
  const actions = [];
  for (const [start, end] of split.spans) {
    const ts = tokens(code.slice(start, end));
    if (ts.at(-1)?.v === ';') ts.pop();
    if (!ts.length) continue;
    if (ts[0]?.v !== 'await' || ts[0].string || !/^[A-Za-z_$][\w$]*$/.test(ts[1]?.v ?? '') || ts[1].string ||
        ts[2]?.v !== '.' || !['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction',
          'paste', 'pressKey', 'typeText'].includes(ts[3]?.v) || ts[3].string || ts[4]?.v !== '(' || ts.at(-1)?.v !== ')') return;
    const args = ts.slice(5, -1);
    if (args.some((t, i) => !t.string && !/^(?:\d+|true|false|null|[\[\]{},:\-])$/.test(t.v) &&
        !(args[i + 1]?.v === ':' && /^[A-Za-z_$][\w$]*$/.test(t.v)))) return;
    const handle = ts[1].v;
    if (actions.length && handle !== actions[0].handle) return;
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
  let receipt, count = 0, input = false;
  const head = [];
  const cleaned = content.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string') { if (!count) head.push(item); return [item]; }
    const text = item.text.split('\n').filter(line => {
      if (!line.startsWith(mark)) { if (!count) head.push({ ...item, text: line }); return true; }
      let record;
      try { record = JSON.parse(line.slice(mark.length)); } catch { /* An invalid receipt proves nothing. */ }
      if (record?.input === true) { input = true; return false; }
      count++; receipt = record;
      return false;
    }).join('\n');
    return text ? [{ ...item, text }] : [];
  });
  return { content: cleaned, head, receipt: count === 1 ? receipt : undefined, input };
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
