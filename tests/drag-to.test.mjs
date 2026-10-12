import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { dragTo, dragToCode } from '../plugins/sleight/lib/drag-to.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(source = { x: 20, y: 400, width: 100, height: 40 }, target = { x: 20, y: 200, width: 100, height: 40 }, viewport = { width: 1000, height: 1000 }) {
  const calls = [], scrolls = [], offset = { x: 0, y: 0 };
  const root = { tagName: 'HTML', id: '', clientWidth: viewport.width, clientHeight: viewport.height,
    scrollWidth: 3000, scrollHeight: 5000, children: [], parentElement: null,
    scrollBy: ({ left = 0, top = 0 }) => {
      scrolls.push({ left, top }); offset.x = Math.max(0, offset.x + left); offset.y = Math.max(0, offset.y + top);
    } };
  const parent = { tagName: 'UL', id: 'list', children: [], parentElement: root, overflowY: 'visible',
    contains: el => parent.children.includes(el) };
  root.children = [parent];
  const make = (id, rect) => ({ id, tagName: 'LI', textContent: id, parentElement: parent,
    getBoundingClientRect: () => ({ ...rect, x: rect.x - offset.x, y: rect.y - offset.y }), closest: () => null,
    scrollIntoView: () => {
      scrolls.push(id); offset.x = Math.max(0, rect.x + rect.width / 2 - viewport.width / 2);
      offset.y = Math.max(0, rect.y + rect.height / 2 - viewport.height / 2);
    } });
  const from = make('source', source), to = make('target', target);
  parent.children = [to, from];
  const document = { documentElement: root, scrollingElement: root, getElementById: id => parent.children.find(el => el.id === id),
    getElementsByTagName: () => parent.children,
    elementFromPoint: (x, y) => parent.children.find(el => {
      const r = el.getBoundingClientRect();
      return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    }) };
  const window = { scrollBy: value => root.scrollBy(value), getComputedStyle: el => ({ overflowY: el.overflowY ?? 'visible' }) };
  const loc = el => ({ count: async () => el ? 1 : 0, evaluate: async (fn, arg) => runInNewContext('(' + fn.toString() + ')(el, arg)', { document, window, el, arg }) });
  const tab = { playwright: { locator: selector => loc(selector === '#source' ? from : selector === '#target' ? to : null),
    evaluate: async (fn, arg) => runInNewContext('(' + fn.toString() + ')(arg)', { document, window, arg }) },
    drag: async (a, b) => { calls.push([a, b]); parent.children = [from, to]; } };
  return { tab, calls, scrolls, from, to, locator: loc, parent, root, document, window };
}

test('the last two of eight equal drag moves land inside the target in every direction', async () => {
  for (const [x, y] of [[320, 420], [320, 20], [600, 220], [20, 220], [600, 420], [20, 20]]) {
    const h = fixture({ x, y, width: 100, height: 40 }, { x: 320, y: 220, width: 100, height: 40 });
    const result = await dragTo(h.tab, '#source', '#target');
    const [from, to] = h.calls[0], r = h.to.getBoundingClientRect();
    assert.deepEqual(from, [x + 50, y + 20]);
    for (const point of [to, to.map((value, axis) => value - (value - from[axis]) / 8)]) {
      assert.ok(point[0] > r.x && point[0] < r.x + r.width);
      assert.ok(point[1] > r.y && point[1] < r.y + r.height);
    }
    assert.equal(result.before, 1); assert.equal(result.after, 0); assert.equal(result.indexChanged, true);
  }
});

test('below-fold endpoints are scrolled before their final rectangles are read', async () => {
  for (const endpoints of ['selectors', 'locators']) {
    const h = fixture({ x: 20, y: 1200, width: 100, height: 40 }, { x: 20, y: 1360, width: 100, height: 40 }, { width: 800, height: 500 });
    const result = await dragTo(h.tab, endpoints === 'selectors' ? '#source' : h.locator(h.from),
      endpoints === 'selectors' ? '#target' : h.locator(h.to));
    assert.ok(h.scrolls.length > 0);
    for (const point of [result.from, result.to]) assert.ok(point[1] >= 0 && point[1] < 500);
    assert.equal(result.moved, true);
  }
});

test('a span that fits the viewport is centered after endpoint scrolling separates it', async () => {
  const h = fixture({ x: 20, y: 1200, width: 100, height: 40 }, { x: 20, y: 1540, width: 100, height: 60 }, { width: 800, height: 500 });
  const result = await dragTo(h.tab, '#source', '#target');
  assert.ok(h.scrolls.some(value => typeof value === 'object'), 'the common scroller centers the span');
  assert.ok(result.from[1] >= 0 && result.from[1] < 500);
  assert.ok(result.to[1] >= 0 && result.to[1] < 500);
});

