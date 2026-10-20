// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
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

async function hostContext() {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../bench/xl1-probe-host.js', import.meta.url), 'utf8');
  const context = { ObjC: { import() {} } };
  runInNewContext(source, context);
  return context;
}
const fixture = `${MAC_TMP}/sleight-xl1-AbC123/XL1-A-1.xlsx`;
const urlForms = [`file://${MAC_TMP}/sleight-xl1-AbC123/XL1-A-1.xlsx`, 'file:///tmp/sleight-xl1-AbC123/XL1-A-1.xlsx',
  'file:///tmp/sleight-xl1-AbC123/XL1-A-1.xlsx/', `file://localhost${MAC_TMP}/sleight-xl1-AbC123/XL1%2DA%2D1.xlsx`,
  `file://${MAC_TMP}//sleight-xl1-AbC123/XL1-A-1.xlsx`];
const others = [`file://${MAC_TMP}/sleight-xl1-AbC123/XL1-A-2.xlsx`, `file://${MAC_USERS}someone/Book1.xlsx`,
  `file://${MAC_TMP}/sleight-xl1-AbC123/XL1-A-1.xlsx.bak`, `https://example.com${MAC_TMP}/sleight-xl1-AbC123/XL1-A-1.xlsx`, null];

test('host and probe compare resolved file paths, tolerating /private, slashes and percent-encoding', async () => {
  const context = await hostContext();
  const { fileUrlPath, normalPath } = await load();
  for (const url of urlForms) {
    assert.equal(context.filePath(url), context.normalPath(fixture), url);
    assert.equal(fileUrlPath(url), normalPath(fixture), url);
  }
  for (const url of others) {
    assert.notEqual(context.filePath(url), context.normalPath(fixture), String(url));
    assert.notEqual(fileUrlPath(url), normalPath(fixture), String(url));
  }
});

const win = (fields) => ({ indicator: false, role: 'AXWindow', subrole: 'AXStandardWindow', width: 800, height: 600, document: null, ...fields });

test('the owned window is the single window whose document is the fixture; panels and the capture indicator are ignored', async () => {
  const { chooseOwnedWindow } = await hostContext();
  const owned = win({ document: urlForms[1] });
  const infos = [win({ indicator: true, subrole: 'AXUnknown', width: 40, height: 20 }), win({ subrole: 'AXFloatingWindow', width: 300 }),
    owned, win({ subrole: 'AXUnknown', width: 1, height: 1 })];
  assert.equal(chooseOwnedWindow(infos, fixture, true).index, 2);
  assert.equal(chooseOwnedWindow(infos, fixture, false).index, 2);
});

test('a second document window, a missing fixture window or an app dialog refuses input with a content-free diagnostic', async () => {
  const { chooseOwnedWindow } = await hostContext();
  const owned = win({ document: urlForms[0] });
  const cases = [
    [[owned, win({ document: `file://${MAC_USERS}someone/Secret%20Plan.xlsx` })], /Foreign or ambiguous app window; no input sent/],
    [[owned, win({})], /Foreign or ambiguous app window; no input sent/],
    [[owned, win({ document: urlForms[1] })], /Foreign or ambiguous app window; no input sent/],
    [[win({ document: `file://${MAC_TMP}/sleight-xl1-AbC123/XL1-B-1.xlsx` })], /Owned workbook window not found; no input sent/],
    [[win({ subrole: 'AXFloatingWindow' })], /Owned workbook window not found; no input sent/],
    [[owned, win({ subrole: 'AXDialog' })], /Unexpected app dialog; no input sent/],
  ];
  for (const [infos, message] of cases) {
    const choice = chooseOwnedWindow(infos, fixture, true);
    assert.equal(choice.index, undefined);
    assert.match(choice.error, message);
    assert.equal(choice.windows.length, infos.length);
    for (const entry of choice.windows) {
      assert.deepEqual(Object.keys(entry).sort(), ['hasDocument', 'height', 'indicator', 'owned', 'role', 'subrole', 'width']);
    }
    assert.doesNotMatch(JSON.stringify(choice.windows), /Secret|someone|xlsx|file:/);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(chooseOwnedWindow(cases[0][0], fixture, true).windows)), [
    { role: 'AXWindow', subrole: 'AXStandardWindow', width: 800, height: 600, hasDocument: true, owned: true, indicator: false },
    { role: 'AXWindow', subrole: 'AXStandardWindow', width: 800, height: 600, hasDocument: true, owned: false, indicator: false }]);
  // Cleanup still finds the owned window beside a foreign document (it answers only that window's sheet).
  assert.equal(chooseOwnedWindow(cases[0][0], fixture, false).index, 0);
  assert.equal(chooseOwnedWindow(cases[2][0], fixture, false).index, undefined);
});

test('a host refusal carries its diagnostic out of checkHost', async () => {
  const { checkHost } = await load();
  assert.deepEqual(checkHost({ ok: true, pid: 4 }), { ok: true, pid: 4 });
  const error = (() => { try { checkHost({ ok: false, error: 'Owned workbook window not found; no input sent', windows: [{ owned: false }] }); } catch (e) { return e; } })();
  assert.match(error.message, /not found/);
  assert.deepEqual(error.details, { windows: [{ owned: false }] });
});

test('cleanup always asks the owned process to quit after a trial error and records what it left', async () => {
  const { cleanupFixture } = await load();
  const calls = [], records = [];
  const persist = async record => { records.push(record); };
  const owned = { path: fixture, started: 1, front: 2, pid: 9, birth: 3 };
  // The engine client fails to close; quit is still attempted and its refusal is recorded with the windows left.
  const refusal = Object.assign(new Error('Excel normal exit unconfirmed; retaining fixture and lock'),
    { details: { exited: false, left: { windows: [{ role: 'AXWindow', owned: true }] } } });
  await assert.rejects(cleanupFixture({ client: { close: async () => { calls.push('close'); throw new Error('pipe closed'); } }, owned,
    pointer: { x: 1, y: 2 }, persist, host: async (op, extra) => { calls.push(op); assert.deepEqual(extra, { pointer: { x: 1, y: 2 } }); throw refusal; } }),
  /exit unconfirmed/);
  assert.deepEqual(calls, ['close', 'quit']);
  assert.equal(records.at(-1).phase, 'cleanup');
  assert.equal(records.at(-1).exited, false);
  assert.deepEqual(records.at(-1).left, { windows: [{ role: 'AXWindow', owned: true }] });
  // A confirmed exit returns no remaining fixture; an engine close error is still reported.
  calls.length = 0;
  await assert.rejects(cleanupFixture({ client: { close: async () => { throw new Error('pipe closed'); } }, owned, pointer: { x: 1, y: 2 }, persist,
    host: async op => { calls.push(op); return { ok: true, exited: true, pointerRestored: true }; } }), /pipe closed/);
  assert.equal(records.at(-1).exited, true);
  assert.equal(await cleanupFixture({ owned, pointer: {}, persist, host: async () => ({ ok: true, exited: true, pointerRestored: true }) }), undefined);
  // An unbound launch binds first so quit can prove identity.
  calls.length = 0;
  const unbound = { path: fixture, started: 1, front: 2 };
  assert.equal(await cleanupFixture({ owned: unbound, pointer: {}, persist, host: async op => {
    calls.push(op); return op === 'bind' ? { ok: true, pid: 9, birth: 3 } : { ok: true, exited: true, pointerRestored: true }; } }), undefined);
  assert.deepEqual(calls, ['bind', 'quit']);
  assert.equal(unbound.pid, 9);
  assert.equal(await cleanupFixture({ persist, host: async () => assert.fail('no fixture') }), undefined);
});
