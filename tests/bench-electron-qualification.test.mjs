// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  APPS, CELLS, RELAUNCH_CELLS, backgroundEvidence, cellsFor, main, parseArgs, percentile, prepareWorkspace, relaunchCellsFor, requiredCells, runQualification,
  scrubReceipt, timingSummary, validateReceipt,
} from '../bench/electron-qualification.mjs';
import { fakeDriver, fakeObserver } from '../bench/electron-qualification-fakes.mjs';

const identity = { pid: 501, pidBirth: 'b1', instance: 'i1', epoch: 1 };
const clock = () => { let t = 1000; return { now: () => t, advance: ms => { t += ms; }, sleep: async ms => { t += ms; } }; };
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'eq-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const quietIo = (over = {}) => ({ exists: () => false, permission: async () => false, ...over });

test('fixture controls beyond the first snapshot page remain usable without earlier cells', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  driver.tool = async (name, args) => {
    const result = await tool(name, args);
    if (name !== 'browser_read' || result.isError) return result;
    const lines = result.text.split('\n');
    const head = lines.filter(line => line.startsWith('#'));
    const body = lines.filter(line => !line.startsWith('#'));
    // VS Code's explorer and workbench precede the editor, quick input and panel.
    if (!args.find) return { ...result, text: [...head, '- treeitem "a-scratch.txt" [ref=e2]',
      ...Array.from({ length: 160 }, (_, i) => `- button "workbench control ${i}" [ref=e${100 + i}]`)].join('\n') + '\n# Cut: more rows omitted. Continue with ref="more1_0".' };
    const terms = args.find.toLowerCase().split('|');
    return { ...result, text: [...head, ...body.filter(line => terms.some(term => line.toLowerCase().includes(term)))].join('\n') };
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'key', 'background-type', 'webview', 'terminal-refusal', 'sheet-parking', 'revoke', 'timings'].includes(cell.id)),
    options: { trials: 1, samples: 1, coldSamples: 1 } });
  assert.deepEqual(receipt.cells.filter(cell => cell.status !== 'pass').map(cell => [cell.id, cell.error]), []);
  assert.ok(receipt.cells.find(cell => cell.id === 'key').reads.some(read => read.find?.includes('Search files by name') && read.text.includes('combobox')));
  assert.equal(receipt.cells[0].startMs, 1000);
  assert.equal(receipt.cells[0].endMs, 1000);
});

test('a missing terminal ref cannot leave subsequent cells typing into the terminal', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  let terminalFocused = false;
  driver.tool = async (name, args) => {
    if (name === 'browser_act') for (const step of args.steps) {
      if (step.do === 'click' && ['e2', 'e3', 'e8'].includes(step.ref)) terminalFocused = false;
      if (step.do === 'press' && terminalFocused) return { text: 'ELECTRON_TERMINAL_REFUSED', isError: true };
      if (step.key === 'Control+`') terminalFocused = true;
    }
    const r = await tool(name, args);
    return name === 'browser_read' ? { ...r, text: r.text.replace(/^- textbox "Terminal[^\n]*\n?/gm, '') } : r;
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'click', 'terminal-refusal', 'sheet-parking', 'revoke', 'timings'].includes(cell.id)),
    options: { samples: 1, coldSamples: 1 } });
  assert.equal(receipt.cells.find(cell => cell.id === 'terminal-refusal').error, 'TERMINAL_NOT_FOUND');
  assert.deepEqual(receipt.cells.filter(cell => cell.status !== 'pass').map(cell => cell.id), ['terminal-refusal']);
  assert.equal(terminalFocused, false);
});

test('window creation must refuse without input focus, and one window cannot qualify multi-window joins', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.nativeSecondWindow = async () => {};
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'new-window'].includes(cell.id)).map(cell => ({ ...cell, prepare: undefined })) });
  const row = receipt.cells.at(-1);
  assert.equal(row.status, 'pass', row.error);
  assert.equal(row.detail.windowCreationRefused, true);
  assert.equal(row.detail.joined, 1);
  assert.ok(receipt.validation.unqualified.includes('MULTI_WINDOW_UNMEASURED'));
  for (const detail of [{ windowCreationRefused: true }, { joined: 1 }, { joined: 2, falseJoins: 1 }, { joined: 2, falseJoins: 0 }]) {
    const verdict = validateReceipt(receiptWith([passed('new-window', { detail,
      windows: [{ id: 77, epoch: 1, pid: 501, pidBirth: 'b1' }] })]), { required: ['new-window'] });
    assert.ok(verdict.unqualified.includes('MULTI_WINDOW_UNMEASURED'), JSON.stringify(detail));
  }
});

test('three joined windows cannot substitute for the two owned fixture windows', () => {
  const receipt = receiptWith([passed('new-window', { detail: { joined: 3, falseJoins: 0 },
    windows: [77, 78, 79].map(id => ({ id, epoch: 1, pid: 501, pidBirth: 'b1' })) })]);
  assert.ok(validateReceipt(receipt, { required: ['new-window'] }).unqualified.includes('MULTI_WINDOW_UNMEASURED'));
});

test('cold act timing restores the editor before reconnecting, so Escape is the first action of the new turn', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool, reconnect = driver.reconnect;
  let fresh = false;
  const firstActions = [];
  driver.reconnect = async options => { fresh = true; return reconnect(options); };
  driver.tool = async (name, args) => {
    if (name === 'browser_act' && fresh) {
      fresh = false;
      firstActions.push(args.steps[0]);
    }
    return tool(name, args);
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'timings'].includes(cell.id)), options: { samples: 1, coldSamples: 1 } });
  assert.equal(receipt.cells.at(-1).status, 'pass', receipt.cells.at(-1).error);
  assert.deepEqual(firstActions.at(-1), { do: 'press', ref: 'e3', key: 'Escape' });
  assert.equal(receipt.timings.act.cold.n, 1);
});

test('native second-window preparation finishes before measurement and Turbo still refuses creating a window', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  let prepared = false;
  driver.nativeSecondWindow = async () => { c.advance(300); prepared = true; return { created: true, windows: [4100, 4101] }; };
  driver.tool = async (name, args) => {
    const result = await tool(name, args);
    if (name === 'browser_tabs' && prepared) result.text += '\nt00000000000000000000000000001005 Visual Studio Code window 4101 joined join 1';
    return result;
  };
  driver.windowOwners = async ids => Object.fromEntries(ids.map(id => [id, driver.identity().pid]));
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'new-window'].includes(cell.id)) });
  const row = receipt.cells.at(-1);
  assert.equal(prepared, true);
  assert.equal(row.setup.ms, 300);
  assert.equal(row.startMs, 1300);
  assert.equal(row.status, 'pass', row.error);
  assert.equal(row.detail.joined, 2);
  assert.equal(row.detail.falseJoins, 0);
  assert.equal(row.detail.windowCreationRefused, true);
  assert.equal(new Set(row.windows.map(window => window.id)).size, 2);
});

