import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { pickFromList, pickFromListCode } from '../plugins/sleight/lib/pick-from-list.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(labels, { top = 0, height = 100, disabled = [], duplicate = false, stalls = false, verify = true } = {}) {
  const calls = [], clicks = [], selected = [];
  let offset = top, attached = true;
  const root = { clientHeight: 800, clientWidth: 1000 };
  const document = { documentElement: root };
  const options = labels.map((text, i) => ({ textContent: text, selected: false,
    getAttribute: key => key === 'aria-disabled' ? String(disabled.includes(text)) :
      key === 'aria-selected' ? String(selected.includes(text)) : null,
    getBoundingClientRect: () => ({ x: 100, y: 100 + i * 20 - offset, width: 200, height: 20 }) }));
  const list = { get scrollTop() { return offset; }, scrollHeight: labels.length * 20, clientHeight: height,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height }),
    querySelectorAll: () => options.filter((el, i) => i * 20 >= offset - 20 && i * 20 < offset + height + 20) };
  const locator = { count: async () => attached ? 1 : 0,
    evaluate: async (fn, arg) => {
      if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
      return runInNewContext('(' + fn.toString() + ')(list, arg)', { list, document, arg });
    },
    getByRole: (role, { name, exact }) => {
      assert.equal(role, 'option'); assert.equal(exact, true);
      return { count: async () => duplicate ? 2 : labels.filter(text => text === name).length,
        click: async () => {
          const i = labels.indexOf(name);
          assert.ok(i * 20 >= offset && i * 20 < offset + height, 'only rendered options can be clicked');
          clicks.push(name);
          if (verify) selected.splice(0, selected.length, name);
        } };
    },
  };
  const tab = { playwright: { locator: selector => selector === '#list' ? locator : { count: async () => 0 } },
    scroll: async (point, direction, pages) => {
      calls.push({ point, direction, pages });
      assert.ok(point[0] > 100 && point[0] < 300 && point[1] > 100 && point[1] < 100 + height);
      assert.ok(Number.isFinite(pages) && pages > 0);
      if (!stalls) offset = Math.max(0, Math.min(labels.length * 20 - height, offset + (direction === 'up' ? -1 : 1) * pages * 800));
    } };
  return { tab, locator, calls, clicks, selected, list, detach: () => { attached = false; } };
}

test('a rendered option is selected exactly and read back without scrolling', async () => {
  for (const useLocator of [false, true]) {
    const h = fixture(['Alpha', 'Beta', 'Gamma']);
    const result = await pickFromList(h.tab, useLocator ? h.locator : '#list', 'Beta');
    assert.equal(result.found, true); assert.equal(result.verified, true);
    assert.deepEqual(Array.from(result.selected), ['Beta']);
    assert.deepEqual(h.clicks, ['Beta']); assert.equal(h.calls.length, 0);
  }
});

test('a sorted virtualized list uses bisection to find a distant option', async () => {
  const labels = Array.from({ length: 1000 }, (_, i) => 'Option ' + String(i).padStart(4, '0'));
  const h = fixture(labels);
  const result = await pickFromList(h.tab, '#list', 'Option 0876');
  assert.equal(result.verified, true);
  assert.ok(h.calls.length > 0 && h.calls.length <= 14, String(h.calls.length));
  assert.ok(h.calls[0].pages > 1, 'the first scroll bisects rather than scanning every page');
  assert.deepEqual(h.clicks, ['Option 0876']);
});

test('descending lists bisect and an unsorted list scans with overlapping steps', async () => {
  const labels = Array.from({ length: 200 }, (_, i) => 'Option ' + String(199 - i).padStart(3, '0'));
  const sorted = fixture(labels);
  assert.equal((await pickFromList(sorted.tab, '#list', 'Option 019')).verified, true);
  const h = fixture(['Zulu', 'Alpha', 'Echo', 'Beta', 'Mike', 'Delta', 'Oscar', 'Foxtrot', 'Tango', 'Hotel', 'India', 'Juliet']);
  const result = await pickFromList(h.tab, '#list', 'India');
  assert.equal(result.verified, true); assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(call => call.pages <= 0.125));
});

