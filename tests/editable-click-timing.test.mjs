import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const window = { title: 'Draft', app: 'Fixture Editor', url: null };
function fixture({ role = 'text field', readDelay = 0, onWait = () => {}, failClick = false } = {}) {
  let now = 1000, reads = 0;
  const events = [], waits = [];
  const raw = {
    getAXState: async () => {
      if (++reads === 2) now += readDelay;
      return `Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 ${role} Description: Query, ID: query`;
    },
    click: async () => { now += 80; events.push(['click', now]); if (failClick) throw Error('click failed'); },
    typeText: async text => { events.push(['typeText', now, text]); return 'typed'; },
    paste: async text => { events.push(['paste', now, text]); return 'pasted'; },
    pressKey: async key => events.push(['key', now, key]),
  };
  const context = createContext({ app: raw, other: { ...raw }, cua: { getApp: async () => raw },
    performance: { now: () => now }, nodeRepl: { write() {} },
    setTimeout: (resolve, ms) => { waits.push(ms); now += ms; onWait(); resolve(); } });
  const run = (code, options = {}, lease) => runInContext(`(async () => { ${guardedCode(code, window, undefined, lease, options)} })()`, context,
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, context, events, waits };
}

for (const role of ['text field', 'text area', 'text entry area', 'search field', 'search text field', 'combo box']) {
  for (const method of ['typeText', 'paste']) test(`${method} waits for a completed ${role} click to settle`, async () => {
    const f = fixture({ role });
    await f.run(`await app.click(1); const result = await app.${method}("query"); if (result !== "${method === 'paste' ? 'pasted' : 'typed'}") throw Error('lost return value');`, { quietEdits: true });
    assert.deepEqual(f.waits, [250]);
    assert.equal(f.events[1][1] - f.events[0][1], 250, 'delay starts when the click returns');
  });
}

for (const selector of ['{ id: "query" }', '{ label: "Query" }', '"Query"']) {
  test(`resolved editable selector ${selector} also settles before input`, async () => {
    const f = fixture();
    await f.run(`await app.click(${selector}); await app.typeText("query");`, { quietEdits: true });
    assert.deepEqual(f.waits, [250]);
  });
}

for (const readDelay of [70, 135, 300]) test(`a ${readDelay} ms guard read counts toward the settling interval`, async () => {
  const f = fixture({ readDelay });
  await f.run('await app.click(1); await app.paste("query");', { careful: true });
  assert.deepEqual(f.waits, readDelay < 250 ? [250 - readDelay] : []);
  assert.equal(f.events[1][1] - f.events[0][1], Math.max(250, readDelay));
});

for (const role of ['button Description: text field', 'tab', 'static text']) test(`${role} does not add a settling delay`, async () => {
  const f = fixture({ role });
  await f.run('await app.click(1); await app.typeText("query");');
  assert.deepEqual(f.waits, []);
});

test('coordinates, another handle, another call and an intervening key do not reuse an editable click', async () => {
  for (const code of ['await app.click([1, 2]); await app.typeText("query");',
    'const other = await cua.getApp("fixture"); await app.click(1); await other.typeText("query");',
    'await app.click(1); await app.pressKey("Tab"); await app.typeText("query");']) {
    const f = fixture();
    // The second handle must be distinct even when its window identity matches.
    f.context.cua.getApp = async () => f.context.other;
    await f.run(code);
    assert.deepEqual(f.waits, []);
  }
  const f = fixture();
  await f.run('await app.click(1);');
  await f.run('await app.typeText("query");', { reuseSetup: true });
  assert.deepEqual(f.waits, []);
});

test('only the first text action after the click waits, and a failed click never qualifies', async () => {
  const f = fixture();
  await f.run('await app.click(1); await app.typeText("one"); await app.paste("two");', { quietEdits: true });
  assert.deepEqual(f.waits, [250]);
  const failed = fixture({ failClick: true });
  await failed.run('try { await app.click(1); } catch {} await app.typeText("query");', { quietEdits: true });
  assert.deepEqual(failed.waits, []);
});

for (const loss of ['takeover', 'expiry']) test(`lease ${loss} during settling stops the text action`, async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-editable-click-')));
  t.after(() => removeTemp(directory));
  const path = join(directory, 'lease.json');
  const record = { token: 'owned', expires: Date.now() + 60000 };
  writeFileSync(path, JSON.stringify(record));
  const f = fixture({ onWait: () => writeFileSync(path, JSON.stringify(loss === 'takeover'
    ? { ...record, token: 'new-owner' } : { ...record, expires: 0 })) });
  await assert.rejects(f.run('await app.click(1); await app.typeText("query");', { quietEdits: true }, { path, token: 'owned' }), /ownership lost or expired/);
  assert.deepEqual(f.waits, [250]);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
  assert.deepEqual(Array.from(f.context.__sleightDocumentGuard.typed), [], 'no typed receipt before sending input');
});