test('failed native window preparation prevents the measured Turbo action', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.nativeSecondWindow = async () => { throw Error('WINDOW_SETUP_IDENTITY_CHANGED'); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'new-window'].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).error, 'WINDOW_SETUP_IDENTITY_CHANGED');
  assert.equal(driver.calls.some(call => call.args.steps?.some(step => step.key === 'Meta+Shift+N')), false);
});
test('second-window setup waits for both renderer joins before the measured refusal', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool, native = driver.nativeSecondWindow;
  let setup = false, lists = 0;
  driver.nativeSecondWindow = async () => { const result = await native(); setup = true; return result; };
  driver.tool = async (name, args) => {
    const result = await tool(name, args);
    if (setup && name === 'browser_tabs' && ++lists < 3) result.text = result.text.split('\n')[0];
    return result;
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'new-window'].includes(cell.id)) });
  const row = receipt.cells.at(-1);
  assert.equal(row.status, 'pass', row.error);
  assert.equal(row.setup.ms, 200);
  assert.equal(row.startMs, 1200);
  assert.equal(row.detail.joined, 2);
});

test('host-kill permits only its measured owned direct launch through first window plus two seconds', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.fixturePids = () => [501];
  driver.launchWindows = () => [{ pid: 501, execMs: 1050, firstWindowMs: 1200, endMs: 3200 }];
  const receipt = await runQualification({ app: APPS.vscode, driver,
    observer: fakeObserver({ now: c.now, fixturePid: () => 501, front: t => t >= 1050 && t <= 3200 ? 501 : 90 }), io: quietIo(), clock: c,
    cells: [{ id: 'host-kill', run: async () => { c.advance(2300); } }] });
  assert.equal(receipt.cells[0].status, 'pass', receipt.cells[0].error);
  assert.equal(receipt.cells[0].background.unexpectedFixtureFront, 0);
  assert.equal(receipt.launchFindings.length, 1);
});

for (const scenario of ['before-exec', 'after-cutoff', 'missing-window', 'wrong-pid', 'input'])
  test(`host-kill direct launch allowance rejects ${scenario}`, async () => {
    const c = clock(), driver = fakeDriver({ now: c.now });
    driver.fixturePids = () => [501];
    driver.launchWindows = () => [{ pid: scenario === 'wrong-pid' ? 999 : 501, execMs: 1050,
      firstWindowMs: scenario === 'missing-window' ? null : 1200, endMs: 3200 }];
    const at = scenario === 'before-exec' ? 1000 : scenario === 'after-cutoff' ? 3250 : 1200;
    const receipt = await runQualification({ app: APPS.vscode, driver,
      observer: fakeObserver({ now: c.now, fixturePid: () => 501, front: t => t === at ? 501 : 90 }), io: quietIo(), clock: c,
      cells: [{ id: 'host-kill', input: scenario === 'input', run: async () => { c.advance(2300); } }] });
    assert.equal(receipt.cells[0].status, 'fail');
    assert.match(receipt.cells[0].error, /BACKGROUND_FOCUS_TAKEN/);
  });

for (const target of ['key', 'webview']) test(`${target} waits for the intended selected document instead of using a previous editor`, async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  let switching = false, reads = 0;
  driver.tool = async (name, args) => {
    if (name === 'browser_act') for (const step of args.steps) {
      if (step.ref === 'e99' || step.key === 'Meta+Shift+V' && switching)
        return { isError: true, text: 'WRONG_DOCUMENT_INPUT' };
      if (step.do === 'click' && ['e1', 'e2', 'e8', 'e9'].includes(step.ref)) { switching = true; reads = 0; }
    }
    const r = await tool(name, args);
    if (name === 'browser_read' && args.find?.includes('Editor content') && switching) {
      if (++reads < 3) return { ...r, text: r.text.replace(/\[selected\]/g, '')
        .replace(/^- textbox[^\n]*/gm, '- textbox "previous.txt, Editor content" [ref=e99]') };
      switching = false;
    }
    return r;
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', target].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).status, 'pass', receipt.cells.at(-1).error);
  assert.ok(reads >= 3);
});

test('each failed cell records host park status and receipt scrubbing refuses arbitrary reasons', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.status = async () => ({ broker: 'parked', parked: { reason: 'pipe queue full', resumable: true } });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: [{ id: 'click', run() { throw Error('click refused'); } }, { id: 'key', run() { throw Error('unavailable'); } }] });
  for (const cell of receipt.cells) assert.deepEqual(cell.broker.parked, { reason: 'pipe queue full', resumable: true });
  assert.deepEqual(scrubReceipt({ parked: { reason: 'page supplied private text', resumable: true, secretText: 'private' } }),
    { parked: { reason: 'host failure', resumable: true } });
});

for (const keyboardOnly of [false, true]) test(`editor shortcuts target the selected editor ref without clicking its input surface (keyboard-only=${keyboardOnly})`, async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool, keys = [];
  driver.tool = async (name, args) => {
    if (name === 'browser_act') for (const step of args.steps) {
      if (step.do === 'click' && ['e3', 'e10', 'x3'].includes(step.ref)) return { isError: true, text: 'EDITOR_POINTER_NOT_AVAILABLE' };
      if (['Meta+P', 'Meta+Shift+V'].includes(step.key)) {
        keys.push(step);
        const expected = step.key === 'Meta+P' ? keyboardOnly ? 'x3' : 'e3' : 'e10';
        if (step.ref !== expected) return { isError: true, text: 'EXACT_EDITOR_REF_REQUIRED' };
      }
    }
    const r = await tool(name, args);
    if (keyboardOnly && name === 'browser_read') return { ...r, text: r.text.replace(
      '- textbox "a-scratch.txt, Editor content" [ref=e3]',
      '- textbox "a-scratch.txt, Editor content" [active]\n- textbox "a-scratch.txt, Editor content" [active] [keyboard-only] [ref=x3]') };
    return r;
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'key', 'webview'].includes(cell.id)) });
  assert.deepEqual(receipt.cells.filter(cell => cell.status !== 'pass').map(cell => [cell.id, cell.error]), []);
  assert.deepEqual(keys.map(step => step.ref), [keyboardOnly ? 'x3' : 'e3', 'e10']);
});

test('two actionable named editor refs remain ambiguous even when one is keyboard-only', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  driver.tool = async (name, args) => {
    const r = await tool(name, args);
    return name === 'browser_read' ? { ...r, text: r.text.replace('- textbox "a-scratch.txt, Editor content" [ref=e3]',
      '- textbox "a-scratch.txt, Editor content" [ref=e3]\n- textbox "a-scratch.txt, Editor content" [active] [keyboard-only] [ref=x3]') } : r;
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'key'].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).error, 'EDITOR_NOT_FOUND');
});

test('a failed first connection keeps the host refusal, skips dependent cells and still cleans up', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  let calls = 0;
  driver.connect = async () => ({ error: 'STATE_DIR_TOO_LONG', stage: 'app-host', card: { shown: false, status: 'refused', error: 'STATE_DIR_TOO_LONG' }, launch: {}, connect: {} });
  driver.tool = async () => { calls++; throw Error('dependent call'); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c });
  assert.equal(receipt.cells[0].error, 'STATE_DIR_TOO_LONG');
  assert.ok(receipt.cells.slice(1).every(cell => cell.status === 'skipped' && cell.reason === 'STARTUP_FAILED'));
  assert.equal(receipt.stopped.reason, 'startup-failed');
  assert.equal(receipt.stopped.stage, 'app-host');
  assert.equal(calls, 0);
  assert.equal(receipt.cleanup.confirmed, true);
});

