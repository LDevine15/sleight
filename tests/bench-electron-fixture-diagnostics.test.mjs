import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS, CELLS, prepareWorkspace, runQualification, scrubReceipt } from '../bench/electron-qualification.mjs';
import { fixtureHelper } from '../bench/electron-qualification-live.mjs';
import { fakeDriver, fakeObserver } from '../bench/electron-qualification-fakes.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const clock = () => { let t = 1000; return { now: () => t, advance: ms => { t += ms; }, sleep: async ms => { t += ms; } }; };
const quietIo = { exists: () => false, permission: async () => false };
const cells = (...ids) => CELLS.filter(cell => ['consent-card', 'list', ...ids].includes(cell.id));

test('generated workspaces enable the editor accessibility prerequisite without changing their documents', t => {
  const root = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-eq-prerequisite-'))));
  const files = prepareWorkspace(root);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.vscode', 'settings.json'), 'utf8')), { 'editor.accessibilitySupport': 'on' });
  assert.deepEqual(readdirSync(root).sort(), ['.vscode', 'a-notes.md', 'a-scratch.txt', 'b-big.txt', 'rows']);
  assert.equal(readFileSync(files.scratch, 'utf8'), '');
  assert.equal(readFileSync(files.notes, 'utf8'), '# Notes\n\n- [Item one](#one)\n\n## One\n\nQualification notes.\n');
  assert.equal(readFileSync(files.big, 'utf8').split('\n').length, 1501);
  assert.equal(readdirSync(files.rows).length, 200);
});

// Selected-tab/editor excerpt from the 2026-10-21 interrupted receipt (snapshot 174).
// The run-specific absolute workspace path is replaced; labels and editor refs are retained.
const inaccessibleEditor = `- tab "a-scratch.txt, preview" [selected] [ref=e592]:
  - generic "a-scratch" [ref=e593]:
    - generic [ref=e368]: "a-scratch"
- generic "/fixture/workspace/a-scratch.txt" [ref=e598]:
  - generic [ref=e599]: "a-scratch.txt"
- generic "a-scratch.txt, preview" [ref=e601]:
  - code [ref=e602]:
    - generic [ref=e603]:
      - textbox "The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Option+F1"
      - textbox [ref=e604]`;

for (const [label, snapshot, expected] of [
  ['captured inaccessible editor', inaccessibleEditor, 'EDITOR_ACCESSIBILITY_REQUIRED'],
  ['unnamed textbox without the prerequisite warning', inaccessibleEditor.replace(/^.*textbox ".*\n/m, ''), 'EDITOR_NOT_FOUND'],
  ['warning without the selected file', inaccessibleEditor.replace(' [selected]', ''), 'EDITOR_NOT_FOUND'],
  ['warning quoted by ordinary page text', inaccessibleEditor.replace('- textbox "The editor', '- text: "The editor'), 'EDITOR_NOT_FOUND'],
]) test(`editor setup diagnoses ${label} without targeting an unnamed textbox`, async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  driver.tool = async (name, args) => {
    const result = await tool(name, args);
    if (name !== 'browser_read' || result.isError) return result;
    const terms = args.find?.toLowerCase().split('|');
    const body = terms ? snapshot.split('\n').filter(line => terms.some(term => line.toLowerCase().includes(term))).join('\n') : snapshot;
    return { ...result, text: result.text.split('\n').filter(line => line.startsWith('#')).join('\n') + '\n' + body };
  };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo, clock: c, cells: cells('key') });
  const row = receipt.cells.at(-1);
  assert.equal(row.status, 'fail');
  assert.equal(row.error, expected);
  assert.equal(row.ms, 5000, 'diagnosis must not extend the polling deadline');
  const steps = driver.calls.flatMap(call => call.args.steps ?? []);
  assert.deepEqual(steps, [{ do: 'click', ref: 'e592' }], 'only the identified file tab may be clicked');
  assert.equal(receipt.qualified, false);
});

test('accessible named editors still reach the key probe without a prerequisite diagnostic', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo, clock: c, cells: cells('key') });
  assert.equal(receipt.cells.at(-1).status, 'pass');
  assert.ok(driver.calls.some(call => call.args.steps?.some(step => step.ref === 'e3')));
  assert.ok(driver.calls.some(call => call.args.steps?.some(step => step.key === 'Meta+P')));
});

