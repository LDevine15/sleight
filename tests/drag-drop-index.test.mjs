import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');
function fixture() {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(source, context);
  const queries = [];
  const area = {
    indexAt: p => p.y >= 100 && p.y < 114 && p.x >= 10 && p.x < 34 ? Math.floor((p.x - 10) / 8) : 0,
    rect: (i, length = 1) => i === 4 && length === 0
      ? { X: 10, Y: 120, Width: 0, Height: 14 }
      : i < 3 ? { X: 10 + i * 8, Y: 100, Width: 8 * length, Height: 14 } : null,
    lineForIndex: i => { queries.push(['line', i]); return 0; },
    lineRange: n => { queries.push(['range', n]); return n === 0 ? { location: 0, length: 4 } : n === 1 ? { location: 4, length: 0 } : null; },
    lineEnd: () => 4,
  };
  return { context, area, queries, drop: (p, text = 'abc\n') => context.dropIndex(area, p, text) };
}

for (const text of ['abc\n\n', 'abc\n\r\n']) {
  test(`DP7 accepts a line containing only its newline: ${JSON.stringify(text)}`, () => {
    const h = fixture(), rect = h.area.rect;
    h.area.lineRange = n => n === 1 ? { location: 4, length: text.length - 4 } : { location: 0, length: 4 };
    h.area.rect = (i, n) => i === 4 ? { X: 10, Y: 120, Width: 0, Height: 14 } : rect(i, n);
    assert.equal(h.drop({ x: 20, y: 126 }, text), 4);
  });
}

for (const [name, text] of [['non-empty next line', 'abc\ntext\n'], ['wrapped non-empty next line', 'abc\nwrapped text']]) {
  test(`DP7 refuses a point left of a ${name}`, () => {
    const h = fixture(), rect = h.area.rect;
    h.area.lineRange = n => n === 1 ? { location: 4, length: text.length - 4 } : { location: 0, length: 4 };
    h.area.rect = (i, n) => i === 4 ? { X: 100, Y: 120, Width: 80, Height: 14 } : rect(i, n);
    assert.throws(() => h.drop({ x: 20, y: 126 }, text), /cannot find where the drop point falls/);
  });
}

test('DPd resolves the second of two blank lines through consecutive AX ranges', () => {
  const h = fixture(), rect = h.area.rect;
  h.area.lineRange = n => n === 1 ? { location: 4, length: 1 } : n === 2 ? { location: 5, length: 0 } : { location: 0, length: 4 };
  h.area.rect = (i, n) => i === 4 || i === 5 ? { X: 10, Y: i === 4 ? 120 : 140, Width: 0, Height: 14 } : rect(i, n);
  assert.equal(h.drop({ x: 20, y: 146 }, 'abc\n\n'), 5);
  vm.runInContext('dp7 = false', h.context);
  assert.throws(() => h.drop({ x: 20, y: 146 }, 'abc\n\n'), /cannot find where the drop point falls/);
});

for (const newline of ['\n', '\r\n']) {
  test(`DPd smoke shape: destination plus two ${JSON.stringify(newline)} endings`, () => {
    const h = fixture(), text = `destination${newline}${newline}`, first = 11 + newline.length;
    h.area.indexAt = p => p.y >= 81 && p.y < 94 && p.x >= 762 && p.x < 835 ? Math.floor((p.x - 762) / 7) : 0;
    h.area.rect = (i, n = 1) => i === first
      ? { X: 762, Y: 94, Width: 0, Height: 13 }
      : i === text.length && n === 0 ? { X: 762, Y: 107, Width: 0, Height: 13 }
        : { X: 762 + i * 7, Y: 81, Width: 7, Height: 13 };
    h.area.lineRange = n => n === 0 ? { location: 0, length: first } : n === 1
      ? { location: first, length: newline.length } : n === 2 ? { location: text.length, length: 0 } : null;
    // The recorded 1440 x 1120 screenshot and 720 x 560 window convert these points to screen units.
    for (const [x, y] of [[24, 128], [20, 132]]) assert.equal(h.drop({ x: 752 + x / 2, y: 49 + y / 2 }, text), text.length);
  });
}

test('DPd propagates an AX timeout on a later blank row', () => {
  const h = fixture(), rect = h.area.rect;
  h.area.lineRange = n => {
    if (n === 2) throw Object.assign(Error('AX timeout'), { axCode: -25204 });
    return n === 1 ? { location: 4, length: 1 } : { location: 0, length: 4 };
  };
  h.area.rect = (i, n) => i === 4 ? { X: 10, Y: 120, Width: 0, Height: 14 } : rect(i, n);
  assert.throws(() => h.drop({ x: 20, y: 146 }, 'abc\n\n'), e => e.axCode === -25204);
});