test('startup focus theft fails the consent cell even after an early selection error', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.identity = () => null;
  driver.fixturePids = () => [501];
  driver.connect = async () => { c.advance(200); return { error: 'ELECTRON_UNQUALIFIED', stage: 'app-select', card: { shown: true, status: 'granted' } }; };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => 501, front: () => 501 }), io: quietIo(), clock: c });
  const cell = receipt.cells[0];
  assert.equal(cell.status, 'fail');
  assert.match(cell.error, /BACKGROUND_FOCUS_TAKEN/);
  assert.equal(cell.detail.startupError, 'ELECTRON_UNQUALIFIED');
  assert.ok(cell.background.fixtureFront > 0);
  assert.equal(cell.background.frontmostSamples[0].t, 1000);
  assert.equal(cell.background.frontmostSamples[0].front, 501);
  assert.equal(cell.background.frontmostSamples.at(-1).t, 1200);
  assert.equal(receipt.cleanup.confirmed, true);
  assert.ok(receipt.cells.slice(1).every(row => row.status === 'skipped'));
});

test('VS Code direct launch focus is a finding only through first window plus two seconds', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  const connect = driver.connect;
  driver.connect = async () => { const result = await connect(); c.advance(2300); return result; };
  driver.launchWindows = () => [{ pid: 501, execMs: 1050, firstWindowMs: 1200, endMs: 3200 }];
  const observer = fakeObserver({ now: c.now, fixturePid: () => 501, front: t => t >= 1050 && t <= 3200 ? 501 : 90 });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer, io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'connect'].includes(cell.id)) });
  assert.deepEqual(receipt.cells.map(cell => cell.status), ['pass', 'pass']);
  assert.equal(receipt.cells[0].background.fixtureFront, 44);
  assert.equal(receipt.cells[0].background.unexpectedFixtureFront, 0);
  assert.equal(receipt.launchFindings.length, 1);
  const finding = receipt.launchFindings[0];
  assert.equal(finding.kind, 'benchmark-direct-launch');
  assert.equal(finding.execMs, 1050);
  assert.equal(finding.firstWindowMs, 1200);
  assert.equal(finding.endMs, 3200);
  assert.equal(finding.background.fixtureFront, 44);
  assert.equal(finding.frontmostSamples[0].t, 1050);
  assert.equal(finding.frontmostSamples.at(-1).t, 3200);
});

for (const scenario of ['before-exec', 'after-cutoff', 'no-first-window', 'wrong-cutoff', 'cursor', 'later-cell', 'input-cell', 'relaunch']) {
  test(`launch exception refuses ${scenario}`, async () => {
    const c = clock(), driver = fakeDriver({ now: c.now });
    driver.launchWindows = () => [{ pid: 501, execMs: 1050, firstWindowMs: scenario === 'no-first-window' ? null : 1100,
      endMs: scenario === 'wrong-cutoff' ? 9999 : 3100 }];
    const at = scenario === 'before-exec' ? 1000 : scenario === 'after-cutoff' ? 3150 : 1200;
    const observer = fakeObserver({ now: c.now, fixturePid: () => 501, front: t => t === at ? 501 : 90 });
    const receipt = await runQualification({ app: scenario === 'cursor' ? APPS.cursor : APPS.vscode, driver, observer, io: quietIo(), clock: c,
      cells: [{ id: scenario === 'later-cell' ? 'connect' : 'consent-card', input: scenario === 'input-cell',
        run: async () => { c.advance(2200); return {}; } }], options: { relaunch: scenario === 'relaunch' } });
    if (scenario === 'relaunch') assert.equal(receipt.launchFindings.length, 0);
    else { assert.equal(receipt.cells[0].status, 'fail'); assert.match(receipt.cells[0].error, /BACKGROUND_FOCUS_TAKEN/); }
  });
}

test('a launch finding preserves the original selection failure', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.fixturePids = () => [501];
  driver.identity = () => null;
  driver.launchWindows = () => [{ pid: 501, execMs: 1000, firstWindowMs: 1050, endMs: 3050 }];
  driver.connect = async () => { c.advance(2100); return { error: 'ELECTRON_UNQUALIFIED', stage: 'app-select', card: { shown: true, status: 'granted' } }; };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, front: t => t <= 3050 ? 501 : 90 }), io: quietIo(), clock: c });
  assert.equal(receipt.cells[0].error, 'ELECTRON_UNQUALIFIED');
  assert.equal(receipt.launchFindings[0].background.fixtureFront, 42);
  assert.ok(receipt.cells.slice(1).every(row => row.status === 'skipped'));
});

test('a sampler gap cannot stretch the launch allowance to a late first-window observation', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.launchWindows = () => [{ pid: 501, execMs: 1000, firstWindowMs: 5000, endMs: 7000 }];
  const observer = { samples: async () => [1000, 5000, 7000].map(t => ({ t, front: 501, x: 1, y: 2 })) };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer, io: quietIo(), clock: c,
    cells: [{ id: 'consent-card', run: async () => { c.advance(6000); } }] });
  assert.equal(receipt.cells[0].status, 'fail');
  assert.match(receipt.cells[0].error, /BACKGROUND_FOCUS_TAKEN/);
  assert.equal(receipt.launchFindings.length, 0);
});

test('background typing requires Terminal and sends no input with a different front app', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.frontApp = async () => ({ pid: 90, bundle: 'fixture.other' });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'background-type'].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).error, 'BACKGROUND_TERMINAL_REQUIRED');
  assert.ok(!driver.calls.some(call => call.name === 'browser_act'));
});

test('background typing arranges Terminal before its measured input window', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), frontCalls = [];
  let ready = false;
  driver.frontApp = async options => {
    frontCalls.push(options ?? null);
    if (options?.bundle === 'com.apple.Terminal') { c.advance(500); ready = true; }
    return { pid: 90, bundle: ready ? 'com.apple.Terminal' : 'fixture.other' };
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'click', 'background-type'].includes(cell.id)), options: { trials: 1 } });
  assert.equal(receipt.cells.at(-1).status, 'pass', receipt.cells.at(-1).error);
  assert.equal(frontCalls[0]?.bundle, 'com.apple.Terminal');
  assert.equal(receipt.cells.at(-1).setup.ms, 500);
  assert.equal(receipt.cells.at(-1).ms, 0);
});

test('host loss with a confirmed app exit never probes a second launch or asks for its card', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.killHost = async () => { await driver.quitByPid(); return { appAlive: false, appExited: true }; };
  driver.secondLaunch = async () => assert.fail('a dead temporary app has no unresolved live owner');
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'quit', 'host-kill'].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).status, 'pass', receipt.cells.at(-1).error);
  assert.equal(receipt.cells.at(-1).detail.appSurvived, false);
  assert.equal(receipt.cells.at(-1).detail.secondLaunchProbed, false);
});