const privateText = join(tmpdir(), 'private-owner', 'private-content');
const helperReceipt = JSON.stringify({ stage: 'new-window', windows: [4100, 4101], privateText });
const normalExit = { groupClean: true, exit: { code: 0, signal: null }, stdout: helperReceipt, stderr: '' };
const expectedHelper = { expectedStage: 'new-window', matchedStage: 'new-window', groupClean: true, exitCode: 0, exitSignal: null, code: null };
for (const [label, result, expected] of [
  ['uncollected child', { ...normalExit, groupClean: false }, { ...expectedHelper, groupClean: false }],
  ['native refusal', { ...normalExit, exit: { code: 1, signal: null }, stderr: `${privateText}: execution error: Error: WINDOW_SETUP_MENU_AMBIGUOUS (-2700)` },
    { ...expectedHelper, exitCode: 1, code: 'WINDOW_SETUP_MENU_AMBIGUOUS' }],
  ['signal termination', { ...normalExit, exit: { code: null, signal: 'SIGTERM' } }, { ...expectedHelper, exitCode: null, exitSignal: 'SIGTERM' }],
  ['absent exit result', { ...normalExit, exit: undefined }, { ...expectedHelper, exitCode: null }],
  ['missing receipt', { ...normalExit, stdout: privateText }, { ...expectedHelper, matchedStage: null }],
  ['wrong receipt stage', { ...normalExit, stdout: JSON.stringify({ stage: 'ready', privateText }) }, { ...expectedHelper, matchedStage: null }],
  ['non-object JSON', { ...normalExit, stdout: `null\n${JSON.stringify(privateText)}\n` }, { ...expectedHelper, matchedStage: null }],
  ['unknown native code', { ...normalExit, exit: { code: 1 }, stderr: `Error: WINDOW_SETUP_PRIVATE_OWNER_CONTENT ${privateText}` }, { ...expectedHelper, exitCode: 1 }],
  ['ambiguous native codes', { ...normalExit, exit: { code: 1 }, stderr: 'Error: WINDOW_SETUP_REQUEST\nError: WINDOW_SETUP_TIMEOUT' }, { ...expectedHelper, exitCode: 1 }],
  ['invalid metadata', { ...normalExit, groupClean: privateText, exit: { code: privateText, signal: privateText }, stderr: privateText },
    { ...expectedHelper, groupClean: null, exitCode: null }],
  ['rejected collector', Error(privateText), { ...expectedHelper, matchedStage: null, groupClean: null, exitCode: null }],
]) test(`second-window setup preserves bounded ${label} diagnostics through the cell receipt`, async () => {
  const c = clock(), driver = fakeDriver({ now: c.now });
  let calls = 0;
  const helper = fixtureHelper(APPS.vscode.bundleId, async () => { calls++; if (result instanceof Error) throw result; return result; });
  driver.nativeSecondWindow = () => helper({ mode: 'new-window' });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo, clock: c, cells: cells('new-window') });
  const row = receipt.cells.at(-1);
  assert.equal(calls, 1, 'a failed helper is never retried');
  assert.equal(row.status, 'fail');
  assert.equal(row.error, 'FIXTURE_HELPER_UNCONFIRMED');
  assert.equal(row.setup.error, 'FIXTURE_HELPER_UNCONFIRMED');
  assert.deepEqual(row.setup.detail, { helper: expected });
  assert.deepEqual(row.detail, { helper: expected, focusTaken: false });
  assert.equal(driver.calls.some(call => call.args.steps?.some(step => step.key === 'Meta+Shift+N')), false);
  assert.doesNotMatch(JSON.stringify(scrubReceipt(receipt)), /private-owner|private-content|PRIVATE_OWNER_CONTENT|stderr|stdout/);
  assert.equal(receipt.qualified, false);
});

test('collected successful helpers preserve their receipt without failure diagnostics', async () => {
  const helper = fixtureHelper(APPS.vscode.bundleId, async () => normalExit);
  assert.deepEqual(await helper({ mode: 'new-window' }), { stage: 'new-window', windows: [4100, 4101], privateText });
});

