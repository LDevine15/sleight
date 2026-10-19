import ts from 'typescript';

export const resultText = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// Include the full ancestor path. Equal labels in two groups never select by position.
export function elements(text) {
  const rows = [], parents = [];
  for (const line of text.split('\n')) {
    const match = /^(?:\+ )?(\s*)(\d+) ([a-z][^\n]*)$/.exec(line);
    if (!match) continue;
    const depth = match[1].replaceAll('\t', '    ').length;
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const label = match[3].replace(/,? Value:.*?(?=, (?:ID|Description|Help|Placeholder|Secondary Actions):|$)/g, '').trim();
    const row = { id: Number(match[2]), label, key: [...parents.map(p => p.label), label].join(' > '), depth };
    rows.push(row); parents.push(row);
  }
  return rows.filter((row, i) => rows.findIndex(other => other.id === row.id && other.key === row.key) === i);
}

export function elementMapping(before, after) {
  return matchRows(elements(before), elements(after));
}

function matchRows(old, fresh) {
  const map = new Map();
  for (const row of old) {
    const named = /(?:ID|Description|Placeholder|Help):|(?:button|field|textbox|radio|switch|slider|option|link|listbox)\b.+\S/.test(row.label);
    const uniqueLabel = new Set(old.filter(r => r.label === row.label).map(r => r.id)).size === 1;
    const source = old.filter(r => r.key === row.key), targets = fresh.filter(r => r.key === row.key || (named && uniqueLabel && r.label === row.label));
    const targetIds = [...new Set(targets.map(r => r.id))];
    if (new Set(source.map(r => r.id)).size === 1 && targetIds.length === 1) map.set(row.id, targetIds[0]);
  }
  return map;
}

function mergeElements(previous, text) {
  const rows = elements(text);
  if (!/lines changed since the last full tree/.test(text)) return rows.length ? rows : previous;
  const merged = [...previous];
  for (const row of rows) {
    const old = merged.filter(r => r.label === row.label);
    const index = old.length === 1 ? merged.indexOf(old[0]) : merged.findIndex(r => r.id === row.id);
    if (index >= 0) merged[index] = { ...row, key: merged[index].label === row.label ? merged[index].key : row.key };
    else merged.push(row);
  }
  return merged;
}

function mergeRefs(previous, text) {
  const fresh = refs(text);
  if (/^# Snapshot \d+/m.test(text)) return fresh;
  const merged = new Map(previous.map(row => [row.id, row]));
  for (const line of text.split('\n')) {
    if (/^-\s+- /.test(line)) { const id = /\[ref=([^\]]+)\]/.exec(line)?.[1]; if (id) merged.delete(id); }
  }
  for (const row of fresh) merged.set(row.id, row);
  return [...merged.values()];
}

export function refs(text) {
  const rows = [], parents = [];
  for (const line of text.split('\n')) {
    if (/^-\s+- /.test(line)) continue;
    const match = /^(?:[+\-] )?(\s*)- (.+?) \[ref=((?:f\d+)?e\d+|s\d+)\]/.exec(line);
    if (!match) continue;
    const depth = match[1].length;
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const label = match[2].replace(/ \[(?:active|checked|selected)\]/g, '');
    const row = { id: match[3], label, depth, key: [...parents.map(p => p.label), label].join(' > ') };
    rows.push(row); parents.push(row);
  }
  return rows.filter((row, i) => rows.findIndex(other => other.id === row.id && other.key === row.key) === i);
}

