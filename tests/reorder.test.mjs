import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { reorder, reorderCode, rewriteDragAttempt } from '../plugins/sleight/lib/reorder.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const ENGINE_LIST = new Set(['count', 'evaluate', 'locator']);

function engineOnly(impl, allowed) {
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in Object.prototype) return target[prop];
      if (allowed.has(prop) && prop in target) return target[prop];
      return () => { throw new Error(`${String(prop)} is not a function`); };
    },
  });
}

function fixture(names, { noDrop = false, replace = false } = {}) {
  const calls = [], state = { names: [...names] };
  const text = value => ({ nodeType: 3, textContent: value });
  const row = name => ({ nodeType: 1, getAttribute: () => null, childNodes: [
    { nodeType: 1, getAttribute: key => key === 'aria-hidden' ? 'true' : null, childNodes: [text('⋮⋮')] },
    { nodeType: 1, getAttribute: () => null, childNodes: [text(name)] },
  ] });
  const list = engineOnly({
    count: async () => 1,
    evaluate: async fn => fn({ children: state.names.map(row) }),
    locator: selector => {
      assert.equal(selector, ':scope > *');
      return engineOnly({
        nth: index => engineOnly({ index }, new Set(['index'])),
      }, new Set(['nth']));
    },
  }, ENGINE_LIST);
  const tab = { playwright: { locator: () => list } };
  const drag = async (targetTab, from, to) => {
    assert.equal(targetTab, tab);
    calls.push(['drag', from.index, to.index]);
    if (!noDrop) state.names.splice(to.index, 0, state.names.splice(from.index, 1)[0]);
    if (replace) state.names[0] = 'Replacement';
    return { moved: true };
  };
  return { tab, list, state, calls, drag };
}

test('reorders rerendered rows, omits hidden grips and verifies the complete order', async () => {
  const h = fixture(['Billing', 'Security', 'Product updates', 'Mentions', 'Reminders']);
  const order = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
  const out = await reorder(h.tab, '#list', order, h.drag);
  assert.equal(out.verified, true);
  assert.deepEqual(out.after, order);
  assert.deepEqual(h.state.names, order);
  assert.equal(h.calls.filter(c => c[0] === 'drag').length, 3);
});

test('does not credit a helper movement claim when the complete order stayed unchanged', async () => {
  const h = fixture(['First', 'Second'], { noDrop: true });
  const out = await reorder(h.tab, h.list, ['Second', 'First'], h.drag);
  assert.equal(out.verified, false);
  assert.deepEqual(out.after, ['First', 'Second']);
  assert.match(out.note, /did not produce the requested order/);
  assert.equal(h.calls.filter(c => c[0] === 'drag').length, 1);
});

