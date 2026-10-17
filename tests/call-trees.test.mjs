// AB2: a call's repeated reads of one window show only the last, and separate scroll calls on one
// list get a note suggesting one bounded loop. Travel shape: Firefox airport search, 2026-10-17.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { GUARD_MARK, GUARD_END, GUARD_OMIT_MARK, SCROLL_LOOP_NOTE, createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';

const LOOP = 'let found = "none"; for (let i = 0; i < 40 && found === "none"; i++) { const s = await ff.getAXState({ disableDiffing: true }); ' +
  'const hit = s.split("\\n").filter(l => /Norcrest/.test(l)); if (hit.length) { found = hit.join("\\n"); break; } await ff.scroll(49, "down", 3); } nodeRepl.write(found);';

// The travel page: browser chrome, a 16-row airport list starting at `first`, and the menu bar.
function travel(first, title = 'Book a trip · Skyway') {
  const rows = Array.from({ length: 16 }, (_, i) => {
    const n = first + i, name = `Airport ${String(n).padStart(4, '0')} International`, code = `A${String(n).padStart(3, '0')}`;
    return `\t\t\t\t\t\t\t${50 + i} text (selectable) ${name} ${code}\n${name}\n${code}`;
  });
  return [`Window: "${title}", App: Firefox.`, `0 standard window ${title}, Secondary Actions: Raise`,
    '\t1 container Book a trip · Skyway', '\t\t2 toolbar Browser tabs', '\t\t\t3 tab group',
    ...Array.from({ length: 22 }, (_, i) => `\t\t\t\t${4 + i} button Toolbar control ${i}`),
    '\t\t26 HTML Content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel',
    ...Array.from({ length: 22 }, (_, i) => `\t\t\t\t${27 + i} text Form text ${i}`),
    '\t\t\t\t\t49 list Departing from', ...rows,
    '\t\t\t\t\t\t66 text 1,000 airports, sorted by name. No airport selected.', '\t\t\t\t\t\t67 button Back', '\t\t\t\t\t\t68 button Next',
    '\t69 close button', '72 menu bar', '\t73 Firefox', '', `The focused UI element is 47 pop up button Sapporo`].join('\n');
}
const marked = trees => trees.map(tree => GUARD_MARK + tree + GUARD_END).join('');
const text = value => ({ type: 'text', text: value });
const roots = output => [...output.matchAll(/^0 standard window /gm)].length;
const join_ = result => result.map(item => item.text).join('\n');

function loopCall(c, trees, extra = []) {
  return join_(c.process([text(marked(trees) + 'none'), ...extra],
    { code: LOOP, explicitFull: true, action: c.beginAction(LOOP) }));
}

test('a 41-read scroll loop shows only its last tree, with Claude\'s output and a count', () => {
  const trees = Array.from({ length: 41 }, (_, i) => travel(i * 9));
  const c = createReadCompactor({ callTrees: true });
  c.process([text(travel(0))]);
  const output = loopCall(c, trees);
  assert.equal(roots(output), 1, 'one full tree');
  assert.ok(output.includes(trees.at(-1)), 'the final tree is whole');
  assert.match(output, /^none$/m, "Claude's own output stays");
  assert.match(output, /sleight: 40 earlier reads of the same window in this call left out; the last is shown\./);
  assert.doesNotMatch(output, /Airport 0009 /, 'earlier rows are gone');
  const baseline = createReadCompactor({ callTrees: false });
  baseline.process([text(travel(0))]);
  const all = loopCall(baseline, trees);
  assert.equal(roots(all), 41, 'SLEIGHT_CALL_TREES=all keeps every tree');
  assert.ok(output.length < all.length / 20, `${output.length} against ${all.length}`);
});

test('SLEIGHT_CALL_TREES=all is the baseline', () => {
  const saved = process.env.SLEIGHT_CALL_TREES;
  try {
    delete process.env.SLEIGHT_CALL_TREES;
    assert.equal(roots(loopCall(createReadCompactor(), [travel(0), travel(9), travel(18)])), 1, 'on by default');
    process.env.SLEIGHT_CALL_TREES = 'all';
    assert.equal(roots(loopCall(createReadCompactor(), [travel(0), travel(9), travel(18)])), 3);
  } finally {
    if (saved === undefined) delete process.env.SLEIGHT_CALL_TREES; else process.env.SLEIGHT_CALL_TREES = saved;
  }
});

test('two reads of a window stay; a third leaves the first two out', () => {
  const c = createReadCompactor({ callTrees: true });
  assert.equal(roots(loopCall(c, [travel(0), travel(9)])), 2);
  const three = loopCall(createReadCompactor({ callTrees: true }), [travel(0), travel(9), travel(18)]);
  assert.equal(roots(three), 1);
  assert.match(three, /Airport 0018 /);
});

test("another window's tree, errors and notices stay", () => {
  const c = createReadCompactor({ callTrees: true });
  const other = travel(500, 'Other page');
  const trees = [travel(0), travel(9), other, travel(18), travel(27)];
  const output = loopCall(c, trees, [text('Computer Use server error -10005: elementHasNoFrame'),
    text('sleight: a menu is open (element 70).')]);
  assert.ok(output.includes(other), 'the only read of another window is whole');
  assert.ok(output.includes(travel(27)), 'the last read of the searched window is whole');
  assert.equal(roots(output), 2);
  assert.match(output, /elementHasNoFrame/);
  assert.match(output, /a menu is open/);
  assert.match(output, /3 earlier reads/);
});

