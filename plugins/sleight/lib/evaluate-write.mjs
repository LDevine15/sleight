import { EVALUATE_ACTION } from './tab-errors.mjs';

const setters = { value: 'fill', checked: 'check', innerHTML: 'read', textContent: 'read', className: 'read',
  selected: 'select', selectedIndex: 'select', scrollTop: 'scroll', scrollLeft: 'scroll', fetch: 'read' };
const methods = { click: 'click', dispatchEvent: 'click', createEvent: 'click', addEventListener: 'read',
  setAttribute: 'read', appendChild: 'drag', insertBefore: 'drag', removeChild: 'drag', replaceChild: 'drag' };

// Like the A3R5 check, ignore literal text. Keep offsets, regex character classes and
// template expressions so a quoted action cannot hide a later write or become one.
function tokens(code) {
  const out = []; let i = 0;
  const push = (v, at, string = false) => out.push({ v, at, string });
  function scan(interpolation = false) {
    let braces = 0;
    while (i < code.length) {
      const at = i, c = code[i];
      if (/\s/.test(c)) { i++; continue; }
      if (code.startsWith('//', i)) { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue; }
      if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
      if (c === '}' && interpolation && braces === 0) { i++; return; }
      if (c === '{') braces++;
      if (c === '}') braces--;
      if (c === '`') {
        i++; push('(', at);
        while (i < code.length && code[i] !== '`') {
          if (code[i] === '\\') { i += 2; continue; }
          if (code.startsWith('${', i)) { i += 2; push('(', i); scan(true); push(')', i); }
          else i++;
        }
        i++; push(')', i - 1); continue;
      }
      if (c === '"' || c === "'") {
        i++; let value = '';
        while (i < code.length && code[i] !== c) {
          if (code[i] === '\\') { i++; value += code[i++] ?? ''; }
          else value += code[i++];
        }
        i++; push(value, at, true); continue;
      }
      if (c === '/' && (!out.length || (!out.at(-1).string && ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', '=>', '&&', '||', '??'].includes(out.at(-1).v)))) {
        i++; let bracket = false;
        while (i < code.length) {
          const ch = code[i++];
          if (ch === '\\') i++;
          else if (ch === '[') bracket = true;
          else if (ch === ']') bracket = false;
          else if (ch === '/' && !bracket) break;
        }
        while (i < code.length && /[a-z]/i.test(code[i])) i++;
        push('<regexp>', at); continue;
      }
      const word = /^[\w$]+/.exec(code.slice(i));
      if (word) { push(word[0], at); i += word[0].length; continue; }
      const operator = /^(?:=>|\?\.|===|!==|==|!=|\+\+|--|\+=|-=|\|\|=|&&=|\?\?=|&&|\|\||\?\?)/.exec(code.slice(i));
      if (operator) { push(operator[0], at); i += operator[0].length; }
      else { push(c, at); i++; }
    }
  }
  scan(); return out;
}

function argumentEnd(ts, start) {
  let depth = 0;
  for (let i = start; i < ts.length; i++) {
    if (ts[i].string) continue;
    const v = ts[i].v;
    if (!depth && [',', ')', ';'].includes(v)) return i;
    if (['(', '[', '{'].includes(v)) depth++;
    if ([')', ']', '}'].includes(v)) depth--;
    if (depth < 0) return i;
  }
  return ts.length;
}

function callbacks(ts) {
  const ranges = [];
  for (let i = 0; i < ts.length; i++) {
    const computed = ts[i - 1]?.v === '[' && ts[i].string && ts[i + 1]?.v === ']';
    let open = computed ? i + 2 : i + 1;
    if (ts[open]?.v === '?.') open++;
    if (ts[i].v !== 'evaluate' || (!computed && !['.', '?.'].includes(ts[i - 1]?.v)) || ts[open]?.v !== '(') continue;
    const start = open + 1, end = argumentEnd(ts, start), arg = ts.slice(start, end);
    if (arg.some(t => !t.string && ['=>', 'function'].includes(t.v))) ranges.push(arg);
    else if (arg.length === 1 && !arg[0].string) {
      const name = arg[0].v;
      for (let j = 0; j < ts.length; j++) {
        if (ts[j].v !== name || ts[j].string) continue;
        if (ts[j - 1]?.v === 'function') {
          const parameters = ts.findIndex((t, k) => k > j && !t.string && t.v === '(');
          const body = closingToken(ts, parameters) + 1;
          if (ts[body]?.v === '{') ranges.push(ts.slice(body, closingToken(ts, body) + 1));
        } else if (ts[j + 1]?.v === '=') {
          const value = ts.slice(j + 2, argumentEnd(ts, j + 2));
          if (value.some(t => t.v === '=>' || t.v === 'function')) ranges.push(value);
        }
      }
    }
  }
  return ranges;
}

function closingToken(ts, start) {
  const open = ts[start]?.v, close = { '(': ')', '[': ']', '{': '}' }[open];
  if (!close) return start;
  let depth = 1;
  for (let i = start + 1; i < ts.length; i++) {
    if (ts[i].string) continue;
    if (ts[i].v === open) depth++;
    if (ts[i].v === close && --depth === 0) return i;
  }
  return ts.length - 1;
}

function receiverRoot(ts, index) {
  let i = index;
  while (i >= 0) {
    if ([')', ']'].includes(ts[i].v) && !ts[i].string) {
      const close = ts[i].v, open = close === ')' ? '(' : '['; let depth = 1;
      while (--i >= 0 && depth) {
        if (ts[i].string) continue;
        if (ts[i].v === close) depth++;
        if (ts[i].v === open) depth--;
      }
      continue;
    }
    if (['.', '?.'].includes(ts[i - 1]?.v)) { i -= 2; continue; }
    return ts[i].v;
  }
}

function writeIn(ts) {
  const locals = new Set(), data = new Set();
  for (let i = 0; i < ts.length; i++) {
    if (['const', 'let', 'var', 'function', 'class'].includes(ts[i - 1]?.v) && !ts[i].string) {
      locals.add(ts[i].v);
      if (ts[i + 1]?.v === '=' && ['{', '['].includes(ts[i + 2]?.v)) data.add(ts[i].v);
      if (ts[i + 1]?.v === '=' && ts[i + 2]?.v === 'JSON' && ts[i + 3]?.v === '.' && ts[i + 4]?.v === 'parse') data.add(ts[i].v);
    }
  }
  for (let pass = 0; pass < locals.size; pass++) {
    let added = false;
    for (let i = 0; i < ts.length; i++) {
      if (locals.has(ts[i].v) && ts[i + 1]?.v === '=' && data.has(ts[i + 2]?.v) && !data.has(ts[i].v)) {
        data.add(ts[i].v); added = true;
      }
    }
    if (!added) break;
  }
  for (let i = 0; i < ts.length; i++) {
    const token = ts[i], v = token.v;
    const property = ['.', '?.'].includes(ts[i - 1]?.v);
    const computed = token.string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    let nextIndex = i + (computed ? 2 : 1);
    if (ts[nextIndex]?.v === '?.') nextIndex++;
    const next = ts[nextIndex]?.v;
    const receiver = receiverRoot(ts, i - 2);
    let constructor = i;
    while (['.', '?.'].includes(ts[constructor - 1]?.v)) constructor -= 2;
    if (!token.string && ts[constructor - 1]?.v === 'new' && next === '(' && !locals.has(v) && !data.has(receiver)) {
      const action = v === 'DataTransfer' || v === 'DragEvent' ? 'drag' : /Event$/.test(v) ? 'click' : undefined;
      if (action) return { token, action };
    }
    if (!token.string && v === 'fetch' && next === '(' && !locals.has(v) && !data.has(receiver)) return { token, action: 'read' };
    if ((!property && !computed) || data.has(receiver)) continue;
    if (next === '(' && Object.hasOwn(methods, v)) {
      const attribute = ts[nextIndex + 1];
      const action = v === 'setAttribute' && attribute?.string && ['value', 'checked', 'selected'].includes(attribute.v) ? setters[attribute.v] : methods[v];
      return { token, action };
    }
    if (['=', '+=', '-=', '++', '--', '||=', '&&=', '??='].includes(next)) {
      const action = Object.hasOwn(setters, v) ? setters[v] : /^on\w+$/.test(v) ? 'read' : undefined;
      if (action) return { token, action };
    }
  }
}

export function evaluateWrite(code) {
  if (typeof code !== 'string' || !code.includes('evaluate')) return;
  const writes = callbacks(tokens(code)).map(writeIn).filter(Boolean).sort((a, b) => a.token.at - b.token.at);
  const write = writes[0];
  if (!write) return;
  const line = code.slice(0, write.token.at).split('\n').length;
  return `Line ${line}: evaluate is read-only; ${write.token.v} cannot run there. ${write.action === 'read' ? 'Read the controls with' : 'Use'} ${EVALUATE_ACTION[write.action]}. Rejected before the engine call.`;
}
