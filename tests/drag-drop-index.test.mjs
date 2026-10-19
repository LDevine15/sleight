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
  return { context, area, queries, drop: p => context.dropIndex(area, p, 'abc\n') };
}

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