test('an unconfirmed Quit stops host-kill before it launches another fixture', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), connect = driver.connect;
  let launches = 0;
  driver.connect = async () => { launches++; return connect(); };
  driver.quit = async () => { throw Error('QUIT_REFUSED'); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'quit', 'host-kill'].includes(cell.id)) });
  assert.equal(receipt.cells.at(-1).error, 'PREVIOUS_QUIT_UNCONFIRMED');
  assert.equal(launches, 1);
});

test('failed reads preserve the listed app tab and sanitized snapshot diagnostics', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  const failure = { stage: 'dom', reason: 'budget' };
  driver.tool = async (name, args) => name === 'browser_read' ? { text: 'Snapshot unavailable', isError: true, snapshotFailure: failure } : tool(name, args);
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c,
    cells: CELLS.filter(cell => ['consent-card', 'list', 'read'].includes(cell.id)) });
  const tab = receipt.cells.find(cell => cell.id === 'list').detail.tabs[0].tab;
  assert.match(tab, /^t[0-9a-f]{32}$/);
  assert.deepEqual(receipt.cells.at(-1).detail, { tab, snapshotFailure: failure });
});

test('a clone launch refusal stops relaunch dependents and keeps launch diagnostics', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.relaunch = async () => { throw Object.assign(Error('COPY_LAUNCH_IDENTITY_MISMATCH'), { detail: { stage: 'copy-launch', pid: 42, expected: '/fixture/Copy.app', actual: '/Applications/Code.app' } }); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c, options: { relaunch: true } });
  assert.equal(receipt.cells[0].error, 'COPY_LAUNCH_IDENTITY_MISMATCH');
  assert.equal(receipt.cells[0].detail.actual, '/Applications/Code.app');
  assert.ok(receipt.cells.slice(1).every(cell => cell.status === 'skipped'));
  assert.equal(receipt.cleanup.confirmed, true);
});

function receiptWith(cells, over = {}) {
  return { version: 1, kind: 'electron-qualification', mode: 'live', app: { bundleId: APPS.vscode.bundleId },
    profile: { temporary: true }, cleanup: { confirmed: true, appExited: true, profileRemoved: true, left: [] },
    timings: {}, cells, qualified: false, ...over };
}
const passed = (id, extra = {}) => ({ id, status: 'pass', ms: 5, identity,
  ...(id === 'new-window' ? { detail: { joined: 2, falseJoins: 0 } } : {}),
  windows: [{ id: 77, epoch: 1, pid: 501, pidBirth: 'b1' }, ...(id === 'new-window' ? [{ id: 78, epoch: 1, pid: 501, pidBirth: 'b1' }] : [])], ...extra });

test('live runs need --owner-away; dry runs need nothing; both together and unknown options refuse', () => {
  assert.throws(() => parseArgs([]), /OWNER_AWAY_REQUIRED/);
  assert.throws(() => parseArgs(['--dry-run', '--owner-away']), /CONFLICTING_MODE/);
  assert.throws(() => parseArgs(['--owner-away', '--frobnicate']), /INVALID_OPTIONS/);
  assert.throws(() => parseArgs(['--owner-away', '--apps', 'slack']), /UNKNOWN_APP/);
  assert.deepEqual(parseArgs(['--dry-run']).apps, ['vscode']);
  const live = parseArgs(['--owner-away', '--apps', 'vscode,cursor', '--samples', '5']);
  assert.equal(live.mode, 'live');
  assert.deepEqual(live.apps, ['vscode', 'cursor']);
  assert.equal(live.samples, 5);
});

test('background evidence counts fixture-frontmost samples, pointer travel and gaps in the 50 ms sampling', () => {
  const samples = [0, 50, 100, 150, 200].map((t, i) => ({ t: 1000 + t, front: i === 2 ? 501 : 90, x: 10, y: 10 + (i === 4 ? 3 : 0) }));
  const evidence = backgroundEvidence(samples, { startMs: 1000, endMs: 1200, fixturePid: 501 });
  assert.equal(evidence.samples, 5);
  assert.equal(evidence.fixtureFront, 1);
  assert.equal(evidence.pointerMovedPx, 3);
  assert.equal(evidence.covered, true);
  assert.deepEqual(evidence.frontPids, [90, 501]);
  const gap = backgroundEvidence(samples.filter((_, i) => i === 0 || i === 4), { startMs: 1000, endMs: 1200, fixturePid: 501 });
  assert.equal(gap.covered, false);
  assert.equal(backgroundEvidence([], { startMs: 0, endMs: 10, fixturePid: 1 }).covered, false);
});

test('percentiles are nearest rank, and summaries keep the sample count', () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile(values, 90), 18);
  assert.deepEqual(timingSummary([30, 10, 20]), { n: 3, p50: 20, p90: 30 });
  assert.deepEqual(timingSummary([]), { n: 0, p50: null, p90: null });
});

test('a cell records pass, fail with its code, ms and the identity; an input cell fails without background proof', async () => {
  const c = clock();
  const cells = [
    { id: 'ok', run: async () => { c.advance(7); return { number: 3, unit: 'rows' }; } },
    { id: 'boom', run: async () => { throw new Error('ELECTRON_PARKED: native-modal'); } },
    { id: 'typed', input: true, run: async () => { c.advance(100); return {}; } },
    { id: 'moved', input: true, run: async () => { c.advance(100); return {}; } },
  ];
  const observer = fakeObserver({ now: c.now, fixturePid: () => 501, pointerAt: t => (t > 1150 ? 4 : 0) });
  const receipt = await runQualification({ app: APPS.vscode, cells, driver: fakeDriver({ now: c.now }), observer, io: quietIo(), clock: c });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId.ok.status, 'pass');
  assert.equal(byId.ok.ms, 7);
  assert.equal(byId.ok.number, 3);
  assert.deepEqual(Object.keys(byId.ok.identity).sort(), ['epoch', 'instance', 'pid', 'pidBirth']);
  assert.equal(byId.boom.status, 'fail');
  assert.equal(byId.boom.error, 'ELECTRON_PARKED: native-modal');
  assert.equal(byId.typed.status, 'pass');
  assert.equal(byId.typed.background.fixtureFront, 0);
  assert.equal(byId.moved.status, 'fail');
  assert.match(byId.moved.error, /BACKGROUND_POINTER_MOVED/);
});

