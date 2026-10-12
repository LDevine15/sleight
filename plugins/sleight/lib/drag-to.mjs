// The eight-step path and two-move dragover requirement were measured with
// bench/fowl/drag-probe.mjs, using an HTML5 list like FowlBrowser's MIT settings fixture.
export async function dragTo(tab, from, to) {
  if (!tab?.playwright || typeof tab.drag !== 'function') throw new Error('dragTo needs a browser tab.');
  const inspect = el => {
    if (Array.isArray(el)) {
      el = document.elementFromPoint(el[0], el[1]);
      el = el?.closest('[draggable="true"]') ?? el;
    }
    if (!el?.parentElement) throw new Error('dragTo needs exactly one attached element at each endpoint.');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      index: Array.from(el.parentElement.children).indexOf(el), id: el.id, tag: el.tagName, text: el.textContent };
  };
  const read = async endpoint => {
    let rect;
    if (Array.isArray(endpoint)) {
      if (endpoint.length !== 2 || !endpoint.every(Number.isFinite)) throw new Error('dragTo coordinates must be two finite numbers.');
      rect = await tab.playwright.evaluate(inspect, endpoint);
    } else {
      const loc = typeof endpoint === 'string' ? tab.playwright.locator(endpoint) : endpoint;
      if (!loc || await loc.count() !== 1) throw new Error('dragTo endpoints must match exactly one element.');
      rect = await loc.evaluate(inspect);
    }
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('dragTo needs a nonempty finite rectangle at each endpoint.');
    }
    return rect;
  };
  const source = await read(from), target = await read(to);
  const start = [source.x + source.width / 2, source.y + source.height / 2];
  const end = [target.x, target.y].map((min, axis) => {
    const size = axis ? target.height : target.width, margin = Math.min(3, size / 4);
    const low = min + margin, high = min + size - margin;
    // Both the release p and the penultimate move (7p + start) / 8 must be inside.
    const lo = Math.max(low, (8 * low - start[axis]) / 7);
    const hi = Math.min(high, (8 * high - start[axis]) / 7);
    if (lo > hi) throw new Error('dragTo cannot put the last two moves inside this target. Use a shorter hop. Nothing was pressed.');
    const preferred = start[axis] < low ? low : start[axis] > high ? high : (low + high) / 2;
    return Math.max(lo, Math.min(hi, preferred));
  });
  await tab.drag(start, end);
  let after = null, note;
  try {
    after = await tab.playwright.evaluate(source => {
      const matches = Array.from(document.getElementsByTagName(source.tag)).filter(el =>
        source.id ? el.id === source.id : el.textContent === source.text);
      return matches.length === 1 && matches[0].parentElement
        ? Array.from(matches[0].parentElement.children).indexOf(matches[0]) : null;
    }, { id: source.id, tag: source.tag, text: source.text });
    if (after === null) note = 'Source readback is missing or ambiguous; read the page before retrying.';
  } catch { note = 'Source readback failed; input was sent. Read the page before retrying.'; }
  return { from: start, to: end, before: source.index, after,
    indexChanged: after === null ? null : source.index !== after, ...(note ? { note } : {}) };
}

export function dragToCode(code) {
  if (!/\bsleight\s*\.\s*dragTo\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.dragTo = (${dragTo.toString()});\n${code}`;
}
