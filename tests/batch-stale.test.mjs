import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createBrowserStaleGuard } from '../plugins/sleight/lib/browser-stale.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';

test('literal extraction keeps repeated targets and excludes examples and computed numbers', () => {
  assert.deepEqual(literalElements(`await app.click(5); var example = 'app.click(90)';
    // await app.click(91);
    await app.setValue(6, 'text'); await app.click(5); await app.click(computed);`), [5, 6, 5]);
  assert.deepEqual(literalElements('await app.click(5); var example = `app.click(6)`;'), [5]);
  assert.deepEqual(literalElements('await app.click(5); var opaque = `${computed}`;'), []);
});

for (const browser of [false, true]) {
  const kind = browser ? 'tab' : 'window';
  const header = browser ? 'Browser tab: 1, Title: "Calendar", URL: "https://example.test".' : 'Window: "Calendar", App: Fixture.';
  const tree = rows => `${header}\n0 ${browser ? 'AXWebArea' : 'standard window'} Calendar\n` + rows.map(([n, label]) => `\t${n} button ${label}`).join('\n');
  const original = [[10, 'Open'], [11, 'June 4'], [12, 'June 9']];
  function fixture(snapshots, before = original) {
    let read = 0;
    const clicked = [], output = [];
    const raw = { id: '1', getAXState: async () => tree(snapshots[Math.min(read++, snapshots.length - 1)]),
      click: async n => clicked.push(n) };
    const context = { app: raw, cua: { getApp: async () => raw, getTab: async () => raw },
      nodeRepl: { write: s => output.push(s) }, setTimeout, clearTimeout };
    const code = 'await app.click(10); await app.click(11); await app.click(12);';
    let wrapped;
    if (browser) {
      const guard = createBrowserStaleGuard();
      guard.observe([{ type: 'text', text: tree(before) }]);
      wrapped = guard.code('var app = await cua.getTab("1", { browser: "fixture" });' + code);
    } else wrapped = guardedCode(code, { title: 'Calendar', app: 'Fixture', url: null }, undefined, undefined,
      { seenLines: Object.fromEntries(before.map(([n, label]) => [n, 'button ' + label])),
        uniqueSeen: before.filter(([, label]) => before.filter(([, other]) => label === other).length === 1).map(([n]) => n), literals: [10, 11, 12] });
    return { clicked, output, run: () => runInNewContext(`(async () => { ${wrapped} })()`, context) };
  }

  test(`${kind}: distinct date literals survive multiple re-renders in one call`, async () => {
    for (let i = 0; i < 20; i++) {
      const n = 20 + i * 10;
      const f = fixture([original, [[n, 'June 4'], [n + 1, 'June 9']], [[n + 5, 'June 9']]]);
      await f.run();
      assert.deepEqual(f.clicked, [10, n, n + 5]);
    }
  });

  test(`${kind}: a renumber before the first action remaps every remaining literal`, async () => {
    const shifted = [[20, 'Open'], [21, 'June 4'], [22, 'June 9']];
    const f = fixture([shifted]);
    await f.run();
    assert.deepEqual(f.clicked, [20, 21, 22]);
  });

  for (const [name, shifted] of [
    ['same-label ambiguity', [[21, 'June 4'], [22, 'June 9'], [23, 'June 9']]],
    ['same-label ambiguity on an unchanged later number', [[21, 'June 4'], [12, 'June 9'], [23, 'June 9']]],
    ['missing later date', [[21, 'June 4']]],
  ]) test(`${kind}: ${name} stops before any remaining input`, async () => {
    const f = fixture([original, shifted]);
    await assert.rejects(f.run(), /sleight stopped before/);
    assert.deepEqual(f.clicked, [10]);
  });

  test(`${kind}: duplicate old labels cannot become a unique binding`, async () => {
    const before = [...original, [13, 'June 9']];
    const f = fixture([before, [[21, 'June 4'], [22, 'June 9']]], before);
    await assert.rejects(f.run(), /sleight stopped before/);
    assert.deepEqual(f.clicked, [10]);
  });
}

for (const ambiguous of [false, true]) test(`bound native capture recovery checks every remaining literal, ambiguity=${ambiguous}`, async () => {
  const header = 'Window: "Calendar", App: Fixture.\n0 standard window Calendar\n';
  let stale = false, reads = 0, changed = false;
  const clicked = [];
  const before = '\t10 button First\n\t11 button June 4\n\t12 button June 9';
  const after = '\t21 button June 4\n\t22 button June 9' + (ambiguous ? '\n\t23 button June 9' : '');
  const raw = {
    getAXState: async () => { stale = false; reads++; return header + (changed ? after : before); },
    click: async n => {
      if (stale) throw new Error(`${n} is an invalid element ID`);
      clicked.push(n); changed = true; stale = true;
    },
  };
  const code = guardedCode('await app.click(10); await app.click(11); await app.click(12);',
    { title: 'Calendar', app: 'Fixture', url: null }, undefined, undefined, { bind: true,
      seenLines: { 10: 'button First', 11: 'button June 4', 12: 'button June 9' }, uniqueSeen: [10, 11, 12], literals: [10, 11, 12] });
  const run = runInNewContext(`(async () => { ${code} })()`, {
    app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout,
  });
  if (ambiguous) {
    await assert.rejects(run, /invalid element ID/);
    assert.deepEqual(clicked, [10]);
  } else {
    await run;
    assert.deepEqual(clicked, [10, 21, 22]);
    assert.equal(reads, 4);
  }
});