export class TargetMapper {
  constructor() { this.before = ''; this.after = ''; this.strings = new Map(); this.identities = new Map(); this.refMap = new Map(); this.beforeRows = []; this.afterRows = []; this.beforeRefs = []; this.afterRefs = []; }
  refresh(text) {
    if (elements(text).length) this.afterRows = elements(text);
    this.afterRefs = mergeRefs([], text);
    this.refMap = matchRows(this.beforeRefs, this.afterRefs);
  }
  observe(before, after) {
    if (elements(before).length) {
      this.before = before; this.after = after;
      this.beforeRows = mergeElements(this.beforeRows, this.replaceStrings(before)); this.afterRows = mergeElements(this.afterRows, after);
    }
    this.beforeRefs = mergeRefs(this.beforeRefs, before); this.afterRefs = mergeRefs(this.afterRefs, after);
    this.refMap = matchRows(this.beforeRefs, this.afterRefs);
    const header = text => [...text.matchAll(/^(t[a-f0-9]{16,}) (https?:\/\/[^\s]+)\nTitle[^\n]*: ([^\n]+)/gm)];
    const a = header(before), b = header(after);
    if (a.length || b.length) {
      if (a.length !== 1 || b.length !== 1 || a[0][2] !== b[0][2] || this.replaceStrings(a[0][3]) !== b[0][3]) throw Error('Ambiguous tab handle mapping');
      this.addString(a[0][1], b[0][1]);
    }
    // A native select_window receipt binds a changing window number to app + title.
    const receipts = text => text.split('\n').flatMap(line => {
      try { const v = JSON.parse(line); return v.target && v.identity ? [v] : []; } catch { return []; }
    });
    const x = receipts(before), y = receipts(after);
    if (x.length === 1 && y.length === 1 && this.replaceStrings(x[0].target.title) === y[0].target.title && x[0].target.appId === y[0].target.appId) {
      for (const key of ['windowNumber', 'windowId']) if (x[0].identity[key] !== undefined && y[0].identity[key] !== undefined)
        for (const alias of ['windowNumber', 'windowId', 'toWindowId']) this.identities.set(`${alias}:${x[0].identity[key]}`, y[0].identity[key]);
    }
  }
  addString(before, after) {
    if (!before || !after || (this.strings.has(before) && this.strings.get(before) !== after)) throw Error('Ambiguous fixture mapping');
    this.strings.set(before, after);
  }
  replaceStrings(value) {
    if (!this.strings.size) return value;
    const keys = [...this.strings.keys()].sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return value.replace(new RegExp(keys.join('|'), 'g'), key => this.strings.get(key));
  }
  mapElement(id) {
    const matches = this.beforeRows.filter(row => row.id === id);
    const mapped = matchRows(this.beforeRows, this.afterRows).get(id);
    if (matches.length !== 1 || mapped === undefined) throw Error(`Ambiguous or missing element ${id}; refresh required`);
    return mapped;
  }
  code(code) {
    code = this.replaceStrings(code);
    const ast = ts.createSourceFile('recorded.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw Error('Recorded JavaScript cannot be parsed');
    const edits = [];
    const visit = node => {
      if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.initializer)) {
        const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        if (['elementIndex', 'targetIndex'].includes(key)) edits.push([node.initializer.getStart(ast), node.initializer.end, String(this.mapElement(Number(node.initializer.text)))]);
        if (['windowId', 'windowNumber', 'toWindowId'].includes(key)) {
          const id = this.identities.get(`${key}:${node.initializer.text}`);
          if (id === undefined) throw Error(`Unmapped ${key}: ${node.initializer.text}`);
          edits.push([node.initializer.getStart(ast), node.initializer.end, String(id)]);
        }
        if (['id', 'tabId', 'providerTabId'].includes(key)) throw Error(`Unmapped numeric selector ${key}`);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['click', 'doubleClick', 'rightClick', 'hover', 'setValue', 'selectText', 'scroll', 'pickFromList', 'performSecondaryAction'].includes(node.expression.name.text)) {
        const arg = node.arguments[0];
        if (arg && ts.isNumericLiteral(arg)) edits.push([arg.getStart(ast), arg.end, String(this.mapElement(Number(arg.text)))]);
        else if (arg && !ts.isObjectLiteralExpression(arg) && !ts.isArrayLiteralExpression(arg) && !ts.isStringLiteral(arg))
          throw Error('Computed element targets cannot be remapped safely');
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + value + code.slice(end);
    return code;
  }
  arguments(args) {
    const walk = (value, key) => {
      if (key === 'code' && typeof value === 'string') return this.code(value);
      if (['ref', 'to', 'submit'].includes(key) && typeof value === 'string' && /^(?:f\d+)?e\d+$|^s\d+$/.test(value)) {
        if (!this.refMap.has(value)) throw Error(`Ambiguous or missing ref ${value}; refresh required`);
        return this.refMap.get(value);
      }
      if (key === 'tab' && typeof value === 'string' && /^t[a-f0-9]+$/.test(value) && !this.strings.has(value)) throw Error(`Unmapped tab: ${value}`);
      if (['elementIndex', 'element', 'targetIndex'].includes(key) && typeof value === 'number') return this.mapElement(value);
      if (['windowId', 'toWindowId', 'windowNumber', 'tabId', 'tab_id'].includes(key)) {
        if (!this.identities.has(`${key}:${value}`)) throw Error(`Unmapped ${key}: ${value}`);
        return this.identities.get(`${key}:${value}`);
      }
      if (Array.isArray(value)) return value.map(v => walk(v));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
      return typeof value === 'string' ? this.replaceStrings(value) : value;
    };
    return walk(args);
  }
}

export function normalized(text, mapper = new TargetMapper(), recorded = false) {
  text = mapper.replaceStrings(text).replace(/\r\n/g, '\n');
  if (recorded) text = text.replace(/("(?:windowId|toWindowId)"\s*:\s*)(\d+)/g, (all, prefix, id) => {
    const key = /"([^"]+)"/.exec(prefix)[1];
    return mapper.identities.has(`${key}:${id}`) ? prefix + mapper.identities.get(`${key}:${id}`) : all;
  }).replace(/(\b(?:ref|click|type|select|check|uncheck|hover|drag|fill) )((?:f\d+)?e\d+|s\d+)\b/g,
    (_, prefix, id) => prefix + (mapper.refMap.get(id) ?? id));
  const ids = new Map(elements(text).map(r => [r.id, r.key]));
  return text.replace(/^(\+ )?(\s*)\d+ (?=[a-z])/gm, '$1$2# ')
    .replace(/\[ref=(?:f\d+)?[es]\d+\]/g, '[ref=#]')
    .replace(/\b(element|index) (\d+)\b/g, (_, label, id) => `${label} ${ids.get(Number(id)) ?? id}`)
    .replace(/(\b(?:pid|windowNumber)"?\s*[:=]\s*)\d+/g, '$1<runtime-id>')
    .trim();
}

export function refreshCode(args) {
  const ast = ts.createSourceFile('refresh.js', args.code ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const receivers = new Set();
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['click', 'doubleClick', 'rightClick', 'hover', 'setValue', 'selectText', 'scroll', 'pickFromList', 'performSecondaryAction'].includes(node.expression.name.text)) {
      const receiver = node.expression.expression;
      if (!ts.isIdentifier(receiver)) throw Error('Refresh requires a named app handle');
      receivers.add(receiver.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (receivers.size !== 1) throw Error('Refresh needs exactly one app handle');
  return `await ${[...receivers][0]}.getAXState({ disableDiffing: true });`;
}

export function divergence(expected, actual, mapper) {
  const text = resultText(actual);
  if (/sleight stopped this payment|payment (?:confirmation|approval) (?:blocked|required)|confirmation required through the trusted consent UI|Replay approval declined|^\s*(?:approval declined|permission denied|not approved)\s*$|The user (?:didn't allow|did not allow|did not approve)|Computer Use was not approved|permission request[^\n]*(?:denied|dismissed)|waiting for (?:a |the )?(?:payment |confirmation )?card/im.test(text)) return 'confirmation or approval gate';
  if (Boolean(expected?.isError) !== Boolean(actual?.isError)) return 'success/error changed';
  const expectedMedia = (expected?.content ?? []).filter(b => b.type !== 'text');
  const actualMedia = (actual?.content ?? []).filter(b => b.type !== 'text');
  if (JSON.stringify(expectedMedia) !== JSON.stringify(actualMedia)) return 'non-text evidence changed; visual interpretation required';
  const a = expected?.structuredContent ?? expected?.structured_content, b = actual?.structuredContent ?? actual?.structured_content;
  if (normalized(JSON.stringify(a ?? null), mapper, true) !== normalized(JSON.stringify(b ?? null), mapper)) return 'structured result changed';
  if (normalized(resultText(expected), mapper, true) !== normalized(text, mapper)) return 'observable text changed';
  return null;
}