for (const shape of ['missing bounds', 'nonempty row', 'overlapping row', 'discontinuous range', 'repeated empty range']) {
  test(`DPd refuses a later blank line with ${shape}`, () => {
    const h = fixture(), rect = h.area.rect;
    const text = shape === 'nonempty row' ? 'abc\nx\n' : 'abc\n\n';
    h.area.lineRange = n => n === 0 ? { location: 0, length: 4 } : n === 1
      ? { location: 4, length: shape === 'repeated empty range' ? 0 : shape === 'nonempty row' ? 2 : 1 }
      : n === 2 ? { location: shape === 'discontinuous range' ? 4 : text.length, length: 0 } : null;
    h.area.rect = (i, n) => i === 4 ? { X: 10, Y: shape === 'overlapping row' ? 100 : 120, Width: shape === 'nonempty row' ? 8 : 0, Height: 14 }
      : i === text.length ? shape === 'missing bounds' ? null : { X: 10, Y: 140, Width: 0, Height: 14 } : rect(i, n);
    assert.throws(() => h.drop({ x: 20, y: 146 }, text), /cannot find where the drop point falls/);
  });
}

test('DP7 refuses line spacing belonging to the current non-empty row', () => {
  const h = fixture(), rect = h.area.rect;
  h.area.rect = (i, n) => i === 0 && n === 4 ? { X: 10, Y: 100, Width: 24, Height: 34 } : rect(i, n);
  h.area.lineRange = n => n === 0 ? { location: 0, length: 4 } : null;
  assert.throws(() => h.drop({ x: 20, y: 126 }), /cannot find where the drop point falls/);
});

test('DP7 drops on an empty final line using its own AX range and caret row', () => {
  const h = fixture();
  assert.equal(h.drop({ x: 20, y: 126 }), 4);
  assert.ok(h.queries.some(([kind, n]) => kind === 'range' && n === 1));
});

for (const [name, y] of [['below the last line', 150], ['between lines', 117], ['above all lines', 95]]) {
  test(`DP7 refuses ${name}`, () => {
    assert.throws(() => fixture().drop({ x: 20, y }), /cannot find where the drop point falls/);
  });
}

test('DP7 off keeps the old refusal and makes no line-range queries', () => {
  const h = fixture(); vm.runInContext('dp7 = false', h.context);
  assert.throws(() => h.drop({ x: 20, y: 126 }), /cannot find where the drop point falls/);
  assert.deepEqual(h.queries, []);
});

test('DP7 rejects missing caret geometry and never swallows an AX timeout', () => {
  const h = fixture(), rect = h.area.rect;
  h.area.rect = (i, n) => i === 4 ? { X: 0, Y: 0, Width: 0, Height: 14 } : rect(i, n);
  assert.throws(() => h.drop({ x: 20, y: 126 }), /cannot find/);
  h.area.lineRange = () => { throw Object.assign(Error('AX timeout'), { axCode: -25204 }); };
  assert.throws(() => h.drop({ x: 20, y: 126 }), e => e.axCode === -25204);
});

function finalRangeFixture(text) {
  const h = fixture(), reads = [];
  h.area.bounds = () => ({ X: 757, Y: 81, Width: 700, Height: 520 });
  h.area.characterCount = () => { reads.push('count'); return 12; };
  h.area.indexAt = () => null;
  h.area.rect = (index, length = 1) => {
    reads.push([index, length]);
    return index === 11 && length === 1 ? { X: 833.5, Y: 81, Width: 0, Height: 13 }
      : index === 0 && length === 12 ? { X: 762, Y: 81, Width: 71.5, Height: 13 } : null;
  };
  h.area.value = () => assert.fail('drop geometry must never read document text');
  h.area.lineForIndex = () => 0;
  h.area.lineRange = () => ({ location: 0, length: 12 });
  return { ...h, reads, drop: p => h.context.dropIndex(h.area, p, text) };
}

for (const [x, y] of [[24, 104], [20, 100]]) {
  test(`WD3 resolves the recorded empty-final-line point ${x},${y} with metadata only`, () => {
    const h = finalRangeFixture();
    assert.equal(h.drop({ x: 752 + x / 2, y: 49 + y / 2 }), 12);
    assert.ok(h.reads.some(read => Array.isArray(read) && read[0] === 11 && read[1] === 1));
  });
}

