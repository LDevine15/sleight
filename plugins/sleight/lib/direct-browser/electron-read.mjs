// The read for an opted-in Electron app window (EPV3-4). It is snapshot.mjs's read, unchanged in meaning
// (YAML, refs, redaction, find, since and delivery), with up to three header lines in front:
//   # <app> <version> (pid N) window W epoch E, join J <joined|parked: reason>[, renderer hidden]
//   # Document: <scheme>://<host> (app document) | <https origin> (web)
//   # Coverage (untrusted page content): rows F-L of T rendered; ...
// The first two come from trusted state (the AppInstance, the registry entry and the target record's URL),
// never from page text. Coverage is the page's own ARIA claim about a virtual list, read in the main world,
// and says so. The header counts against maxChars. Nothing here reads native document content.
const fail = code => { throw Error(code); };
const LINE = 240, COVERAGE_MS = 1000;
const clean = (value, size = LINE) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, size);
const line = text => clean(text).trimEnd();

// Closure-free: Playwright serializes it into the page. On the scoped root (or the body), the first
// tree, listbox, grid, table or list whose total is declared, by its own aria-rowcount (rows carry
// aria-rowindex) or by its items' aria-setsize (items carry aria-posinset). Null when there is none.
export const readCoverage = root => {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document.body;
  if (!scope || typeof scope.querySelectorAll !== 'function') return null;
  const whole = value => {
    if (value === null || value === undefined || !/^\s*\d{1,15}\s*$/.test(String(value))) return null;
    return Number(value);
  };
  const roleOf = node => String(node.getAttribute('role') ?? '').trim().split(/\s+/)[0].toLowerCase();
  const containers = [scope, ...scope.querySelectorAll('[role]')];
  for (let index = 0; index < containers.length && index < 20000; index++) {
    const node = containers[index];
    if (typeof node?.getAttribute !== 'function' || !/^(?:tree|listbox|grid|table|list)$/.test(roleOf(node))) continue;
    let total = whole(node.getAttribute('aria-rowcount')), first = Infinity, last = 0, rendered = 0;
    const take = position => { rendered++; if (position < first) first = position; if (position > last) last = position; };
    if (total !== null) {
      for (const row of node.querySelectorAll('[aria-rowindex]')) {
        const position = whole(row.getAttribute('aria-rowindex'));
        if (position !== null && position >= 1) take(position);
      }
    } else {
      for (const item of node.querySelectorAll('[aria-posinset]')) {
        const size = whole(item.getAttribute('aria-setsize')), position = whole(item.getAttribute('aria-posinset'));
        if (size === null || position === null || position < 1) continue;
        if (total === null) total = size;
        if (size === total) take(position);
      }
    }
    if (total !== null && rendered) return { declaredTotal: total, renderedRows: rendered, first, last };
  }
  return null;
};

// Pure. The summary is page content: anything that is not a consistent set of whole numbers prints nothing.
export function coverageLine(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const { declaredTotal: total, renderedRows: rendered, first, last } = summary;
  const whole = value => Number.isSafeInteger(value) && value >= 0 && value < 1e15;
  if (![total, rendered, first, last].every(whole) || first < 1 || first > last || last > total || rendered < 1 || rendered > total) return null;
  const all = first === 1 && last === total;
  return `# Coverage (untrusted page content): rows ${first}-${last} of ${total} rendered${all ? '' : '; scroll with until:text or press End for more'}`;
}

// From the trusted target record's URL: the scheme and host of an app document, or a web page's https origin.
function documentLine(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return '# Document: unavailable'; }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme === 'https') return line(`# Document: ${parsed.origin} (web)`);
  if (scheme === 'file') return '# Document: file:// (app document)';
  if (scheme !== 'http' && /^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) && parsed.host) return line(`# Document: ${scheme}://${parsed.host} (app document)`);
  return '# Document: unavailable';
}

async function coverageOf(page, ref) {
  let timer;
  try {
    let run;
    if (ref === undefined) run = () => page.evaluate(readCoverage);
    else if (/^(?:f\d+)?e\d+$/.test(ref) && typeof page.getByRef === 'function') run = () => page.getByRef(ref).evaluate(readCoverage, undefined, { timeout: COVERAGE_MS });
    else return null; // a closed-root control or a continuation: no element of its own to measure
    return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('coverage timed out')), COVERAGE_MS); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}

export function createAppSnapshot({ snapshot, pages, targets, app, now = Date.now } = {}) {
  if (typeof snapshot !== 'function' || typeof pages?.entryOf !== 'function' || typeof targets?.record !== 'function' || typeof now !== 'function' ||
      typeof app?.name !== 'string' || !app.name || typeof app.version !== 'string' || !Number.isSafeInteger(app.pid) || app.pid < 0) fail('ELECTRON_READ_REQUIRED');
  const name = clean(app.name, 64), version = clean(app.version, 32), pid = app.pid;
  return async function appSnapshot(page, options = {}) {
    const entry = pages.entryOf(page);
    if (!entry) fail('ELECTRON_PAGE_UNKNOWN');
    const maxChars = options.maxChars ?? 8000;
    if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 40000) throw Error('Invalid snapshot request');
    // EPV3-5 compares these with the entry before input: a join or target that changed after this point is stale.
    const start = { joinNo: entry.joinNo, epoch: entry.epoch, at: now() };
    Object.assign(entry.state, { readJoinNo: start.joinNo, readEpoch: start.epoch, readAt: start.at });
    try {
      const status = entry.parked ? 'parked: ' + clean(entry.parked, 120) : 'joined';
      const header = [
        line(`# ${name} ${version} (pid ${pid}) window ${entry.window?.id} epoch ${entry.window?.epoch}, join ${entry.joinNo} ${status}${entry.renderer === 'hidden' ? ', renderer hidden' : ''}`),
        documentLine(targets.record(entry.targetId)?.url),
      ];
      const coverage = coverageLine(await coverageOf(page, options.ref));
      if (coverage) header.push(coverage);
      const text = header.join('\n'), budget = maxChars - text.length - 1;
      if (budget < 1000) throw Error(`Snapshot unavailable: max_chars ${maxChars} leaves no room for the app window header; use max_chars: ${1001 + text.length} or more`);
      const value = await snapshot(page, { ...options, maxChars: budget });
      Object.assign(entry.state, { readJoinNo: start.joinNo, readEpoch: start.epoch, readAt: start.at });
      return { ...value, text: text + '\n' + value.text };
    } catch (error) {
      delete entry.state.readJoinNo; delete entry.state.readEpoch; delete entry.state.readAt;
      throw error;
    }
  };
}
