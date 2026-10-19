import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const tree = rows => ['Window: "Draft", App: Fixture Editor.',
  '0 standard window Draft, URL: file:///tmp/draft', ...rows].join('\n');
const pane = ['\t1 split group Document Pane', '\t\t2 scroll area', '\t3 text Value: Draft',
  '\t4 text field (settable) Value: 100%', '\t5 toggle button Bold, Value: off'];
const note = 'sleight: the document area exposes no text values. Read the window with `nodeRepl.emitImage(await app.getScreenshot())`.';
const text = value => ({ type: 'text', text: value });
const read = (c, value, options) => c.process([text(value)], options);
const output = content => content.map(item => item.text ?? '').join('\n');

test('the screenshot variant hints at textless document panes, layout areas and tables despite toolbar values', () => {
  for (const area of ['split group Document Pane', 'layout area Content Area, Description: Document contents', 'table']) {
    const value = tree(pane.map(line => line.replace('split group Document Pane', area)));
    const result = read(createReadCompactor({ screenshotReads: true }), value);
    assert.deepEqual(result, [text(value), text(note)], area);
  }
});

test('an empty text area hints only when open_file found its file non-empty on disk', () => {
  const value = tree(pane.map(line => line.replace('split group Document Pane', 'text entry area (settable) Value: ')));
  for (const [size, hinted] of [[undefined, false], [0, false], [5, true]]) {
    const c = createReadCompactor({ screenshotReads: true });
    if (size !== undefined) c.noteOpenedFile('/tmp/draft', '/private/tmp/draft', size);
    assert.deepEqual(read(c, value), hinted ? [text(value), text(note)] : [text(value)], String(size));
  }
  // A blank new document: an empty text area with no file behind it.
  const blank = ['Window: "Untitled", App: Fixture Editor.', '0 standard window Untitled', '\t1 scroll area',
    '\t\t2 text area (settable) Value: ', '\t3 toggle button Bold, Value: off'].join('\n');
  assert.deepEqual(read(createReadCompactor({ screenshotReads: true }), blank), [text(blank)]);
});

// The first-call rules ride before the tree and quote "a result says the user changed the app". An unanchored stop
// match read that as a stop, which suppressed this note and the open screenshot in every A/B 2 run (2026-10-17).
test('first-call rules quoting a user-changed stop do not suppress the textless note', () => {
  const value = tree(pane);
  const rules = text('- If acquisition returns an empty tree, or a result says the user changed the app or a header changed, read again.');
  const c = createReadCompactor({ screenshotReads: true });
  assert.ok(output(c.process([rules, text(value)])).includes(note));
  assert.equal(c.lastReadNoted(), true);
  const stop = createReadCompactor({ screenshotReads: true });
  assert.ok(!output(stop.process([text(value), text('sleight: the user changed the app.')])).includes(note), 'a real stop still suppresses it');
});

test('the explicit A/B baseline leaves the read unchanged', () => {
  const value = tree(pane);
  assert.deepEqual(read(createReadCompactor({ screenshotReads: false }), value), [text(value)]);
});

test('text inside the document area makes the screenshot hint unnecessary', () => {
  for (const row of ['\t\t2 text entry area Value: alpha', '\t\t2 cell A1, Value: 42',
    '\t\t2 static text alpha', '\t\t2 text alpha', '\t\t2 text entry area Value: <redacted>']) {
    const value = tree([pane[0], row, ...pane.slice(2)]);
    assert.deepEqual(read(createReadCompactor({ screenshotReads: true }), value), [text(value)], row);
  }
});

test('the hint is shown once per document even when subsequent guards are no-change diffs', () => {
  const c = createReadCompactor({ screenshotReads: true }), value = tree([
    ...pane, ...Array.from({ length: 30 }, (_, i) => `\t${i + 6} button Toolbar ${i}`),
  ]);
  read(c, value);
  const result = read(c, GUARD_MARK + value + GUARD_END);
  assert.match(result[0].text, /no change since/);
  assert.equal(result.filter(item => item.text === note).length, 0);
});

