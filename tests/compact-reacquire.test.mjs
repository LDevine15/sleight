import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadCompactor, dropAcquisitionTree, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const window = { title: 'Report', app: 'Fixture Reader', url: 'file:///tmp/report.pdf' };
const rows = Array.from({ length: 16 }, (_, i) => `\t\t${i + 4} button Row ${i + 1}, Help: Opens row ${i + 1} of the report`);
const tree = ({ title = 'Report', status = 'Ready', extra = [], tail = [] } = {}) => [`Window: "${title}", App: Fixture Reader.`,
  `0 standard window ${title}, URL: file:///tmp/report.pdf, Secondary Actions: Raise`,
  '\t1 group Layout', `\t\t2 text Value: ${status}`, ...extra, '\t\t3 button Open',
  ...rows, ...tail, '\t20 menu bar', '\t\t21 File', '', `The focused UI element is 0 standard window ${title}`]
  // Numbers stay 0, 1, 2… in order, as the engine writes them.
  .reduce((out, line) => { const m = /^(\t*)\d+ (.*)$/.exec(line); out.push(m ? `${m[1]}${out.n++} ${m[2]}` : line); return out; },
    Object.assign([], { n: 0 })).join('\n');
const text = value => ({ type: 'text', text: value });
const output = content => content.map(item => item.text ?? '').join('\n');
const acquire = (c, value = tree(), options = {}) => output(c.process([text(value)], { acquisition: true, ...options }));
const NO_CHANGE = 'sleight: no change since the last full tree you saw for this window.';

test('an unchanged re-acquisition is the window line and "no change", and every number stays known', () => {
  const c = createReadCompactor({ compactReacquire: true });
  assert.equal(acquire(c), tree(), 'a first acquisition is whole');
  const out = acquire(c, 'Engine docs\n' + tree());
  assert.equal(out, 'Engine docs\n' + tree().split('\n').slice(0, 2).join('\n') + '\n' + NO_CHANGE);
  for (let n = 0; n <= 22; n++) assert.equal(c.staleIndex(window, `app.click(${n})`), undefined);
});

test('a changed re-acquisition is a diff whose + lines carry the current numbers', () => {
  const c = createReadCompactor({ compactReacquire: true });
  acquire(c);
  const out = acquire(c, tree({ status: 'Saved' }));
  assert.match(out, /sleight: lines changed since the last full tree you saw/);
  assert.match(out, /^- \t\ttext Value: Ready$/m);
  assert.match(out, /^\+ \t\t2 text Value: Saved$/m);
  assert.doesNotMatch(out, /Row 1,/);
  assert.equal(c.staleIndex(window, 'app.click(2)'), undefined);
  assert.equal(c.seenLines(window, [2])[2], 'text Value: Saved');
});

test('a renumbered re-acquisition shows known lines with their new numbers, as a getAXState read does', () => {
  const c = createReadCompactor({ compactReacquire: true });
  acquire(c);
  const out = acquire(c, tree({ tail: ['\t\t0 button New'] }));
  assert.match(out, /^\+ \t\t20 button New$/m);
  assert.match(out, /^\+ \t21 menu bar$/m, 'a line Claude knew comes back with its new number');
  assert.match(out, /other elements have new numbers/);
  assert.doesNotMatch(out, /Row 1,/);
  assert.equal(c.staleIndex(window, 'app.click(21)'), undefined);
  assert.equal(c.seenLines(window, [21])[21], 'menu bar');
  assert.equal(acquire(c, tree({ extra: ['\t\t0 button New'] })).split('\n').length > 20, true, 'renumbering most lines sends the tree whole');
});