test('native census failure keeps its fixed phase, count and original-window presence through the public receipt', async () => {
  const census = { phase: 'initial', reason: 'count', count: 3, originalPresent: null };
  const helper = fixtureHelper(APPS.vscode.bundleId, async () => ({ groupClean: true, exit: { code: 1 },
    stdout: JSON.stringify({ stage: 'new-window-failure', census, privateText }), stderr: 'Error: WINDOW_SETUP_WINDOW_CHANGED' }));
  const c = clock(), driver = fakeDriver({ now: c.now });
  driver.nativeSecondWindow = () => helper({ mode: 'new-window' });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo, clock: c, cells: cells('new-window') });
  const row = receipt.cells.at(-1);
  assert.equal(row.status, 'fail');
  assert.equal(row.error, 'FIXTURE_HELPER_UNCONFIRMED');
  assert.deepEqual(row.setup.detail.helper.census, census);
  assert.deepEqual(row.detail.helper.census, census);
  assert.doesNotMatch(JSON.stringify(scrubReceipt(receipt)), /private-owner|private-content/);
});

for (const bad of [
  { phase: privateText, reason: 'count', count: 3, originalPresent: null },
  { phase: 'initial', reason: privateText, count: 3, originalPresent: null },
  { phase: 'initial', reason: 'count', count: privateText, originalPresent: null },
  { phase: 'initial', reason: 'count', count: 66, originalPresent: null },
  { phase: 'initial', reason: 'count', count: 3, originalPresent: privateText },
  { phase: 'initial', reason: 'original-missing', count: 2, originalPresent: false },
]) test(`native census diagnostics reject malformed metadata ${JSON.stringify(bad).slice(0, 80)}`, async () => {
  const helper = fixtureHelper(APPS.vscode.bundleId, async () => ({ groupClean: true, exit: { code: 1 },
    stdout: JSON.stringify({ stage: 'new-window-failure', census: bad }), stderr: 'Error: WINDOW_SETUP_WINDOW_CHANGED' }));
  await assert.rejects(helper({ mode: 'new-window' }), error => {
    assert.equal(error.message, 'FIXTURE_HELPER_UNCONFIRMED');
    assert.equal(Object.hasOwn(error.detail.helper, 'census'), false);
    assert.doesNotMatch(JSON.stringify(error.detail), /private-owner|private-content/);
    return true;
  });
});

test('duplicate census diagnostics or a different helper failure never gain census evidence', async () => {
  const row = { stage: 'new-window-failure', census: { phase: 'initial', reason: 'count', count: 3, originalPresent: null } };
  for (const [stdout, stderr] of [[JSON.stringify(row) + '\n' + JSON.stringify(row), 'WINDOW_SETUP_WINDOW_CHANGED'],
    [JSON.stringify(row), 'WINDOW_SETUP_TIMEOUT']]) {
    const helper = fixtureHelper(APPS.vscode.bundleId, async () => ({ groupClean: true, exit: { code: 1 }, stdout, stderr }));
    await assert.rejects(helper({ mode: 'new-window' }), error => {
      assert.equal(Object.hasOwn(error.detail.helper, 'census'), false);
      return error.message === 'FIXTURE_HELPER_UNCONFIRMED';
    });
  }
});

test('a successful four-key refusal that fails the 5 px pointer gate retains the measured samples', async () => {
  const c = clock(), driver = fakeDriver({ now: c.now }), tool = driver.tool;
  driver.tool = async (name, args) => {
    const result = await tool(name, args);
    if (name === 'browser_act') c.advance(25);
    return result;
  };
  const observer = fakeObserver({ now: c.now, pointerAt: t => t >= 1050 ? 5 : 0 });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer, io: quietIo, clock: c, cells: cells('app-key-refusal') });
  const row = receipt.cells.at(-1);
  assert.equal(row.number, 4);
  assert.equal(row.status, 'fail');
  assert.equal(row.error, 'BACKGROUND_POINTER_MOVED: 5 px');
  assert.equal(row.background.covered, true);
  assert.equal(row.background.fixtureFront, 0);
  assert.deepEqual(row.background.frontmostSamples, [
    { t: 1000, front: 90, x: 100, y: 100 },
    { t: 1050, front: 90, x: 105, y: 100 },
    { t: 1100, front: 90, x: 105, y: 100 },
  ]);
  assert.equal(receipt.qualified, false);
});
