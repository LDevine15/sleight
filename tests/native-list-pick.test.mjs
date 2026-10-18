import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { guardedCode, readCode, sameElement, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const window = { title: 'Book a trip', app: 'Firefox', url: null };
const letters = 'abcdefghijklmnopqrstuvwxyz';
// Unique, lexically sorted labels with a code after the name, as the travel form's airports.
const sortedNames = n => Array.from({ length: n }, (_, i) =>
  'Port ' + letters[Math.floor(i / 676) % 26] + letters[Math.floor(i / 26) % 26] + letters[i % 26] + ' Airport ' + (100 + (i * 7) % 900));

// A virtualized list: `visible` rows show, `overscan` more render on each side, a page key moves `page` rows.
function fakeList(names, { visible = 10, page = 9, overscan = 2, start = 0, focus = 'list', hook } = {}) {
  const model = { names, position: start, keys: [], reads: 0, focus, stuck: false, snapshot: [], numbers: new Map() };
  const clamp = value => Math.max(0, Math.min(model.names.length - visible, value));
  model.key = async key => {
    model.keys.push(key);
    if (!model.stuck) model.position = clamp(model.position + (key === 'Page_Down' ? page : key === 'Page_Up' ? -page : 0));
    hook?.key?.(model, key);
  };
  model.tree = async () => {
    model.reads++;
    hook?.read?.(model);
    const from = Math.max(0, model.position - overscan), to = Math.min(model.names.length, model.position + visible + overscan);
    const lines = ['Window: "Book a trip", App: Firefox.', '0 standard window Book a trip', '\t1 container Book a trip',
      '\t\t2 text Departing from', '\t\t3 list Departing from'];
    model.numbers = new Map();
    for (let i = from; i < to; i++) {
      const number = 4 + i - from;
      const name = model.names[i];
      model.numbers.set(number, name);
      lines.push(`\t\t\t${number} text (selectable) ${name}\n${name.split(' Airport ')[0]}\n${name.split(' ').at(-1)}`);
    }
    lines.push('\t\t90 text Selected: none', '\t\t91 button Next', '', model.focus === 'list' ? 'The focused UI element is 3 list Departing from'
      : 'The focused UI element is 91 button Next');
    model.snapshot = lines;
    return lines.join('\n');
  };
  return model;
}

function picker(model, extra = {}) {
  const clicks = [];
  const run = listPicker({ read: model.tree, observe() {}, press: model.key, parse: windowFromText, sameElement, expected: window,
    sleep: async () => {}, click: async line => { clicks.push(line); }, ...extra });
  return { clicks, run };
}
const labelOfClick = (model, line) => /^text \(selectable\) (.*)$/.exec(line)?.[1];

test('finds a target ahead with coarse page steps and clicks exactly that row', async () => {
  const names = sortedNames(1000), model = fakeList(names, { page: 9 });
  const { run, clicks } = picker(model);
  const result = await run(names[612]);
  assert.equal(result.found, true); assert.equal(result.clicked, true);
  assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [names[612]]);
  assert.ok(result.reads <= 24, `reads ${result.reads}`);
  assert.ok(model.keys.every(key => key === 'Page_Down' || key === 'Page_Up'));
  assert.ok(model.keys.filter(key => key === 'Page_Down').length >= 60);
});

test('overshoot reverses page by page and still finds the target', async () => {
  const names = sortedNames(300), model = fakeList(names, { page: 9 });
  const { run, clicks } = picker(model);
  // Four coarse pages move to row 36; the target sits just behind the rendered rows.
  const result = await run(names[30]);
  assert.equal(result.clicked, true);
  assert.equal(labelOfClick(model, clicks[0]), names[30]);
  assert.ok(model.keys.includes('Page_Up'), 'reversed after overshooting');
  assert.ok(model.keys.slice(model.keys.indexOf('Page_Up')).every(key => key === 'Page_Up'));
  assert.equal(model.keys.slice(model.keys.indexOf('Page_Up')).length, 1, 'one page at a time, not another coarse step');
});

