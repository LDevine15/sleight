import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const window = { title: 'Report', app: 'Fixture Reader', url: 'file:///tmp/report.pdf' };
const long = 'The full document readback. '.repeat(100);
const tree = (title = 'Report') => [`Window: "${title}", App: Fixture Reader.`,
  `0 standard window ${title}, URL: file:///tmp/report.pdf, Secondary Actions: Raise`,
  '\t1 group Layout', '\t\t2 button Open', '\t\t3 text field (settable) Value: query',
  '\t\t4 row Decorative', '\t\t5 row (selectable) Result', '\t\t6 row Secondary Actions: Open',
  '\t\t7 text Value: Ready', '\t\t8 static text Value: ' + long, '\t\t9 image Decoration',
  '10 menu bar', '\t11 File', '\t12 Edit', '\t13 menu item Export',
  '\t14 check box (checkable) Option', '\t15 link Details'].join('\n');
const text = value => ({ type: 'text', text: value });
const output = content => content.map(item => item.text ?? '').join('\n');
const compact = (c, value = tree(), options = {}) => output(c.process([text(value)], { acquisition: true, ...options }));

test('first acquisitions keep the header, actions, menu names and short static text', () => {
  const c = createReadCompactor({ compactAcquisition: true });
  const out = compact(c);
  assert.ok(out.startsWith(tree().split('\n').slice(0, 2).join('\n')));
  for (const number of [2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15]) {
    assert.match(out, new RegExp('(?:^|\\n)\\t*' + number + ' '));
    assert.equal(c.staleIndex(window, `app.click(${number})`), undefined);
  }
  assert.doesNotMatch(out, /Layout|Decorative|Decoration|full document readback/);
  assert.match(out, /getAXState\(\{ disableDiffing: true \}\).*full tree/i);
  assert.ok(out.length < tree().length / 2);
});

test('hidden static rows never become known or remappable, including duplicate trees', () => {
  for (const content of [[text(tree())], [text(tree()), text(GUARD_MARK + tree() + GUARD_END)],
    [text('Engine docs\n' + tree() + '\n' + GUARD_MARK + tree() + GUARD_END)]]) {
    const c = createReadCompactor({ compactAcquisition: true });
    const out = output(c.process(content, { acquisition: true }));
    assert.doesNotMatch(out, /full document readback/);
    for (const number of [1, 4, 8, 9]) {
      assert.deepEqual(c.staleIndex(window, `app.click(${number})`), { number });
      assert.equal(c.seenLines(window, [number]), undefined);
      assert.deepEqual(c.uniqueSeen(window, [number]), []);
      assert.equal(c.remapStale(window, `app.click(${number})`), undefined);
    }
    const next = compact(c, GUARD_MARK + tree() + GUARD_END, { acquisition: false });
    assert.doesNotMatch(next, /full document readback/);
    assert.deepEqual(c.staleIndex(window, 'app.click(8)'), { number: 8 });
    assert.equal(c.seenLines(window, [8]), undefined, 'an unchanged guard never invents a hidden receipt');
  }
});

test('one explicit full read restores a long document value and its number', () => {
  const c = createReadCompactor({ compactAcquisition: true });
  compact(c);
  assert.deepEqual(c.staleIndex(window, 'app.click(8)'), { number: 8 });
  assert.equal(compact(c, GUARD_MARK + tree() + GUARD_END, { acquisition: false, forceFull: true }), tree());
  assert.equal(c.staleIndex(window, 'app.click(8)'), undefined);
  assert.match(c.seenLines(window, [8])[8], /full document readback/);
});

test('a changed header stays current and a user-change notice retains the full tree', () => {
  const c = createReadCompactor({ compactAcquisition: true });
  compact(c);
  const changed = tree('Other');
  const out = compact(c, changed);
  assert.match(out, /^Window: "Other".*\n0 standard window Other/);
  assert.doesNotMatch(out, /full document readback/);
  assert.equal(compact(c, changed + '\nsleight: the user changed the app.'), changed + '\nsleight: the user changed the app.');
});

test('errors, change notices and explicit full acquisitions keep full trees', () => {
  for (const options of [{ failed: true }, { forceFull: true }, { action: { overlap: true } }]) {
    const c = createReadCompactor({ compactAcquisition: true });
    assert.equal(compact(c, tree(), options).split('\nsleight: UI')[0], tree());
    assert.equal(c.staleIndex(window, 'app.click(8)'), undefined);
  }
  for (const notice of ['sleight: the user switched windows.', 'Input lease stopped: window changed.',
    'Document scope stopped: Window or URL changed.', 'sleight: this call acted on another window.']) {
    const c = createReadCompactor({ compactAcquisition: true });
    assert.equal(compact(c, tree() + '\n' + notice), tree() + '\n' + notice);
  }
});

test('plain reads, later acquisitions, ambiguous and incomplete reads stay whole', () => {
  const c = createReadCompactor({ compactAcquisition: true });
  assert.equal(compact(c, tree(), { acquisition: false }), tree());
  assert.equal(compact(c), tree(), 'an already seen window is not a first acquisition');
  for (const value of [tree() + '\n' + tree('Other'), 'Window: "Report", App: Fixture Reader.',
    tree() + '\n…(2000)', tree().replace('0 standard window', '0 button')]) {
    assert.equal(compact(createReadCompactor({ compactAcquisition: true }), value), value);
  }
});

test('the static value limit is under 80 characters and preserves all of a kept line', () => {
  const value = tree().split('\n').slice(0, 2).concat([
    '\t1 text Value: ' + 'a'.repeat(79) + ', ID: short', '\t2 text Value: ' + 'b'.repeat(80),
    '\t3 text field (settable) Value: ' + long,
  ]).join('\n');
  const out = compact(createReadCompactor({ compactAcquisition: true }), value);
  assert.match(out, /a{79}, ID: short/);
  assert.doesNotMatch(out, /b{80}/);
  assert.ok(out.includes(long), 'an actionable field keeps its value');
});

