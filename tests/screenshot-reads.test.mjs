import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('the hint follows full guard observations even when the visible result is a no-change diff', () => {
  const c = createReadCompactor({ screenshotReads: true }), value = tree([
    ...pane, ...Array.from({ length: 30 }, (_, i) => `\t${i + 6} button Toolbar ${i}`),
  ]);
  read(c, value);
  const result = read(c, GUARD_MARK + value + GUARD_END);
  assert.match(result[0].text, /no change since/);
  assert.equal(result.at(-1).text, note);
  assert.equal(result.filter(item => item.text === note).length, 1);
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