test('every label is found at page sizes 8, 9 and 10 with overscan; a page equal to the window needs overlap and stops instead', async () => {
  const names = sortedNames(160);
  for (const page of [8, 9, 10]) {
    let slow = 0;
    for (const target of names) {
      const model = fakeList(names, { page, overscan: 2 });
      const { run, clicks } = picker(model);
      const result = await run(target);
      assert.equal(result.clicked, true, `${target} at page ${page}: ${JSON.stringify(result)}`);
      assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [target]);
      slow = Math.max(slow, result.reads);
    }
    assert.ok(slow <= 24, `page ${page}: most reads ${slow}`);
  }
  let gaps = 0;
  for (const target of names) {
    const model = fakeList(names, { page: 10, overscan: 0 });
    const { run, clicks } = picker(model);
    const result = await run(target);
    if (result.clicked) assert.equal(labelOfClick(model, clicks[0]), target);
    else { gaps++; assert.equal(result.reason, 'gap'); assert.deepEqual(clicks, []); }
  }
  assert.ok(gaps > 0);
});

test('first row, last row and rows at the edges of the rendered window are found', async () => {
  const names = sortedNames(100);
  for (const [at, start] of [[0, 0], [99, 0], [99, 90], [0, 90], [9, 0], [12, 0], [97, 90]]) {
    const model = fakeList(names, { start });
    const { run, clicks } = picker(model);
    const result = await run(names[at]);
    assert.equal(result.clicked, true, `${at} from ${start}: ${JSON.stringify(result)}`);
    assert.equal(labelOfClick(model, clicks[0]), names[at]);
  }
  const model = fakeList(names, { start: 0 });
  assert.equal((await picker(model).run(names[0])).keys, 0, 'already visible: no key');
});

test('exact labels only: a longer and a shorter neighbour never match', async () => {
  const names = ['Norcrest Bay', 'Norcrest Point International', 'Norcrest Pointe', 'Norcrest Pointer', 'Norcrest Q'];
  const filler = sortedNames(60).map(name => 'Aa ' + name);
  const all = [...filler, ...names, 'Zz end 1', 'Zz end 2'].sort((a, b) => a.localeCompare(b));
  const model = fakeList(all, { page: 8 });
  const { run, clicks } = picker(model);
  const near = await run('Norcrest Point');
  assert.equal(near.found, false); assert.equal(near.reason, 'not-in-list');
  assert.deepEqual(clicks, []);
  assert.deepEqual(near.near, ['Norcrest Point International']);
  assert.match(near.note, /Pass a whole row label/);
  const exact = await picker(fakeList(all, { page: 8 })).run('Norcrest Pointe');
  assert.equal(exact.label, 'Norcrest Pointe');
  const model2 = fakeList(all, { page: 8 });
  const p = picker(model2);
  await p.run('Norcrest Pointer');
  assert.equal(labelOfClick(model2, p.clicks[0]), 'Norcrest Pointer');
});

test('a row can be named by its name line; a whole-label near miss reports the rows that start with it', async () => {
  const names = sortedNames(80), model = fakeList(names);
  const name = names[40].split(' Airport ')[0];
  const { run, clicks } = picker(model);
  const result = await run(name);
  assert.equal(result.clicked, true);
  assert.equal(labelOfClick(model, clicks[0]), names[40]);
  const prefix = names[41].slice(0, -2);
  const miss = await picker(fakeList(names)).run(prefix);
  assert.equal(miss.clicked, false);
});

test('a label between two rows is reported absent and nothing is clicked', async () => {
  const names = sortedNames(200), model = fakeList(names);
  const { run, clicks } = picker(model);
  const result = await run(names[120] + ' x');
  assert.equal(result.found, false); assert.equal(result.reason, 'not-in-list');
  assert.deepEqual(clicks, []);
  assert.match(result.note, /^No row clicked\./);
  const before = await picker(fakeList(names)).run('A');
  assert.equal(before.reason, 'no-progress');
  const after = await picker(fakeList(names)).run('Zzzz');
  assert.equal(after.reason, 'no-progress');
  assert.match(after.note, /end of the list/);
});