test('action results never hint and do not consume the next read-only hint', () => {
  const c = createReadCompactor({ screenshotReads: true }), value = tree(pane);
  assert.doesNotMatch(output(read(c, value, { action: { code: 'await app.click(5)' } })), /Read the window with/);
  assert.equal(read(c, GUARD_MARK + value + GUARD_END).filter(item => item.text === note).length, 1);
  assert.equal(read(c, value).filter(item => item.text === note).length, 0);
});

test('a screenshot suppresses future hints for that document but not another one', () => {
  const c = createReadCompactor({ screenshotReads: true }), value = tree(pane);
  const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
  c.process([text(value), image]);
  assert.doesNotMatch(output(read(c, value)), /Read the window with/);
  const other = value.replaceAll('Draft', 'Other').replace('file:///tmp/draft', 'file:///tmp/other');
  assert.equal(read(c, other).filter(item => item.text === note).length, 1);
  assert.doesNotMatch(output(read(c, value)), /Read the window with/);
});

for (const header of [false, true]) test('a screenshot-only result is associated with its exact supplied window, header=' + header, () => {
  const c = createReadCompactor({ screenshotReads: true });
  c.process([...(header ? [text('Window: "Draft", App: Fixture Editor.')] : []),
    { type: 'image', mimeType: 'image/png', data: 'fixture' }], {
    screenshotWindow: { title: 'Draft', app: 'Fixture Editor', url: 'file:///tmp/draft' },
  });
  assert.doesNotMatch(output(read(c, tree(pane))), /Read the window with/);
});

test('duplicate observations emit at most one hint and document URLs distinguish windows', () => {
  const c = createReadCompactor({ screenshotReads: true }), value = tree(pane);
  assert.equal(c.process([text(value), text(value)]).filter(item => item.text === note).length, 1);
  assert.equal(read(c, value.replace('file:///tmp/draft', 'file:///tmp/second')).filter(item => item.text === note).length, 1);
  assert.equal(read(c, value).filter(item => item.text === note).length, 0);
});

test('session hint and screenshot history survive rebuilding the read compactor', () => {
  for (const screenshot of [false, true]) {
    const readHints = {}, options = { screenshotReads: true, readHints };
    const first = createReadCompactor(options), value = tree(pane);
    first.process([text(value), ...(screenshot ? [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] : [])]);
    assert.doesNotMatch(output(read(createReadCompactor(options), value)), /Read the window with/);
  }
});

test('an existing screenshot, error or user-change refusal needs no screenshot hint', () => {
  const value = tree(pane), c = () => createReadCompactor({ screenshotReads: true });
  const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
  assert.deepEqual(c().process([text(value), image]), [text(value), image]);
  assert.deepEqual(read(c(), value, { failed: true }), [text(value)]);
  for (const stop of ['sleight: the user changed the app.', 'Input lease stopped: window changed.',
    'Document scope stopped: Window or URL changed.']) {
    assert.deepEqual(read(c(), value + '\n' + stop), [text(value + '\n' + stop)]);
  }
});

test('partial, browser, dialog and ambiguous trees do not diagnose a textless document', () => {
  const value = tree(pane);
  for (const incomplete of [value + '\n…(500)', value.replace('0 standard window Draft', '0 AXWebArea Draft'),
    value.replace('0 standard window Draft', '0 sheet Save'), value + '\n' + value.replaceAll('Draft', 'Other'),
    'Window: "Draft", App: Fixture Editor.', 'The following is a diff from the previous accessibility tree\n+ \t1 table',
    tree(['\t1 text field Value: ', '\t2 button Save']), tree(['\t1 scroll area Ribbon', '\t\t2 button Bold'])]) {
    assert.doesNotMatch(output(read(createReadCompactor({ screenshotReads: true }), incomplete)), /Read the window with/);
  }
});