test('a new window, a degraded or incomplete tree and an ambiguous read stay whole', () => {
  const c = createReadCompactor({ compactReacquire: true });
  acquire(c);
  assert.equal(acquire(c, tree({ title: 'Other' })), tree({ title: 'Other' }), 'a window Claude never saw');
  for (const value of [tree() + '\n…(2000)', tree().replace('0 standard window', '0 menu'),
    tree() + '\n' + tree({ title: 'Other' }), tree().replace(', URL: file:///tmp/report.pdf', '')]) {
    const fresh = createReadCompactor({ compactReacquire: true });
    acquire(fresh);
    assert.equal(acquire(fresh, value), value);
  }
});

test('failed, stopped and restarted calls keep the acquisition whole, and so does the next one', () => {
  for (const [options, notice] of [[{ failed: true }, ''], [{}, '\nInput lease stopped this action: window or URL changed.'],
    [{}, "\nsleight: the engine's JavaScript session restarted before this call."], [{}, '\nsleight: the user switched windows.']]) {
    const c = createReadCompactor({ compactReacquire: true });
    acquire(c);
    assert.equal(acquire(c, tree() + notice, options), tree() + notice, 'the call itself');
    assert.equal(acquire(c), tree(), 'the next acquisition after it');
    assert.match(acquire(c), /no change since/, 'and then compacted again');
  }
  const c = createReadCompactor({ compactReacquire: true });
  acquire(c);
  const action = c.beginAction('await app.click(3)');
  c.process([text(GUARD_MARK + tree() + GUARD_END)], { action, failed: true });
  assert.equal(acquire(c), tree(), 'an acquisition after a failed action');
  acquire(c);
  c.reset(); // engine restart or js_reset
  assert.equal(acquire(c), tree(), 'an acquisition after an engine restart');
});

test('"this call acted on" is no reason for the next acquisition to be whole', () => {
  const c = createReadCompactor({ compactReacquire: true });
  acquire(c);
  c.process([text('sleight: this call acted on "Report" in Fixture Reader. The window it shows now is "Other".')]);
  assert.match(acquire(c), /no change since/);
});

test('disableDiffing and a forced full read keep the acquisition whole', () => {
  for (const options of [{ explicitFull: true }, { forceFull: true }]) {
    const c = createReadCompactor({ compactReacquire: true });
    acquire(c);
    assert.equal(acquire(c, tree(), options), tree());
  }
});

test('SLEIGHT_COMPACT_REACQUIRE=1 compacts re-acquisitions; they stay whole otherwise', () => {
  const off = createReadCompactor({ compactReacquire: false });
  acquire(off);
  assert.equal(acquire(off), tree());
  const prior = process.env.SLEIGHT_COMPACT_REACQUIRE;
  try {
    for (const [value, on] of [[undefined, false], ['1', true], ['0', false]]) {
      if (value === undefined) delete process.env.SLEIGHT_COMPACT_REACQUIRE;
      else process.env.SLEIGHT_COMPACT_REACQUIRE = value;
      const c = createReadCompactor();
      acquire(c);
      assert.equal(/no change since/.test(acquire(c)), on, `SLEIGHT_COMPACT_REACQUIRE=${value}`);
    }
  } finally {
    if (prior === undefined) delete process.env.SLEIGHT_COMPACT_REACQUIRE;
    else process.env.SLEIGHT_COMPACT_REACQUIRE = prior;
  }
});