test('stops when the keys do not move the list', async () => {
  const names = sortedNames(200), model = fakeList(names);
  model.stuck = true;
  const { run, clicks } = picker(model);
  const result = await run(names[150]);
  assert.equal(result.reason, 'no-progress');
  assert.equal(model.keys.length, 4, 'one coarse step, then it stops');
  assert.deepEqual(clicks, []);
});

test('stops when focus leaves the list and presses no further key', async () => {
  const names = sortedNames(300);
  const model = fakeList(names, { hook: { key: (m, key) => { if (m.keys.length === 8) m.focus = 'button'; } } });
  const { run, clicks } = picker(model);
  const result = await run(names[250]);
  assert.equal(result.reason, 'focus-lost');
  assert.equal(model.keys.length, 8);
  assert.deepEqual(clicks, []);
  const none = fakeList(names, { focus: 'button' });
  const first = await picker(none).run(names[5]);
  assert.equal(first.reason, 'not-a-list');
  assert.deepEqual(none.keys, []);
});

test('stops on rows that are not strictly ascending, before or after moving', async () => {
  const names = sortedNames(300);
  const swapped = [...names]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  const model = fakeList(swapped);
  const { run, clicks } = picker(model);
  assert.equal((await run(names[250])).reason, 'unsorted');
  assert.deepEqual(model.keys, []);
  assert.deepEqual(clicks, []);
  const later = [...names]; [later[108], later[109]] = [later[109], later[108]];
  const model2 = fakeList(later, { page: 9 });
  const second = picker(model2);
  const result = await second.run(names[290]);
  assert.equal(result.reason, 'unsorted');
  assert.ok(model2.keys.length > 0);
  assert.deepEqual(second.clicks, []);
  const duplicate = fakeList([...names.slice(0, 5), names[4], ...names.slice(5)]);
  assert.equal((await picker(duplicate).run(names[200])).reason, 'unsorted');
});

test('a list that wraps back instead of advancing is refused', async () => {
  const names = sortedNames(300);
  const model = fakeList(names, { hook: { key: m => { if (m.keys.length === 8) m.position = 0; } } });
  const result = await picker(model).run(names[280]);
  assert.equal(result.reason, 'unsorted');
});

test('caps reads, keys and time', async () => {
  const names = sortedNames(1000);
  const model = fakeList(names, { page: 8 });
  const { run, clicks } = picker(model);
  const result = await run(names[900], { maxReads: 6 });
  assert.equal(result.reason, 'cap'); assert.ok(result.reads <= 6);
  assert.deepEqual(clicks, []);
  let tick = 0;
  const timed = picker(fakeList(names, { page: 8 }), { now: () => (tick += 5000) });
  assert.equal((await timed.run(names[900], { timeoutMs: 12000 })).reason, 'cap');
  const slow = fakeList(sortedNames(1000), { page: 1, visible: 3, overscan: 0 });
  const keyed = await picker(slow).run(slow.names[990], { maxReads: 100 });
  assert.equal(keyed.reason, 'cap');
  assert.ok(slow.keys.length <= 400);
});

