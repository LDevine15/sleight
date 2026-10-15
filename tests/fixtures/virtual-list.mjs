// A simulated virtual list for unit tests: it renders the rows in view plus an overscan, like the pages the option search is written for.
const STEMS = ['Ash', 'Bel', 'Cal', 'Dun', 'Elm', 'Fen', 'Glen', 'Har', 'Iron', 'Jade', 'Kent', 'Lark', 'Mill', 'Nor', 'Oak', 'Pine', 'Quill', 'Rock', 'Sand', 'Thorn'];
const TAILS = ['bridge', 'cliff', 'crest', 'dale', 'field', 'gate', 'haven', 'island', 'junction', 'keep', 'lake', 'moor', 'park', 'port', 'ridge', 'shore', 'springs', 'vale', 'wick', 'wood'];
export const AIRPORTS = STEMS.flatMap((stem, s) => TAILS.map((tail, t) => ({ name: stem + tail + ' International',
  code: String.fromCharCode(65 + s) + String.fromCharCode(65 + t) + String.fromCharCode(65 + (s * 7 + t * 3) % 26) }))).sort((a, b) => a.name.localeCompare(b.name));
export const label = a => a.name + ' (' + a.code + ')';

// A virtual list that renders the rows in view plus an overscan of two, like the pages the search is written for.
export function virtualList(items, { row = 36, client = 360, lag = 0, disabled = [], marks = false } = {}) {
  let top = 0, rendered = 0, pending = 0, chosen = -1; const calls = { read: 0, move: 0 };
  const api = {
    calls, get top() { return top; }, get chosen() { return items[chosen]; },
    // The row at this place in the DOM, as the page's own click handler would choose it.
    pick(domIndex) { chosen = Math.max(0, Math.floor(rendered / row) - 2) + domIndex; },
    async read() {
      calls.read++;
      if (pending > 0) pending--; else rendered = top;
      const first = Math.max(0, Math.floor(rendered / row) - 2), last = Math.min(items.length, first + Math.ceil(client / row) + 5);
      const rows = [];
      for (let i = first; i < last; i++) rows.push({ i: i - first, t: items[i], a: '', y: i * row, h: row, v: true, s: marks ? String(chosen === i) : null, d: disabled.includes(i) });
      return { top, max: Math.max(0, items.length * row - client), client, rows };
    },
    async move(to) { calls.move++; top = Math.max(0, Math.min(to, items.length * row - client)); pending = lag; return top; },
  };
  return api;
}