test('a search starting midway scans earlier options when the list is unsorted', async () => {
  const h = fixture(['Zulu', 'Alpha', 'Echo', 'Beta', 'Mike', 'Delta', 'Oscar', 'Foxtrot', 'Tango', 'Hotel'], { top: 100 });
  const result = await pickFromList(h.tab, '#list', 'Alpha');
  assert.equal(result.verified, true); assert.ok(h.calls.some(call => call.direction === 'up'));
});

test('missing options and a stalled scroll fail with observed labels and scroll position', async () => {
  for (const stalls of [false, true]) {
    const h = fixture(Array.from({ length: 20 }, (_, i) => 'Option ' + String(i).padStart(2, '0')), { stalls });
    const result = await pickFromList(h.tab, '#list', 'Missing');
    assert.equal(result.found, false); assert.equal(result.verified, false);
    assert.ok(result.seen.includes('Option 00')); assert.ok(Number.isFinite(result.position));
    assert.match(result.note, /not clicked|no option clicked/i);
    assert.ok(h.calls.length <= 24); assert.deepEqual(h.clicks, []);
  }
});

test('the search cap bounds an unsorted list without guessing a match', async () => {
  const labels = Array.from({ length: 10000 }, (_, i) => ['Zulu', 'Alpha', 'Mike'][i % 3] + i);
  const h = fixture(labels);
  const result = await pickFromList(h.tab, '#list', 'Missing');
  assert.equal(result.found, false); assert.match(result.note, /cap|24/);
  assert.ok(h.calls.length <= 24); assert.deepEqual(h.clicks, []);
});

test('ambiguous or disabled options send no click, and list and text inputs are validated', async () => {
  for (const settings of [{ duplicate: true }, { disabled: ['Beta'] }]) {
    const h = fixture(['Alpha', 'Beta', 'Gamma'], settings);
    const result = await pickFromList(h.tab, '#list', 'Beta');
    assert.equal(result.verified, false); assert.match(result.note, /ambiguous|disabled/);
    assert.deepEqual(h.clicks, []);
  }
  const h = fixture(['Alpha']);
  await assert.rejects(pickFromList(h.tab, '#missing', 'Alpha'), /exactly one/);
  await assert.rejects(pickFromList(h.tab, { count: async () => 2 }, 'Alpha'), /exactly one/);
  await assert.rejects(pickFromList(h.tab, '#list', ''), /text/);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.clicks, []);
});

test('a click without selection proof is reported unverified and is never retried', async () => {
  const h = fixture(['Alpha', 'Beta'], { verify: false });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.equal(result.found, true); assert.equal(result.verified, false);
  assert.deepEqual(Array.from(result.selected), []); assert.deepEqual(h.clicks, ['Beta']);
  assert.ok(result.seen.includes('Beta')); assert.ok(Number.isFinite(result.position));
  const detached = fixture(['Alpha', 'Beta']);
  detached.locator.getByRole = () => ({ count: async () => 1, click: async () => detached.detach() });
  const unknown = await pickFromList(detached.tab, '#list', 'Beta');
  assert.equal(unknown.verified, null); assert.match(unknown.note, /readback|read the page/i);
  assert.ok(unknown.seen.includes('Beta')); assert.ok(Number.isFinite(unknown.position));
});

test('a failed option click keeps observed labels and position without retrying input', async () => {
  const h = fixture(['Alpha', 'Beta']);
  let clicks = 0;
  h.locator.getByRole = () => ({ count: async () => 1, click: async () => { clicks++; throw new Error('covered'); } });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.equal(result.verified, null); assert.equal(clicks, 1);
  assert.ok(result.seen.includes('Beta')); assert.ok(Number.isFinite(result.position));
  assert.match(result.note, /Input may have been sent/);
});