test('a move to the same index in another parent is reported as moved', async () => {
  const h = fixture();
  h.parent.children = [h.from, h.to];
  const other = { id: 'other', tagName: 'UL', parentElement: h.root, children: [] };
  h.root.children.push(other);
  h.document.getElementsByTagName = () => [...h.parent.children, ...other.children];
  h.tab.drag = async () => { h.parent.children = [h.to]; other.children = [h.from]; h.from.parentElement = other; };
  const result = await dragTo(h.tab, '#source', '#target');
  assert.equal(result.before, 0); assert.equal(result.after, 0);
  assert.equal(result.indexChanged, false); assert.equal(result.parentChanged, true); assert.equal(result.moved, true);
});

test('text identity sent to readback is capped and ambiguous prefixes remain unverified', async () => {
  const h = fixture();
  h.from.id = ''; h.from.textContent = 'x'.repeat(2000);
  const evaluate = h.tab.playwright.evaluate, args = [];
  h.tab.playwright.evaluate = async (fn, arg) => { args.push(arg); return evaluate(fn, arg); };
  const result = await dragTo(h.tab, h.locator(h.from), '#target');
  assert.equal(result.after, 0);
  const keys = args.flatMap(arg => [arg, arg?.source, arg?.target]).filter(arg => typeof arg?.text === 'string');
  assert.ok(keys.length > 0); assert.ok(keys.every(key => key.text.length <= 200));
  const ambiguous = fixture();
  ambiguous.from.id = ''; ambiguous.to.id = '';
  ambiguous.from.textContent = 'x'.repeat(200) + 'one';
  ambiguous.tab.drag = async () => { ambiguous.to.textContent = 'x'.repeat(200) + 'two'; };
  const unverified = await dragTo(ambiguous.tab, ambiguous.locator(ambiguous.from), ambiguous.locator(ambiguous.to));
  assert.equal(unverified.moved, null);
});

test('an impossible span names intermediate hops or scrolling before any drag', async () => {
  const h = fixture({ x: 20, y: 1000, width: 100, height: 40 }, { x: 20, y: 0, width: 100, height: 10 });
  await assert.rejects(dragTo(h.tab, '#source', '#target'), /element in between|scroll/i);
  assert.deepEqual(h.calls, []);
});

test('a shared nested scroller centers both endpoints within its own clip', async () => {
  const h = fixture();
  let top = 0;
  Object.assign(h.parent, { clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 1000, overflowY: 'auto',
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 300, height: 200 }),
    scrollBy: value => { top = Math.max(0, top + value.top); } });
  for (const [el, y] of [[h.from, 600], [h.to, 720]]) {
    el.getBoundingClientRect = () => ({ x: 120, y: 100 + y - top, width: 100, height: 40 });
    el.scrollIntoView = () => { top = y + 20 - 100; };
  }
  const result = await dragTo(h.tab, '#source', '#target');
  assert.ok(top > 0);
  for (const point of [result.from, result.to]) {
    assert.ok(point[0] >= 100 && point[0] < 400);
    assert.ok(point[1] >= 100 && point[1] < 300);
  }
});

test('duplicate labels and textless tiles keep the caller endpoints, without scrolling visible elements', async () => {
  for (const text of ['Task', '']) {
    const h = fixture();
    h.from.id = ''; h.to.id = ''; h.from.textContent = text; h.to.textContent = text;
    await dragTo(h.tab, h.locator(h.from), h.locator(h.to));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.scrolls, []);
  }
});

test('duplicate offscreen labels scroll through the caller locators', async () => {
  const h = fixture({ x: 20, y: 1200, width: 100, height: 40 }, { x: 20, y: 1360, width: 100, height: 40 }, { width: 800, height: 500 });
  h.from.id = ''; h.to.id = ''; h.from.textContent = 'Task'; h.to.textContent = 'Task';
  await dragTo(h.tab, h.locator(h.from), h.locator(h.to));
  assert.equal(h.calls.length, 1);
  assert.ok(h.scrolls.length > 0);
});

test('coordinate endpoints scroll their captured elements when labels repeat', async () => {
  const h = fixture({ x: 20, y: 400, width: 100, height: 40 }, { x: 20, y: 600, width: 100, height: 60 }, { width: 800, height: 500 });
  h.from.id = ''; h.to.id = ''; h.from.textContent = ''; h.to.textContent = '';
  const result = await dragTo(h.tab, [70, 420], h.locator(h.to));
  assert.equal(h.calls.length, 1);
  assert.equal(result.from[1], h.from.getBoundingClientRect().y + 20);
});

test('a parent without an ancestor id is unverified rather than a claimed move', async () => {
  const h = fixture(); h.parent.id = '';
  h.tab.drag = async () => {};
  const result = await dragTo(h.tab, '#source', '#target');
  assert.equal(result.parentChanged, null);
  assert.equal(result.moved, null);
  assert.match(result.note, /Parent identity is unverified/);
});

test('a banner inserted above the same parent is not a parent move', async () => {
  const h = fixture();
  h.tab.drag = async () => { h.root.children.unshift({ tagName: 'DIV', id: 'banner', parentElement: h.root }); };
  const result = await dragTo(h.tab, '#source', '#target');
  assert.equal(result.parentChanged, false);
  assert.equal(result.moved, false);
});