test('only one view of a window survives a call when the head says no change', () => {
  const header = tree().split('\n').slice(0, 2).join('\n');
  const unchanged = [text(header + '\n' + NO_CHANGE)];
  const diff = text(header + '\nsleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n+ \t\t3 text Value: Saved');
  assert.deepEqual(dropAcquisitionTree(unchanged, [diff]), [], 'the call\'s diff was taken against the same lines');
  assert.deepEqual(dropAcquisitionTree(unchanged, [text(header + '\n' + NO_CHANGE)]), []);
  assert.deepEqual(dropAcquisitionTree(unchanged, [text(tree({ status: 'Saved' }))]), []);
  const full = [text(tree())];
  assert.equal(dropAcquisitionTree(full, [diff]), full, 'a diff needs the full tree it was taken against');
  const headDiff = [text(header + '\nsleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n+ \t\t3 text Value: Done')];
  assert.equal(dropAcquisitionTree(headDiff, [diff]), headDiff, 'a head diff\'s changes are in no later view');
  assert.deepEqual(dropAcquisitionTree(headDiff, [text(tree())]), []);
  const filtered = text(tree().split('\n').filter((line, i) => i < 2 || /Row 3,/.test(line)).join('\n'));
  assert.equal(dropAcquisitionTree(full, [filtered]), full, 'a filtered print is no whole tree');
  const prefix = text(tree().split('\n').slice(0, 10).join('\n'));
  assert.equal(dropAcquisitionTree(full, [prefix], 'nodeRepl.write(s.slice(0, 400))'), full, 'nor is a sliced one');
  assert.deepEqual(dropAcquisitionTree(full, [text(tree())], 'nodeRepl.write(s.slice(0, 40000))'), [], 'a sliced print with the footer is whole');
  assert.equal(dropAcquisitionTree(unchanged, [text(tree({ title: 'Other' }))]), unchanged, 'never another window\'s');
});

test('with the flag off the duplicate-tree rule is the one from before', () => {
  const full = [text(tree())];
  const filtered = text(tree().split('\n').filter((line, i) => i < 2 || /Row 3,/.test(line)).join('\n'));
  assert.deepEqual(dropAcquisitionTree(full, [filtered], undefined, false), []);
  const header = tree().split('\n').slice(0, 2).join('\n');
  assert.equal(dropAcquisitionTree(full, [text(header + '\n' + NO_CHANGE)], undefined, false), full);
});