// The render window and two-span rows follow FowlBrowser's MIT travel.html list.
// Only DOM storage and the scroll-event clock are replaced with test objects.
function travelList({ belowFold = false, delayed = false, missingOption = false } = {}) {
  const airports = Array.from({ length: 200 }, (_, i) => ({ name: 'Airport ' + String(i).padStart(3, '0'), code: 'AAA' }));
  airports.splice(140, 0, { name: 'Norcrest Point International', code: 'MAO' });
  airports.sort((a, b) => a.name.localeCompare(b.name));
  const ROW = 36, rows = [], selected = [], scrolls = [], clickNames = [];
  let y = belowFold ? 947 : 100, scrollTop = 0, pending = 0, reads = 0, reveals = 0;
  const list = { clientHeight: 216, scrollHeight: airports.length * ROW,
    get scrollTop() { return scrollTop; },
    getBoundingClientRect: () => ({ x: 100, y, width: 300, height: 216 }),
    scrollIntoView: (opts = {}) => { reveals++; y = 292; list.lastScroll = opts; },
    querySelectorAll: () => rows,
    append: row => rows.push(row) };
  const document = { documentElement: { clientWidth: 1000, clientHeight: 800 }, createElement: () => {
    const attributes = {};
    const row = { style: {}, getAttribute: name => attributes[name] ?? null,
      setAttribute: (name, value) => { attributes[name] = value; },
      remove: () => rows.splice(rows.indexOf(row), 1),
      getBoundingClientRect: () => ({ x: 100, y: y + parseFloat(row.style.top) - scrollTop, width: 300, height: ROW }),
      set innerHTML(value) {
        const parts = Array.from(value.matchAll(/<span(?: class="code")?>(.*?)<\/span>/g), match => match[1]);
        row.textContent = parts.join(''); row.innerText = parts.join(' ');
      } };
    return row;
  } };
  const state = { airport: '' };
  function renderRows() {
    const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 3);
    const last = Math.min(airports.length, first + Math.ceil(list.clientHeight / ROW) + 6);
    list.querySelectorAll('.opt').slice().forEach(o => o.remove());
    for (let i = first; i < last; i++) {
      const a = airports[i], o = document.createElement('div');
      o.className = 'opt'; o.setAttribute('role', 'option'); o.style.top = `${i * ROW}px`;
      o.setAttribute('aria-selected', String(a.code === state.airport));
      o.innerHTML = `<span>${a.name}</span><span class="code">${a.code}</span>`;
      o.onclick = () => { state.airport = a.code; selected.push(a.name); renderRows(); };
      list.append(o);
    }
  }
  renderRows();
  const locator = { count: async () => 1,
    evaluate: async (fn, arg) => {
      if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
      reads++;
      if (pending && --pending === 0) renderRows();
      return runInNewContext('(' + fn.toString() + ')(list, arg)', { list, document, arg });
    },
    getByRole: (role, { name, exact }) => {
      assert.equal(role, 'option'); assert.equal(exact, true);
      const matches = () => rows.filter(row => row.innerText === name);
      return { count: async () => missingOption ? 0 : matches().length,
        click: async () => { assert.equal(matches().length, 1); clickNames.push(name); matches()[0].onclick(); } };
    } };
  const tab = { playwright: { locator: () => locator }, scroll: async (point, direction, pages) => {
    assert.ok(point[1] >= 0 && point[1] < 800, 'scroll point is in the viewport');
    scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, scrollTop + (direction === 'up' ? -1 : 1) * pages * 800));
    scrolls.push({ direction, pages, position: scrollTop });
    if (delayed) pending = 4;
    else renderRows();
  } };
  return { tab, locator, selected, scrolls, clickNames, list, reads: () => reads, reveals: () => reveals };
}

test('the travel list two-span text is matched and clicked by the same accessible name', async () => {
  const h = travelList();
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.found, true, JSON.stringify(result)); assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clickNames, ['Norcrest Point International MAO']);
  assert.ok(h.scrolls.length > 0 && h.scrolls.length <= 72);
});

