// Choosing an option of a listbox or combobox popup by its visible text, including a virtualised list that renders only
// the rows in view. readOptions, moveList and pickElement run in the page; searchOptions drives them from the Node side
// so every scroll position is read after the page had time to render it.

// Page side: the options now in the DOM, in document order, with their position inside the list's scrollable content.
export function readOptions(list) {
  const box = list.getBoundingClientRect();
  const textOf = node => {
    const parts = [];
    const walk = at => {
      if (at.nodeType === 3) { const part = at.textContent.trim(); if (part) parts.push(part); }
      else if (at.nodeType === 1 && at.getAttribute('aria-hidden') !== 'true') for (const child of at.childNodes) walk(child);
    };
    walk(node);
    return parts.join(' ').slice(0, 300);
  };
  const rows = [...list.querySelectorAll('[role="option"], option')].map((el, i) => {
    const rect = el.getBoundingClientRect();
    return { i, t: textOf(el), a: (el.getAttribute('aria-label') || '').slice(0, 300), y: Math.round(rect.top - box.top + list.scrollTop),
      h: Math.round(rect.height), v: rect.width > 0 && rect.height > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
      s: el.getAttribute('aria-selected') ?? el.getAttribute('aria-checked'), d: el.getAttribute('aria-disabled') === 'true' || el.disabled === true };
  });
  return { top: Math.round(list.scrollTop), max: Math.max(0, Math.round(list.scrollHeight - list.clientHeight)), client: list.clientHeight, rows };
}
export function moveList(list, to) { list.scrollTop = to; return Math.round(list.scrollTop); }
// The option at index, only if it still reads as the row the search saw. A list that re-rendered meanwhile gives null.
export function pickElement(list, arg) {
  const el = list.querySelectorAll('[role="option"], option')[arg.index];
  if (!el) return null;
  const parts = [];
  const walk = at => {
    if (at.nodeType === 3) { const part = at.textContent.trim(); if (part) parts.push(part); }
    else if (at.nodeType === 1 && at.getAttribute('aria-hidden') !== 'true') for (const child of at.childNodes) walk(child);
  };
  walk(el);
  return parts.join(' ').slice(0, 300) === arg.t && (el.getAttribute('aria-label') || '').slice(0, 300) === arg.a ? el : null;
}
// The popup a combobox controls (aria-controls or aria-owns, on it or on the textbox inside it), else the one visible listbox.
export function findPopup(el) {
  const doc = el.ownerDocument, root = el.getRootNode();
  const inner = el.querySelector('input, textarea, [role="textbox"]');
  for (const owner of [el, inner]) for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of ((owner && owner.getAttribute(attr)) || '').split(/\s+/).filter(Boolean)) {
      const node = (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
      const list = node && (node.matches('[role="listbox"]') ? node : node.querySelector('[role="listbox"]') || node);
      if (list && (list.matches('[role="listbox"]') || list.querySelector('[role="option"], option'))) return list;
    }
  }
  const open = [...doc.querySelectorAll('[role="listbox"]')].filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (typeof node.checkVisibility !== 'function' || node.checkVisibility());
  });
  return open.length === 1 ? open[0] : null;
}

