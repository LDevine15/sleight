// AB2: a call's repeated reads of one window show only the last, and separate scroll calls on one
// list get a note suggesting one bounded loop. Travel shape: Firefox airport search, 2026-10-17.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { GUARD_MARK, GUARD_END, GUARD_OMIT_MARK, SCROLL_LOOP_NOTE, createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

const LOOP = 'let found = "none"; for (let i = 0; i < 40 && found === "none"; i++) { const s = await ff.getAXState({ disableDiffing: true }); ' +
  'const hit = s.split("\\n").filter(l => /Norcrest/.test(l)); if (hit.length) { found = hit.join("\\n"); break; } await ff.scroll(49, "down", 3); } nodeRepl.write(found);';

// The travel page: browser chrome, a 16-row airport list starting at `first`, and the menu bar.
function travel(first, title = 'Book a trip · Skyway', root = `standard window ${title}, Secondary Actions: Raise`, selected = -1) {
  const rows = Array.from({ length: 16 }, (_, i) => {
    const n = first + i, name = `Airport ${String(n).padStart(4, '0')} International`, code = `A${String(n).padStart(3, '0')}`;
    return `\t\t\t\t\t\t\t${50 + i} text (${n === selected ? 'selected' : 'selectable'}) ${name} ${code}\n${name}\n${code}`;
  });
  return [`Window: "${title}", App: Firefox.`, `0 ${root}`,
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

test('SLEIGHT_PROMPT=lean gives the loop note its lean wording', () => {
  const c = createReadCompactor({ scrollNote: true, prompt: 'lean' });
  c.process([text(travel(0))]);
  const scroll = first => join_(c.process([text(GUARD_MARK + travel(first) + GUARD_END)],
    { code: 'await ff.scroll(49, "down", 3);', action: c.beginAction('await ff.scroll(49, "down", 3);') }));
  scroll(9); scroll(18);
  const third = scroll(27), lean = promptNotice(SCROLL_LOOP_NOTE, 'lean');
  assert.ok(lean.length < SCROLL_LOOP_NOTE.length);
  assert.ok(third.includes(lean) && !third.includes(SCROLL_LOOP_NOTE));
});

// FT1a: the note fired in 2 of 3 Safari form-travel runs (race-1017), and the next call wrote the loop it described
// (r3: 3 reads, row not found; r2: 18.3 and 16.4 s). It names the paging helper first and the loop only after it stops.
test('the scroll note names app.pickFromList before any loop, in both prompts', () => {
  for (const prompt of [undefined, 'lean']) {
    const note = promptNotice(SCROLL_LOOP_NOTE, prompt);
    const helper = note.indexOf('`await app.pickFromList("<whole row text>")`'), loop = note.search(/\bloop\b/i);
    assert.ok(helper > 0, note);
    assert.ok(loop > helper, note);
    assert.match(note, /If it stops/);
  }
});

test('the third call in a row scrolling one list the same way gets the loop note, once', () => {
  const c = createReadCompactor({ scrollNote: true });
  c.process([text(travel(0))]);
  const scroll = (code, first, title) => join_(c.process([text(GUARD_MARK + travel(first, title) + GUARD_END)],
    { code, action: c.beginAction(code) }));
  const noted = output => output.includes(SCROLL_LOOP_NOTE);
  assert.ok(!noted(scroll('await ff.scroll(49, "down", 3);', 9)));
  assert.ok(!noted(scroll('await ff.scroll(49, "down", 3);', 18)));
  assert.ok(noted(scroll('await ff.scroll(49, "down", 3);', 27)));
  assert.ok(!noted(scroll('await ff.scroll(49, "down", 3);', 36)), 'once per run of calls');
  // A call that loops already searches in one call, and ends the run.
  scroll('await ff.scroll(49, "down", 3);', 45);
  assert.ok(!noted(scroll('for (let i = 0; i < 6; i++) await ff.scroll(49, "down", 3);', 99)));
  assert.ok(!noted(scroll('await ff.scroll(49, "down", 3);', 108)));
  assert.ok(!noted(scroll('let n = 0; while (n++ < 3) await ff.scroll(49, "down", 3);', 135)));
  // Only the same direction counts: down, down, up starts over at the up.
  scroll('await ff.scroll(49, "down", 3);', 144);
  scroll('await ff.scroll(49, "down", 3);', 153);
  assert.ok(!noted(scroll('await ff.scroll(49, "up", 1);', 152)));
  scroll('await ff.scroll(49, "up", 1);', 151);
  assert.ok(noted(scroll('await ff.scroll(49, "up", 1);', 150)), 'up three times');
  // A click, another window's call, a call with no tree, or another list ends the run.
  for (const interrupt of [() => scroll('await ff.click(58);', 150), () => scroll('await other.scroll(49, "down", 3);', 0, 'Other page'),
    () => c.process([text('done')], { code: 'await ff.scroll(49, "down", 3);', action: c.beginAction('await ff.scroll(49, "down", 3);') }),
    () => scroll('await ff.scroll(12, "down", 3);', 150)]) {
    scroll('await ff.scroll(49, "down", 3);', 159);
    interrupt();
    scroll('await ff.scroll(49, "down", 3);', 168);
    assert.ok(!noted(scroll('await ff.scroll(49, "down", 3);', 177)));
  }
});

test('a sheet or dialog read is never hidden behind the document\'s last read', () => {
  const sheet = first => travel(first, 'Book a trip · Skyway', 'sheet Description: Save, ID: save-panel');
  const sheets = output => [...output.matchAll(/^0 sheet /gm)].length;
  // doc, sheet, sheet, doc: two of each, nothing left out.
  let c = createReadCompactor({ callTrees: true });
  let output = loopCall(c, [travel(0), sheet(1), sheet(2), travel(9)]);
  assert.equal(roots(output), 2);
  assert.equal(sheets(output), 2);
  // doc, sheet, doc, doc, doc: the earlier documents go, the sheet stays.
  c = createReadCompactor({ callTrees: true });
  output = loopCall(c, [travel(0), sheet(1), travel(9), travel(18), travel(27)]);
  assert.equal(roots(output), 1);
  assert.equal(sheets(output), 1);
  assert.match(output, /3 earlier reads/);
  // A menu read under the same header stays too.
  c = createReadCompactor({ callTrees: true });
  output = loopCall(c, [travel(0), travel(9), travel(18), travel(27, 'Book a trip · Skyway', 'menu'), travel(36)]);
  assert.match(output, /^0 menu$/m);
  assert.match(output, /3 earlier reads/);
});

test('two same-titled windows read through two handles are not merged', () => {
  const untitled = first => travel(first, 'Untitled', 'standard window Untitled');
  const code = 'for (let i = 0; i < 3; i++) { await a.getAXState(); await b.getAXState(); }';
  const reads = [0, 100, 9, 109, 18, 118].map(untitled);
  let c = createReadCompactor({ callTrees: true });
  const output = join_(c.process([text(marked(reads))], { code, explicitFull: true }));
  assert.equal(roots(output), 6);
  for (const tree of reads) assert.ok(output.includes(tree));
  // Through one handle, the same reads are one window's.
  c = createReadCompactor({ callTrees: true });
  assert.equal(roots(join_(c.process([text(marked(reads))], { code: 'for (let i = 0; i < 6; i++) await a.getAXState();', explicitFull: true }))), 1);
});

test('after an omission the next call acts on numbers from the last tree', () => {
  const c = createReadCompactor({ callTrees: true });
  c.process([text(travel(0))]);
  const trees = Array.from({ length: 5 }, (_, i) => travel(i * 9));
  const output = loopCall(c, trees);
  assert.match(output, /Element numbers refer to the last tree\./);
  const window = { title: 'Book a trip · Skyway', app: 'Firefox', url: null };
  assert.equal(c.staleIndex(window, 'await ff.click(60);'), undefined, 'number 60 is current');
  assert.match(c.seenLines(window, [60])[60], /^text \(selectable\) Airport 0046 International A046/);
  const click = 'await ff.click(60);';
  const after = join_(c.process([text(GUARD_MARK + travel(36, undefined, undefined, 46) + GUARD_END)],
    { code: click, action: c.beginAction(click) }));
  assert.match(after, /lines changed since the last full tree/, 'the diff is against the last tree');
  assert.match(after, /\+ \t+60 text \(selected\) Airport 0046 International A046/);
  assert.match(after, /sleight: UI changed \(value\)\./);
});

test('a failed or forceFull call is never compacted', () => {
  const trees = Array.from({ length: 5 }, (_, i) => travel(i * 9));
  for (const flags of [{ failed: true }, { forceFull: true }]) {
    const c = createReadCompactor({ callTrees: true });
    c.process([text(travel(0))]);
    const output = join_(c.process([text(marked(trees))], { code: LOOP, explicitFull: true, action: c.beginAction(LOOP), ...flags }));
    assert.equal(roots(output), 5, JSON.stringify(flags));
    assert.doesNotMatch(output, /earlier reads/);
  }
  const c = createReadCompactor({ callTrees: true });
  const output = join_(c.process([text(marked(trees) + 'sleight: an action in this call failed: elementHasNoFrame')], { code: LOOP, explicitFull: true }));
  assert.equal(roots(output), 5, 'a failure notice in the result');
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
