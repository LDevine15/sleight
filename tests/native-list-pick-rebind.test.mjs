import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { guardedCode, readCode, sameElement, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

// Initial and refreshed full trees from validation try 7, with local URL and window tokens replaced.
// The next read's diff shows Alder Depot selected and Save collection enabled after the focusing click.
const recordings = JSON.parse(readFileSync(new URL('./fixtures/native-list-pick-pl1.json', import.meta.url)));
const row = 'text (selectable) Alder Depot COL-0005';
const picked = 'text (selected) Alder Depot COL-0005';

function fixture(recording, { focus = 'container', nested = false, duplicate = false, missing = false, selected = true,
  focusAfterScroll = focus } = {}) {
  let clicked, advanced = false, started = false;
  const clicks = [], keys = [], scrolls = [], notes = [];
  const tree = () => {
    let text = recording.current;
    if (duplicate) text = text.replace('\t44 close button', '\t100 list Collection\n\t44 close button');
    if (missing) text = text.replace('32 list Collection', '32 list Other');
    if (clicked && selected) text = text.replace(row, picked).replace('42 text No collection selected', '42 text Alder Depot COL-0005')
      .replace('43 button (disabled) Save collection', '43 button Save collection');
    if (advanced) {
      // A wheel step has reached a sorted band around the recorded distant target. Geometry is modeled, not timed.
      const [name, number] = recording.target.split(' COL-');
      const targetNumber = Number(number);
      text = text.replace(/^(\t{6})\d+ text \((?:selectable|selected)\) Alder [^\n]+/gm, (line, indent) => {
        const index = Number(/^\s*(\d+)/.exec(line)[1]) - 33;
        const label = name + ' COL-' + String(targetNumber + index - 4).padStart(4, '0');
        return indent + (33 + index) + ' text (' + (clicked === label ? 'selected' : 'selectable') + ') ' + label;
      });
    }
    if (nested) text = text.replace(/^(\t{6})(37 text \([^\n]+)/m, '$1$2\n$1\t101 container Row detail\n$1\t\t102 text Detail');
    if (clicked && focus === 'row') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 37 ' +
      (advanced ? 'text (' + (clicked === recording.target ? 'selected' : 'selectable') + ') ' + recording.target : picked));
    if (clicked && focus === 'nested') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 102 text Detail');
    if (clicked && (advanced ? focusAfterScroll : focus) === 'outside') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 43 button Save collection');
    return text;
  };
  const handle = {
    getAXState: async () => { if (!started) { started = true; return recording.initial; } return tree(); },
    click: async number => {
      const line = tree().split('\n').find(line => new RegExp('^\\s*' + number + ' ').test(line));
      assert.ok(line, 'click must name a current element');
      assert.match(line, /text \((?:selectable|selected)\)/, 'only plain list rows clicked');
      clicked = line.replace(/^\s*\d+ text \([^)]*\) /, ''); clicks.push(number);
    },
    pressKey: async key => { assert.ok(['row', 'nested'].includes(focus), 'no key with focus outside the list'); keys.push(key); advanced = true; },
    scroll: async (number, direction, ticks) => { assert.equal(number, 32); scrolls.push({ number, direction, ticks }); advanced = true; },
  };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write: note => notes.push(note) } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  const start = () => run(readCode('globalThis.app = await cua.getApp("Firefox"); await app.getAXState();'));
  const pick = (number, options = {}) => run(guardedCode(`return await app.pickFromList(${number}, ${JSON.stringify(recording.target)});`,
    windowFromText(recording.current), undefined, undefined,
    { literals: [number], seenLines: { [number]: 'list Collection' }, uniqueSeen: [number], ...options }));
  return { start, pick, clicks, keys, scrolls, notes, tree };
}

for (const recording of recordings) {
  test('PL1 ' + recording.run + ': old number 29 rebinds to 32 and the descendant selection uses only the wheel', async () => {
    const h = fixture(recording);
    await h.start();
    const result = await h.pick(29);
    assert.equal(result.clicked, true);
    assert.equal(result.label, recording.target);
    assert.equal(result.focusClick, row);
    assert.deepEqual(h.clicks, [37, 37]);
    assert.deepEqual(h.keys, []);
    assert.ok(h.scrolls.length > 0);
    assert.match(h.notes.join('\n'), /pickFromList\(29\) went to element 32, the same "list Collection".*renumbered/);
  });

  test('PL1 ' + recording.run + ': current number 32 accepts its selected descendant despite container focus', async () => {
    const h = fixture(recording);
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.deepEqual(h.keys, []);
    assert.ok(h.scrolls.length > 0);
  });
}

test('PL1: focused row descendants, including nested descendants, may receive page keys', async () => {
  for (const focus of ['row', 'nested']) {
    const h = fixture(recordings[0], { focus, nested: focus === 'nested' });
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.ok(h.keys.length > 0);
  }
});

test('PL1: ambiguous, missing and nonunique prior list identities stop before any input', async () => {
  for (const [settings, options] of [[{ duplicate: true }, {}], [{ missing: true }, {}], [{}, { uniqueSeen: [] }]]) {
    const h = fixture(recordings[0], settings);
    await h.start();
    await assert.rejects(h.pick(29, options), /not-a-list.*changed since you read/);
    assert.deepEqual(h.clicks, []); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
  }
});

test('PL1: focus outside the list stops after its one focusing click, before any key or wheel', async () => {
  const h = fixture(recordings[0], { focus: 'outside' });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost/);
  assert.deepEqual(h.clicks, [37]); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
});

test('PL1: a click with no descendant selection proof stops before any key or wheel', async () => {
  const h = fixture(recordings[0], { selected: false });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost/);
  assert.deepEqual(h.clicks, [37]); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
});

test('PL1: focus leaving the ancestor container for an outside control stops further wheel input too', async () => {
  const h = fixture(recordings[0], { focusAfterScroll: 'outside' });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost/);
  assert.deepEqual(h.clicks, [37]); assert.deepEqual(h.keys, []); assert.equal(h.scrolls.length, 1);
});

test('PL1: an old number absent from the current tree still rebinds its unique list', async () => {
  const h = fixture({ ...recordings[0], current: recordings[0].current.replace(/^\t+29 text Display mode \n/m, '') });
  await h.start();
  assert.equal((await h.pick(29)).clicked, true);
  assert.match(h.notes.join('\n'), /went to element 32/);
});

test('PL1: changed roles, disabled state and bare roles cannot stand in for the old list', async () => {
  for (const [current, old] of [[recordings[0].current.replace('32 list Collection', '32 container Collection'), 'list Collection'],
    [recordings[0].current.replace('32 list Collection', '32 list (disabled) Collection'), 'list Collection'],
    [recordings[0].current.replace('32 list Collection', '32 list'), 'list']]) {
    const h = fixture({ ...recordings[0], current });
    await h.start();
    await assert.rejects(h.pick(29, { seenLines: { 29: old } }), /not-a-list.*changed since you read/);
    assert.deepEqual(h.clicks, []); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
  }
});

test('PL1: focus without a matching descendant in the tree never authorizes a key', async () => {
  const text = recordings[0].current.replace(/The focused UI element is .*/, 'The focused UI element is 102 text Detail');
  const keys = [], clicks = [];
  const result = await listPicker({ read: async () => text, observe() {}, press: async key => keys.push(key),
    click: async line => clicks.push(line), parse: windowFromText, sameElement })(32, recordings[0].target);
  assert.equal(result.reason, 'focus-lost');
  assert.deepEqual(keys, []); assert.equal(clicks.length, 1);
});