test('an unterminated last tree is kept, and the reads before it collapse to the last complete one', () => {
  const c = createReadCompactor({ callTrees: true });
  const cut = travel(36);
  const output = join_(c.process([text(marked([travel(0), travel(9), travel(18), travel(27)]) + GUARD_MARK + cut)],
    { code: LOOP, action: c.beginAction(LOOP) }));
  assert.match(output, /Airport 0036 /, 'the unterminated final read stays');
  assert.match(output, /Airport 0027 /, 'so does the last complete one');
  assert.match(output, /3 earlier reads/);
  assert.doesNotMatch(output, /Airport 0009 International A009\n/);
});

test('reads already omitted by emit:false are not counted again', () => {
  const c = createReadCompactor({ callTrees: true });
  const content = GUARD_OMIT_MARK + travel(0) + GUARD_END + marked([travel(9), travel(18), travel(27)]);
  const output = join_(c.process([text(content)], { code: LOOP, explicitFull: true, action: c.beginAction(LOOP) }));
  assert.equal(roots(output), 1);
  assert.match(output, /sleight: 2 earlier reads/);
});

// The retained Firefox round, when this Mac still has it: the real 41-tree result that spilled.
const round = '/tmp/fb-rounds/real-f6f636c8-b44e-407e-a37e-d55e1fbfa2c5-sleight/form-travel/events.jsonl';
const saved = existsSync(round) && /Output has been saved to (.+?)\.\\n/.exec(readFileSync(round, 'utf8'))?.[1];
const spill = saved && existsSync(saved) ? saved : undefined;
test('the recorded travel result drops from 140,731 characters to one tree', { skip: !spill && 'retained round not on this Mac' }, () => {
  const trees = readFileSync(spill, 'utf8').split(/(?=^Window: ")/m).filter(x => x.startsWith('Window: '));
  assert.equal(trees.length, 41);
  const c = createReadCompactor({ callTrees: true });
  const output = join_(c.process([text(marked(trees.map(tree => tree.replace(/\n+$/, ''))) + 'none')],
    { code: LOOP, explicitFull: true, action: c.beginAction(LOOP) }));
  assert.equal(roots(output), 1);
  assert.ok(output.includes(trees.at(-1).replace(/\n+$/, '')));
  assert.match(output, /Hartford Falls International MWV/);
  assert.ok(output.length < 4000, String(output.length));
});

test('the third call in a row scrolling one list gets the loop note, once', () => {
  const c = createReadCompactor({ scrollNote: true });
  c.process([text(travel(0))]);
  const scroll = (code, first, title) => join_(c.process([text(GUARD_MARK + travel(first, title) + GUARD_END)],
    { code, action: c.beginAction(code) }));
  assert.doesNotMatch(scroll('await ff.scroll(49, "down", 3);', 9), /3 calls in a row/);
  assert.doesNotMatch(scroll('await ff.scroll(49, "down", 3);', 18), /3 calls in a row/);
  assert.ok(scroll('for (let i = 0; i < 6; i++) await ff.scroll(49, "down", 3);', 72).includes(SCROLL_LOOP_NOTE));
  assert.doesNotMatch(scroll('await ff.scroll(49, "down", 3);', 81), /3 calls in a row/, 'once per run of calls');
  // A click on the window starts over; another window's scrolls don't count toward this one.
  scroll('await ff.click(58);', 81);
  scroll('await ff.scroll(49, "down", 3);', 90);
  scroll('await other.scroll(49, "down", 3);', 0, 'Other page');
  scroll('await ff.scroll(49, "down", 3);', 99);
  assert.ok(scroll('await ff.scroll(49, "up", 1);', 98).includes(SCROLL_LOOP_NOTE));
  // A different list starts its own count.
  scroll('await ff.scroll(12, "down", 3);', 98);
  assert.doesNotMatch(scroll('await ff.scroll(49, "down", 3);', 107), /3 calls in a row/);
});

test('SLEIGHT_SCROLL_NOTE=0 leaves the note out', () => {
  const saved = process.env.SLEIGHT_SCROLL_NOTE;
  const third = () => {
    const c = createReadCompactor();
    let last;
    for (const first of [9, 18, 27]) last = join_(c.process([text(GUARD_MARK + travel(first) + GUARD_END)],
      { code: 'await ff.scroll(49, "down", 3);', action: c.beginAction('await ff.scroll(49, "down", 3);') }));
    return last;
  };
  try {
    delete process.env.SLEIGHT_SCROLL_NOTE;
    assert.ok(third().includes(SCROLL_LOOP_NOTE), 'on by default');
    process.env.SLEIGHT_SCROLL_NOTE = '0';
    assert.doesNotMatch(third(), /3 calls in a row/);
  } finally {
    if (saved === undefined) delete process.env.SLEIGHT_SCROLL_NOTE; else process.env.SLEIGHT_SCROLL_NOTE = saved;
  }
});
