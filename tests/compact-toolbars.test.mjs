import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const window = { title: 'Draft', app: 'Fixture Editor', url: null };
const text = text => ({ type: 'text', text });
// Reduced shape of the 2026-10-16 ribbon read: tab group, nested containers,
// actionable controls, sibling tabs, and a separate small toolbar.
function tree({ count = 21, role = 'tab group Description: ribbon, Details: Home' } = {}) {
  return ['Window: "Draft", App: Fixture Editor.', '0 standard window Draft',
    `\t1 ${role}`, '\t\t2 container',
    ...Array.from({ length: count }, (_, i) => `\t\t\t${i + 3} button Command ${i}, ID: command-${i}`),
    '\t\t80 tab Home', '\t\t81 tab Review', '\t90 toolbar', '\t\t91 button Save',
    '\t100 text entry area (settable) Value: Draft', '110 menu bar', '\t111 File'].join('\n');
}
const output = content => content.map(item => item.text ?? '').join('\n');
const run = (c, value = tree(), options) => output(c.process([text(value)], options));
const enabled = () => createReadCompactor({ compactToolbars: true });

test('large ribbons become one line while document, menu and small toolbar stay visible', () => {
  const c = enabled(), out = run(c);
  assert.match(out, /1 tab group Description: ribbon.*23 controls.*omitted/);
  assert.doesNotMatch(out, /Command 0|80 tab Home/);
  for (const kept of ['0 standard window Draft', '91 button Save', '100 text entry area', '111 File']) assert.ok(out.includes(kept));
  assert.ok(out.length < tree().length / 2);
  assert.deepEqual(c.staleIndex(window, 'app.click(3)'), { number: 3 });
  assert.equal(c.seenLines(window, [3]), undefined);
  assert.deepEqual(c.uniqueSeen(window, [3]), []);
  assert.equal(c.remapStale(window, 'app.click(3)'), undefined);
  assert.equal(c.staleIndex(window, 'app.click(91)'), undefined);
});

test('only toolbar or explicitly named ribbon groups above twenty controls are elided', () => {
  for (const role of ['toolbar', 'group Ribbon', 'tab group Description: ribbon']) {
    assert.match(run(enabled(), tree({ role })), /controls omitted/);
    assert.doesNotMatch(run(enabled(), tree({ role, count: 18 })), /controls omitted/);
  }
  for (const role of ['group Document', 'tab group Sheets', 'group Description: ribbon notes']) {
    assert.equal(run(enabled(), tree({ role })), tree({ role }));
  }
});

test('the A/B flag is off by default and accepts only 1', () => {
  const prior = process.env.SLEIGHT_COMPACT_TOOLBARS;
  try {
    for (const value of [undefined, '0', 'true', '1']) {
      if (value === undefined) delete process.env.SLEIGHT_COMPACT_TOOLBARS;
      else process.env.SLEIGHT_COMPACT_TOOLBARS = value;
      const out = run(createReadCompactor());
      if (value === '1') assert.match(out, /controls omitted/);
      else assert.equal(out, tree());
    }
  } finally {
    if (prior === undefined) delete process.env.SLEIGHT_COMPACT_TOOLBARS;
    else process.env.SLEIGHT_COMPACT_TOOLBARS = prior;
  }
});

test('explicit full reads restore hidden controls and their receipts', () => {
  for (const options of [{ forceFull: true }, { explicitFull: true }]) {
    const c = enabled(); run(c);
    assert.equal(run(c, GUARD_MARK + tree() + GUARD_END, options), tree());
    assert.equal(c.staleIndex(window, 'app.click(3)'), undefined);
  }
});

test('a filtered read expands only the printed controls and leaves other hidden numbers refused', () => {
  const c = enabled(); run(c);
  const visible = '\t\t\t3 button Command 0, ID: command-0';
  const out = run(c, visible + '\n[sleight:filtered-read]' + JSON.stringify({ visible }) + '\n' + GUARD_MARK + tree() + GUARD_END);
  assert.ok(out.includes(visible));
  assert.equal(c.staleIndex(window, 'app.click(3)'), undefined);
  assert.deepEqual(c.staleIndex(window, 'app.click(4)'), { number: 4 });
});

test('a later unchanged guard never invents receipts for hidden controls', () => {
  const c = enabled(); run(c);
  run(c, GUARD_MARK + tree() + GUARD_END);
  assert.deepEqual(c.staleIndex(window, 'app.click(3)'), { number: 3 });
  assert.equal(c.remapStale(window, 'app.click(3)'), undefined);
});

test('keep a group acted in by number, ID, label or line, including a removed target', () => {
  for (const code of ['await app.click(3)', 'await app.click({ id: "command-0" })',
    'await app.click({ label: "Command 0" })', 'await app.click({ line: "button Command 0, ID: command-0" })']) {
    const c = enabled(); run(c, tree(), { explicitFull: true });
    const action = c.beginAction(code);
    const changed = tree().replace('\t\t\t3 button Command 0, ID: command-0\n', '');
    const out = run(c, changed, { action, code });
    assert.match(out, /Command 1/);
    assert.doesNotMatch(out, /controls omitted/);
  }
});

