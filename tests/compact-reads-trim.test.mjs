import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const window = { title: 'Save', app: 'Fixture Editor', url: null };
function browser(role = 'outline') {
  const rows = Array.from({ length: 198 }, (_, i) => {
    const name = i === 50 ? 'Target Folder' : i === 80 ? 'report.txt' : `file-${i}.txt`;
    return `\t\t${i * 3 + 3} row (${i === 100 ? 'selected, ' : ''}selectable)\n` +
      `\t\t\t${i * 3 + 4} text Value: ${name}\n` +
      `\t\t\t${i * 3 + 5} text Description: ${i === 50 ? 'Folder' : 'Document'}, Help: ${'metadata '.repeat(30)}`;
  });
  return ['Window: "Save", App: Fixture Editor.', '0 sheet ID: save-panel',
    '\t1 text field (settable) Value: report.txt, ID: saveAsNameTextField', `\t2 ${role}`,
    ...rows, '\t900 button Save'].join('\n');
}
const process = (c, value, options) => c.process([{ type: 'text', text: value }], options)[0].text;

test('result trimming keeps folders, selection and the name field match in 198 file rows', () => {
  for (const role of ['outline', 'list']) {
    const c = createReadCompactor({ resultTrim: true });
    const full = browser(role);
    assert.ok(full.length > 55000);
    const out = process(c, full);
    assert.ok(out.length < 25000, `trimmed ${out.length} characters`);
    for (const kept of ['Target Folder', 'report.txt', 'file-100.txt', '900 button Save']) assert.ok(out.includes(kept), kept);
    assert.doesNotMatch(out, /file-101\.txt/);
    const omitted = [...out.matchAll(/sleight: (\d+) sibling rows omitted/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    assert.equal(omitted, 195);
    assert.doesNotMatch(out, /disableDiffing|getAXState/);
    assert.match(out, /150 lines/);
    assert.equal(out.match(/full read/gi)?.length, 1);
    assert.deepEqual(c.staleIndex(window, 'app.click(306)'), { number: 306 });
    assert.equal(c.staleIndex(window, 'app.click(303)'), undefined, 'selected row remains current');
    assert.equal(c.seenLines(window, [306]), undefined, 'hidden rows are not receipts');
    assert.equal(process(c, GUARD_MARK + full + GUARD_END, { forceFull: true }), full);
    assert.equal(c.staleIndex(window, 'app.click(306)'), undefined, 'explicit full read restores numbers');
  }
});
test('result trimming off is byte-identical and short or non-list trees stay whole', () => {
  const full = browser();
  assert.equal(process(createReadCompactor({ resultTrim: false }), full), full);
  for (const value of [browser('group'), full.slice(0, 1000)]) {
    assert.equal(process(createReadCompactor({ resultTrim: true }), value), value);
  }
});
test('window-title matches and folder descendants keep their whole row', () => {
  const full = browser().replace('Window: "Save"', 'Window: "file-120.txt"');
  const out = process(createReadCompactor({ resultTrim: true }), full);
  assert.match(out, /file-120\.txt/);
  assert.match(out, /153 row[\s\S]*154 text Value: Target Folder[\s\S]*155 text Description: Folder/);
  assert.ok(out.length < 25000);
});
test('the existing A/B environment flag enables trimming in the default compactor', () => {
  const prior = globalThis.process.env.SLEIGHT_RESULT_TRIM;
  try {
    globalThis.process.env.SLEIGHT_RESULT_TRIM = '1';
    assert.ok(process(createReadCompactor(), browser()).length < 25000);
    globalThis.process.env.SLEIGHT_RESULT_TRIM = '0';
    assert.equal(process(createReadCompactor(), browser()), browser());
  } finally {
    if (prior === undefined) delete globalThis.process.env.SLEIGHT_RESULT_TRIM;
    else globalThis.process.env.SLEIGHT_RESULT_TRIM = prior;
  }
});
test('marked first reads trim too and preserve output outside the tree', () => {
  const out = process(createReadCompactor({ resultTrim: true }), 'before\n' + GUARD_MARK + browser() + GUARD_END + '\nafter');
  assert.ok(out.length < 25000);
  assert.match(out, /^before\nWindow:/);
  assert.match(out, /after$/);
});