test('never clicks a row from a tree that a redraw has already replaced', async () => {
  const names = sortedNames(300), target = names[150];
  // The read right after the first tree that shows the target finds the list redrawn at the top.
  let shown = 0;
  const model = fakeList(names, { hook: { read: m => {
    if (shown === 1) { m.position = 0; shown = 2; }
    else if (shown === 0 && m.position - 2 <= 150 && 150 < m.position + 12) shown = 1;
  } } });
  const clicks = [];
  const { run } = picker(model, { click: async line => {
    assert.ok(model.snapshot.some(row => row.includes(line)), 'the newest tree shows the row being clicked');
    clicks.push(line);
  } });
  const result = await run(target);
  assert.equal(shown, 2);
  assert.equal(result.clicked, true);
  assert.deepEqual(clicks.map(line => labelOfClick(model, line)), [target]);
  assert.ok(model.keys.length > 30, 'it searched again after the redraw rather than clicking the old tree');

  // A row that is gone from the confirming tree is never clicked.
  let looks = 0;
  const gone = fakeList(sortedNames(300), { hook: { read: m => {
    if (m.position - 2 <= 150 && 150 < m.position + 12 && ++looks === 2) m.names.splice(150, 1);
  } } });
  const second = picker(gone);
  const missing = await second.run(target);
  assert.equal(missing.clicked, false);
  assert.equal(missing.reason, 'not-in-list');
  assert.deepEqual(second.clicks, []);
});

test('the confirming read must show the row once and in the same list', async () => {
  const names = sortedNames(60);
  const model = fakeList(names);
  let reads = 0;
  const { run, clicks } = picker(model, { read: async () => {
    const text = await model.tree();
    if (++reads === 2) return text.replace('3 list Departing from\n', '3 list Departing from\n').replace(/The focused UI element is 3 list Departing from/, 'The focused UI element is 91 button Next');
    return text;
  } });
  const result = await run(names[4]);
  assert.equal(result.reason, 'focus-lost');
  assert.deepEqual(clicks, []);
});

// FT1a: the skill now sends a long list here first. Safari's travel list (race-1017 r3) reads "list (settable)" with plain
// "text <name> <code>" rows, 16 shown, and focus on the list after a row click; the row the task names is a whole label.
test('the Safari list shape from the travel race is searched and its whole-label row clicked', async () => {
  const shown = ['Ashbridge International FTZ', 'Ashbridge Point Municipal HBB', 'Norcliff International JUR', 'Norcrest Bay Municipal YLU',
    'Norcrest Point International MAO', 'Nordale Bay Airport DIT', 'Rosford Valley Field YZB'];
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const names = [...new Set([...shown, ...sortedNames(990)])].sort(compare);
  let position = 0;
  const keys = [];
  const tree = async () => {
    const rows = names.slice(position, position + 16).map((name, i) => `\t\t\t\t\t\t\t${25 + i} text ${name}`);
    return ['Window: "sleight benchmark — Book a trip · Skyway", App: Safari.', '0 standard window sleight benchmark — Book a trip · Skyway',
      '\t\t\t\t\t\t23 text Departing from', '\t\t\t\t\t\t24 list (settable) Departing from', ...rows,
      '\t\t\t\t\t\t41 text Selected: Ashbridge International (FTZ)', '\t\t\t\t\t\t42 button Back', '',
      'The focused UI element is 24 list (settable) Departing from'].join('\n');
  };
  const clicks = [];
  const run = listPicker({ read: tree, observe() {}, parse: windowFromText, sameElement, sleep: async () => {},
    expected: { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null },
    press: async key => { keys.push(key); position = Math.max(0, Math.min(names.length - 16, position + (key === 'Page_Down' ? 15 : -15))); },
    click: async line => { clicks.push(line); } });
  const result = await run('Norcrest Point International MAO');
  assert.equal(result.clicked, true, JSON.stringify(result));
  assert.deepEqual(clicks, ['text Norcrest Point International MAO']);
  assert.ok(result.reads <= 30, String(result.reads));
  position = 0; clicks.length = 0;
  const partial = await run('Norcrest Point');
  assert.equal(partial.clicked, false);
  assert.deepEqual(partial.near, ['Norcrest Point International MAO']);
  assert.deepEqual(clicks, []);
});