test('a call acting in the document can still elide the unrelated ribbon', () => {
  const c = enabled(); run(c, tree(), { explicitFull: true });
  const code = 'await app.click(100)', action = c.beginAction(code);
  assert.match(run(c, tree(), { action, code }), /controls omitted/);
});

test('unknown action targets, keyboard input and overlaps retain groups', () => {
  for (const code of ['await app.click(target)', 'await app.click({ id: "missing" })',
    'await app.pressKey("super+b")', 'await app.typeText("text")', 'await app.click([1, 2])']) {
    const c = enabled(); run(c, tree(), { explicitFull: true });
    assert.doesNotMatch(run(c, tree(), { action: c.beginAction(code), code }), /controls omitted/);
  }
  assert.doesNotMatch(run(enabled(), tree(), { action: { overlap: true } }), /controls omitted/);
});

test('failure and user-change notices retain all controls', () => {
  for (const options of [{ failed: true }, { forceFull: true }]) assert.equal(run(enabled(), tree(), options), tree());
  for (const notice of ['sleight: the user changed the app.', 'Input lease stopped: focus changed.',
    'Document scope stopped: window changed.']) assert.equal(run(enabled(), tree() + '\n' + notice), tree() + '\n' + notice);
});

test('exact duplicate tree blocks are dropped within and across text items, preserving other output', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
  for (const content of [[text('docs\n' + tree() + '\nfirst\n' + tree() + '\nsecond'), image],
    [text('docs\n' + tree()), image, text(tree() + '\nsecond')],
    [text(tree() + '\n' + GUARD_MARK + tree() + GUARD_END + '\nsecond')]]) {
    const out = enabled().process(content, { explicitFull: true });
    assert.equal(output(out).match(/^Window:/gm)?.length, 1);
    assert.equal(output(out).match(/3 button Command 0/g)?.length, 1);
    assert.match(output(out), /second\n?$/);
    if (content.includes(image)) assert.ok(out.includes(image));
  }
});

test('deduplication is scoped to one result and preserves differing windows, values and numbering', () => {
  const c = enabled();
  for (let i = 0; i < 2; i++) assert.equal(run(c, tree(), { explicitFull: true }), tree());
  for (const changed of [tree().replaceAll('Draft', 'Other'), tree().replace('Value: Draft', 'Value: Changed'),
    tree().replace('3 button Command 0', '200 button Command 0'), tree() + ' ']) {
    const out = run(enabled(), tree() + '\n' + changed, { explicitFull: true });
    assert.equal(out.match(/^Window:/gm)?.length, 2);
  }
});

test('incomplete trees, diffs and multiline continuations stay whole', () => {
  for (const value of [tree() + '\n…(2000)', tree().replace('0 standard window', '0 button'),
    tree().replace('\t\t\t4 button', 'continuation\n\t\t\t4 button'),
    tree().replace('\t\t\t4 button', '+ \t\t\t4 button')]) assert.equal(run(enabled(), value), value);
});

test('duplicate marked reads after an elision keep hidden numbers refused', () => {
  const c = enabled(); run(c);
  const marked = GUARD_MARK + tree() + GUARD_END;
  const out = run(c, marked + '\n' + marked);
  assert.equal(out.match(/^Window:/gm)?.length, 1);
  assert.equal(out.match(/sleight: no change since/g)?.length, 1);
  assert.deepEqual(c.staleIndex(window, 'app.click(3)'), { number: 3 });
  assert.equal(c.remapStale(window, 'app.click(3)'), undefined);
});

test('plain diffs are never mistaken for duplicate full trees with the same root', () => {
  const one = 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\nsleight: lines changed\n+ \t3 button New';
  const two = one.replace('New', 'Other');
  assert.equal(run(enabled(), one + '\n' + two), one + '\n' + two);
});

test('a duplicate marked action read retains its original UI-change observation', () => {
  const c = enabled(); run(c, tree(), { explicitFull: true });
  const code = 'await app.click(100)', action = c.beginAction(code);
  const changed = tree().replace('Value: Draft', 'Value: Changed');
  const marked = GUARD_MARK + changed + GUARD_END;
  const out = run(c, marked + '\n' + marked, { action, code });
  assert.match(out, /UI changed \(value\)/);
});

test('an acted-in ribbon keeps its contents when the click removes its target and retitles the group', () => {
  const c = enabled(); run(c, tree(), { explicitFull: true });
  const code = 'await app.click(3)', action = c.beginAction(code);
  const changed = tree().replace('Details: Home', 'Details: Review').replace('\t\t\t3 button Command 0, ID: command-0\n', '');
  assert.doesNotMatch(run(c, changed, { action, code }), /controls omitted/);
});

test('textless document windows keep the entire ribbon and its element receipts', () => {
  for (const document of ['100 table', '100 text entry area (settable) Value: ',
    '100 split group Document Pane\n\t\t101 scroll area']) {
    const value = tree().replace('100 text entry area (settable) Value: Draft', document);
    const c = enabled();
    assert.equal(c.process([text(value)])[0].text, value);
    assert.equal(c.staleIndex(window, 'app.click(3)'), undefined);
  }
});

