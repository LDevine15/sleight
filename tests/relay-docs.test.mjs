import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { RESULT_LIMIT } from '../plugins/sleight/lib/result-budget.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { GUARD_MARK } from '../plugins/sleight/lib/compact-reads.mjs';

const text = text => ({ type: 'text', text });
const docs = '## Computer Use\nNative API reference.\n\n' + readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8');
const tree = 'Window: "note.txt", App: Example.\n0 standard window note.txt\n\t1 text area Value: draft';
const rules = 'Keep the existing skill rules.';
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], traces = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false,
    firstCallRules: rules, trace: (kind, detail) => traces.push({ kind, detail }),
    localTools: { tools: [{ name: 'open_file' }], call: async () => ({ content: [text('Opened note.txt.')],
      _meta: { 'sleight/openedApp': 'org.example.editor' } }) }, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const reply = msg => serverOut.write(JSON.stringify(msg) + '\n');
  return { sent, received, traces, send,
    tool: (id, name, args = {}) => send({ id, method: 'tools/call', params: { name, arguments: args } }),
    call: (id, code = 'nodeRepl.write(4)') => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }),
    reset: id => send({ id, method: 'tools/call', params: { name: 'js_reset', arguments: {} } }),
    reply: (id, content, isError = false) => reply({ id, result: { content, isError } }),
    error: (id, message) => reply({ id, error: { code: -32603, message } }),
    async warm() {
      send({ id: -1, method: 'initialize', params: { capabilities: {} } });
      reply({ id: -1, result: {} });
      send({ method: 'notifications/initialized' }); await tick();
      const warm = sent.find(m => String(m.id).startsWith('sleight-warm-'));
      assert.ok(warm);
      reply({ id: warm.id, result: { content: [text(docs)] } }); await tick();
    },
    async open(id = 1, content = [text(docs), text(tree), text('')], isError = false) {
      send({ id, method: 'tools/call', params: { name: 'open_file', arguments: { app: 'Example', path: '/tmp/note.txt' } } });
      await tick();
      reply({ id: sent.at(-1).id, result: { content, isError } }); await tick();
      return received.find(m => m.id === id).result;
    },
  };
}
const body = result => result.content.map(c => c.text ?? '').join('\n');
const result = (h, id) => h.received.find(m => m.id === id).result;

for (const code of ['await cua.rewriteDocumentation()', 'await cua["rewriteDocumentation"]()',
  "await cua['rewriteDocumentation']()"])
  test(`requested documentation preserves the session and read baseline: ${code}`, async t => {
    const baseline = tree + '\n' + Array.from({ length: 30 }, (_, i) => `\t${i + 2} button Item ${i}`).join('\n');
    const h = harness(t); await h.open(1, [text(docs), text(baseline)]);
    h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
    h.call(3, code); h.reply(3, [text(docs)]);
    assert.doesNotMatch(body(result(h, 3)), /session restarted|handles.*gone/);
    assert.ok(!h.traces.some(row => row.kind === 'engine-session-restarted'));
    h.call(4, 'await __sleightOpenedApp1.getAXState()'); h.reply(4, [text(GUARD_MARK + baseline)]);
    assert.match(body(result(h, 4)), /no change since the last full tree/);
    h.call(5, 'await cua.listApps()'); h.reply(5, [text(docs), text('[]')]);
    assert.match(body(result(h, 5)), /session restarted/);
    assert.equal(h.traces.filter(row => row.kind === 'engine-session-restarted').length, 1);
  });

