import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(text, selected, destination, dest) {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const writes = [], selections = [], settles = [];
  const area = (initial, range) => {
    let value = initial;
    return {
      value: () => value, selection: () => ({ ...range }), hasAttributes: () => false,
      replace: (at, length, insert) => {
        writes.push([at, length, insert]);
        value = value.slice(0, at) + insert + value.slice(at + length);
      },
      select: (at, length) => selections.push([at, length]), settle: () => settles.push(true),
    };
  };
  const source = area(text, { location: text.indexOf(selected), length: selected.length });
  const target = destination === undefined ? source : area(destination, { location: 0, length: 0 });
  // Endpoint geometry has its own tests. These tests isolate the plain text edits at a proven index.
  context.dropIndex = () => dest;
  const snapshot = { text, selected, app: 'Editor', el: {
    value: source.value, attributes: { byName: () => ({ value: () => selected }) },
  } };
  const a = { id: 11, title: 'Source' }, b = { id: 12, title: 'Target' };
  return { source, target, writes, selections, settles, run: () => destination === undefined
    ? context.accessibilityMove(source, snapshot, {}, a)
    : context.accessibilityCrossWindowMove(source, target, snapshot,
      { text: destination, el: { value: target.value } }, {}, a, b) };
}

test('WD5 spacing compares only one existing character on each side of each endpoint', () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const edges = (text, allowed) => new Proxy({}, {
    get: (_target, key) => {
      assert.ok(key === 'length' || allowed.includes(Number(key)), `unexpected text read: ${String(key)}`);
      return text[key];
    },
  });
  const cut = context.smartDeleteRange(edges('alpha move omega', [5, 10]), 6, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(cut)), { from: 6, to: 11 });
  const insert = context.smartInsert(edges('leftright', [3, 4]), 4, 'move');
  assert.deepEqual(JSON.parse(JSON.stringify(insert)), { text: ' move ', offset: 1, spaceInserted: true });
  const final = context.smartInsert(edges('destination\n', [11, 12]), 12, 'move');
  assert.deepEqual(JSON.parse(JSON.stringify(final)), { text: 'move\n', offset: 0, spaceInserted: false });
});

for (const cross of [false, true]) {
  const route = cross ? 'cross-window' : 'single-window';
  test(`WD5 ${route} recorded move collapses the source space and keeps a final newline`, () => {
    const source = 'alpha move-xxxx omega\n', target = 'destination\n';
    const h = cross ? fixture(source, 'move-xxxx', target, target.length)
      : fixture(source + target, 'move-xxxx', undefined, source.length + target.length);
    const result = h.run();
    assert.equal(result.error, undefined);
    assert.equal(h.source.value(), cross ? 'alpha omega\n' : 'alpha omega\ndestination\nmove-xxxx\n');
    if (cross) assert.equal(h.target.value(), 'destination\nmove-xxxx\n');
    assert.deepEqual(h.selections.at(-1), [cross ? 12 : 24, 9]);
    assert.equal(h.settles.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /alpha|omega|destination|move-xxxx/);
  });

  for (const [selected, expected] of [
    ['move,', 'left move, right'], ['(move)', 'left (move) right'],
    ['move ', 'left move right'], [' move', 'left move right'],
    [' move ', 'left move right'], ['café', 'left café right'],
  ]) {
    test(`WD5 ${route} inserts each missing separator for ${JSON.stringify(selected)}`, () => {
      const source = `a ${selected} z\n`, target = 'leftright';
      const h = cross ? fixture(source, selected, target, 4)
        : fixture(target + '\n' + source, selected, undefined, 4);
      assert.equal(h.run().error, undefined);
      assert.equal(h.source.value(), cross ? 'a z\n' : `${expected}\na z\n`);
      if (cross) assert.equal(h.target.value(), expected);
      const [at, length] = h.selections.at(-1);
      assert.equal(h.target.value().slice(at, at + length), selected);
    });
  }

  for (const [name, source, expected] of [
    ['space before LF', 'alpha move,\n', 'alpha\n'],
    ['space before CR', 'alpha move,\r', 'alpha\r'],
    ['space before CRLF', 'alpha move,\r\n', 'alpha\r\n'],
    ['space after LF', '\nmove, omega\n', '\nomega\n'],
    ['space after CR', '\rmove, omega\n', '\romega\n'],
    ['document start', 'move, omega\n', 'omega\n'],
    ['document end', 'alpha move,', 'alpha'],
    ['word neighbors', 'alphamove,omega\n', 'alphaomega\n'],
    ['tabs', 'alpha\tmove,\tomega\n', 'alpha\t\tomega\n'],
    ['two line ends', '\nmove,\n', '\n\n'],
  ]) {
    test(`WD5 ${route} smart delete preserves line ends and tabs: ${name}`, () => {
      const h = cross ? fixture(source, 'move,', '', 0)
        : fixture(source + '\nend', 'move,', undefined, source.length + 4);
      assert.equal(h.run().error, undefined);
      assert.equal(h.source.value(), cross ? expected : `${expected}\nend move,`);
      if (cross) assert.equal(h.target.value(), 'move,');
    });
  }

  for (const [target, dest, selected, expected] of [
    ['left right', 5, 'move', 'left move right'],
    ['left\nright', 5, 'move', 'left\nmove right'],
    ['left\nright', 4, 'move', 'left move\nright'],
    ['destination\n\n', 12, 'move', 'destination\nmove\n'],
    ['destination\n\n', 13, 'move', 'destination\n\nmove\n'],
    ['destination\n', 12, 'move\n', 'destination\nmove\n'],
    ['destination', 11, 'move', 'destination move'],
    ['', 0, 'move', 'move'],
  ]) {
    test(`WD5 ${route} preserves the drop line at index ${dest} in ${JSON.stringify(target)} with ${JSON.stringify(selected)}`, () => {
      const source = `alpha ${selected} omega\n`;
      const h = cross ? fixture(source, selected, target, dest)
        : fixture(source + target, selected, undefined, source.length + dest);
      assert.equal(h.run().error, undefined);
      const remainder = 'alpha omega\n';
      assert.equal(h.source.value(), cross ? remainder : remainder + (target === '' ? 'move\n' : expected));
      if (cross) assert.equal(h.target.value(), expected);
    });
  }
}