test('WD3 also handles AX returning the sentinel first-character index or no-value error', () => {
  for (const indexAt of [() => 0, () => { throw Object.assign(Error('no AX value'), { axCode: -25212 }); }]) {
    const h = finalRangeFixture(); h.area.indexAt = indexAt;
    assert.equal(h.drop({ x: 762, y: 99 }), 12);
  }
});

for (const point of [{ x: 756, y: 99 }, { x: 1457, y: 99 }, { x: 762, y: 601 },
  { x: 762, y: 80 }, { x: 1000, y: 87 }, { x: 762, y: 93.5 }]) {
  test(`WD3 refuses outside or non-final-row point ${JSON.stringify(point)}`, () => {
    const h = finalRangeFixture();
    delete h.area.lineForIndex; delete h.area.lineRange;
    assert.throws(() => h.drop(point), /cannot find where the drop point falls/);
  });
}

for (const [name, change] of [
  ['no count', area => { area.characterCount = () => null; }],
  ['empty document', area => { area.characterCount = () => 0; }],
  ['fractional count', area => { area.characterCount = () => 11.5; }],
  ['no frame', area => { area.bounds = () => null; }],
  ['invalid frame', area => { area.bounds = () => ({ X: 757, Y: 81, Width: NaN, Height: 520 }); }],
  ['no last range', area => { area.rect = () => null; }],
  ['last range outside frame', area => { area.rect = () => ({ X: 756, Y: 81, Width: 0, Height: 13 }); }],
  ['zero-height last range', area => { area.rect = () => ({ X: 762, Y: 81, Width: 0, Height: 0 }); }],
  ['negative-width last range', area => { area.rect = () => ({ X: 762, Y: 81, Width: -1, Height: 13 }); }],
  ['nonfinite last range', area => { area.rect = () => ({ X: 762, Y: NaN, Width: 0, Height: 13 }); }],
]) {
  test(`WD3 refuses ambiguous final geometry: ${name}`, () => {
    const h = finalRangeFixture(); change(h.area);
    delete h.area.lineForIndex; delete h.area.lineRange;
    assert.throws(() => h.drop({ x: 762, y: 99 }), /cannot find where the drop point falls/);
  });
}

test('WD3 metadata and hit-test timeouts propagate before any fallback', () => {
  for (const method of ['indexAt', 'bounds', 'characterCount', 'rect', 'lineForIndex', 'lineRange']) {
    const h = finalRangeFixture();
    h.area[method] = () => { throw Object.assign(Error('AX timeout'), { axCode: -25204 }); };
    assert.throws(() => h.drop({ x: 762, y: 99 }), error => error.axCode === -25204);
  }
});

for (const text of ['short', 'destination\nextra']) {
  test(`WD4 refuses an end-of-text count that disagrees with supplied text: ${text.length}`, () => {
    assert.throws(() => finalRangeFixture(text).drop({ x: 762, y: 99 }), /cannot find where the drop point falls/);
  });
}

test('WD4 accepts a matching supplied text length', () => {
  assert.equal(finalRangeFixture('destination\n').drop({ x: 762, y: 99 }), 12);
});

test('WD4 refuses below an earlier column when the final line is in another column', () => {
  const h = finalRangeFixture(), rect = h.area.rect;
  h.area.rect = (i, n) => {
    const r = rect(i, n);
    return r && { ...r, X: r.X + 300 };
  };
  assert.throws(() => h.drop({ x: 762, y: 150 }), /cannot find where the drop point falls/);
  assert.equal(h.drop({ x: 1070, y: 150 }), 12);
});

for (const [name, change] of [
  ['missing line metadata', area => { delete area.lineForIndex; delete area.lineRange; }],
  ['multirow line bounds', area => {
    const rect = area.rect;
    area.rect = (i, n) => i === 0 && n === 12 ? { X: 762, Y: 81, Width: 400, Height: 100 } : rect(i, n);
  }],
]) {
  test(`WD4 refuses an append with ${name}`, () => {
    const h = finalRangeFixture(); change(h.area);
    assert.throws(() => h.drop({ x: 762, y: 150 }), /cannot find where the drop point falls/);
  });
}