test('a hold between cells waits; a macOS permission prompt stops the run unanswered, and cleanup still runs', async () => {
  const c = clock();
  let holds = 2, cleaned = 0, prompted = false;
  const io = quietIo({ exists: path => path === '/tmp/sleight-hold' && holds-- > 0,
    permission: async () => (prompted ? { process: 'UserNotificationCenter', title: 'Allow access?' } : false) });
  const cells = [
    { id: 'first', run: async () => { prompted = true; return {}; } },
    { id: 'second', run: async () => { throw new Error('must not run'); } },
  ];
  const driver = fakeDriver({ now: c.now });
  const cleanup = driver.cleanup;
  driver.cleanup = async () => { cleaned++; return cleanup(); };
  const receipt = await runQualification({ app: APPS.vscode, cells, driver, observer: fakeObserver({ now: c.now }), io, clock: c });
  assert.ok(receipt.heldMs >= 60000);
  assert.equal(receipt.cells[0].status, 'pass');
  assert.equal(receipt.cells[1].status, 'stopped');
  assert.equal(receipt.stopped.reason, 'permission-prompt');
  assert.equal(receipt.stopped.title, 'Allow access?');
  assert.equal(cleaned, 1);
  assert.equal(receipt.qualified, false);
});

test('receipt validation: identity, skips, reused windows, home paths, component time, cleanup and qualified claims', () => {
  const all = requiredCells(APPS.vscode).map(id => passed(id));
  const good = validateReceipt(receiptWith(all));
  assert.deepEqual(good.errors, []);
  assert.equal(good.qualified, true);

  const noIdentity = validateReceipt(receiptWith([...all.slice(1), { ...all[0], identity: { pid: 501, pidBirth: 'b1', epoch: 1 } }]));
  assert.ok(noIdentity.errors.some(e => e.startsWith('CELL_IDENTITY_MISSING')));
  const skipped = validateReceipt(receiptWith([{ id: all[0].id, status: 'skipped' }, ...all.slice(1)]));
  assert.deepEqual(skipped.errors, []);
  assert.equal(skipped.qualified, false);
  assert.ok(skipped.unqualified.some(e => e.startsWith('CELL_SKIPPED')));
  const reused = validateReceipt(receiptWith([...all.slice(1), { ...all[0], windows: [{ id: 77, epoch: 1, pid: 999, pidBirth: 'other' }] }]));
  assert.ok(reused.errors.includes('WINDOW_REUSED:77'));
  const home = validateReceipt(receiptWith(all, { note: `wrote ${MAC_USERS}someone/x` }));
  assert.ok(home.errors.includes('SECRET_OUTPUT'));
  const secret = validateReceipt(receiptWith(all, { handle: { secret: 'abc' } }));
  assert.ok(secret.errors.includes('SECRET_OUTPUT'));
  const component = validateReceipt(receiptWith(all, { timings: { read: { scope: 'component', warm: { n: 20, p50: 1, p90: 2 } } } }));
  assert.ok(component.errors.includes('COMPONENT_TIME:read'));
  const dirty = validateReceipt(receiptWith(all, { cleanup: { confirmed: false, left: [4242] } }));
  assert.equal(dirty.qualified, false);
  assert.ok(dirty.errors.includes('CLEANUP_UNCONFIRMED'));
  const shared = validateReceipt(receiptWith(all, { profile: { temporary: false } }));
  assert.ok(shared.errors.includes('ISOLATION_FAILED'));
  const claimed = validateReceipt(receiptWith(all.slice(1), { qualified: true }));
  assert.ok(claimed.errors.includes('QUALIFIED_CLAIM_UNSUPPORTED'));
  assert.ok(claimed.unqualified.includes('REQUIRED_CELL_MISSING:' + all[0].id));
  const dry = validateReceipt(receiptWith(all, { mode: 'dry-run' }));
  assert.equal(dry.qualified, false);
  assert.ok(dry.unqualified.includes('DRY_RUN'));
});

test('VS Code needs every cell except the Cursor overlay row; Cursor runs the overlay probe first, then editor cells only', () => {
  const vscode = requiredCells(APPS.vscode);
  assert.ok(!vscode.includes('cursor-overlay'));
  for (const id of ['consent-card', 'connect', 'read', 'background-type', 'click', 'key', 'navigation', 'new-window', 'sheet-parking',
    'revoke', 'disconnect', 'quit', 'terminal-refusal', 'app-key-refusal', 'webview', 'worker-kill', 'host-kill', 'timings', 'contention']) {
    assert.ok(vscode.includes(id), id);
  }
  const cursor = cellsFor(APPS.cursor).map(cell => cell.id);
  assert.equal(cursor[cursor.indexOf('connect') + 1], 'cursor-overlay');
  assert.ok(!cursor.includes('webview') && !cursor.includes('host-kill'));
  assert.ok(cursor.includes('background-type') && cursor.includes('quit'));
  assert.equal(new Set(CELLS.map(cell => cell.id)).size, CELLS.length);
});

test('the harness never answers the debugger card: without the user\'s click the consent cell fails and nothing else runs', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  driver.connect = async () => ({ card: { shown: true, by: null, status: 'timeout', scope: null, ms: 120000 } });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['consent-card'].status, 'fail');
  assert.match(byId['consent-card'].error, /CONSENT_NEEDS_OWNER: .*never clicks it/);
  assert.equal(byId.read.status, 'skipped');
  assert.equal(byId.quit.status, 'skipped');
  assert.equal(receipt.consent.harnessClicks, false);
  assert.deepEqual(receipt.consent.cards.map(card => card.status), ['timeout']);
  assert.ok(validateReceipt({ ...receipt, qualified: false, consent: { harnessClicks: true } }).errors.includes('HARNESS_CLICKED_CONSENT'));
});

test('a Cursor overlay that Escape never clears skips the editor cells, which leaves Cursor unqualified', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now, app: APPS.cursor, overlay: { present: true, clears: false } });
  const receipt = await runQualification({ app: APPS.cursor, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), io: quietIo(), clock: c,
    options: { trials: 2, samples: 2, aliveWaitMs: 0 } });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['cursor-overlay'].status, 'fail');
  assert.equal(byId['background-type'].status, 'skipped');
  assert.equal(byId.quit.status, 'pass');
  assert.equal(receipt.qualified, false);
});

test('the whole fake VS Code run passes every cell through the five tools, and dry runs never qualify', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }),
    io: quietIo(), clock: c, options: { trials: 3, samples: 4, aliveWaitMs: 0, mode: 'dry-run' } });
  const failed = receipt.cells.filter(cell => cell.status !== 'pass');
  assert.deepEqual(failed.map(cell => `${cell.id}: ${cell.error}`), []);
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['background-type'].number, 3);
  assert.equal(byId['background-type'].detail.otherFront, true);
  assert.equal(byId['new-window'].detail.falseJoins, 0);
  assert.equal(byId['sheet-parking'].detail.staleRefusals, 1);
  assert.equal(byId.revoke.detail.replays, 0);
  assert.deepEqual(byId.contention.detail.map(row => row.busy), [0, 3]);
  assert.deepEqual(byId.contention.detail.map(row => row.cards), [0, 0], 'busy sessions refuse before their card');
  assert.equal(receipt.timings.read.scope, 'tool-call');
  assert.equal(receipt.timings.read.warm.n, 4);
  assert.equal(receipt.timings.read.cold.n, 4, 'cold samples are capped by coldSamples (default 5)');
  assert.equal(byId['host-kill'].detail.refusal, 'ELECTRON_OWNERSHIP_UNRESOLVED');
  assert.ok(driver.calls.every(call => ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'].includes(call.name)));
  assert.equal(driver.quitByPidCalls, 1, 'only the host-kill instance needs the pid-owned quit');
  assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(receipt.qualified, false);
  assert.ok(receipt.validation.unqualified.includes('DRY_RUN'));
  assert.deepEqual(receipt.validation.errors, []);
});

