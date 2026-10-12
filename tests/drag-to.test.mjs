import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { dragTo, dragToCode } from '../plugins/sleight/lib/drag-to.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(source = { x: 20, y: 400, width: 100, height: 40 }, target = { x: 20, y: 200, width: 100, height: 40 }) {
  const calls = [], parent = { children: [] };
  const make = (id, rect) => ({ id, tagName: 'LI', textContent: id, parentElement: parent,
    getBoundingClientRect: () => rect, closest: () => null });
  const from = make('source', source), to = make('target', target);
  parent.children = [to, from];
  const document = { getElementById: id => parent.children.find(el => el.id === id),
    getElementsByTagName: () => parent.children,
    elementFromPoint: (x, y) => parent.children.find(el => {
      const r = el.getBoundingClientRect();
      return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    }) };
  const loc = el => ({ count: async () => el ? 1 : 0, evaluate: async fn => fn(el) });
  const tab = { playwright: { locator: selector => loc(selector === '#source' ? from : selector === '#target' ? to : null),
    evaluate: async (fn, arg) => runInNewContext('(' + fn.toString() + ')(arg)', { document, arg }) },
    drag: async (a, b) => { calls.push([a, b]); parent.children = [from, to]; } };
  return { tab, calls, from, to, locator: loc, parent };
}

test('the last two of eight equal drag moves land inside the target in every direction', async () => {
  for (const [x, y] of [[20, 400], [20, 0], [300, 200], [-200, 200], [300, 400], [-200, 0]]) {
    const h = fixture({ x, y, width: 100, height: 40 });
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
  assert.equal((await dragTo(h.tab, '#source', '#target')).indexChanged, false);
  const missing = fixture();
  missing.tab.drag = async () => { missing.parent.children = [missing.to]; };
  const result = await dragTo(missing.tab, '#source', '#target');
  assert.equal(result.after, null); assert.equal(result.indexChanged, null);
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