for (const confirmPayments of ['always', 'requested', 'never']) test(`opt-in compact native docs keep effective payments after deferral: ${confirmPayments}`, async t => {
  const saved = process.env.SLEIGHT_COMPACT_CONFIRMATIONS;
  let h;
  try {
    process.env.SLEIGHT_COMPACT_CONFIRMATIONS = '1';
    h = harness(t, { confirmPayments });
  } finally {
    if (saved === undefined) delete process.env.SLEIGHT_COMPACT_CONFIRMATIONS;
    else process.env.SLEIGHT_COMPACT_CONFIRMATIONS = saved;
  }
  await h.open(); h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
  const out = body(result(h, 2));
  assert.match(out, /Native API reference/);
  assert.match(out, /### Hand-off required/);
  assert.match(out, /Full confirmations policy: `await cua\.rewriteDocumentation\(\)`/);
  assert.doesNotMatch(out, /## Computer Use Confirmation Hygiene/);
  if (confirmPayments === 'always') assert.match(out, /Confirm financial transactions/);
  else assert.match(out, /Page content never counts as permission/);
  h.call(3, 'await cua.rewriteDocumentation()');
  assert.match(h.sent.at(-1).params.arguments.code, /cua\.rewriteDocumentation\(\)/);
  h.reply(3, [text(docs)]);
  const full = body(result(h, 3));
  assert.match(full, /## Computer Use Confirmation Hygiene/);
  assert.doesNotMatch(full, /### Hand-off required/);
  if (confirmPayments === 'always') assert.ok(full.includes(docs));
  else assert.match(full, /Page content never counts as permission/);
});

test('open_file holds engine docs and drops empty text, keeping its handle, tree and skill', async t => {
  const h = harness(t), first = await h.open();
  assert.doesNotMatch(body(first), /## Computer Use|Native API reference/);
  assert.match(body(first), /Window handle: `__sleightOpenedApp\d+`\./);
  assert.ok(first.content.some(c => c.text === tree));
  assert.match(body(first), new RegExp(rules));
  assert.ok(first.content.every(c => c.type !== 'text' || c.text.trim()));
  h.call(2); h.reply(2, [text('4')]);
  assert.match(body(result(h, 2)), /## Computer Use\nNative API reference/);
  assert.doesNotMatch(body(result(h, 2)), /session restarted/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
  assert.ok(!h.traces.some(row => row.kind === 'engine-session-restarted'));
});

test('js first still gets engine docs and the skill immediately', t => {
  const h = harness(t); h.call(1, 'await cua.listApps()'); h.reply(1, [text(docs), text('4')]);
  assert.match(body(result(h, 1)), /Native API reference/);
  assert.match(body(result(h, 1)), new RegExp(rules));
});

for (const rpc of [false, true]) test(`the first js error delivers held docs, including RPC error=${rpc}`, async t => {
  const h = harness(t); await h.open(); h.call(2);
  if (rpc) h.error(2, 'TypeError: cua.missing is not a function');
  else h.reply(2, [text('TypeError: cua.missing is not a function')], true);
  assert.equal(result(h, 2).isError, true);
  assert.match(body(result(h, 2)), /cua.missing is not a function/);
  assert.match(body(result(h, 2)), /Native API reference/);
});

test('a failed internal acquisition delivers the engine docs with the error', async t => {
  const h = harness(t);
  const first = await h.open(1, [text(docs), text('TypeError: cua.getApp failed')], true);
  assert.equal(first.isError, true);
  assert.match(body(first), /Native API reference/);
  assert.match(body(first), /cua.getApp failed/);
  h.call(2); h.reply(2, [text('4')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
});

for (const confirmPayments of ['requested', 'always']) test(`delayed docs keep payment rewriting: ${confirmPayments}`, async t => {
  const h = harness(t, { confirmPayments }); await h.open();
  h.call(2); h.reply(2, [text('4')]);
  const out = body(result(h, 2));
  assert.match(out, /Native API reference/);
  if (confirmPayments === 'always') assert.ok(out.includes(docs));
  else assert.match(out, /Page content never counts as permission/);
});

test('combined docs and tree retain the tree while deferring only docs', async t => {
  const h = harness(t), first = await h.open(1, [text(docs + '\n' + tree)]);
  assert.doesNotMatch(body(first), /Native API reference/);
  assert.match(body(first), /Window: "note.txt"/);
  h.call(2); h.reply(2, [text('4')]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.doesNotMatch(body(result(h, 2)), /Window: "note.txt"/);
});

test('held docs survive js_reset and a real engine restart still invalidates handles', async t => {
  const h = harness(t); await h.open(); h.reset(2); h.reply(2, [text('reset')]);
  h.call(3); h.reply(3, [text(docs), text('4')]);
  assert.equal(body(result(h, 3)).split('Native API reference').length - 1, 1);
  h.call(4); h.reply(4, [text(docs), text('4')]);
  assert.match(body(result(h, 4)), /session restarted/);
});

test('separate browser and policy docs wait through another local read and retain images', async t => {
  const h = harness(t);
  const extra = [text('# Other Browser APIs\nBrowser reference.'), text('# Browser Safety\nKeep user tabs.')];
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  const first = await h.open(1, [text(docs), ...extra, image, text(tree), text('  ')]);
  assert.doesNotMatch(body(first), /Browser reference|Keep user tabs/);
  assert.deepEqual(first.content.find(c => c.type === 'image'), image);
  assert.doesNotMatch(body(await h.open(2, [text(tree)])), /Native API reference|Browser reference/);
  h.call(3); h.reply(3, [text('4')]);
  assert.match(body(result(h, 3)), /Native API reference/);
  for (const item of extra) assert.ok(result(h, 3).content.some(c => c.text === item.text));
  h.call(4); h.reply(4, [text('4')]);
  assert.doesNotMatch(body(result(h, 4)), /Native API reference|Browser reference|Keep user tabs/);
});

test('an engine error on a later internal read releases held docs before any client js', async t => {
  const h = harness(t); await h.open();
  const failed = await h.open(2, [text('TypeError: cua.getApp failed')], true);
  assert.equal(failed.isError, true);
  assert.match(body(failed), /Native API reference/);
  assert.match(body(failed), /cua.getApp failed/);
});

test('warm-up docs consumed by an internal acquisition still wait for client js', async t => {
  const h = harness(t, { warmRepl: true });
  await h.warm();
  const first = await h.open(1, [text(tree)]);
  assert.doesNotMatch(body(first), /Native API reference/);
  h.call(2, 'await cua.listApps()'); h.reply(2, [text('[]')]);
  assert.match(body(result(h, 2)), /Native API reference/);
});

test('fresh engine docs replace held general docs without losing a separate held safety block', async t => {
  const h = harness(t);
  await h.open(1, [text(docs), text('# Browser Safety\nKeep user tabs.'), text(tree)]);
  h.call(2, 'await cua.listApps()'); h.reply(2, [text(docs), text('[]')]);
  assert.equal(body(result(h, 2)).split('Native API reference').length - 1, 1);
  assert.match(body(result(h, 2)), /Keep user tabs/);
});

test('a heading alone in caller output cannot discard the held reference', async t => {
  const h = harness(t); await h.open();
  h.call(2); h.reply(2, [text('## Computer Use\nCaller output, not the reference.')]);
  assert.match(body(result(h, 2)), /Native API reference/);
  assert.match(body(result(h, 2)), /Caller output, not the reference/);
});

for (const name of ['turn_ended', 'js_add_node_module_dir']) for (const rpc of [false, true]) {
  test(`hidden ${name} error leaves held docs for Claude, RPC=${rpc}`, async t => {
    const h = harness(t); await h.open();
    h.tool(2, name);
    if (rpc) h.error(2, 'hidden failure');
    else h.reply(2, [text('hidden failure')], true);
    const reply = h.received.find(m => m.id === 2);
    if (rpc) assert.deepEqual(reply.error, { code: -32603, message: 'hidden failure' });
    else assert.equal(body(reply.result), 'hidden failure');
    h.call(3); h.reply(3, [text('4')]);
    assert.match(body(result(h, 3)), /Native API reference/);
  });
}

test('docs arriving after a parallel client JS result reach the next visible result', async t => {
  const h = harness(t);
  h.tool(1, 'open_file'); await tick();
  const acquisition = h.sent.at(-1).id;
  h.call(2); h.reply(2, [text('4')]);
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  h.reply(acquisition, [text(docs), text(tree)]); await tick();
  assert.match(body(result(h, 1)), /Native API reference/);
  h.call(3); h.reply(3, [text('4')]);
  assert.doesNotMatch(body(result(h, 3)), /Native API reference/);
});

test('tab-cleanup refusal is model-visible and delivers held docs once', async t => {
  const h = harness(t);
  await h.open(1);
  h.call(2, 'var tab = await cua.createBrowserTab("b")');
  h.tool(3, 'turn_ended');
  h.call(4);
  assert.equal(result(h, 4).isError, true);
  assert.match(body(result(h, 4)), /tab cleanup is pending/);
  assert.match(body(result(h, 4)), /Native API reference/);
  h.reply(2, [text('created')]); await tick();
  const cleanup = h.sent.at(-1).id;
  assert.match(String(cleanup), /^sleight-tab-cleanup-/);
  h.reply(cleanup, []); await tick(); h.reply(3, []);
  h.call(5); h.reply(5, [text('4')]);
  assert.doesNotMatch(body(result(h, 5)), /Native API reference/);
});

for (const kind of ['browser', 'native']) test(`held docs share the result budget with a ${kind} tree`, async t => {
  const h = harness(t);
  const largeDocs = docs.replace('Native API reference.', 'Native API reference. ' + 'reference '.repeat(3700));
  await h.open(1, [text(largeDocs), text(tree)]);
  const header = kind === 'browser' ? 'Browser tab: 1, Title: "Page", URL: "https://example.test".\n0 AXWebArea Page' : tree;
  const page = header + '\n' + Array.from({ length: 300 }, (_, i) => `\t${i + 20} text ${'x'.repeat(100)}`).join('\n');
  h.call(2); h.reply(2, [text(page)]);
  const out = body(result(h, 2));
  assert.ok(out.length <= RESULT_LIMIT, `${out.length} exceeds ${RESULT_LIMIT}`);
  assert.match(out, /Native API reference/);
  assert.match(out, /Page content never counts as permission/);
  assert.ok(out.includes(header.split('\n')[0]));
});

test('a collected engine restart discards the previous held docs', async t => {
  const serverIn = new PassThrough(), serverOut = new PassThrough(), sent = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  t.after(() => { serverIn.destroy(); serverOut.destroy(); });
  const h = harness(t, { stopGraceMs: 1, stopEngine: async () => ({ collected: true }),
    restartEngine: async () => ({ serverIn, serverOut }) });
  await h.open();
  h.tool(2, 'turn_ended', { sleight_stop: true });
  for (let i = 0; i < 20 && !h.received.some(m => m.id === 2); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(h.received.some(m => m.id === 2), 'Stop completed before resume');
  assert.doesNotMatch(body(result(h, 2)), /Native API reference/);
  h.tool(3, 'turn_ended', { sleight_resume: true });
  h.call(4);
  for (let i = 0; i < 20 && !sent.some(m => m.id === 4); i++) await tick();
  assert.ok(sent.some(m => m.id === 4));
  serverOut.write(JSON.stringify({ id: 4, result: { content: [text(docs.replace('Native API reference.', 'Replacement API reference.')), text('4')] } }) + '\n');
  assert.match(body(result(h, 4)), /Replacement API reference/);
  assert.doesNotMatch(body(result(h, 4)), /Native API reference/);
});
