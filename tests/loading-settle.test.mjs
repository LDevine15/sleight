import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { settleLoading } from '../plugins/sleight/lib/loading-settle.mjs';

const header = 'Window: "Dependent", App: Fixture.';
const tree = row => `${header}\n0 standard window Dependent\n\t1 pop up button Parent\n\t${row}`;
const ready = tree('2 pop up button Choose an option');
const loading = tree('2 pop up button (disabled) Loading options…');

function fixture(states, { before = ready, readMs = 0 } = {}) {
  let acted = false, now = 0, index = 0;
  const output = [], delays = [], clicks = [];
  const raw = {
    getAXState: async () => { now += readMs; return acted ? states[Math.min(index++, states.length - 1)] : before; },
    click: async n => { clicks.push(n); acted = true; },
  };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: s => output.push(s) },
    performance: { now: () => now },
    setTimeout: (fn, ms) => setImmediate(() => { delays.push(ms); now += ms; fn(); }), clearTimeout: clearImmediate };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, { title: 'Dependent', app: 'Fixture', url: null })} })()`, context);
  return { run, output, delays, clicks, get now() { return now; }, get reads() { return index; } };
}

test('a parent selection returns the settled dependent control without another caller read', async () => {
  const f = fixture([loading, loading, ready]);
  await f.run('await app.click(1);');
  assert.equal(f.output.join('').includes(loading), false);
  assert.match(f.output.join(''), /pop up button Choose an option/);
  assert.deepEqual(f.delays, [300, 300]);
  await f.run('await app.click(2);');
  assert.deepEqual(f.clicks, [1, 2]);
});

test('an explicit trailing read also returns the settled tree', async () => {
  const f = fixture([loading, ready]);
  await f.run('await app.click(1); globalThis.observed = await app.getAXState();');
  assert.deepEqual(f.delays, [300]);
  assert.doesNotMatch(f.output.join(''), /Loading options/);
});

for (const row of ['2 busy indicator Updating', '2 progress indicator Fetching', '2 progress bar Fetching']) {
  test(`changed ${row} settles without loading text`, async () => {
    const f = fixture([tree(row), ready]);
    await f.run('await app.click(1);');
    assert.deepEqual(f.delays, [300]);
    assert.match(f.output.join(''), /Choose an option/);
  });
}

test('a control still loading at 1.5 seconds returns its latest tree', async () => {
  const f = fixture([loading]);
  await f.run('await app.click(1);');
  assert.equal(f.now, 1500);
  assert.equal(f.reads, 6);
  assert.match(f.output.join(''), /Loading options/);
});

test('settling counts read time toward its 1.5 second budget', async () => {
  const f = fixture([loading], { readMs: 200 });
  await f.run('await app.click(1);');
  assert.ok(f.delays.length > 0);
  assert.ok(f.now <= 1900, 'initial reads plus the bounded polling budget');
});

test('an engine read already in flight finishes even when the polling deadline passes', async () => {
  let now = 0, finish, resolved = false, reads = 0;
  const read = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const pending = settleLoading(read, ready, loading, text => text.split('\n')[0], () => now).then(text => { resolved = true; return text; });
  // The helper's first 300 ms wait completes before its controlled engine read.
  await new Promise(resolve => setTimeout(resolve, 320));
  now = 2000;
  assert.equal(reads, 1);
  assert.equal(resolved, false, 'IN2 forbids abandoning a read at the deadline');
  finish(ready);
  assert.equal(await pending, ready);
  assert.equal(reads, 1);
});

for (const [name, before, after] of [
  ['unchanged loading control', loading, loading],
  ['enabled text mentioning loading', ready, tree('2 button Loading guide')],
  ['unrelated existing progress control', ready + '\n\t3 progress indicator Sync', ready.replace('Parent', 'Selected') + '\n\t3 progress indicator Sync'],
  ['different window', ready, loading.replace('Dependent",', 'Other",')],
]) test(`${name} adds no polling`, async () => {
  const f = fixture([after], { before });
  await f.run('await app.click(1);');
  assert.deepEqual(f.delays, []);
});
