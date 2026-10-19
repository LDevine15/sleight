// app.pickFromList(label): the engine-path counterpart of turbo's pick-from-list.mjs, which needs Playwright.
// Serialized into the engine's realm alongside the cooperative app guard, like elementWait, so nothing
// here may use module scope. Every key, wheel step and the final click go through the guarded handle (window,
// lease and stale-element checks); the helper adds its own checks on the list it pages through.
// The Firefox travel form's 1,000-row airport list cost 34.6 and 36.3 s of small scroll/read loops
// (astra-1018-forms, 2026-10-18); the offline model of this search found every label in 1,000/1,000
// lists with 18 to 20 reads.
//
// What b7 (race-1017, 2026-10-19) measured, and what this follows: after the click the skill asks for, the read
// names a "Selected:" row instead of the focused list (5 of 7 calls stopped there). Page_Down moves Safari's web list
// about 2.2 rows a key and Firefox's about 9, and the wheel moves Safari's 10 rows a tick, so the mover is chosen by
// the rows each step moved. Rows rendered past the list's visible band have no frame (Safari r1, -10005), so a matched
// row is brought toward the middle of the rendered rows before the click.
export function listPicker({ read, observe, press, scroll, click, parse, sameElement, expected, clicked,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const LIST_ROLE = /^(?:list box|listbox|list)(?: \([^()]*\))*(?: |,|$)/;
  // Totals per search; a key step with fewer rows a key than MIN_KEY_ROWS moves to the wheel.
  const MAX_KEYS = 400, MAX_TICKS = 400, MIN_KEY_ROWS = 5, FIRST_TICKS = 2, MAX_TICK_STEP = 32, MAX_CENTERING = 3;
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const words = value => String(value).replace(/\s+/g, ' ').trim();
  // The list's rows from one tree: a row's label is its first line without role and states.
  // Its later lines (a name above a code) are kept, so the name alone can name the row.
  // The list is the focused element or its parent; or, when the read names only a "Selected:" row, that row's
  // parent, if this call's last action clicked that list or one of its rows (keys could reach anything else).
  const view = (text, trusted) => {
    const rows = [], selected = [];
    let open = false, tail = false, inSelection = false;
    for (const line of String(text).split('\n')) {
      if (/^(?:The focused UI element is |Selected:\r?$)/.test(line)) { tail = true; open = false; inSelection = /^Selected:/.test(line); continue; }
      const m = /^(\t*)(\d+) (.*?)\r?$/.exec(line);
      if (tail) {
        if (inSelection && m && m[1].length === 1) selected.push({ number: Number(m[2]), body: m[3] });
        else inSelection = false;
        continue;
      }
      if (m) { rows.push({ depth: m[1].length, number: Number(m[2]), body: m[3], extra: [] }); open = true; }
      else if (!line.trim()) open = false;
      else if (open && !/^Window: /.test(line)) rows.at(-1).extra.push(line.replace(/\r$/, ''));
    }
    const focus = /^The focused UI element is (\d+) (.+?)\r?$/m.exec(text);
    const anchors = focus ? [{ number: Number(focus[1]), body: focus[2] }] : selected;
    if (!anchors.length) return { problem: 'The window names no focused element or selected row, so the list cannot be verified.' };
    const listOf = anchor => {
      const at = rows.findIndex(row => row.number === anchor.number);
      if (at < 0 || !sameElement(anchor.body, rows[at].body)) return { problem: 'The ' + (focus ? 'focused' : 'selected') + ' element is missing from the tree.' };
      if (LIST_ROLE.test(rows[at].body)) return { at };
      for (let i = at - 1; i >= 0; i--) if (rows[i].depth < rows[at].depth) return LIST_ROLE.test(rows[i].body) ? { at: i } : { not: rows[at] };
      return { not: rows[at] };
    };
    const found = anchors.map(listOf);
    const problem = found.find(item => item.problem)?.problem;
    if (problem) return { problem };
    const outside = found.find(item => item.not);
    if (outside || found.some(item => item.at !== found[0].at)) {
      return { problem: (focus ? 'Focus' : 'The selection') + ' is on ' + JSON.stringify((outside?.not ?? rows[found[0].at]).body.slice(0, 60)) + ', not a list or one of its rows.' };
    }
    const listAt = found[0].at, list = rows[listAt], kids = [];
    for (let i = listAt + 1; i < rows.length && rows[i].depth > list.depth; i++) if (rows[i].depth === list.depth + 1) kids.push(rows[i]);
    // The list this search already accepted needs no click: its rows moved under these keys or wheel steps.
    if (!focus && !(trusted && sameElement(trusted, list.body)) &&
        !(clicked && [list, ...kids].some(row => row.number === clicked.number && sameElement(clicked.line, row.body)))) {
      return { problem: 'The read names a selected row in ' + JSON.stringify(list.body.slice(0, 60)) + ' but no focused element, and the action just before was not a click on that list or one of its rows.' };
    }
    // The role is the lowercase words every row starts with ("text", then states such as "(selectable)").
    const runs = kids.map(kid => {
      const parts = kid.body.split(' '), end = parts.findIndex(word => !/^[a-z]+$/.test(word));
      return parts.slice(0, end < 0 ? parts.length : end);
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
    return { list: list.body, rows: labeled, labels: labeled.map(row => row.label), focused: !!focus };
  };
  return async (label, options = {}) => {
    const maxReads = options?.maxReads ?? 60, coarse = options?.coarse ?? 4, timeoutMs = options?.timeoutMs ?? 20000;
    if (typeof label !== 'string' || !label.trim()) throw new Error('pickFromList needs the exact label of a row.');
    if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100 || !Number.isInteger(coarse) || coarse < 1 || coarse > 8 ||
        !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) {
      throw new Error('pickFromList takes maxReads from 1 to 100, coarse from 1 to 8 pages and timeoutMs up to 60000.');
    }
    // "Norcrest Point International\nMAO" (Firefox r2, b7) is the row's name and code on two lines.
    const target = words(label), deadline = now() + timeoutMs;
    const isMatch = row => row.label === target || words(row.name ?? '') === target;
    let identity = expected, reads = 0, keys = 0, ticks = 0, v, listLine, previous, direction = 0, fine = false, confirmed = null;
    // The mover in use, the units of the last move, and the rows one unit moved (measured, per mover).
    let mover = 'key', step = coarse, lastStep = 0, lastMover = 'key', centering = 0, centerDir = 0, heldAt = 0, retried = false;
    // The first and last labels seen in this search, which tell whether the list can be at its top or end.
    let lowest, highest;
    const rate = {};
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
      const seen = view(text, listLine);
      if (seen.labels?.length) {
        if (!lowest || compare(seen.labels[0], lowest) < 0) lowest = seen.labels[0];
        if (!highest || compare(seen.labels.at(-1), highest) > 0) highest = seen.labels.at(-1);
      }
      for (const row of seen.rows ?? []) if (near.size < 3 && row.label.startsWith(target + ' ')) near.add(row.label);
      return seen;
    };
    const stop = (reason, note, extra) => ({ found: false, clicked: false, reason, reads, keys, ...(ticks ? { ticks } : {}),
      ...(v?.labels?.length ? { first: v.labels[0], last: v.labels.at(-1) } : {}),
      ...(near.size ? { near: [...near] } : {}), ...extra,
      note: 'No row clicked. ' + note + (near.size ? ' Rows starting with it: ' + [...near].join('; ') + '. Pass a whole row label.' : '') });
    const sameRows = (a, b) => !!a.labels && !!b?.labels && a.labels.length === b.labels.length && a.labels.every((x, i) => x === b.labels[i]);
    // Rows the list moved from `a` to `b` in direction d, from their overlap. Without one it moved past every rendered
    // row (Firefox: 36 rows a 4-key step against 16 rendered), which measures nothing but is no slow mover.
    const shifted = (a, b, d) => {
      const at = d > 0 ? a.labels.indexOf(b.labels[0]) : b.labels.indexOf(a.labels[0]);
      return at >= 0 ? at : undefined;
    };
    // A list held at an end shifts its rendered rows less than it moved, so the largest measurement stands.
    // A step past every rendered row moved at least that many rows: a lower bound (`atLeast`), never a rate for moves.
    const atLeast = {};
    const measure = (how, a, b, d, units) => {
      const rows = shifted(a, b, d);
      if (rows !== undefined) rate[how] = Math.max(rate[how] ?? 0, rows / units);
      else atLeast[how] = Math.max(atLeast[how] ?? 0, a.labels.length / units);
    };
    const move = async (d, units, how = mover) => {
      if (how === 'key' && !v.focused) throw new Error('pickFromList stopped: no read shows the focus on the list, so no key was sent. Read the window again.');
      if (how === 'key') for (let i = 0; i < units; i++) { await press(d > 0 ? 'Page_Down' : 'Page_Up'); keys++; }
      else { await scroll(v.list, d > 0 ? 'down' : 'up', units); ticks += units; }
      lastStep = units; lastMover = how;
      confirmed = null;
      let next = await look();
      // An unchanged window can be a redraw still in flight: look once more before calling it stuck.
      if (sameRows(next, v) && reads < maxReads) { await sleep(80); next = await look(); }
      return next;
    };
    // The finest measured mover, for small moves; a key when nothing was measured yet. Keys only after a read that shows
    // the focus on the list: with only a "Selected:" row nothing shows where keys go.
    const finest = () => {
      const keyed = v.focused || !scroll;
      const movers = ['key', 'wheel'].filter(how => rate[how] > 0 && (how === 'key' ? keyed : scroll));
      return movers.sort((a, b) => rate[a] - rate[b])[0] ?? (scroll && (rate.key === 0 || !keyed) ? 'wheel' : 'key');
    };
    const moverName = how => how === 'key' ? (direction > 0 ? 'Page_Down' : 'Page_Up') : 'the scroll wheel';
    v = await look();
    // A read that names only a selected row: the wheel on the list, which needs no focus, until a read shows the focus.
    let blind = !v.problem && !v.focused;
    if (blind) {
      if (!scroll) return stop('not-a-list', 'Only a selected row names the list, and keys need a read that shows the focus on it.');
      mover = 'wheel'; step = FIRST_TICKS;
    }
    for (;;) {
      if (v.problem) return stop(listLine ? 'focus-lost' : 'not-a-list', v.problem + (listLine ? (keys ? ' Keys may have reached another control.' : ' No key was sent.') : ' Click the list or one of its rows just before pickFromList, in the same call.'));
      if (listLine && !sameElement(listLine, v.list)) {
        return stop('focus-lost', 'Focus moved from ' + JSON.stringify(listLine.slice(0, 60)) + ' to ' + JSON.stringify(v.list.slice(0, 60)) + '. Keys may have reached another control.');
      }
      listLine ??= v.list;
      if (v.labels.length < 3) return stop('not-a-list', 'The list shows fewer than three labeled rows, so its order cannot be checked.');
      const bad = v.labels.findIndex((text, i) => i && compare(v.labels[i - 1], text) >= 0);
      if (bad > 0) return stop('unsorted', 'The visible rows are not in strictly ascending order (' + JSON.stringify(v.labels[bad - 1]) + ' before ' + JSON.stringify(v.labels[bad]) + '), so a position cannot be inferred.');
      if (previous) {
        if (sameRows(v, previous)) {
          // Keys that move nothing may not reach the list; the wheel scrolls the list itself.
          if (lastMover === 'key' && scroll && rate.wheel === undefined) {
            rate.key = 0; mover = 'wheel'; step = FIRST_TICKS;
            if (now() >= deadline || ticks + step > MAX_TICKS) return stop('cap', 'The search reached its ' + (now() >= deadline ? 'time' : 'wheel') + ' cap.');
            v = await move(direction, step);
            continue;
          }
          // Firefox's wheel moves about half a row a tick (10 ticks, 5 rows: b7 r2 c16), which the overscan held at the top
          // of the list hides. The ticks double up to 8 before the wheel counts as stuck.
          if (lastMover === 'wheel' && lastStep < 8 && ticks + lastStep * 2 <= MAX_TICKS && now() < deadline) {
            step = lastStep * 2;
            v = await move(direction, step);
            continue;
          }
          return stop('no-progress', 'The list did not move after ' + moverName(lastMover) + ' (' + (direction > 0 ? 'the end' : 'the top') + ' of the list, or ' + (lastMover === 'key' ? 'keys' : 'the wheel') + ' not reaching it).');
        }
        const was = previous.labels;
        const moved = direction > 0 ? compare(v.labels.at(-1), was.at(-1)) > 0 && compare(v.labels[0], was[0]) >= 0
          : compare(v.labels[0], was[0]) < 0 && compare(v.labels.at(-1), was.at(-1)) <= 0;
        if (!moved) return stop('unsorted', 'The rows went the wrong way after ' + moverName(lastMover) + ', so the list is not a plain sorted list.');
        if (fine && lastStep === 1 && !v.labels.some(text => was.includes(text))) {
          return stop('gap', 'One step moved past every previously seen row, so rows may have been skipped.');
        }
        measure(lastMover, previous, v, direction, lastStep);
        heldAt = 0;
        // Safari's web list: about 2.2 rows a Page_Down against 10 a wheel tick (b7 r1 and r3).
        if (mover === 'key' && lastMover === 'key' && rate.key < MIN_KEY_ROWS && scroll) { mover = 'wheel'; step = FIRST_TICKS; }
      }
      // Focus shows on the list now: keys may go, and they take over from a wheel slower than MIN_KEY_ROWS rows a tick.
      if (blind && v.focused) {
        blind = false;
        if (!(Math.max(rate.wheel ?? 0, atLeast.wheel ?? 0) >= MIN_KEY_ROWS)) { mover = 'key'; step = fine ? 1 : coarse; }
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
        // Rows rendered past the visible band have no frame, or a frame under other controls. The travel list renders 16
        // rows and shows 10: rendered rows 3 to 12 in the middle of the list, 0 to 9 at its top and 6 to 15 at its end. The
        // row is clicked inside the band shown at every place the list can still be. It can be at its top until a row before
        // the first rendered one is seen, and is known there once a move up leaves the rows as they were; its end likewise.
        // Generic bands: the middle half, plus the first or last five eighths at an end.
        const n = v.rows.length, at = v.rows.indexOf(hits[0]);
        const topOpen = !!lowest && compare(lowest, v.labels[0]) < 0, endOpen = !!highest && compare(highest, v.labels.at(-1)) > 0;
        let lo = Math.floor(n / 4), hi = n - 1 - Math.floor(n / 4);
        if (heldAt < 0) { lo = 0; hi = Math.ceil(5 * n / 8) - 1; }
        else if (heldAt > 0) { lo = Math.floor(3 * n / 8); hi = n - 1; }
        else {
          if (!topOpen) hi = Math.min(hi, Math.ceil(5 * n / 8) - 1);
          if (!endOpen) lo = Math.max(lo, Math.floor(3 * n / 8));
        }
        if ((at < lo || at > hi) && centering < MAX_CENTERING && reads < maxReads - 1 && now() < deadline) {
          // d > 0 scrolls the list down, which moves the row up the rendered rows.
          const d = at > hi ? 1 : -1, how = finest(), unit = rate[how] > 0 ? rate[how] : undefined;
          const landing = units => at - d * units * unit, miss = i => i < lo ? lo - i : i > hi ? i - hi : 0;
          // The units that leave the row nearest the band and still rendered, if that is nearer than now: a 10-row wheel
          // tick would take Safari's fourth rendered row to its fourteenth. A move back the other way goes only into the
          // band: a 9-row Firefox key otherwise takes a row from one side of it to the other and back.
          let units = unit ? 0 : 1;
          for (let k = 1; unit && k <= Math.ceil(n / unit); k++) {
            const i = landing(k);
            if (i >= 0 && i <= n - 1 && miss(i) < miss(units ? landing(units) : at)) units = k;
          }
          if (d === -centerDir && !(unit && units && !miss(landing(units)))) units = 0;
          if (units > 0 && (how === 'key' ? keys + units <= MAX_KEYS : ticks + units <= MAX_TICKS)) {
            centering++; centerDir = d;
            const before = v;
            v = await move(d, units, how);
            // Rows that stay put after a move toward an end: the list is at that end when rows past the other side were
            // seen, or when the move was longer than the rows rendered past the shown ones (3/8 of them), so it was no
            // overscan held at the other end. An unmeasured move up counts as long: a list opens at its top.
            if (sameRows(v, before)) { if ((d < 0 ? endOpen : topOpen) || (unit ? units * unit >= 3 * n / 8 : d < 0)) heldAt = d; }
            else { heldAt = 0; measure(how, before, v, d, units); }
            previous = undefined;
            continue;
          }
        }
        try { await click(hits[0].body); }
        catch (error) {
          if (!/elementHasNoFrame|\bis an invalid element ID\b/.test(String(error?.message ?? error))) throw error;
          // The engine sends nothing for a row with no frame. Read again, move the row one unit toward the middle, and
          // retry once.
          if (!retried && reads < maxReads - 2 && now() < deadline) {
            retried = true; previous = undefined; confirmed = null;
            const before = v;
            v = await look();
            const again = v.rows?.find(isMatch);
            if (again && sameRows(v, before)) {
              const d = v.rows.indexOf(again) > (v.rows.length - 1) / 2 ? 1 : -1;
              v = await move(d, 1, finest());
              if (!sameRows(v, before)) { heldAt = 0; measure(lastMover, before, v, d, 1); }
            }
            centering = 0; centerDir = 0;
            continue;
          }
          return { found: true, clicked: false, reason: 'click-failed', reads, keys, ...(ticks ? { ticks } : {}), label: hits[0].label,
            note: 'The row was found but could not be clicked (' + String(error.message ?? error).split('\n')[0] + '). Input may have been sent. Read the window before retrying.' };
        }
        // The read after the click must show this row selected: a click on a row the list does not show reaches what is
        // drawn there (in Firefox's travel form, the Back and Next buttons sit right under the list).
        const after = await look();
        const picked = after.rows?.find(isMatch);
        if (!picked || !/\((?:[^()]*, )?selected(?:, [^()]*)?\)/.test(picked.body)) {
          return { found: true, clicked: false, reason: 'click-unverified', reads, keys, ...(ticks ? { ticks } : {}), label: hits[0].label,
            note: 'The row was clicked, but the read after it does not show it selected, so the click may have reached another control. Read the window before retrying.' };
        }
        return { found: true, clicked: true, label: hits[0].label, reads, keys, ...(ticks ? { ticks } : {}) };
      }
      const first = v.labels[0], last = v.labels.at(-1);
      if (compare(target, first) >= 0 && compare(target, last) <= 0) {
        return stop('not-in-list', JSON.stringify(target) + ' sorts between visible rows ' + JSON.stringify(first) + ' and ' + JSON.stringify(last) + ' but no row has that label.');
      }
      const need = compare(target, last) > 0 ? 1 : -1;
      if (direction && need !== direction) {
        if (fine && lastStep === 1) return stop('not-in-list', 'Rows on both sides were checked step by step and none has that label.');
        fine = true;
      }
      // Keys page coarse, then one at a time after the first reversal. The wheel doubles its ticks until it passes
      // the row, then halves them each step: 10 rows a tick reach row 612 in about 11 steps.
      if (mover === 'key') step = fine ? 1 : coarse;
      else if (fine) step = Math.max(1, Math.floor(step / 2));
      else if (direction === need && lastMover === 'wheel') step = Math.min(MAX_TICK_STEP, step * 2);
      direction = need;
      if (reads >= maxReads || (mover === 'key' ? keys + step > MAX_KEYS : ticks + step > MAX_TICKS) || now() >= deadline) {
        return stop('cap', 'The search reached its ' + (reads >= maxReads ? 'read' : now() >= deadline ? 'time' : mover === 'key' ? 'key' : 'wheel') + ' cap.');
      }
      previous = v;
      v = await move(direction, step);
    }
  };
}