test('unexpected multiline content stays whole rather than losing separate output', () => {
  const full = tree().replace('The full document readback. ', 'First page\nSecond page\n');
  assert.equal(compact(createReadCompactor({ compactAcquisition: true }), full), full);
});

test('an all-action tree needs no notice and other content blocks are preserved', () => {
  const full = tree().split('\n').slice(0, 2).concat(['\t1 button Open', '\t2 text Value: Ready']).join('\n');
  const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
  const c = createReadCompactor({ compactAcquisition: true });
  assert.deepEqual(c.process([text('Engine docs'), image, text(full)], { acquisition: true }), [text('Engine docs'), image, text(full)]);
});

test('small trees stay whole when the full-read notice would cost more than it saves', () => {
  const full = tree().split('\n').slice(0, 2).concat(['\t1 group', '\t\t2 button Open']).join('\n');
  const c = createReadCompactor({ compactAcquisition: true });
  assert.equal(compact(c, full), full);
  assert.equal(c.staleIndex(window, 'app.click(1)'), undefined, 'the whole tree was actually delivered');
});

test('the experiment stays off by default and is enabled only by the exact flag', () => {
  const prior = process.env.SLEIGHT_COMPACT_ACQUISITION;
  try {
    for (const value of [undefined, '0', 'true', '1']) {
      if (value === undefined) delete process.env.SLEIGHT_COMPACT_ACQUISITION;
      else process.env.SLEIGHT_COMPACT_ACQUISITION = value;
      const out = compact(createReadCompactor());
      if (value === '1') assert.doesNotMatch(out, /full document readback/);
      else assert.equal(out, tree());
    }
  } finally {
    if (prior === undefined) delete process.env.SLEIGHT_COMPACT_ACQUISITION;
    else process.env.SLEIGHT_COMPACT_ACQUISITION = prior;
  }
});

function harness(t, options = {}) {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-acquisition-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  const record = into => data => into.push(...data.toString().trim().split('\n').map(JSON.parse));
  serverIn.on('data', record(sent)); clientOut.on('data', record(replies));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    compactAcquisition: true, inputLease: new InputLease({ directory, holder: 'fixture' }), ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
  return { sent, replies,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: (id, value, isError = false) => serverOut.write(JSON.stringify({ id, result: { isError,
      content: [text(value)], _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n'),
  };
}
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('relay refuses a hidden number before it reaches the engine and one full read unlocks it', async t => {
  const h = harness(t);
  h.call(1, 'var app = await cua.getApp("example.fixture")'); await tick();
  h.reply(1, 'Engine docs\n' + tree()); await tick();
  assert.match(output(h.replies.find(m => m.id === 1).result.content), /^Engine docs\nWindow:/);
  assert.doesNotMatch(output(h.replies.find(m => m.id === 1).result.content), /full document readback/);
  h.call(2, 'await app.click(8)'); await tick();
  assert.equal(h.replies.find(m => m.id === 2)?.result.isError, true);
  assert.match(output(h.replies.find(m => m.id === 2).result.content), /element 8 may be stale/);
  assert.ok(!h.sent.some(m => m.id === 2));
  h.call(3, 'nodeRepl.write(await app.getAXState({ disableDiffing: true }))'); await tick();
  h.reply(3, GUARD_MARK + tree() + GUARD_END); await tick();
  assert.ok(output(h.replies.find(m => m.id === 3).result.content).includes(long));
  h.call(4, 'await app.click(8)'); await tick();
  assert.ok(h.sent.some(m => m.id === 4), 'a number received in the full read reaches the engine');
  h.reply(4, GUARD_MARK + tree() + GUARD_END); await tick();
});

test('relay keeps failed acquisitions whole and handles a new window header', async t => {
  const h = harness(t);
  h.call(1, 'var app = await cua.getApp({ windowId: 42 })'); await tick();
  h.reply(1, tree(), true); await tick();
  assert.ok(output(h.replies.find(m => m.id === 1).result.content).includes(long));
  h.call(2, 'var app = await cua.getApp({ windowId: 43 })'); await tick();
  h.reply(2, tree('Other')); await tick();
  const out = output(h.replies.find(m => m.id === 2).result.content);
  assert.match(out, /^Window: "Other".*\n0 standard window Other/);
  assert.doesNotMatch(out, /full document readback/);
});

test('an unchanged action that shows the whole tree makes its rows known again', () => {
  const c = createReadCompactor({ compactAcquisition: true });
  compact(c);
  assert.ok(c.staleIndex(window, 'app.click(8)'));
  const action = c.beginAction('await app.click(2)');
  const out = output(c.process([text(GUARD_MARK + tree() + GUARD_END)], { action }));
  assert.match(out, /full document readback/);
  assert.equal(c.staleIndex(window, 'app.click(8)'), undefined);
});

test('the flag forces full trees only for acquisitions, not every failed call', () => {
  const c = createReadCompactor({ compactAcquisition: true }), plain = createReadCompactor();
  for (const r of [c, plain]) r.process([text(tree())]);
  const action = () => ({ ...c.beginAction('await app.click(2)') });
  const changed = tree().replace('Ready', 'Done');
  const a = output(c.process([text(GUARD_MARK + changed + GUARD_END)], { action: action(), failed: true }));
  const b = output(plain.process([text(GUARD_MARK + changed + GUARD_END)], { action: plain.beginAction('await app.click(2)'), failed: true }));
  assert.equal(a, b);
});