test('fold notices count omitted lines and offer the full read only once per document key', () => {
  const c = enabled();
  for (const [value, hint] of [[tree(), true], [tree(), false], [tree().replaceAll('Draft', 'Other'), true], [tree(), false]]) {
    const out = run(c, value);
    assert.doesNotMatch(out, /disableDiffing|getAXState|filtered/);
    assert.match(out, /24 lines/);
    assert.equal(/full read/i.test(out), hint);
  }
});

test('sliced and filtered copies do not resend an already returned tree in either order', () => {
  const lines = tree().split('\n');
  for (const copy of [lines.slice(0, 10).join('\n'), lines.slice(4, 10).join('\n'),
    lines.filter(line => /Command [135],/.test(line)).join('\n')]) {
    for (const content of [[text(tree()), text(copy)], [text(copy), text(tree())],
      [text(copy + '\nseparate output\n' + GUARD_MARK + tree() + GUARD_END)]]) {
      const out = output(enabled().process(content, { explicitFull: true }));
      assert.equal(out.match(/4 button Command 1,/g)?.length, 1);
      assert.equal(out.match(/^Window:/gm)?.length, 1);
      if (content.length === 1) assert.match(out, /separate output/);
    }
  }
});

test('a slice before the guard does not replace the full tree with a diff against that slice', () => {
  const copy = tree().split('\n').slice(0, 10).join('\n');
  const out = run(enabled(), copy + '\n' + GUARD_MARK + tree() + GUARD_END);
  assert.equal(out.match(/^Window:/gm)?.length, 2, 'the slice names ribbon controls the fold could hide, so it stays');
  assert.equal(out.match(/4 button Command 1,/g)?.length, 2, 'the full tree beside it is not folded either');
  assert.doesNotMatch(out, /controls omitted/);
});

test('character slices ending in the middle of a numbered line dedupe only with slice provenance', () => {
  const copy = tree().slice(0, tree().indexOf('Command 5') + 6);
  for (const [code, copies] of [['nodeRepl.write(state.slice(0, 300))', 1], [undefined, 2]]) {
    const out = output(enabled().process([text(tree()), text(copy)], { explicitFull: true, code }));
    assert.equal(out.match(/^Window:/gm)?.length, copies);
  }
});

test('a filtered copy of folded controls survives, and differing filtered values survive', () => {
  const c = enabled(), copy = tree().split('\n').slice(4, 10).join('\n');
  const out = output(c.process([text(tree()), text(copy)]));
  assert.match(out, /23 controls.*omitted/);
  assert.equal(out.match(/4 button Command 1,/g)?.length, 1, 'Claude keeps the lines it filtered out of the folded tree');
  assert.deepEqual(c.staleIndex(window, 'app.click(4)'), { number: 4 }, 'the copy grants no receipt for a folded control');
  const outside = tree().split('\n').filter(line => /^\t?11[01] /.test(line)).join('\n');
  assert.equal(output(enabled().process([text(tree()), text(outside)])).match(/111 File/g)?.length, 1, 'lines outside the fold still dedupe');
  const changed = '\t100 text entry area (settable) Value: Changed';
  assert.match(output(enabled().process([text(tree()), text(changed)], { explicitFull: true })), /Value: Changed/);
});

test('a smaller action snapshot is not discarded as a filtered copy of its earlier tree', () => {
  const c = enabled(); run(c, tree(), { explicitFull: true });
  const code = 'await app.click(100)', action = c.beginAction(code);
  const changed = tree().replace('\t111 File', '');
  const out = run(c, tree() + '\n' + GUARD_MARK + changed + GUARD_END, { action, code, explicitFull: true });
  assert.equal(out.match(/^Window:/gm)?.length, 2);
});

// Two windows with one title and no URL differ only by the root element's ID.
const withId = (id, value = tree()) => value.replace('0 standard window Draft', `0 standard window Draft, ID: ${id}`);

test('windows with one title and no URL keep separate hint state when the tree carries an ID', () => {
  const c = enabled();
  for (const [id, hint] of [['win-a', true], ['win-a', false], ['win-b', true], ['win-b', false], ['win-a', false]]) {
    assert.equal(/full read/i.test(run(c, withId(id))), hint, id + ' ' + hint);
  }
});

test('an acquisition of several windows registers each one, so a later read of any repeats nothing', () => {
  const long = tree().replace('\t100 text', '\t99 static text Value: ' + 'x'.repeat(200) + '\n\t100 text');
  const both = withId('win-a', long) + '\n' + withId('win-b', long);
  const c = createReadCompactor({ compactToolbars: true, compactAcquisition: true });
  const first = output(c.process([text(both)], { acquisition: true }));
  assert.equal(first.match(/static or structural lines omitted/g)?.length, 2);
  for (const id of ['win-b', 'win-a']) assert.doesNotMatch(run(c, withId(id)), /full read/i, id);
});