test('a prior textless observation does not add hints to unrelated results or conceal current text', () => {
  const c = createReadCompactor({ screenshotReads: true });
  read(c, tree(pane));
  assert.deepEqual(read(c, '2'), [text('2')]);
  const value = tree([pane[0], '\t\t2 text entry area Value: alpha', ...pane.slice(2)]);
  assert.doesNotMatch(output(read(c, GUARD_MARK + value + GUARD_END)), /Read the window with/);
});

test('screenshot reads default on and only the A/B zero turns them off', () => {
  const original = process.env.SLEIGHT_SCREENSHOT_READS;
  try {
    for (const value of [undefined, '0', '1', 'false', '']) {
      if (value === undefined) delete process.env.SLEIGHT_SCREENSHOT_READS;
      else process.env.SLEIGHT_SCREENSHOT_READS = value;
      assert.equal(output(read(createReadCompactor(), tree(pane))).includes(note), value !== '0');
    }
  } finally {
    if (original === undefined) delete process.env.SLEIGHT_SCREENSHOT_READS;
    else process.env.SLEIGHT_SCREENSHOT_READS = original;
  }
});

for (const flag of [undefined, '0']) for (const mismatch of [false, true]) test(`the relay associates screenshot-only results and honors the A/B switch: flag=${flag}, mismatch=${mismatch}`, async t => {
  const directory = trackTemp(mkdtempSync('/tmp/sleight-fl1-'));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const previous = process.env.SLEIGHT_SCREENSHOT_READS;
  if (flag === undefined) delete process.env.SLEIGHT_SCREENSHOT_READS;
  else process.env.SLEIGHT_SCREENSHOT_READS = flag;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory, holder: 'fl1-fixture' }) });
  if (previous === undefined) delete process.env.SLEIGHT_SCREENSHOT_READS;
  else process.env.SLEIGHT_SCREENSHOT_READS = previous;
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); removeTemp(directory); });
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const call = async (id, code, content, appId = 'example.fixture') => {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    await tick();
    serverOut.write(JSON.stringify({ id, result: { content,
      _meta: { 'codex/toolSurface': { app: { appId } } } } }) + '\n');
    await tick();
    return replies.find(reply => reply.id === id)?.result;
  };
  // Acquire a readable document, so no textless hint has been spent yet.
  await call(1, 'var app = await cua.getApp("example.fixture")', [text(tree([pane[0], '\t\t2 text Value: alpha']))]);
  await call(2, 'nodeRepl.emitImage(await app.getScreenshot())', [{ type: 'image', mimeType: 'image/png', data: 'fixture' }], mismatch ? 'example.other' : 'example.fixture');
  const result = await call(3, 'await app.getAXState()', [text(GUARD_MARK + tree(pane) + GUARD_END)]);
  assert.equal(result?.isError, undefined);
  assert.equal(/Read the window with/.test(output(result.content)), flag !== '0' && mismatch);
});

test('windows with one title and no URL keep separate hint and screenshot state when the tree carries an ID', () => {
  const win = id => tree(pane).replace('0 standard window Draft, URL: file:///tmp/draft', `0 standard window Draft, ID: ${id}`);
  const c = createReadCompactor({ screenshotReads: true });
  for (const [id, hinted] of [['win-a', true], ['win-a', false], ['win-b', true], ['win-b', false]]) {
    assert.equal(read(c, win(id)).some(item => item.text === note), hinted, id + ' ' + hinted);
  }
  const d = createReadCompactor({ screenshotReads: true });
  d.process([text(win('win-a')), { type: 'image', data: 'x', mimeType: 'image/png' }]);
  assert.ok(!read(d, win('win-a')).some(item => item.text === note), 'its own screenshot suppresses the hint');
  assert.ok(read(d, win('win-b')).some(item => item.text === note), 'another window with the same title still gets it');
});