function harness(t, options = {}) {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-reacquire-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  const record = into => data => into.push(...data.toString().trim().split('\n').map(JSON.parse));
  serverIn.on('data', record(sent)); clientOut.on('data', record(replies));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory, holder: 'fixture' }), ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
  return { sent, replies,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: (id, value) => serverOut.write(JSON.stringify({ id, result: { isError: false,
      content: [text(value)], _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n'),
  };
}
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const prefixId = h => h.sent.filter(m => String(m.id).startsWith('sleight-acquire-')).at(-1)?.id;

test('relay: a call that re-acquires an unchanged window gets one short view of it', async t => {
  for (const compactReacquire of [true, false]) {
    const h = harness(t, { compactReacquire });
    h.call(1, 'let app = await cua.getApp("example.fixture")'); await tick();
    h.reply(1, tree()); await tick();
    assert.equal(output(h.replies.find(m => m.id === 1).result.content), tree());
    h.call(2, 'let app = await cua.getApp("example.fixture"); nodeRepl.write("done")'); await tick();
    h.reply(prefixId(h), tree()); await tick();
    assert.ok(h.sent.some(m => m.id === 2), 'the rest of the call went on');
    h.reply(2, 'done'); await tick();
    const second = output(h.replies.find(m => m.id === 2).result.content);
    assert.equal(/Row 7,/.test(second), !compactReacquire);
    assert.equal(second.includes(NO_CHANGE), compactReacquire);
    h.call(3, 'let app = await cua.getApp("example.fixture"); nodeRepl.write(await app.getAXState())'); await tick();
    h.reply(prefixId(h), tree()); await tick();
    h.reply(3, GUARD_MARK + tree() + GUARD_END); await tick();
    const third = output(h.replies.find(m => m.id === 3).result.content);
    // Off, the acquisition's whole tree stays ahead of the call's "no change", as before.
    assert.equal(third.split('Window: "Report"').length - 1, compactReacquire ? 1 : 2, third);
    assert.equal(third.endsWith(NO_CHANGE), true);
  }
});

test('replay: the first 4 results of excel-edit run 1 lose at least 40% of their characters', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/excel-reacquire.json', import.meta.url), 'utf8'));
  const items = list => list.map(value => value === null ? { type: 'image', data: '' } : text(value === '@inventory' ? fixture.inventory : value));
  const size = content => content.reduce((n, item) => n + (item.text?.length ?? 0), 0);
  const run = compactReacquire => {
    const c = createReadCompactor({ compactReacquire });
    let total = 0;
    for (const result of fixture.results) {
      const head = c.process(items(result.head), { acquisition: true, code: 'let app = await cua.getApp("Microsoft Excel")' });
      const rest = items(result.rest);
      // The rest is replayed as Claude got it; its whole trees become what Claude last saw, as in the relay.
      for (const item of rest) for (const m of (item.text ?? '').matchAll(/^Window: [^\n]*\n0 [^\n]*\n(?:\t+\d+ [^\n]*\n?)+/gm)) {
        const numbers = m[0].trim().split('\n').slice(1).map(line => /^\t*(\d+) /.exec(line)[1]);
        if (numbers.every((n, i) => n === String(i))) c.process([text(m[0].trim())]);
      }
      total += size(items(result.before)) + size(dropAcquisitionTree(head, rest, result.code ?? undefined, compactReacquire)) + size(rest);
    }
    return total;
  };
  const before = run(false), after = run(true);
  assert.ok(after <= before * 0.6, `${before} -> ${after} characters`);
});

test('numbersMoved compares depth, role and identity, not values, flags, Help or a titled line\'s Description', () => {
  const excel = (range, formula, help, chat = 'Copilot Chat') => tree({ extra: [
    `\t\t0 layout area Content Area, Description: Workbook area, Used range: ${range}, Help: The content area of the window`,
    `\t\t0 text entry area Description: Formula Bar. ${formula}, ID: XLFormulaEditor`,
    `\t\t0 button (disabled) Description: enter formula, Help: ${help}, ID: EnterButton`,
    `\t\t0 button Description: ${chat}, Help: Copilot Chat (⌃⌘I), Secondary Actions: Expand`] });
  const moved = (before, after, upTo) => {
    const c = createReadCompactor();
    acquire(c, before);
    const trees = c.trees();
    return c.numbersMoved(trees, [text(acquire(c, after))], upTo);
  };
  assert.equal(moved(excel('A1 to B4', 'A,1 Item', 'Enter'), excel('A1 to C9', 'B,2 7', 'Press Enter'), 20), false);
  assert.equal(moved(excel('A1 to B4', 'A,1 Item', 'Enter'), excel('A1 to B4', 'A,1 Item', 'Enter', 'Other'), 20), true, 'an untitled line\'s Description is its identity');
  assert.equal(moved(excel('A1 to B4', 'A,1 Item', 'Enter'), excel('A1 to B4', 'A,1 Item', 'Enter', 'Other'), 5), false, 'above the largest number');
  assert.equal(moved(tree(), tree({ title: 'Other' }), 20), false, 'another window has no earlier tree');
});

test('numbersMoved ignores value-bearing titles and tells repeated rows apart by their Value', () => {
  const moved = (before, after, upTo) => {
    const c = createReadCompactor({ compactReacquire: true });
    acquire(c, before);
    return c.numbersMoved(c.trees(), [text(acquire(c, after))], upTo);
  };
  const controls = (scroll, field, triangle) => tree({ extra: [`\t\t0 scroll bar ${scroll}`, `\t\t0 text field (settable) ${field}`, `\t\t0 disclosure triangle ${triangle}`] });
  assert.equal(moved(controls('0', '5', '0'), controls('0.42', '2', '1'), 20), false, 'positions, field text and triangle state are values');
  const files = names => tree({ extra: names.flatMap(name => ['\t\t0 row', `\t\t\t0 text field Value: ${name}`, '\t\t\t0 text 12 KB']) });
  assert.equal(moved(files(['a.txt', 'b.txt', 'c.txt']), files(['a.txt', 'new.txt', 'b.txt', 'c.txt']), 12), true, 'a file inserted into repeated rows');
  assert.equal(moved(files(['a.txt', 'b.txt', 'c.txt']), files(['b.txt', 'a.txt', 'c.txt']), 12), true, 'reordered rows');
  assert.equal(moved(files(['a.txt', 'b.txt', 'c.txt']), files(['a.txt', 'b.txt', 'c.txt']), 12), false);
});

test('relay: a head that changed the window stops the rest when it has literal numbers (LS1)', async t => {
  // 60 items after row 16 take numbers 20 to 79; a popup inserted before item 38 takes 58 and moves item 38 to 59.
  const items = Array.from({ length: 60 }, (_, i) => `\t\t0 button Item ${i}`);
  const plain = tree({ tail: items }), popup = tree({ tail: items.toSpliced(38, 0, '\t\t0 button POPUP') });
  assert.match(plain, /^\t\t58 button Item 38$/m);
  for (const compactReacquire of [true, false]) {
    const h = harness(t, { compactReacquire });
    h.call(1, 'let app = await cua.getApp("example.fixture")'); await tick();
    h.reply(1, plain); await tick();
    h.call(2, 'let app = await cua.getApp("example.fixture"); await app.click(58)'); await tick();
    h.reply(prefixId(h), popup); await tick();
    assert.equal(h.sent.some(m => m.id === 2), false, 'no input went to the engine');
    const stopped = h.replies.find(m => m.id === 2).result;
    assert.equal(stopped.isError, true);
    assert.match(output(stopped.content), /^(?:\+ )?\t\t58 button POPUP$/m, 'the head shows the new numbers');
    assert.match(output(stopped.content), /^(?:\+ )?\t\t59 button Item 38$/m);
    assert.match(output(stopped.content), /window changed before this call's actions ran, so nothing after the acquisition was sent/);
    const valued = items.with(38, '\t\t0 button Item 38, Value: 5'), rows = Array(60).fill('\t\t0 button Row');
    for (const [id, code, head, runs, why] of [
      [3, 'await app.click(59)', popup, true, 'an unchanged head'],
      [4, 'await app.click({ label: "Item 38" })', plain, true, 'a changed head with a label'],
      [5, 'await app.click({ id: "item-38" })', popup, true, 'a changed head with an ID'],
      [6, 'nodeRepl.write("done")', plain, true, 'a changed head with no element numbers'],
      [7, 'await app.click(58)', tree({ tail: valued }), true, 'a Value change at the clicked number'],
      [8, 'await app.click(58)', tree({ status: 'Saved', tail: valued }), true, 'a Value change below it'],
      [9, 'await app.click(58)', tree({ status: 'Saved', tail: valued.with(38, '\t\t0 button (selected) Item 38, Value: 5') }), true, 'a selected flag'],
      [10, 'await app.click(58)', tree({ status: 'Saved', tail: valued.with(50, '\t\t0 button Item 50 renamed').slice(0, -1) }), true, 'changes only above it'],
      [11, 'nodeRepl.write("done")', tree({ tail: rows }), true, 'a new baseline of identical rows'],
      [12, 'await app.click(58)', tree({ tail: rows.toSpliced(10, 0, '\t\t0 button Row') }), false, 'an identical row inserted before it'],
      [13, 'await app.click(58)', tree({ tail: items.toSpliced(38, 0, '\t\t0 button POPUP') }), false, 'the popup inserted before it again'],
    ]) {
      h.call(id, `let app = await cua.getApp("example.fixture"); ${code}`); await tick();
      h.reply(prefixId(h), head); await tick();
      assert.equal(h.sent.some(m => m.id === id), runs, `${why}: ${code} ${runs ? 'runs' : 'stops'} (compactReacquire ${compactReacquire})`);
      if (runs) { h.reply(id, 'done'); await tick(); }
      else assert.match(output(h.replies.find(m => m.id === id).result.content), /nothing after the acquisition was sent/);
    }
  }
});