test('an id-less parent under an identified app stays unverified after a banner is inserted', async () => {
  const h = fixture(); h.root.id = 'app'; h.parent.id = '';
  h.tab.drag = async () => { h.root.children.unshift({ tagName: 'DIV', id: 'banner', parentElement: h.root }); };
  const result = await dragTo(h.tab, '#source', '#target');
  assert.equal(result.indexChanged, false);
  assert.equal(result.parentChanged, null);
  assert.equal(result.moved, null);
  assert.match(result.note, /Parent identity is unverified/);
});

test('root span centering uses window.scrollBy', async () => {
  const h = fixture({ x: 20, y: 1200, width: 100, height: 40 }, { x: 20, y: 1540, width: 100, height: 60 }, { width: 800, height: 500 });
  const scrollBy = h.root.scrollBy; let windows = 0;
  h.window.scrollBy = value => { windows++; scrollBy(value); };
  h.root.scrollBy = () => { throw new Error('root element scrollBy is unsupported'); };
  await dragTo(h.tab, '#source', '#target');
  assert.equal(windows, 1);
});

test('overflow visible and hidden ancestors are not selected as scrolling containers', async () => {
  for (const overflowY of ['visible', 'hidden']) {
    const h = fixture();
    Object.assign(h.parent, { clientWidth: 100, clientHeight: 100, scrollWidth: 100, scrollHeight: 1000, overflowY,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      scrollBy: () => { throw new Error('not a scrolling container'); } });
    await dragTo(h.tab, '#source', '#target');
    assert.equal(h.calls.length, 1);
  }
});

test('coordinate endpoints retain their element when scrolling changes the point contents', async () => {
  const h = fixture({ x: 20, y: 400, width: 100, height: 40 }, { x: 20, y: 600, width: 100, height: 60 }, { width: 800, height: 500 });
  const result = await dragTo(h.tab, [70, 420], '#target');
  const rect = h.from.getBoundingClientRect();
  assert.equal(result.from[1], rect.y + rect.height / 2);
  assert.notEqual(result.from[1], 420);
  assert.equal(result.after, 0);
});

test('a path that still exceeds the viewport refuses before input', async () => {
  const h = fixture({ x: 20, y: 1200, width: 100, height: 40 }, { x: 20, y: 1360, width: 100, height: 40 }, { width: 800, height: 100 });
  await assert.rejects(dragTo(h.tab, '#source', '#target'), /viewport.*shorter hop/i);
  assert.deepEqual(h.calls, []);
});

test('selectors, locator objects and coordinates read current rectangles before dragging', async () => {
  const h = fixture();
  await dragTo(h.tab, h.locator(h.from), [70, 220]);
  assert.equal(h.calls.length, 1);
  const points = fixture();
  const result = await dragTo(points.tab, [70, 420], '#target');
  assert.deepEqual(points.calls[0][0], [70, 420]);
  assert.equal(result.after, 0);
});

test('unreachable targets and invalid or ambiguous inputs send no drag', async () => {
  for (const [source, target] of [[{ x: 20, y: 1000, width: 100, height: 40 }, { x: 20, y: 0, width: 100, height: 10 }],
    [{ x: 20, y: 400, width: 100, height: 40 }, { x: 20, y: 200, width: 0, height: 40 }]]) {
    const h = fixture(source, target);
    await assert.rejects(dragTo(h.tab, '#source', '#target'), /shorter hop|rectangle/);
    assert.deepEqual(h.calls, []);
  }
  const h = fixture();
  for (const from of ['#missing', [NaN, 3], { count: async () => 2 }]) {
    await assert.rejects(dragTo(h.tab, from, '#target'), /exactly one|finite/);
  }
  assert.deepEqual(h.calls, []);
});

test('readback reports unchanged order and ambiguous source identity without claiming a move', async () => {
  const h = fixture();
  h.tab.drag = async (from, to) => { h.calls.push([from, to]); };
  const unchanged = await dragTo(h.tab, '#source', '#target');
  assert.equal(unchanged.indexChanged, false); assert.equal(unchanged.parentChanged, false); assert.equal(unchanged.moved, false);
  const missing = fixture();
  missing.tab.drag = async () => { missing.parent.children = [missing.to]; };
  const result = await dragTo(missing.tab, '#source', '#target');
  assert.equal(result.after, null); assert.equal(result.indexChanged, null); assert.equal(result.parentChanged, null); assert.equal(result.moved, null);
  assert.match(result.note, /readback|source/);
});

test('the helper is self-contained when injected and the relay hooks browser calls', async t => {
  const h = fixture();
  const result = await runInNewContext('(async () => {' + dragToCode('return await sleight.dragTo(tab, "#source", "#target")') + '})()', { tab: h.tab });
  assert.equal(result.after, 0);
  assert.equal(dragToCode('await tab.getAXState()'), 'await tab.getAXState()');
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'nodeRepl.write(await sleight.dragTo(tab, "#source", "#target"))',
  } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis\.sleight\.dragTo\s*=/);
});