test('dry-run main writes a scrubbed receipt and never takes the live lock or launches', async t => {
  const out = temp(t);
  const touched = [];
  const code = await main(['--dry-run', '--out', out, '--samples', '2', '--trials', '2'], {
    io: { exists: path => { touched.push(path); return false; }, permission: async () => false,
      acquireLock: async () => { throw new Error('dry run took the lock'); } },
    log: () => {},
  });
  assert.equal(code, 0);
  const [file] = readdirSync(out);
  const receipt = JSON.parse(readFileSync(join(out, file), 'utf8'));
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.app.bundleId, 'com.microsoft.VSCode');
  assert.ok(!touched.includes('/tmp/sleight-live.lock'));
});

test('a live run keeps the lock when cleanup is unconfirmed, and releases it once cleanup is confirmed', async t => {
  for (const confirmed of [true, false]) {
    const c = clock();
    let released = 0;
    const driver = fakeDriver({ now: c.now });
    driver.cleanup = async () => ({ confirmed, appExited: confirmed, profileRemoved: confirmed, left: confirmed ? [] : [4242] });
    const out = temp(t), logs = [];
    const code = await main(['--owner-away', '--out', out, '--samples', '2', '--trials', '2'], {
      io: quietIo({ acquireLock: async () => async () => { released++; } }), clock: c, log: line => logs.push(line),
      liveRuntime: async (_options, { qualificationDiagnosticPath: path }) => {
        assert.equal(statSync(path).mode & 0o777, 0o600);
        appendFileSync(path, JSON.stringify({ method: 'DOM.describeNode', code: -32000, message: 'upstream test cause' }) + '\n');
        return { driverFor: () => driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), close: async () => {} };
      },
      write: () => {},
    });
    assert.equal(released, confirmed ? 1 : 0);
    assert.equal(code, 1, 'a live fake run is unqualified either way');
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).firstCDPFailure,
      { method: 'DOM.describeNode', code: -32000, message: 'upstream test cause' });
    assert.ok(logs.every(line => !line.includes('upstream test cause')));
  }
});

test('the live runtime refuses before any launch while an EPV3-4 to 7 interface is missing, and reads codesign fields', async () => {
  const { liveRuntime, missingContract, parseCodesign } = await import('../bench/electron-qualification-live.mjs');
  const exec = async () => { throw new Error('a live command ran'); };
  await assert.rejects(liveRuntime(parseArgs(['--owner-away']), { io: { permission: async () => false } },
    { exec, load: async name => (name === 'snapshot.mjs' ? { invalidateRefs() {} } : Promise.reject(new Error('absent'))) }), /ELECTRON_RUNTIME_MISSING: electron-admin\.mjs, .*nothing was launched/);
  assert.deepEqual(await missingContract(async () => ({ ensureHost() {} })), [
    'electron-runtime.mjs connectAppHost', 'electron-runtime.mjs selectAppConnection', 'electron-runtime.mjs createAppTurn', 'electron-runtime.mjs releaseAppConnection',
    'electron-runtime.mjs runWindowHelper', 'electron-identity.mjs deriveAppInstance', 'worker.mjs createAppTurnRuntime', 'worker.mjs serverAppSecret']);
  assert.deepEqual(parseCodesign('Executable=/x\nAuthority=Developer ID Application: Example (ABC)\nAuthority=Apple Root CA\nCDHash=abc123\nTeamIdentifier=ABC\n'),
    { signer: 'Developer ID Application: Example (ABC)', team: 'ABC', cdhash: 'abc123' });
});

test('scrubbing turns the home path into ~ and the user name into [user]', () => {
  const out = scrubReceipt({ a: `${MAC_USERS}pat/Library/x`, b: ['pat ran', { c: `${MAC_USERS}pat` }] }, { home: `${MAC_USERS}pat`, user: 'pat' });
  assert.deepEqual(out, { a: '~/Library/x', b: ['[user] ran', { c: '~' }] });
});

