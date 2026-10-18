// app.pickFromList(label): the engine-path counterpart of turbo's pick-from-list.mjs, which needs Playwright.
// Serialized into the engine's realm alongside the cooperative app guard, like elementWait, so nothing
// here may use module scope. Every key and the final click go through the guarded handle (window,
// lease and stale-element checks); the helper adds its own checks on the list it pages through.
// The Firefox travel form's 1,000-row airport list cost 34.6 and 36.3 s of small scroll/read loops
// (astra-1018-forms, 2026-10-18); the offline model of this search found every label in 1,000/1,000
// lists with 18 to 20 reads.
export function listPicker({ read, observe, press, click, parse, sameElement, expected,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const LIST_ROLE = /^(?:list box|listbox|list)(?: \([^()]*\))*(?: |,|$)/;
  const MAX_KEYS = 400;
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  // The focused list's rows from one tree: a row's label is its first line without role and states.
  // Its later lines (a name above a code) are kept, so the name alone can name the row.
  const view = text => {
    const rows = [];
    let open = false;
    for (const line of String(text).split('\n')) {
      const m = /^(\t*)(\d+) (.*?)\r?$/.exec(line);
      if (m) { rows.push({ depth: m[1].length, number: Number(m[2]), body: m[3], extra: [] }); open = true; }
      else if (!line.trim()) open = false;
      else if (open && !/^(?:The focused UI element is|Window: )/.test(line)) rows.at(-1).extra.push(line.replace(/\r$/, ''));
    }
    const focus = /^The focused UI element is (\d+) (.+?)\r?$/m.exec(text);
    if (!focus) return { problem: 'The window names no focused element, so the list cannot be verified.' };
    const at = rows.findIndex(row => row.number === Number(focus[1]));
    if (at < 0 || !sameElement(focus[2], rows[at].body)) return { problem: 'The focused element is missing from the tree.' };
    let listAt = at;
    if (!LIST_ROLE.test(rows[at].body)) {
      listAt = -1;
      for (let i = at - 1; i >= 0 && listAt < 0; i--) if (rows[i].depth < rows[at].depth) listAt = i;
      if (listAt < 0 || !LIST_ROLE.test(rows[listAt].body)) {
        return { problem: 'Focus is on ' + JSON.stringify(rows[at].body.slice(0, 60)) + ', not a list or one of its rows.' };
      }
    }
    const list = rows[listAt], kids = [];
    for (let i = listAt + 1; i < rows.length && rows[i].depth > list.depth; i++) if (rows[i].depth === list.depth + 1) kids.push(rows[i]);
    // The role is the lowercase words every row starts with ("text", then states such as "(selectable)").
    const runs = kids.map(kid => {
      const words = kid.body.split(' '), end = words.findIndex(word => !/^[a-z]+$/.test(word));
      return words.slice(0, end < 0 ? words.length : end);
    });
    const role = runs.reduce((common, run) => {
      let n = 0;
      while (n < common.length && common[n] === run[n]) n++;
      return common.slice(0, n);
    }, runs[0] ?? []).join(' ');
    const labelOf = body => {
      const rest = body.slice(role.length).trimStart().replace(/^(?:\([^()]*\) )+/, '');
      const described = /^Description: (.*?)(?=, (?:Value|ID|Help|Secondary Actions): |$)/.exec(rest);
      return described ? described[1] : rest.split(/, (?=(?:Value|ID|Help|Secondary Actions|Description|URL): )/)[0];
    };
    const labeled = kids.map(kid => ({ number: kid.number, body: kid.body, label: labelOf(kid.body), name: kid.extra[0] }))
      .filter(row => row.label);
    return { list: list.body, rows: labeled, labels: labeled.map(row => row.label) };
  };
  return async (label, options = {}) => {
    const maxReads = options?.maxReads ?? 60, coarse = options?.coarse ?? 4, timeoutMs = options?.timeoutMs ?? 20000;
    if (typeof label !== 'string' || !label.trim()) throw new Error('pickFromList needs the exact label of a row.');
    if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100 || !Number.isInteger(coarse) || coarse < 1 || coarse > 8 ||
        !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) {
      throw new Error('pickFromList takes maxReads from 1 to 100, coarse from 1 to 8 pages and timeoutMs up to 60000.');
    }
    const target = label.trim(), deadline = now() + timeoutMs;
    const isMatch = row => row.label === target || row.name === target;
    let identity = expected, reads = 0, keys = 0, v, listLine, previous, direction = 0, fine = false, confirmed = null;
    const near = new Set();
    const look = async () => {
      const text = await read();
      reads++;
      const header = parse(text);
      if (!header || (identity && ['title', 'app', 'url'].some(key => header[key] !== identity[key]))) {
        throw new Error('pickFromList stopped: window changed or its full header is missing.\n' + text);
      }
      identity = header;
      observe(text);
      const seen = view(text);
      for (const row of seen.rows ?? []) if (near.size < 3 && row.label.startsWith(target + ' ')) near.add(row.label);
      return seen;
    };
    const stop = (reason, note, extra) => ({ found: false, clicked: false, reason, reads, keys,
      ...(v?.labels?.length ? { first: v.labels[0], last: v.labels.at(-1) } : {}),
      ...(near.size ? { near: [...near] } : {}), ...extra,
      note: 'No row clicked. ' + note + (near.size ? ' Rows starting with it: ' + [...near].join('; ') + '. Pass a whole row label.' : '') });
    const sameRows = (a, b) => !!a.labels && !!b?.labels && a.labels.length === b.labels.length && a.labels.every((x, i) => x === b.labels[i]);
    const move = async d => {
      const pages = fine ? 1 : coarse;
      for (let i = 0; i < pages; i++) { await press(d > 0 ? 'Page_Down' : 'Page_Up'); keys++; }
      confirmed = null;
      let next = await look();
      // An unchanged window can be a redraw still in flight: look once more before calling it stuck.
      if (sameRows(next, v) && reads < maxReads) { await sleep(80); next = await look(); }
      return next;
    };
    v = await look();
    for (;;) {
      if (v.problem) return stop(listLine ? 'focus-lost' : 'not-a-list', v.problem + (listLine ? ' Keys may have reached another control.' : ' Focus the list first.'));
      if (listLine && !sameElement(listLine, v.list)) {
        return stop('focus-lost', 'Focus moved from ' + JSON.stringify(listLine.slice(0, 60)) + ' to ' + JSON.stringify(v.list.slice(0, 60)) + '. Keys may have reached another control.');
      }
      listLine ??= v.list;
      if (v.labels.length < 3) return stop('not-a-list', 'The list shows fewer than three labeled rows, so its order cannot be checked.');
      const bad = v.labels.findIndex((text, i) => i && compare(v.labels[i - 1], text) >= 0);
      if (bad > 0) return stop('unsorted', 'The visible rows are not in strictly ascending order (' + JSON.stringify(v.labels[bad - 1]) + ' before ' + JSON.stringify(v.labels[bad]) + '), so a position cannot be inferred.');
      if (previous) {
        if (sameRows(v, previous)) return stop('no-progress', 'The list did not move after ' + (direction > 0 ? 'Page_Down' : 'Page_Up') + ' (' + (direction > 0 ? 'the end' : 'the top') + ' of the list, or keys not reaching it).');
        const was = previous.labels;
        const moved = direction > 0 ? compare(v.labels.at(-1), was.at(-1)) > 0 && compare(v.labels[0], was[0]) >= 0
          : compare(v.labels[0], was[0]) < 0 && compare(v.labels.at(-1), was.at(-1)) <= 0;
        if (!moved) return stop('unsorted', 'The rows went the wrong way after ' + (direction > 0 ? 'Page_Down' : 'Page_Up') + ', so the list is not a plain sorted list.');
        if (fine && !v.labels.some(text => was.includes(text))) {
          return stop('gap', 'One page moved past every previously seen row, so rows may have been skipped.');
        }
      }
      const hits = v.rows.filter(isMatch);
      if (hits.length > 1) return stop('ambiguous', hits.length + ' rows match ' + JSON.stringify(target) + '.');
      if (hits.length === 1) {
        // The match came from a tree taken before any later key or redraw. Click only a row that the
        // newest tree shows once, with no key pressed since the tree before it.
        if (confirmed !== hits[0].label) {
          if (reads >= maxReads) return stop('cap', 'The search reached its read cap before confirming the row.');
          confirmed = hits[0].label; previous = undefined;
          v = await look();
          continue;
        }
        try { await click(hits[0].body); }
        catch (error) {
          if (!/elementHasNoFrame|\bis an invalid element ID\b/.test(String(error?.message ?? error))) throw error;
          return { found: true, clicked: false, reason: 'click-failed', reads, keys, label: hits[0].label,
            note: 'The row was found but could not be clicked (' + String(error.message ?? error).split('\n')[0] + '). Input may have been sent. Read the window before retrying.' };
        }
        return { found: true, clicked: true, label: hits[0].label, reads, keys };
      }
      const first = v.labels[0], last = v.labels.at(-1);
      if (compare(target, first) >= 0 && compare(target, last) <= 0) {
        return stop('not-in-list', JSON.stringify(target) + ' sorts between visible rows ' + JSON.stringify(first) + ' and ' + JSON.stringify(last) + ' but no row has that label.');
      }
      const need = compare(target, last) > 0 ? 1 : -1;
      if (direction && need !== direction) {
        if (fine) return stop('not-in-list', 'Rows on both sides were checked page by page and none has that label.');
        fine = true;
      }
      direction = need;
      if (reads >= maxReads || keys + (fine ? 1 : coarse) > MAX_KEYS || now() >= deadline) {
        return stop('cap', 'The search reached its ' + (reads >= maxReads ? 'read' : keys + (fine ? 1 : coarse) > MAX_KEYS ? 'key' : 'time') + ' cap.');
      }
      previous = v;
      v = await move(direction);
    }
  };
}
