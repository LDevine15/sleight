import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { guardedCode, elementParents } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
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
        seenParents: Object.fromEntries(elementParents(tree(before))),
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
      seenLines: { 10: 'button First', 11: 'button June 4', 12: 'button June 9' }, uniqueSeen: [10, 11, 12], literals: [10, 11, 12],
      seenParents: { 10: 'standard window Calendar', 11: 'standard window Calendar', 12: 'standard window Calendar' } });
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

// Review of X5: a resend after a refused stale ID goes to an element of the fresh tree, and the payment gate decides there.
// The call's tree showed no payment; the fresh one is the checkout with "Pay now" under the same kind of parent.
const checkout = readFileSync(new URL('./fixtures/payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8')
  .split('\n').filter(line => !/^\t*(?:89|9[0-7]) /.test(line)).join('\n');
for (const [target, resent] of [['button Pay now', null], ['radio button Standard 5–7 business days · Free, Value: 0', 59]]) test(`bound refusal resend to ${target.split(' ').slice(0, 3).join(' ')} on the fresh checkout ${resent ? 'goes' : 'stops at the payment gate'}`, async () => {
  const cart = `Window: "Checkout · Northbound Supply", App: Firefox.\n0 standard window Checkout · Northbound Supply\n\t1 HTML content Cart\n\t\t2 button Add gift wrap\n\t\t3 container\n\t\t\t4 ${target}`;
  let acted = false;
  const clicked = [], output = [];
  const raw = { getAXState: async () => acted ? checkout : cart,
    click: async n => { if (acted && n === 4) throw new Error('4 is an invalid element ID'); clicked.push(n); acted = true; } };
  const code = guardedCode('await app.click(2); await app.click(4);', { title: 'Checkout · Northbound Supply', app: 'Firefox', url: null }, undefined, undefined,
    { bind: true, payment: { setting: 'requested', message: null, spent: null, allow: null, now: 1e6 },
      seenLines: { 2: 'button Add gift wrap', 4: target }, seenParents: { 2: 'HTML content Cart', 4: 'container' }, uniqueSeen: [2, 4], literals: [2, 4] });
  const run = runInNewContext(`(async () => { ${code} })()`, { app: raw, cua: { getApp: async () => raw },
    nodeRepl: { write: s => output.push(s) }, setTimeout, clearTimeout, performance });
  if (resent) {
    await run;
    assert.deepEqual(clicked, [2, resent]);
  } else {
    await assert.rejects(run, /sleight stopped this payment: the page shows \$268\.00 and sleight has no copy/);
    assert.deepEqual(clicked, [2]);
  }
});

// Review of X5: "button 15" under October and "button 15" under November are different days.
const calendar = months => 'Window: "Cal", App: Fixture.\n0 standard window Cal\n\t1 button Go\n' +
  months.map(([n, month, days]) => `\t${n} group ${month}\n` + days.map(([d, label]) => `\t\t${d} button ${label}`).join('\n')).join('\n');
const calBefore = calendar([[2, 'October', [[3, '15'], [4, '16']]], [5, 'November', [[6, '20']]]]);
for (const [name, after, expected] of [
  ['a parentless line that moved to another parent stops', calendar([[2, 'November', [[3, '14'], [4, '15'], [5, '16b']]]]), [1]],
  ['identical lines under the same parent still follow the renumber', calendar([[2, 'September', [[3, '1']]], [4, 'October', [[5, '15'], [6, '16']]]]), [1, 5]],
]) test(`window: ${name}`, async () => {
  let acted = false;
  const clicked = [];
  const raw = { getAXState: async () => acted ? after : calBefore, click: async n => { clicked.push(n); acted = true; } };
  const code = guardedCode('await app.click(1); await app.click(3);', { title: 'Cal', app: 'Fixture', url: null }, undefined, undefined,
    { seenLines: { 1: 'button Go', 3: 'button 15' }, seenParents: Object.fromEntries(elementParents(calBefore)), uniqueSeen: [1, 3], literals: [1, 3] });
  const run = runInNewContext(`(async () => { ${code} })()`, { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout, performance });
  if (expected.length === 1) await assert.rejects(run, /sleight stopped before click\(3\)/); else await run;
  assert.deepEqual(clicked, expected);
});

test('bound refusal recovery also needs the parent Claude saw', async () => {
  let acted = false;
  const clicked = [];
  const after = calendar([[2, 'November', [[3, '14'], [4, '15'], [5, '16b']]]]);
  const raw = { getAXState: async () => acted ? after : calBefore,
    click: async n => { if (acted && n === 3) throw new Error('3 is an invalid element ID'); clicked.push(n); acted = true; } };
  const code = guardedCode('await app.click(1); await app.click(3);', { title: 'Cal', app: 'Fixture', url: null }, undefined, undefined,
    { bind: true, seenLines: { 1: 'button Go', 3: 'button 15' }, seenParents: Object.fromEntries(elementParents(calBefore)), uniqueSeen: [1, 3], literals: [1, 3] });
  await assert.rejects(runInNewContext(`(async () => { ${code} })()`, { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout, performance }), /invalid element ID/);
  assert.deepEqual(clicked, [1]);
});

test('the compactor reports the parent line Claude saw for each number', () => {
  const c = createReadCompactor();
  c.process([{ type: 'text', text: calBefore }]);
  assert.deepEqual(c.seenParents({ title: 'Cal', app: 'Fixture', url: null }, [0, 1, 3, 6]),
    { 0: null, 1: 'standard window Cal', 3: 'group October', 6: 'group November' });
  assert.deepEqual(Object.fromEntries(elementParents(calBefore)), c.seenParents({ title: 'Cal', app: 'Fixture', url: null }));
});

for (const [name, after, expected] of [
  ['a parentless row that moved to another parent stops', [[2, 'November', [[3, '14'], [4, '15'], [5, '16b']]]], []],
  ['identical rows under the same parent still follow the renumber', [[2, 'September', [[3, '1']]], [4, 'October', [[5, '15'], [6, '16']]]], [1, 5]],
]) test(`tab: ${name}`, async () => {
  const tab = months => calendar(months).replace('Window: "Cal", App: Fixture.\n0 standard window Cal', 'Browser tab: 1, Title: "Cal", URL: "https://example.test".\n0 AXWebArea Cal');
  const before = tab([[2, 'October', [[3, '15'], [4, '16']]], [5, 'November', [[6, '20']]]]);
  let acted = false;
  const clicked = [];
  const raw = { id: '1', getAXState: async () => acted ? tab(after) : before, click: async n => { clicked.push(n); acted = true; } };
  const guard = createBrowserStaleGuard();
  guard.observe([{ type: 'text', text: before }]);
  const code = guard.code('var app = await cua.getTab("1", { browser: "fixture" }); await app.click(1); await app.click(3);');
  const run = runInNewContext(`(async () => { ${code} })()`, { cua: { getTab: async () => raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout });
  if (!expected.length) await assert.rejects(run, /sleight stopped before click\(3\): element 3/); else await run;
  assert.deepEqual(clicked, expected.length ? expected : [1]);
});

// Review of X5: one tab's batch held another tab's literals, and two tabs could each recover from a shared list.
test('tab: literals on two tabs in one call never recover a renumber', async () => {
  const page = (id, rows) => `Browser tab: ${id}, Title: "T${id}", URL: "https://example.test/${id}".\n0 AXWebArea T${id}\n` + rows.map(([n, l]) => `\t${n} button ${l}`).join('\n');
  const tabs = {}, clicked = [];
  for (const id of ['1', '2']) {
    let acted = false;
    const before = page(id, [[10, 'A' + id], [11, 'B' + id]]), after = page(id, [[20, 'A' + id], [21, 'B' + id]]);
    tabs[id] = { before, raw: { id, getAXState: async () => acted ? after : before, click: async n => { clicked.push(id + ':' + n); acted = true; } } };
  }
  const guard = createBrowserStaleGuard();
  guard.observe([{ type: 'text', text: tabs['1'].before }, { type: 'text', text: tabs['2'].before }]);
  const code = guard.code('var a = await cua.getTab("1", { browser: "f" }); var b = await cua.getTab("2", { browser: "f" }); await a.click(10); await b.click(11); await b.click(10);');
  await assert.rejects(runInNewContext(`(async () => { ${code} })()`, { cua: { getTab: async id => tabs[id].raw }, nodeRepl: { write() {} }, setTimeout, clearTimeout }), /sleight stopped before click\(10\): element/);
  assert.deepEqual(clicked, ['1:10', '2:11']);
});