test('the workspace has 200 row files, a 1,500-line file and a Markdown file', t => {
  const root = temp(t);
  const files = prepareWorkspace(root);
  assert.equal(readdirSync(join(root, 'rows')).length, 200);
  assert.equal(readFileSync(join(root, 'b-big.txt'), 'utf8').trimEnd().split('\n').length, 1500);
  assert.match(readFileSync(join(root, 'a-notes.md'), 'utf8'), /^# Notes/);
  assert.equal(files.scratch, join(root, 'a-scratch.txt'));
});

test('the native helper samples frontmost and pointer without activating anything, and sends no Apple events', () => {
  const source = readFileSync(new URL('../bench/electron-qualification.js', import.meta.url), 'utf8');
  for (const file of ['electron-qualification.js', 'electron-qualification-live.mjs', 'electron-qualification-worker.mjs', 'electron-qualification.mjs']) {
    const text = readFileSync(new URL('../bench/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /tell application|Application\(['"]|System Events|osascript', \['-e'/, file);
  }
  const emitted = [];
  let t = 0;
  const sandbox = {};
  runInNewContext(source + '\nthis.sampleLoop = sampleLoop;', sandbox);
  sandbox.sampleLoop({ intervalMs: 50, durationMs: 200 }, {
    front: () => 90, pointer: () => ({ x: 1, y: 2 }), stopped: () => false, windowPids: () => t >= 50 ? [501] : [],
  }, { now: () => t, wait: ms => { t += ms; }, emit: value => emitted.push(value) });
  assert.equal(emitted.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), { t: 0, front: 90, x: 1, y: 2, windowPids: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[1].windowPids)), [501]);
});

test('the live observer finds the first window only for the launched PID after its exec time', async t => {
  const { liveObserver } = await import('../bench/electron-qualification-live.mjs');
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const observer = liveObserver({ root: temp(t), spawnProcess: () => child });
  await observer.start();
  for (const sample of [
    { t: 900, windowPids: [501] }, { t: 1000, windowPids: [777] },
    { t: 1050, windowPids: [501, 777] }, { t: 1100, windowPids: [501] },
  ]) child.stdout.write(JSON.stringify({ front: 90, x: 1, y: 2, ...sample }) + '\n');
  assert.equal(observer.firstWindowMs(501, 1000), 1050);
  assert.equal(observer.firstWindowMs(777, 1000), 1000);
  assert.equal(observer.firstWindowMs(888, 1000), null);
  child.emit('exit', 0);
  await observer.stop();
});

// H2: the recipe the driver writes is one the registry and instanceFromRecipe accept for the same bundle.
test('the driver\'s recipe passes the registry and matches the bundle the runtime derives', async t => {
  const { recipeFromBundle } = await import('../bench/electron-qualification-live.mjs');
  const { deriveAppInstance } = await import('../plugins/sleight/lib/direct-browser/electron-identity.mjs');
  const { readRecipeRegistry, recipeFor, instanceFromRecipe } = await import('../plugins/sleight/lib/direct-browser/electron-recipes.mjs');
  const bundle = '/Applications/Visual Studio Code.app', executable = bundle + '/Contents/MacOS/Code';
  const inspect = () => ({ verified: true, codesign: { executable, identifier: 'com.microsoft.VSCode', cdhash: 'c'.repeat(40), team: 'UBF8T346G9',
    authority: 'Developer ID Application: Microsoft Corporation (UBF8T346G9)' }, electron: { CFBundleVersion: '39.2.3' },
    info: { CFBundleIdentifier: 'com.microsoft.VSCode', CFBundleName: 'Code', CFBundleShortVersionString: '1.105.0' } });
  const profile = `${MAC_TMP}/eq/profiles/com.microsoft.VSCode`;
  const derived = deriveAppInstance({ bundle, executable, profile, temporary: true, pid: 1, pidBirth: 'recipe' }, { inspect });
  const recipe = recipeFromBundle({ app: APPS.vscode, derived, executable, sha256: 'a'.repeat(64), bundlePath: bundle, workspace: `${MAC_TMP}/eq/workspace` });
  assert.equal(recipe.signer, 'UBF8T346G9', 'the team id, not the Authority line');
  assert.equal(recipe.runtime, 'electron/39.2.3');
  assert.equal(recipe.cdhash, 'c'.repeat(40));
  const dir = temp(t), path = join(dir, 'recipes.json');
  (await import('node:fs')).writeFileSync(path, JSON.stringify({ version: 1, recipes: [recipe] }));
  const row = recipeFor(readRecipeRegistry(path), 'com.microsoft.VSCode');
  assert.equal(instanceFromRecipe(row, { profile, temporary: true, inspect }).pid, 0, 'no RECIPE_BUILD_CHANGED');
});

// H1, F2: the live worker composes a turn the installed worker's way and takes the app host's secret from its parent only.
test('the live worker uses the installed path: connectAppHost with the parent\'s secret, createAppTurn, createAppTurnRuntime', () => {
  const worker = readFileSync(new URL('../bench/electron-qualification-worker.mjs', import.meta.url), 'utf8');
  for (const call of ['runtimeMod.connectAppHost(', 'secret: msg.appSecret', "profile: msg.profile === 'user' ? 'user' : 'temporary'", 'runtimeMod.selectAppConnection(', 'windows: b.runtimeMod.runWindowHelper',
    'profile: b.host.profile', 'runtimeMod.createAppTurn(', 'workerMod.createAppTurnRuntime(', 'releaseAppConnection(']) assert.ok(worker.includes(call), call);
  for (const shortcut of ['ensureHost(', 'adminSecret', 'createAppRunners(', 'createAppSnapshot(', 'snapshotMod.snapshot']) assert.ok(!worker.includes(shortcut), shortcut);
  const live = readFileSync(new URL('../bench/electron-qualification-live.mjs', import.meta.url), 'utf8');
  assert.ok(live.includes('serverAppSecret()'), 'the driver holds the secret the way the MCP server does');
  assert.ok(!/adminSecret|randomBytes\(32\)/.test(live), 'and never makes its own');
});

// L3: the written receipt is the scrubbed one, so a home path in an error is not a secret in it.
test('a home path in a cell error is scrubbed before the receipt\'s secret check', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  driver.ownerInstances = async () => { throw Error(`ENOENT: ${MAC_USERS}pat/Library/Application Support/Code`); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }),
    io: quietIo(), clock: c, options: { trials: 2, samples: 2, aliveWaitMs: 0, mode: 'dry-run' } });
  assert.match(receipt.cells.find(cell => cell.id === 'new-window').error, /ENOENT/);
  assert.ok(!receipt.validation.errors.includes('SECRET_OUTPUT'), receipt.validation.errors.join(' '));
  assert.ok(validateReceipt(receiptWith([], { note: `${MAC_USERS}pat/x` })).errors.includes('SECRET_OUTPUT'), 'an unscrubbed path still fails');
});

// H3: the disconnect cell reads the host's own status after the worker is gone. Retained means owned with the pipe
// ready or resumably parked; an app that quit on the drop or a quit through the app is not retained.
test('pipeRetained reads the host status after a worker drop: parked and resumable is retained, a closed pipe or a quit is not', async t => {
  const { pipeRetained } = await import('../bench/electron-qualification-live.mjs');
  const { makeHost, connectWorker, until } = await import('./direct-browser-electron-host-fixture.mjs');
  const host = async () => { const h = await makeHost(); t.after(() => { h.host._crashForTest(); h.state.remove(); }); await h.host.start({ build: 'fake-build' }); return h; };
  let h = await host();
  const w = await connectWorker(h.host, 'w');
  assert.equal(pipeRetained(h.host.status()), true, 'connected');
  await w.connection.disconnect(w.connection.session);
  await until(() => h.host.status().channels === 0, 'worker dropped');
  assert.equal(pipeRetained(h.host.status()), true, `after the drop: ${JSON.stringify(h.host.status().broker)}`);
  h = await host();
  await connectWorker(h.host, 'w');
  h.world.alive = false; h.app.output.end(); // the app quits on its own, as on pipe EOF
  await until(() => h.host.status().broker?.state !== 'ready', 'app gone');
  assert.equal(pipeRetained(h.host.status()), false, `app gone: ${JSON.stringify(h.host.status())}`);
  assert.equal(pipeRetained({ ownership: { state: 'free' }, broker: { state: 'collected' } }), false);
  assert.equal(pipeRetained({ ownership: 'owned', broker: 'ready' }), false, 'the worker row\'s strings are not a host status');
});

