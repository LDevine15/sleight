import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../bench/xl1-probe.mjs');

test('tab snapshots preserve order, selected state, and numbered click targets', async () => {
  const { sheetTabs } = await load();
  const state = 'Window: "XL1-A-1", App: Microsoft Excel.\n0 standard window XL1-A-1\n' +
    '\t4 layout area Content Area, Description: Workbook area, Review\n' +
    '\t\t7 button Fixture, , Used range: A1 to A1, Description: Fixture, Help: Press to make this sheet active\n' +
    '\t\t8 button Selected, Review, , Blank sheet, Description: Review, Help: Press to make this sheet active\n' +
    '\t\t9 button New Sheet, ID: addBlankSheetButton';
  assert.deepEqual(sheetTabs(state), [{ number: 7, name: 'Fixture', selected: false }, { number: 8, name: 'Review', selected: true }]);
  assert.throws(() => sheetTabs(state.replace('Selected, Review', 'Review')), /selection/);
});

test('each arm prepares a new renamed sheet and samples the pointer immediately before its action', async () => {
  const { runTrials } = await load();
  const events = [], before = [{ number: 7, name: 'Fixture', selected: false }, { number: 8, name: 'Review', selected: true }];
  let trial;
  const rows = await runTrials({
    prepare: async (arm, index) => { trial = `${arm}${index}`; events.push(trial + ':prepare'); return before; },
    sample: async () => { events.push(trial + ':sample'); return { leftDown: false, pointer: { x: 100, y: 200 } }; },
    balance: async () => events.push(trial + ':balance'),
    park: async () => events.push(trial + ':park'),
    sleep: async ms => events.push(trial + ':wait' + ms),
    act: async (method, target) => { events.push(trial + ':' + method); assert.equal(target, 7); return before; },
    read: async () => before,
    cleanup: async () => events.push(trial + ':cleanup'),
    record: async () => {},
  });
  assert.equal(rows.length, 15);
  for (const arm of ['A', 'B', 'C', 'D', 'E']) for (let i = 1; i <= 3; i++) {
    const prefix = `${arm}${i}:`;
    assert.deepEqual(events.filter(event => event.startsWith(prefix)).map(event => event.slice(prefix.length)),
      ['prepare', ...(arm === 'B' ? ['balance'] : arm === 'C' ? ['wait500'] : arm === 'E' ? ['park'] : []),
        'sample', arm === 'D' ? 'press' : 'click', 'cleanup']);
  }
  assert.equal(rows[0].beforeClick.pointer.x, 100);
  assert.deepEqual(rows[0].after, before);
  assert.deepEqual(rows[0].nextRead, before);
});

test('a failed action still cleans its fixture and stops subsequent trials', async () => {
  const { runTrials } = await load();
  let cleanups = 0, preparations = 0;
  await assert.rejects(runTrials({
    prepare: async () => { preparations++; return [{ number: 7, name: 'Fixture', selected: false }, { number: 8, name: 'Review', selected: true }]; },
    sample: async () => ({ leftDown: true, pointer: { x: 0, y: 5 } }),
    act: async () => { throw new Error('action stopped'); },
    cleanup: async () => { cleanups++; }, record: async () => {},
  }), /action stopped/);
  assert.equal(cleanups, 1);
  assert.equal(preparations, 1);
});

test('the probe grants only its exact allowlisted native app and supported session forms', async () => {
  const { probeApproval } = await load();
  const message = app => `Allow Computer Use to use "${app}"?`;
  for (const app of ['Microsoft Excel', 'Excel', 'com.microsoft.Excel']) {
    assert.deepEqual(probeApproval({ message: message(app) }), { action: 'accept', content: {} });
    assert.deepEqual(probeApproval({ message: message(app), requestedSchema: { properties: { choice: { enum: ['once', 'session'] } } } }),
      { action: 'accept', content: { choice: 'session' } });
  }
  for (const value of [message('Microsoft Excel copy'), message('ChatGPT'), message('System Settings'),
    'Allow Computer Use to read notifications?', 'Allow Claude to drag in Microsoft Excel? It moves the pointer.']) {
    assert.deepEqual(probeApproval({ message: value }), { action: 'decline' });
  }
  assert.deepEqual(probeApproval({ message: message('Microsoft Excel'), requestedSchema: { properties: { choice: { enum: ['always'] } } } }),
    { action: 'decline' });
});

test('cleanup waits for the same answered sheet but rejects a replacement or an extra sheet', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../bench/xl1-probe-host.js', import.meta.url), 'utf8');
  // Loading function definitions is inert; no JXA run() or native APIs are called.
  const context = { ObjC: { import() {} } };
  runInNewContext(source, context);
  const sheet = {}, other = {}, same = (a, b) => a === b;
  assert.equal(context.cleanupSheetStep([sheet], null, same), 'answer');
  assert.equal(context.cleanupSheetStep([sheet], sheet, same), 'wait');
  assert.equal(context.cleanupSheetStep([], sheet, same), 'none');
  assert.throws(() => context.cleanupSheetStep([other], sheet, same), /Unexpected cleanup sheet/);
  assert.throws(() => context.cleanupSheetStep([sheet, other], sheet, same), /Unexpected cleanup sheet/);
});