export const normalize = text => String(text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Text to type into a combobox that filters its list: the wanted text, then without brackets, then its first two words.
export function queries(want) {
  const bare = want.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim(), words = bare.split(' ');
  return [...new Set([want, bare, words.length > 2 ? words.slice(0, 2).join(' ') : ''].filter(Boolean))];
}
// 2: the same words, 1: the wanted words appear in the option's words, 0: no match.
const tierOf = (row, want) => Math.max(...[row.t, row.a].map(text => {
  const words = normalize(text);
  return !words ? 0 : words === want ? 2 : (' ' + words + ' ').includes(' ' + want + ' ') ? 1 : 0;
}));
const label = row => (row.t || row.a).replace(/\s+/g, ' ');
const closest = (seen, want) => {
  const wanted = new Set(want.split(' '));
  return [...seen.values()].map(text => {
    const words = new Set(normalize(text).split(' '));
    return { text, score: [...words].filter(word => wanted.has(word)).length / (new Set([...words, ...wanted]).size || 1) };
  }).sort((a, b) => b.score - a.score).slice(0, 5).map(row => row.text);
};
const sorted = rows => rows.every((row, i) => i === 0 || normalize(label(rows[i - 1])) <= normalize(label(row)));

// read() returns readOptions' result and move(top) sets the list's scroll position. Statuses: found (index is the
// option's place in the last read), ambiguous, disabled, none and timeout. The search ends on the first option whose
// words equal the wanted words. A list that is sorted is bisected first, any other list is walked from the top, and
// options that only contain the wanted words count only when exactly one of them exists in the whole list.
export async function searchOptions({ read, move, want, now = Date.now, sleep, budgetMs = 8000, maxReads = 400 }) {
  const target = normalize(want), started = now(), seen = new Map(), partial = new Map();
  let reads = 0, last;
  if (!target) return { status: 'none', closest: [] };
  const look = async (to) => {
    if (to !== undefined) await move(Math.max(0, Math.round(to)));
    // A moved list renders on the page's next frame. The rows must cover the viewport before they count.
    for (let n = 0; n < 4; n++) {
      await sleep(n === 0 && to === undefined ? 0 : 16);
      last = await read(); reads++;
      const rows = last.rows.filter(row => row.v);
      const covered = rows.some(row => row.y < last.top + last.client && row.y + row.h > last.top);
      if (covered && (to === undefined || Math.abs(last.top - Math.min(to, last.max)) <= 2) || last.max === 0 && rows.length) break;
    }
    const rows = last.rows.filter(row => row.v);
    for (const row of rows) seen.set(normalize(label(row)), label(row));
    const exact = rows.filter(row => tierOf(row, target) === 2);
    if (exact.length > 1) return { status: 'ambiguous', options: exact.map(label).slice(0, 5) };
    if (exact.length) return exact[0].d ? { status: 'disabled', text: label(exact[0]) } : { status: 'found', index: exact[0].i, text: label(exact[0]), row: exact[0] };
    for (const row of rows) if (tierOf(row, target) === 1) partial.set(normalize(label(row)), { text: label(row), y: row.y, h: row.h, d: row.d });
  };
  const over = () => now() - started > budgetMs || reads >= maxReads;
  let result = await look();
  if (result) return result;
  const rowHeight = () => Math.max(1, ...last.rows.filter(row => row.v).map(row => row.h).slice(0, 1));
  if (last.max > 0) {
    const step = Math.max(last.client - rowHeight(), rowHeight(), 40);
    // Bisect a long sorted list. Anything else, or a miss, falls through to the walk from the top.
    if (last.max > 3 * step && sorted(last.rows.filter(row => row.v))) {
      let low = 0, high = last.max, narrowed = false;
      for (let n = 0; n < 14 && !over(); n++) {
        if (high - low <= step) { narrowed = true; break; }
        result = await look((low + high) / 2);
        if (result) return result;
        const rows = last.rows.filter(row => row.v);
        if (!rows.length || !sorted(rows)) break;
        if (target < normalize(label(rows[0]))) high = last.top; else if (target > normalize(label(rows.at(-1)))) low = last.top; else break;
      }
      // Two viewports cover what is left of a narrowed range.
      for (const top of narrowed ? [low, high] : []) { result = await look(top); if (result) return result; }
    }
    for (let top = 0; !over(); top += step) {
      result = await look(top);
      if (result) return result;
      if (top >= last.max || last.top < top - 2) break;
    }
  }
  if (over() && partial.size !== 1) return { status: 'timeout', closest: closest(seen, target), seen: seen.size };
  if (partial.size === 1) {
    const [only] = partial.values();
    if (only.d) return { status: 'disabled', text: only.text };
    result = await look(only.y + only.h / 2 - last.client / 2);
    if (result) return result;
    const rows = last.rows.filter(row => row.v && normalize(label(row)) === normalize(only.text));
    if (rows.length === 1) return { status: 'found', index: rows[0].i, text: only.text, row: rows[0], partial: true };
    return { status: 'timeout', closest: closest(seen, target), seen: seen.size };
  }
  if (partial.size > 1) return { status: 'ambiguous', options: [...partial.values()].map(row => row.text).slice(0, 5) };
  return { status: 'none', closest: closest(seen, target), seen: seen.size };
}

export function describeMiss(result, want) {
  const some = list => list.length ? ': ' + list.map(text => '"' + text.slice(0, 60) + '"').join(', ') : '';
  if (result.status === 'ambiguous') return `several options match "${want.slice(0, 60)}"${some(result.options)}; give more of the text`;
  if (result.status === 'disabled') return `option "${result.text.slice(0, 60)}" is disabled`;
  if (result.status === 'timeout') return `the list search ran out of time after ${result.seen} options; closest${some(result.closest) || ': none'}`;
  return result.closest.length ? `no option matches "${want.slice(0, 60)}"; closest${some(result.closest)}` : `no option matches "${want.slice(0, 60)}" and the list has no options`;
}