function lineFixture({ final = false, newline = true, direction = 'ltr', bounds = true } = {}) {
  const h = fixture();
  if (bounds) h.area.bounds = () => ({ X: 10, Y: 100, Width: 300, Height: 100 });
  h.area.characterCount = () => final ? (newline ? 4 : 3) : 8;
  h.area.indexAt = p => p.y >= 100 && p.y < 114 && p.x >= 10 && p.x < 34
    ? direction === 'rtl' ? 2 - Math.floor((p.x - 10) / 8) : Math.floor((p.x - 10) / 8) : null;
  h.area.lineForIndex = i => i < 4 ? 0 : 1;
  h.area.lineRange = n => n === 0 ? { location: 0, length: newline ? 4 : 3 }
    : n === 1 && !final ? { location: 4, length: 4 } : null;
  h.area.rect = (i, n = 1) => {
    if (i === 0 && n === (newline ? 4 : 3)) return { X: 10, Y: 100, Width: 24, Height: 14 };
    if (i === 4 && n === 4 && !final) return { X: 10, Y: 130, Width: 24, Height: 14 };
    if (n === 0) {
      if (direction === 'unknown') return null;
      if (i === 0) return { X: direction === 'rtl' ? 34 : 10, Y: 100, Width: 0, Height: 14 };
      if (i === 3) return { X: direction === 'rtl' ? 10 : 34, Y: 100, Width: 0, Height: 14 };
      if (i === 4) return { X: 10, Y: 130, Width: 0, Height: 14 };
    }
    if (i < 3) return { X: 10 + (direction === 'rtl' ? 2 - i : i) * 8, Y: 100, Width: 8, Height: 14 };
    if (i === 3 && newline) return { X: direction === 'rtl' ? 10 : 34, Y: 100, Width: 0, Height: 14 };
    if (i === 7 && !final) return { X: 34, Y: 130, Width: 0, Height: 14 };
    return null;
  };
  h.area.value = () => assert.fail('line-end mapping must never read document text');
  h.area.lineEnd = () => newline ? 4 : 3;
  return { ...h, drop: (p, text) => h.context.dropIndex(h.area, p, text) };
}

for (const final of [false, true]) {
  for (const newline of [false, true]) {
    test(`WD4 maps right of a ${final ? 'final' : 'non-final'} line with newline=${newline} using geometry only`, () => {
      assert.equal(lineFixture({ final, newline }).drop({ x: 50, y: 107 }), 3);
    });
  }
  for (const direction of ['rtl', 'unknown']) {
    for (const bounds of [false, true]) {
      test(`WD4 refuses right of a ${final ? 'final' : 'non-final'} ${direction} line with bounds=${bounds}`, () => {
        assert.throws(() => lineFixture({ final, direction, bounds }).drop({ x: 50, y: 107 }, final ? 'abc\n' : 'abc\nxyz\n'),
          /cannot find where the drop point falls/);
      });
    }
  }
}

test('WD4 same-window move refuses an index outside the verified text before writing', () => {
  const h = fixture(), writes = [];
  Object.assign(h.area, {
    value: () => 'alpha beta', selection: () => ({ location: 0, length: 5 }), hasAttributes: () => false,
    indexAt: () => 20, rect: () => ({ X: 10, Y: 100, Width: 8, Height: 14 }),
    replace: (...args) => writes.push(args),
  });
  assert.throws(() => h.context.accessibilityMove(h.area, { text: 'alpha beta', selected: 'alpha' },
    { x: 11, y: 107 }, { id: 1, title: 'fixture' }), /drop index is outside destination text/);
  assert.deepEqual(writes, []);
});

test('WD4 a stale character count cannot block an independently proven line end', () => {
  const h = lineFixture();
  h.area.characterCount = () => 99;
  assert.equal(h.context.dropIndex(h.area, { x: 50, y: 107 }, 'abc\nxyz\n'), 3);
});

test('WD3 refuses the zero-origin sentinel even within a text-area frame', () => {
  const h = finalRangeFixture();
  h.area.bounds = () => ({ X: 0, Y: 0, Width: 100, Height: 100 });
  h.area.rect = () => ({ X: 0, Y: 0, Width: 0, Height: 13 });
  delete h.area.lineForIndex; delete h.area.lineRange;
  assert.throws(() => h.drop({ x: 20, y: 30 }), /cannot find where the drop point falls/);
});

test('WD3 does not treat other AX hit-test failures as an empty hit', () => {
  const h = finalRangeFixture(), error = Object.assign(Error('invalid AX argument'), { axCode: -25202 });
  h.area.indexAt = () => { throw error; };
  assert.throws(() => h.drop({ x: 762, y: 99 }), actual => actual === error);
});
