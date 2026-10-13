import { locateList } from './list-locate.mjs';

export async function pickFromList(tab, list, text, opts = {}) {
  if (!tab?.playwright || typeof tab.scroll !== 'function') throw new Error('pickFromList needs a browser tab.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('pickFromList needs nonempty option text.');
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const wanted = normalize(text);
  const { loc } = await locateList(tab, list, 'pickFromList');
  const options = { timeoutMs: 1000 }, seen = new Set(), started = opts.started ?? Date.now();
  const read = async () => {
    if (await loc.count() !== 1) throw new Error('List is missing or ambiguous.');
    return loc.evaluate(el => {
      const r = el.getBoundingClientRect(), root = document.documentElement;
      const left = Math.max(0, r.x), right = Math.min(root.clientWidth, r.x + r.width);
      const top = Math.max(0, r.y), bottom = Math.min(root.clientHeight, r.y + r.height);
      const rows = Array.from(el.querySelectorAll('[role="option"], option')).map(option => {
        const rect = option.getBoundingClientRect();
        return { text: String(option.getAttribute('aria-label') ?? option.innerText ?? option.textContent ?? '').replace(/\s+/g, ' ').trim(),
          disabled: option.disabled === true || option.getAttribute('aria-disabled') === 'true',
          selected: option.selected === true || option.getAttribute('aria-selected') === 'true',
          visible: rect.width > 0 && rect.height > 0 && rect.y >= top && rect.y + rect.height <= bottom && rect.x < right && rect.x + rect.width > left };
      });
      return { position: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight), height: el.clientHeight,
        viewport: root.clientHeight, point: [(left + right) / 2, (top + bottom) / 2], inView: right > left && bottom > top,
        rows: rows.filter(row => row.visible).slice(0, 200), selected: rows.filter(row => row.selected).map(row => row.text) };
    }, undefined, options);
  };
  let state = await read(), scrolls = 0, prefix = null;
  if (!state.inView) {
    await loc.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), undefined, options);
    state = await read();
  }
  const remember = () => { for (const row of state.rows) if (seen.size < 50) seen.add(row.text.slice(0, 200)); };
  const fail = note => ({ found: false, verified: false, matched: null, selected: state.selected, position: state.position,
    scrolls, seen: [...seen], note: 'No option clicked. ' + note });
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const order = rows => {
    if (rows.length < 2) return 0;
    const signs = rows.slice(1).map((row, i) => Math.sign(compare(row.text, rows[i].text)));
    return signs.every(n => n >= 0) && signs.some(n => n > 0) ? 1 :
      signs.every(n => n <= 0) && signs.some(n => n < 0) ? -1 : 0;
  };
  let sort = order(state.rows), low = 0, high = state.max, scanning = opts.scan || !sort, fromStart = false;
  const choose = async name => {
    if (state.rows.find(row => row.text === name)?.disabled) return fail('The matching option is disabled.');
    const option = loc.getByRole('option', { name, exact: true });
    const count = await option.count();
    if (count !== 1) return fail(count === 0 ? 'The matching option was not found.' : 'The matching option is ambiguous.');
    try { await option.click(options); }
    catch (error) {
      return { found: true, verified: null, matched: name, selected: null, position: state.position, scrolls,
        seen: [...seen],
        note: 'Option click failed. Input may have been sent. Read the page before retrying. ' + String(error.message) };
    }
    try {
      state = await read();
      const verified = state.selected.includes(name);
      return { found: true, verified, matched: name, selected: state.selected,
        position: state.position, scrolls, ...(verified ? {} : { seen: [...seen], note: 'The option was clicked, but selection was not verified. Read the page before retrying.' }) };
    } catch {
      return { found: true, verified: null, matched: name, selected: null, position: state.position, scrolls,
        seen: [...seen], note: 'Selection readback failed after the click. Read the page before retrying.' };
    }
  };
  const ended = note => (!prefix || prefix === wanted) ? fail(note) : pickFromList(tab, list, prefix, { scan: true, started });
  for (;;) {
    remember();
    if (Date.now() - started >= 20_000) return fail('The search reached its 20s cap.');
    if (![state.position, state.max, state.height, state.viewport, ...state.point].every(Number.isFinite) ||
        state.height <= 0 || state.viewport <= 0 || !state.inView) return fail('The list needs a finite rectangle inside the viewport.');
    const exact = state.rows.filter(row => row.text === wanted);
    const prefixes = state.rows.filter(row => row.text.startsWith(wanted + ' '));
    if (exact.length > 1) return fail('The matching option is ambiguous.');
    if (exact.length === 1) return choose(exact[0].text);
    if (prefixes.length) {
      const names = [...new Set(prefixes.map(row => row.text))];
      if (names.length > 1 && (!prefix || names.some(name => name !== prefix))) return fail('The matching option is ambiguous.');
      prefix ??= names[0];
    }
    if (scrolls >= (opts.scan ? 48 : 24)) return ended('The search reached its 24-scroll cap.');
    let next;
    if (!scanning) {
      if (order(state.rows) !== sort) scanning = true;
      else if (sort * compare(wanted, state.rows[0].text) < 0) high = Math.min(high, Math.max(0, state.position - 1));
      else if (sort * compare(wanted, state.rows.at(-1).text) > 0) low = Math.max(low, Math.min(state.max, state.position + 1));
      else scanning = true;
      if (!scanning) {
        next = (low + Math.min(high, state.max)) / 2;
        if (Math.abs(next - state.position) < 1) {
          next = sort * compare(wanted, state.rows[0].text) < 0 ? Math.floor(next) : Math.ceil(next);
        }
        if (low > high || Math.abs(next - state.position) < 0.5) scanning = true;
      }
    }
    if (scanning) {
      if (!fromStart && state.position > 1) next = 0;
      else {
        fromStart = true;
        if (state.position >= state.max - 1) return ended('The list ended without the requested option.');
        next = Math.min(state.max, state.position + state.height * 0.75);
      }
    }
    const previous = state.position, delta = next - previous;
    const previousRows = JSON.stringify(state.rows.map(row => row.text));
    try {
      // Coordinate scroll pages use the tab's viewport height, not the list's height.
      await tab.scroll(state.point, delta < 0 ? 'up' : 'down', Math.min(8, Math.abs(delta) / Math.max(100, state.viewport)));
      scrolls++;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 50));
        state = await read();
        if (Math.abs(state.position - previous) >= 0.5 && state.rows.length &&
            JSON.stringify(state.rows.map(row => row.text)) !== previousRows) break;
      }
      if (Math.abs(state.position - previous) < 0.5) { remember(); return fail('Scrolling did not advance the list.'); }
      if (!state.rows.length) return fail('Rendered options did not settle after scrolling.');
    } catch (error) { return fail('Scroll or read failed. Input may have been sent. Read the page before retrying. ' + String(error.message)); }
  }
}

export function pickFromListCode(code) {
  if (!/\bsleight\s*\.\s*pickFromList\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.pickFromList = ((locateList) => (${pickFromList.toString()}))(${locateList.toString()});\n${code}`;
}