// The disconnect cell on the live driver with a fake worker: the refused call must go through the same, still running worker,
// so only a disconnect that really revokes passes. A worker channel left open at the host fails it too.
test('the live disconnect cell passes only when the disconnect itself refuses the next call through the live worker', async t => {
  const { liveDriver } = await import('../bench/electron-qualification-live.mjs');
  const cell = CELLS.find(row => row.id === 'disconnect');
  const ps = `  501 1 ${process.getuid()} Sun Oct 18 16:00:00 2026 /Applications/Fake.app/Contents/MacOS/Fake --user-data-dir=/x\n`;
  const exec = async file => ({ stdout: file === '/bin/ps' ? ps : '', stderr: '' });
  async function attempt({ revokes = true, left = [] } = {}) {
    const forks = [];
    const forkWorker = () => {
      let revoked = false;
      const w = { lost: false, ops: [], kill() { w.lost = true; }, async send(op) {
        w.ops.push(op);
        if (w.lost) return { ok: false, error: 'V3_WORKER_UNAVAILABLE' };
        if (op === 'start') { revoked = false; return { ok: true, identity, card: { shown: true, status: 'granted', by: 'user', scope: 'session' }, launch: {}, connectMs: 1 }; }
        if (op === 'call') return { ok: true, result: revoked ? { text: 'Turbo is unavailable for this turn.', isError: true } : { text: 'one app tab', isError: false } };
        if (op === 'disconnect') {
          revoked = revokes;
          return { ok: true, status: { ownership: { state: 'owned' }, broker: { state: 'parked', parked: { reason: 'revoked', resumable: true } }, workers: left } };
        }
        return { ok: true };
      } };
      forks.push(w); return w;
    };
    const driver = liveDriver(APPS.vscode, { root: temp(t), exec, observer: {}, forkWorker });
    await driver.reconnect({});
    const c = { driver, state: {}, options: { consentWaitMs: 0 }, consent() {}, tool: (name, args) => driver.tool(name, args), list: async () => [{ tab: 't1' }] };
    const result = await cell.run(c).then(out => ({ out }), error => ({ error: error.message }));
    return { ...result, forks, parked: c.state.disconnectParked };
  }
  const good = await attempt();
  assert.deepEqual(good.out?.detail, { appAlive: true, pipeRetained: true }, good.error);
  assert.equal(good.forks.length, 1, 'one worker: disconnected, refused, then reconnected in place');
  assert.deepEqual(good.parked, { reason: 'revoked', resumable: true });
  assert.deepEqual(good.forks[0].ops, ['start', 'disconnect', 'call', 'start']);
  assert.match((await attempt({ revokes: false })).error ?? '', /DISCONNECTED_CALL_ANSWERED/, 'a disconnect that leaves calls answered fails the cell');
  assert.match((await attempt({ left: ['v3other'] })).error ?? '', /DISCONNECT_WORKER_CHANNEL_OPEN/, 'a worker channel still open at the host fails it');
});

// The relaunch flow (1.3.1): every app-dependent behaviour is a cell of its own, run dry only; the owner watches any live run.
test('relaunch cells name what each app decides, run dry on both apps, and a live relaunch run is refused', async t => {
  assert.deepEqual(RELAUNCH_CELLS.map(cell => cell.id), ['relaunch-card', 'relaunch-quit', 'relaunch-unsaved', 'relaunch-pipe', 'relaunch-background',
    'relaunch-restore', 'relaunch-reuse', 'relaunch-user-quit', 'relaunch-host-loss']);
  assert.ok(RELAUNCH_CELLS.every(cell => typeof cell.measures === 'string' && cell.measures.length > 20), 'each cell says what it measures');
  assert.ok(!RELAUNCH_CELLS.some(cell => CELLS.some(other => other.id === cell.id)));
  assert.deepEqual(relaunchCellsFor(APPS.cursor).map(cell => cell.id), RELAUNCH_CELLS.map(cell => cell.id));
  assert.throws(() => parseArgs(['--owner-away', '--relaunch']), /RELAUNCH_NEEDS_OWNER/);
  assert.equal(parseArgs(['--dry-run', '--relaunch']).relaunch, true);
  assert.equal(parseArgs(['--dry-run']).relaunch, false);
  for (const app of [APPS.vscode, APPS.cursor]) {
    const c = clock(), driver = fakeDriver({ now: c.now, app });
    const receipt = await runQualification({ app, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), io: quietIo(), clock: c,
      options: { mode: 'dry-run', relaunch: true } });
    assert.deepEqual(receipt.cells.filter(cell => cell.status !== 'pass').map(cell => `${cell.id}: ${cell.error}`), [], app.key);
    assert.equal(receipt.kind, 'electron-relaunch'); assert.equal(receipt.profile.temporary, false);
    assert.deepEqual(receipt.validation.errors, [], 'the own profile is not an isolation failure on a relaunch receipt');
    assert.ok(receipt.validation.unqualified.includes('DRY_RUN')); assert.equal(receipt.qualified, false);
    const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
    assert.equal(byId['relaunch-background'].detail.activated, false);
    assert.equal(byId['relaunch-unsaved'].detail.outcome, 'kept');
    assert.deepEqual(receipt.consent.cards.map(card => card.cell), ['relaunch-card', 'relaunch-card', 'relaunch-reuse', 'relaunch-host-loss', 'relaunch-host-loss']);
    // RF2: the keeper holds the pipe, so losing sleight's host leaves the owner's app and its unsaved work alone, and the restarted host
    // reattaches (or, without the parent's secret, releases the app to the user). The live run measures it.
    assert.deepEqual(byId['relaunch-host-loss'].detail, { appSurvived: true, unsaved: 'kept', prompt: false, restarted: 'reattached' });
  }
  const unmeasured = fakeDriver({ now: clock().now }); unmeasured.hostLoss = async () => ({ card: { debugger: {}, relaunch: { status: 'granted' } } });
  const r2 = await runQualification({ app: APPS.vscode, driver: unmeasured, observer: fakeObserver({ now: clock().now }), io: quietIo(), clock: clock(),
    cells: RELAUNCH_CELLS.filter(cell => cell.id === 'relaunch-host-loss'), options: { mode: 'dry-run', relaunch: true } });
  assert.equal(r2.cells[0].error, 'HOST_LOSS_UNMEASURED');
  for (const [loss, code] of [[{ appSurvived: false, unsaved: 'lost', prompt: false, restarted: 'released' }, 'APP_QUIT_ON_HOST_LOSS'],
    [{ appSurvived: true, unsaved: 'lost', prompt: false, restarted: 'reattached' }, 'UNSAVED_WORK_LOST'],
    [{ appSurvived: true, unsaved: 'kept', prompt: false, restarted: 'unresolved' }, 'HOST_LOSS_NOT_RECOVERED']]) {
    const failing = fakeDriver({ now: clock().now }); failing.hostLoss = async () => ({ card: {}, ...loss });
    const r3 = await runQualification({ app: APPS.vscode, driver: failing, observer: fakeObserver({ now: clock().now }), io: quietIo(), clock: clock(),
      cells: RELAUNCH_CELLS.filter(cell => cell.id === 'relaunch-host-loss'), options: { mode: 'dry-run', relaunch: true } });
    assert.equal(r3.cells[0].error, code);
  }
  // An app that refuses or still asks at the deadline fails its quit cell, and the run is not qualified.
  const c = clock(), driver = fakeDriver({ now: c.now, relaunchQuit: 'running' });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), io: quietIo(), clock: c,
    options: { mode: 'dry-run', relaunch: true } });
  assert.equal(receipt.cells.find(cell => cell.id === 'relaunch-quit').error, 'QUIT_RUNNING');
  // A relaunch receipt claiming a temporary profile, or a benchmark receipt on the own profile, fails isolation.
  assert.ok(validateReceipt({ ...receipt, profile: { temporary: true } }).errors.includes('ISOLATION_FAILED'));
  assert.ok(validateReceipt(receiptWith(requiredCells(APPS.vscode).map(id => passed(id)), { profile: { temporary: false } })).errors.includes('ISOLATION_FAILED'));
  const out = temp(t);
  assert.equal(await main(['--dry-run', '--relaunch', '--apps', 'vscode,cursor', '--out', out], { io: quietIo({ acquireLock: async () => { throw Error('took the lock'); } }), log: () => {} }), 0);
  assert.equal(readdirSync(out).filter(name => name.includes('-relaunch-dry-run-')).length, 2);
});