test('a travel list below the fold is revealed before scrolling', async () => {
  const h = travelList({ belowFold: true });
  assert.equal(typeof h.locator.scrollIntoViewIfNeeded, 'undefined');
  await assert.rejects(async () => h.locator.scrollIntoViewIfNeeded(), /not a function|is not a function/);
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true, JSON.stringify({ result, scrolls: h.scrolls }));
  assert.ok(h.reveals() > 0);
  assert.equal(h.list.lastScroll?.behavior, 'instant');
  assert.equal(h.list.lastScroll?.block, 'center');
});

test('delayed scroll events are reread before the travel list search advances', async () => {
  const h = travelList({ delayed: true });
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.ok(h.reads() > h.scrolls.length);
  assert.deepEqual(h.clickNames, ['Norcrest Point International MAO']);
});

test('a row locator that disappears is not found rather than ambiguous', async () => {
  const h = fixture(['Beta']);
  h.locator.getByRole = () => ({ count: async () => 0, click: async () => assert.fail('missing row was clicked') });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.match(result.note, /not found/i); assert.deepEqual(h.clicks, []);
});

test('a prefix inside a longer word never matches a list option', async () => {
  const h = fixture(['AlphaBeta']);
  const result = await pickFromList(h.tab, '#list', 'Alpha');
  assert.equal(result.found, false); assert.deepEqual(h.clicks, []);
});

test('a prefix match waits for an exact row further down and names the matched text', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome', 'Portland'], { height: 40 });
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, true);
  assert.equal(result.matched, 'Portland');
  assert.deepEqual(h.clicks, ['Portland']);
});

test('a prefix-only list still picks the full row after scanning', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome']);
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, true);
  assert.equal(result.matched, 'Portland International PDX');
  assert.deepEqual(h.clicks, ['Portland International PDX']);
});

test('evaluate scrollIntoView reveals a list below the fold; click and innerHTML writes still fail', async () => {
  const h = travelList({ belowFold: true });
  await h.locator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  assert.ok(h.reveals() > 0);
  await assert.rejects(h.locator.evaluate(el => el.click()), /read-only/);
  await assert.rejects(h.locator.evaluate(el => { el.innerHTML = 'x'; }), /read-only/);
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true);
});

test('the search stops after about 20 seconds', async () => {
  const labels = Array.from({ length: 40 }, (_, i) => 'Zulu' + i);
  const h = fixture(labels);
  const started = Date.now;
  let now = 0;
  Date.now = () => now;
  h.locator.evaluate = async (fn, arg) => {
    now = 21_000;
    if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
    return runInNewContext('(' + fn.toString() + ')(list, arg)', { list: h.list, document: { documentElement: { clientHeight: 800, clientWidth: 1000 } }, arg });
  };
  try {
    const result = await pickFromList(h.tab, '#list', 'Missing');
    assert.equal(result.found, false);
    assert.match(result.note, /20s|20 s|wall/i);
    assert.equal(result.matched, null);
  } finally { Date.now = started; }
});

test('a prefix rescan keeps the same 20s wall-clock cap', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome']);
  const realNow = Date.now;
  let n = 0;
  Date.now = () => ++n <= 2 ? 0 : 21_000;
  try {
    const result = await pickFromList(h.tab, '#list', 'Portland');
    assert.equal(result.found, false);
    assert.match(result.note, /20s|20 s|wall/i);
    assert.deepEqual(h.clicks, []);
  } finally { Date.now = realNow; }
});

test('the helper injects into a fresh realm and the relay installs it only when requested', async t => {
  const h = fixture(['Alpha', 'Beta']);
  const result = await runInNewContext('(async () => {' + pickFromListCode('return await sleight.pickFromList(tab, "#list", "Beta")') + '})()', { tab: h.tab });
  assert.equal(result.verified, true);
  assert.equal(pickFromListCode('await tab.getAXState()'), 'await tab.getAXState()');
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'nodeRepl.write(await sleight.pickFromList(tab, "#list", "Beta"))',
  } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis\.sleight\.pickFromList\s*=/);
});
