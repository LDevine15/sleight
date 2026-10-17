import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
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
  for (const area of ['split group Document Pane', 'layout area Content Area, Description: Document contents',
    'table', 'text entry area (settable) Value: ']) {
    const value = tree(pane.map(line => line.replace('split group Document Pane', area)));
    const result = read(createReadCompactor({ screenshotReads: true }), value);
    assert.deepEqual(result, [text(value), text(note)], area);
  }
});

test('the default read and unselected variants remain unchanged', () => {
  const value = tree(pane);
  assert.deepEqual(read(createReadCompactor({ screenshotReads: false }), value), [text(value)]);
  assert.deepEqual(read(createReadCompactor(), value), [text(value)]);
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

test('the environment selects the screenshot compactor variant with an exact value', () => {
  const original = process.env.SLEIGHT_SKILL;
  try {
    for (const variant of ['screenshot', 'none', 'SCREENSHOT', 'default']) {
      process.env.SLEIGHT_SKILL = variant;
      assert.equal(output(read(createReadCompactor(), tree(pane))).includes(note), variant === 'screenshot');
    }
  } finally {
    if (original === undefined) delete process.env.SLEIGHT_SKILL;
    else process.env.SLEIGHT_SKILL = original;
  }
});

for (const mismatch of [false, true]) test('the relay associates a screenshot-only result with its acquired handle, mismatch=' + mismatch, async t => {
  const original = process.env.SLEIGHT_SKILL;
  process.env.SLEIGHT_SKILL = 'screenshot';
  t.after(() => { if (original === undefined) delete process.env.SLEIGHT_SKILL; else process.env.SLEIGHT_SKILL = original; });
  const directory = mkdtempSync('/tmp/sleight-fl1-');
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory, holder: 'fl1-fixture' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
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
  assert.equal(/Read the window with/.test(output(result.content)), mismatch);
});