test('a changed window stops the search with its tree and clicks nothing', async () => {
  const names = sortedNames(300), model = fakeList(names);
  const { run, clicks } = picker(model, { read: async () => {
    const text = await model.tree();
    return model.keys.length >= 4 ? text.replace('Window: "Book a trip"', 'Window: "Other"') : text;
  } });
  await assert.rejects(run(names[250]), /window changed/);
  assert.deepEqual(clicks, []);
});

test('input is checked', async () => {
  const { run } = picker(fakeList(sortedNames(50)));
  for (const bad of ['', '  ', 4, undefined]) await assert.rejects(run(bad), /exact label/);
  await assert.rejects(run('x', { maxReads: 0 }), /maxReads/);
  await assert.rejects(run('x', { coarse: 9 }), /coarse/);
});

// Through the guard: every key and the click use the guarded handle.
function guarded(model, { raw = {} } = {}) {
  const clicks = [], keys = [];
  const handle = { getAXState: async () => model.tree(), pressKey: async key => { keys.push(key); await model.key(key); },
    click: async number => { clicks.push(model.numbers.get(number)); }, ...raw };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  return { clicks, keys, run, handle, start: () => run(readCode('await cua.getApp("Firefox");')),
    call: code => run(guardedCode(code, window)) };
}

test('app.pickFromList pages by key and clicks the row it resolved in its newest tree', async () => {
  const names = sortedNames(400), model = fakeList(names, { page: 9 });
  const g = guarded(model);
  await g.start();
  const result = await g.call(`return await app.pickFromList(${JSON.stringify(names[333])});`);
  assert.equal(result.clicked, true);
  assert.deepEqual(g.clicks, [names[333]]);
  assert.ok(g.keys.length > 20 && g.keys.every(key => key.startsWith('Page_')));
});

test('app.pickFromList stops when the window changes between keys', async () => {
  const names = sortedNames(400), model = fakeList(names);
  let swapped = false;
  const g = guarded(model, { raw: {
    getAXState: async () => { const text = await model.tree(); return swapped ? text.replace('"Book a trip"', '"Elsewhere"') : text; },
    pressKey: async key => { if (model.keys.length >= 8) swapped = true; await model.key(key); },
  } });
  await g.start();
  await assert.rejects(g.call(`return await app.pickFromList(${JSON.stringify(names[390])});`), /window changed|Observed/);
  assert.deepEqual(g.clicks, []);
});

test('app.pickFromList refuses to press a key without the input lease', async () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-list-lease-')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const path = join(dir, 'lease.json');
    writeFileSync(path, JSON.stringify({ token: 'someone else', expires: Date.now() + 30000 }));
    const names = sortedNames(400), model = fakeList(names), keys = [], clicks = [];
    const raw = { getAXState: async () => model.tree(), pressKey: async key => { keys.push(key); await model.key(key); },
      click: async number => { clicks.push(number); } };
    const code = guardedCode(`return await app.pickFromList(${JSON.stringify(names[300])});`, window, undefined, { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /Input lease stopped/);
    } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
    assert.deepEqual(keys, []);
    assert.deepEqual(clicks, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a search that does not click ends the call with its reason; a frameless click is reported, other click errors propagate', async () => {
  const names = sortedNames(100), model = fakeList(names);
  const absent = guarded(model);
  await absent.start();
  await assert.rejects(absent.call(`await app.pickFromList(${JSON.stringify(names[50] + ' x')}); await app.click(1);`), /pickFromList stopped \(not-in-list\): No row clicked\..*reads, \d+ keys/);
  assert.deepEqual(absent.clicks, []);
  const g = guarded(fakeList(names), { raw: { click: async () => { throw new Error('elementHasNoFrame'); } } });
  await g.start();
  await assert.rejects(g.call(`return await app.pickFromList(${JSON.stringify(names[3])});`), /click-failed.*Input may have been sent/);
  const other = guarded(fakeList(names), { raw: { click: async () => { throw new Error('boom'); } } });
  await other.start();
  await assert.rejects(other.call(`return await app.pickFromList(${JSON.stringify(names[3])});`), /boom/);
});
