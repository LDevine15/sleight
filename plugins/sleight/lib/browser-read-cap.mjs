// FowlBrowser's snapshots.mjs caps page reads at 12,000 characters on a line boundary.
// Reserve space for the focused dialog first, keeping rows in their original order.
export const BROWSER_READ_LIMIT = 12000;
const HEADER = /^Browser tab: (\d+), Title: "(?:[^"\\\n]|\\.)*", URL: "(?:[^"\\\n]|\\.)*"\.\n(?=(?:[+~-] )?\t*\d+ )/gm;
const ROW = /^(?:[+~-] )?(\t*)(\d+) (.*)$/;
const DOCS = /^(?:## Computer Use|# Other Browser APIs)\n/;
const OMIT = /^sleight: (\d+) browser tree lines omitted\.[^\n]*/;

function treeRow(line) {
  return /^(?:[+~-] (?:\t+\d+ |\d+ AX)|\t+\d+ |\d+ AX)/.test(line);
}

function pageParts(text) {
  const starts = [...text.matchAll(HEADER)], parts = [];
  let pos = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index, limit = starts[i + 1]?.index ?? text.length;
    const nextWindow = text.slice(start, limit).search(/^Window: /m);
    const tail = text.slice(start, nextWindow < 0 ? limit : start + nextWindow);
    const focus = /\n\nThe focused UI element (?:is|was) (\d+) /.exec(tail);
    const body = tail.slice(0, focus?.index ?? tail.length);
    // Inside a tree, any indented index line is a row (role or not). Caller text
    // starts after the closing blank and is not indented as a tree row.
    const rows = [...body.matchAll(/^(?:[+~-] \t+\d+ |[+~-] \d+ AXWebArea\b|\t+\d+ |\d+ AXWebArea\b)[^\n]*/gm)]
      .filter(row => treeRow(row[0]));
    if (!rows.length) continue;
    const last = rows.at(-1);
    let end = last.index + last[0].length;
    const previous = OMIT.exec(body.slice(end + 1));
    if (previous) end += 1 + previous[0].length;
    parts.push({ text: text.slice(pos, start) });
    parts.push({ text: tail.slice(0, end), tab: starts[i][1], focus: focus?.[1],
      focusSize: focus ? tail.slice(focus.index).split('\n', 3).join('\n').length : 0, previous });
    pos = start + end;
  }
  parts.push({ text: text.slice(pos) });
  return parts;
}

function priority(lines, focus) {
  const rows = lines.map(line => ROW.exec(line)), stack = [], parents = new Map(), dialogs = [];
  for (let i = 1; i < lines.length; i++) {
    const row = rows[i]; if (!row) continue;
    while (stack.length && rows[stack.at(-1)][1].length >= row[1].length) stack.pop();
    parents.set(i, [...stack]);
    if (/^(?:dialog|sheet)\b/i.test(row[3])) dialogs.push(i);
    stack.push(i);
  }
  const focused = rows.findIndex(row => row?.[2] === focus);
  const containing = dialogs.find(i => i === focused || parents.get(focused)?.includes(i));
  const dialog = containing ?? (dialogs.length ? dialogs.at(-1) : undefined);
  const chosen = dialog ?? (focused > 0 ? focused : undefined);
  if (chosen === undefined) return { first: [], parents };
  const first = [...(parents.get(chosen) ?? []), chosen];
  if (dialog !== undefined) {
    const inDialog = focused > 0 && (focused === dialog || parents.get(focused)?.includes(dialog));
    const focusChain = inDialog ? [...(parents.get(focused) ?? []).filter(i => i !== dialog), focused] : [];
    const rest = [];
    for (let i = dialog + 1; i < lines.length; i++) {
      if (rows[i] && rows[i][1].length <= rows[dialog][1].length) break;
      if (!focusChain.includes(i)) rest.push(i);
    }
    first.push(...focusChain, ...rest);
  }
  return { first, parents };
}

export function trimBrowserTree(text, { focus, limit = BROWSER_READ_LIMIT } = {}) {
  const prefix = 'Browser tab: 0, Title: "Tree", URL: "https://example.com".\n';
  const hasHeader = /^Browser tab: \d+, Title: "/.test(text);
  const wrapped = hasHeader ? text : prefix + text + (focus != null && focus !== '' ? `\n\nThe focused UI element is ${focus} ` : '');
  const out = trimBrowserResults([{ type: 'text', text: wrapped }], '', { limit })[0].text;
  return hasHeader ? out : out.replace(prefix, '').replace(/\n\nThe focused UI element is \d+ [^\n]*/, '');
}

export function trimBrowserResults(content, code = '', { limit = 45000, countDocs = false } = {}) {
  const entries = content.map(item => ({ item, parts: item?.type === 'text' && typeof item.text === 'string' && !DOCS.test(item.text)
    ? pageParts(item.text) : [] }));
  const trees = entries.flatMap(entry => entry.parts).filter(part => part.tab);
  if (!trees.length) return content;
  const fixed = entries.reduce((sum, entry) => sum + (entry.parts.length
    ? entry.parts.filter(part => !part.tab).reduce((n, part) => n + part.text.length, 0)
    : countDocs && entry.item?.type === 'text' ? entry.item.text.length : 0), 0);
  let budget = Math.max(0, limit - fixed);
  const names = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.(getTab|createBrowserTab)\s*\(\s*(?:(['"])([^'"]*)\3)?/g)];
  const created = names.filter(match => match[2] === 'createBrowserTab');
  const reads = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*getAXState(?:AndScreenshot)?\s*\(/g)];
  for (let i = 0; i < trees.length; i++) {
    const part = trees[i], share = Math.min(BROWSER_READ_LIMIT - part.focusSize, Math.floor(budget / (trees.length - i)));
    if (part.text.length <= share) { budget -= part.text.length; continue; }
    const lines = part.text.split('\n');
    if (part.previous) lines.pop();
    const bound = names.find(match => match[2] === 'getTab' && match[4] === part.tab);
    const name = bound?.[1] ?? (trees.length === 1 ? reads.at(-1)?.[1] : undefined) ??
      (created.length === trees.length ? created[i]?.[1] : undefined);
    const more = part.previous?.[0].match(/Read more[^\n]*/)?.[0] ?? (name
      ? `Read more: nodeRepl.write(await ${name}.playwright.locator('main').innerText()).`
      : "Read more with your tab handle's Playwright locator('main').innerText(), written with nodeRepl.write(...).");
    const omitted = Number(part.previous?.[1] ?? 0);
    const notice = count => `sleight: ${count} browser tree lines omitted. Numbers not shown need a locator or a filtered read. ${more}`;
    const room = Math.max(0, share - lines[0].length - notice(omitted + lines.length).length - 1);
    const kept = new Set([0]);
    const { first, parents } = priority(lines, part.focus);
    let used = 0;
    const take = (j, ignoreRoom = false) => {
      if (kept.has(j)) return;
      if (parents.get(j)?.some(parent => !kept.has(parent))) return;
      const maxUse = ignoreRoom ? Math.max(room, BROWSER_READ_LIMIT) : room;
      if (used + 1 + lines[j].length > maxUse) return;
      kept.add(j); used += 1 + lines[j].length;
    };
    for (const j of [...first, ...lines.keys()]) take(j);
    const rowCount = [...kept].filter(j => j !== 0 && treeRow(lines[j] ?? '')).length;
    if (rowCount < 20) {
      for (let j = 1; j < lines.length && [...kept].filter(k => k !== 0 && treeRow(lines[k] ?? '')).length < 20; j++) {
        for (const parent of parents.get(j) ?? []) take(parent, true);
        take(j, true);
      }
    }
    part.text = [...kept].sort((a, b) => a - b).map(j => lines[j]).join('\n') + '\n' + notice(omitted + lines.length - kept.size);
    budget -= part.text.length;
  }
  return entries.map(({ item, parts }) => {
    const text = parts.map(part => part.text).join('');
    return parts.length && text !== item.text ? { ...item, text } : item;
  });
}