test('refuses duplicate, missing and partial row orders before input', async () => {
  for (const [rows, order] of [[['A', 'A'], ['A', 'A']], [['A', 'B'], ['A']], [['A', 'B'], ['A', 'C']]]) {
    const h = fixture(rows);
    await assert.rejects(reorder(h.tab, h.list, order, h.drag), error => {
      assert.match(error.message, /unique|permutation/);
      for (const name of [...rows, ...order]) assert.match(error.message, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    assert.equal(h.calls.length, 0);
  }
});

test('stops when a drop replaces a row and reports the observed order', async () => {
  const h = fixture(['A', 'B', 'C'], { replace: true });
  const out = await reorder(h.tab, h.list, ['B', 'C', 'A'], h.drag);
  assert.equal(out.verified, false);
  assert.deepEqual(out.after, ['Replacement', 'A', 'C']);
  assert.equal(h.calls.filter(c => c[0] === 'drag').length, 1);
});

test('returns a readback failure without claiming success or repeating input', async () => {
  const h = fixture(['A', 'B']);
  const read = h.list.evaluate;
  h.list.evaluate = async fn => {
    if (h.calls.some(c => c[0] === 'drag')) throw Error('read deadline');
    return read(fn);
  };
  const out = await reorder(h.tab, h.list, ['B', 'A'], h.drag);
  assert.equal(out.verified, false);
  assert.equal(out.after, null);
  assert.match(out.note, /input may have been sent/i);
});

test('an already ordered list needs no scroll or drag', async () => {
  const h = fixture(['A', 'B']);
  assert.equal((await reorder(h.tab, h.list, ['A', 'B'], h.drag)).verified, true);
  assert.deepEqual(h.calls, []);
});

test('injection provides both helpers and runs with a fresh global', async () => {
  const h = fixture(['A', 'B']);
  const context = createContext({ tab: h.tab });
  const code = reorderCode('return await sleight.reorder(tab, "#list", ["A", "B"]);');
  assert.match(code, /globalThis.sleight.dragTo/);
  const out = await runInContext('(async () => {' + code + '})()', context);
  assert.equal(out.verified, true);
});

test('waits for delayed row rendering after a drop', async () => {
  const h = fixture(['A', 'B']);
  const read = h.list.evaluate;
  let remaining = 2;
  h.list.evaluate = async fn => {
    if (h.calls.some(c => c[0] === 'drag') && remaining-- > 0) {
      const current = h.state.names;
      h.state.names = ['A', 'B'];
      const result = await read(fn);
      h.state.names = current;
      return result;
    }
    return read(fn);
  };
  assert.equal((await reorder(h.tab, h.list, ['B', 'A'], h.drag)).verified, true);
});

test('an input error leaves the resulting order unknown', async () => {
  const h = fixture(['A', 'B']);
  const out = await reorder(h.tab, h.list, ['B', 'A'], async () => { throw Error('drag deadline'); });
  assert.equal(out.verified, false);
  assert.equal(out.after, null);
  assert.match(out.note, /drag deadline.*Input may have been sent/);
});

test('the time cap prevents another drop', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const h = fixture(['A', 'B', 'C']);
  const out = await reorder(h.tab, h.list, ['C', 'B', 'A'], async (...args) => {
    const result = await h.drag(...args);
    t.mock.timers.tick(20001);
    return result;
  });
  assert.equal(out.verified, false);
  assert.match(out.note, /20 second/);
  assert.equal(h.calls.filter(c => c[0] === 'drag').length, 1);
});

test('engine locators reject methods the engine lacks', async () => {
  const h = fixture(['A', 'B']);
  const row = h.list.locator(':scope > *').nth(0);
  assert.throws(() => row.scrollIntoViewIfNeeded(), /not a function/);
  assert.throws(() => row.dragTo(row), /not a function/);
  assert.equal((await reorder(h.tab, h.list, ['B', 'A'], h.drag)).verified, true);
});

test('a failed drag-like tab call names sleight.reorder or sleight.dragTo', () => {
  assert.match(rewriteDragAttempt('TypeError: locator.dragTo is not a function'), /sleight\.reorder\(tab, list, order\)/);
  assert.match(rewriteDragAttempt('TypeError: locator.dragTo is not a function'), /sleight\.dragTo/);
  assert.equal(rewriteDragAttempt('TypeError: locator.dragTo is not a function').split('\n').length, 2);
  assert.match(rewriteDragAttempt('ReferenceError: DragEvent is not defined'), /sleight\.reorder/);
  assert.match(rewriteDragAttempt('Error: timeout', 'await tab.pressKey(null, "ArrowDown")'), /sleight\.reorder/);
  assert.equal(rewriteDragAttempt('Debugger unattached', 'await tab.click(1)'), 'Debugger unattached');
});

function errorReply(t, text, code) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [];
  clientOut.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => { if (line) output.push(JSON.parse(line)); }));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'js', arguments: { code } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
    isError: true, content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { kind: 'browserUse' } },
  } }) + '\n');
  return output.at(-1).result.content[0].text;
}

test('the relay appends the reorder hint on a locator.dragTo failure', t => {
  const out = errorReply(t, 'TypeError: loc.dragTo is not a function', 'await loc.dragTo(other)');
  assert.match(out, /sleight\.reorder\(tab, list, order\)/);
  assert.match(out, /sleight\.dragTo/);
});

test('the relay injects reorder only when requested', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'js', arguments: { code: 'nodeRepl.write(await sleight.reorder(tab, "#list", ["A", "B"]))' } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis.sleight.reorder/);
  assert.equal(reorderCode('await tab.getAXState()'), 'await tab.getAXState()');
});
