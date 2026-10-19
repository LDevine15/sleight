import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext, createContext, runInContext, constants } from 'node:vm';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync, linkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { actionOutcome, renderOutcomes, ActionLog, actionLogPath } from '../plugins/sleight/lib/action-outcomes.mjs';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { replSetupCode } from '../plugins/sleight/lib/repl-warmup.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { outcomeOptions } from '../plugins/sleight/lib/launch.mjs';
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-outcomes-')));
after(() => removeTemp(dir));

// Shapes replayed from recorded native results (textedit-save, word-edit, excel-edit, 2026-10-18), cut to the lines that matter.
const window = { title: 'notes.txt', app: 'TextEdit', url: 'file:///tmp/notes.txt' };
const tree = (rows, { title = window.title, app = window.app, url = window.url, focus } = {}) =>
  `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}, Secondary Actions: Raise${url ? `, URL: ${url}` : ''}\n${rows}` +
  (focus ? `\n\nThe focused UI element is ${focus}` : '');
const editor = (value = '', extra = '') => tree(`\t1 scroll area\n\t\t2 text entry area (settable) ${value ? `Value: ${value}, ID: First Text View` : 'First Text View'}${extra}\n\t5 close button\n11 menu bar\n\t12 TextEdit\n\t13 File`,
  { focus: `2 text entry area (settable) ${value ? `Value: ${value}, ID: First Text View` : 'First Text View'}` });
const form = (name = '', checked = '0', extra = '') => tree(`\t1 text field (settable) Description: Name, Value: ${name}\n\t2 check box Remember me, Value: ${checked}\n\t3 button Save…\n\t4 secure text field (settable) Description: Password, Value: ••••${extra}`,
  { focus: '1 text field (settable) Description: Name, Value: ' + name });
const saveSheet = form('', '0', '\n\t20 sheet Save, ID: save-panel\n\t\t21 text field (settable) Description: Save As:, Value: notes, ID: saveAsNameTextField\n\t\t22 button Save');

test('a click that opens a sheet names the sheet', () => {
  const { facts, targets } = actionOutcome([{ a: 'click', n: 3, body: 'button Save…' }], form(), saveSheet);
  assert.deepEqual(facts[0], { o: 'opened', d: 'sheet "Save"' });
  assert.deepEqual(targets[0], { r: 'button', m: 'Save…' });
});

test('setValue shows the control\'s own value, or that it holds what was set without repeating it', () => {
  const before = tree('\t31 text field (settable) Description: Zoom, Value: 36');
  const after = tree('\t31 text field (settable) Description: Zoom, Value: 37');
  assert.deepEqual(actionOutcome([{ a: 'setValue', n: 31, body: 'text field (settable) Description: Zoom, Value: 36', want: '37' }], before, after).facts,
    [{ o: 'value', m: true, d: '37' }]);
  assert.deepEqual(actionOutcome([{ a: 'setValue', n: 31, body: 'text field (settable) Description: Zoom, Value: 36', want: '40' }], before, after).facts,
    [{ o: 'value', m: false, d: '37' }]);
  // Unchanged but already equal: it holds.
  assert.deepEqual(actionOutcome([{ a: 'setValue', n: 31, body: 'text field (settable) Description: Zoom, Value: 37', want: '37' }], after, after).facts,
    [{ o: 'value', m: true, d: '37' }]);
});

test('a key with no effect reads as no visible change', () => {
  assert.deepEqual(actionOutcome([{ a: 'pressKey', k: 'Return' }], editor('draft'), editor('draft')).facts, [{ o: 'none' }]);
});

test('typing names the focused field and never repeats the typed text', () => {
  const { facts, targets } = actionOutcome([{ a: 'typeText', c: 5, focus: 1, body: 'text field (settable) Description: Name, Value: ' }], form(''), form('Alice'));
  assert.deepEqual(targets[0], { r: 'text field', m: 'Name' });
  assert.deepEqual(facts, [{ o: 'value' }]);
  assert.doesNotMatch(JSON.stringify(facts), /Alice/);
});

test('secure fields and text areas never show a value', () => {
  const secure = 'secure text field (settable) Description: Password, Value: ••••';
  const { facts, targets } = actionOutcome([{ a: 'setValue', n: 4, body: secure, want: 'hunter2' }], form(), form('', '0', '•'));
  assert.equal(targets[0].s, true);
  // A secure field's value isn't shown, so the action stays unverified, even with no visible change.
  assert.equal(facts, undefined);
  assert.equal(actionOutcome([{ a: 'setValue', n: 4, body: secure, want: 'x' }], form(), form()).facts, undefined);
  // The platform's subrole first, then bullets, then names.
  for (const body of ['text field (settable) Description: Code, Subrole: AXSecureTextField', 'text field Value: ••••••', 'text field Description: PIN',
    'text field Recovery key', 'text field Description: Verification code']) assert.equal(actionOutcome([{ body }]).targets[0].s, true, body);
  assert.equal(actionOutcome([{ body: 'tab Secret plans.pdf' }]).targets[0].s, undefined);
  const area = actionOutcome([{ a: 'setValue', n: 2, body: 'text entry area (settable) First Text View', want: 'whole document' }], editor(''), editor('whole document'));
  assert.deepEqual(area.facts, [{ o: 'value', m: true }]);
});

test('a check box, a window change, a menu, focus and other lines each get their own fact', () => {
  assert.deepEqual(actionOutcome([{ a: 'click', n: 2, body: 'check box Remember me, Value: 0' }], form(), form('', '1')).facts, [{ o: 'state', d: 'checked' }]);
  const renamed = editor('draft').replace(/notes\.txt/g, 'notes 2.txt');
  assert.deepEqual(actionOutcome([{ a: 'pressKey', k: 'super+s' }], editor('draft'), renamed).facts[0], { o: 'window', d: '[redacted 11 chars]' });
  const menu = editor('draft', '\n\t30 menu Secondary Actions: Cancel\n\t\t31 menu item New\n\t\t32 menu item Open…');
  assert.deepEqual(actionOutcome([{ a: 'click', n: 13, body: 'File' }], editor('draft'), menu).facts, [{ o: 'menu', d: '2' }]);
  assert.deepEqual(actionOutcome([{ a: 'pressKey', k: 'Escape' }], menu, editor('draft')).facts, [{ o: 'menu-' }]);
  const tabbed = form().replace(/The focused UI element is .*$/, 'The focused UI element is 2 check box Remember me, Value: 0');
  assert.deepEqual(actionOutcome([{ a: 'pressKey', k: 'Tab' }], form(), tabbed).facts, [{ o: 'focus', d: 'check box [redacted 11 chars]' }]);
  const more = form().replace('\t3 button Save…', '\t3 button Save…\n\t9 text Saved');
  assert.deepEqual(actionOutcome([{ a: 'click', n: 3, body: 'button Save…' }], form(), more).facts, [{ o: 'lines', d: '1' }]);
});

test('names show only as generic control words; tab, link, menu item and window names become lengths', () => {
  assert.deepEqual(actionOutcome([{ body: 'tab Q3 board deck.key' }, { body: 'link Read the memo' }, { body: 'menu item Report-2026.docx' },
    { body: 'button Cancel' }, { body: 'button Save As…' }]).targets,
  [{ r: 'tab', ml: 17 }, { r: 'link', ml: 13 }, { r: 'menu item', ml: 16 }, { r: 'button', m: 'Cancel' }, { r: 'button', m: 'Save As…' }]);
  const named = form('', '0', '\n\t20 sheet Delete “Taxes 2026.pdf”?');
  assert.deepEqual(actionOutcome([{ a: 'click', n: 3, body: 'button Save…' }], form(), named).facts, [{ o: 'opened', d: 'sheet [redacted 24 chars]' }]);
  assert.equal(renderOutcomes({ outcomes: [{ a: 'typeText', c: 3, t: { r: 'combo box', ml: 15 }, f: [{ o: 'value' }] }] }),
    'sleight outcomes:\n1 typeText 3 chars into combo box [redacted 15 chars]: value changed');
});

test('a menu tree is an open menu, not a new window, and a root that turns into a dialog is not a sheet (word-edit, 2026-10-18)', () => {
  const doc = tree('\t1 menu bar\n\t\t2 Edit\n\t3 button Find', { title: 'Report  -  Compatibility Mode', app: 'Microsoft Word' });
  const menuTree = 'Window: "Report  -  Compatibility Mode", App: Microsoft Word.\n0 Edit, ID: EditMenu_MenuItem, Secondary Actions: Cancel, Pick\n\t1 menu item Undo\n\t2 menu item Find';
  assert.deepEqual(actionOutcome([{ a: 'click', n: 2, body: 'Edit' }], doc, menuTree).facts, [{ o: 'menu', d: '2' }]);
  assert.deepEqual(actionOutcome([{ a: 'click', n: 2, body: 'menu item Find' }], menuTree, doc).facts, [{ o: 'menu-' }]);
  const pane = doc.replace('0 standard window', '0 dialog');
  assert.deepEqual(actionOutcome([{ a: 'pressKey', k: 'cmd+h' }], doc, pane).facts, [{ o: 'lines', d: '2' }]);
});

test('without a read on either side there is nothing to verify', () => {
  const { facts, targets } = actionOutcome([{ a: 'click', n: 3, body: 'button Save…' }], undefined, form());
  assert.equal(facts, undefined);
  assert.deepEqual(targets, [{ r: 'button', m: 'Save…' }]);
});

test('rendered outcomes are one short line per action, group actions that shared a read, and list what never ran', () => {
  const text = renderOutcomes({ planned: 6, outcomes: [
    { a: 'click', n: 12, f: [{ o: 'opened', d: 'sheet "Save"' }] },
    { a: 'setValue', n: 31, c: 2, f: [{ o: 'value', m: false, d: '36' }] },
    { a: 'pressKey', k: 'Return', f: [{ o: 'none' }] },
    { a: 'typeText', c: 14, t: { r: 'text field', m: 'Name' } },
    { a: 'pressKey', k: 'Return', x: 'refused', r: 'window changed' },
  ] });
  assert.equal(text, [
    'sleight outcomes:',
    '1 click 12: sheet "Save" opened',
    '2 setValue 31 2 chars: value reads "36"',
    '3 pressKey "Return": no visible change',
    '4 typeText 14 chars into text field "Name": ran, unverified',
    '5 pressKey "Return": not run (window changed)',
    '6: not run (stopped after 4)',
  ].join('\n'));
  assert.equal(renderOutcomes({ outcomes: [
    { a: 'paste', c: 16, g: true }, { a: 'pressKey', k: 'super+s', f: [{ o: 'value' }] }] }),
  'sleight outcomes:\n1 paste 16 chars, 2 pressKey "super+s": value changed');
  assert.equal(renderOutcomes({ outcomes: [] }), undefined);
  assert.doesNotMatch(renderOutcomes({ planned: 3, outcomes: [{ a: 'click', n: 1, x: 'refused' }] }, { notSent: true }), /stopped after/);
});

test('a continued call shows the head without the action sleight sends again, and numbers the rest after it', () => {
  const head = { planned: 3, outcomes: [{ a: 'click', n: 4, f: [{ o: 'menu', d: '5' }] }, { a: 'click', n: 9, x: 'refused', r: 'window changed' }] };
  assert.equal(renderOutcomes(head, { continuing: true }), 'sleight outcomes:\n1 click 4: menu opened (5 items)');
  assert.equal(renderOutcomes({ planned: 2, outcomes: [{ a: 'click', n: 9, f: [{ o: 'menu-' }] }, { a: 'pressKey', k: 'Return', x: 'refused' }] }, { start: 1 }),
    'sleight outcomes:\n2 click 9: menu closed\n3 pressKey "Return": not run (stopped)');
});

test('SLEIGHT_PROMPT=lean shortens every outcome phrase, on every line', () => {
  const text = renderOutcomes({ planned: 4, outcomes: [
    { a: 'pressKey', k: 'Tab', f: [{ o: 'none' }] }, { a: 'pressKey', k: 'Tab', f: [{ o: 'none' }] },
    { a: 'setValue', n: 3, c: 1, f: [{ o: 'value', m: true }] }, { a: 'click', n: 9, x: 'failed' }] });
  assert.equal(promptNotice(text, 'lean'), 'outcomes:\n1 pressKey "Tab": no change\n2 pressKey "Tab": no change\n3 setValue 3 1 chars: holds it\n4 click 9: failed, maybe partly');
  assert.equal(promptNotice(text), text);
});

// The guard in the engine's JavaScript, run in a vm against a fake app whose tree each action changes.
function engine(states) {
  let at = 0;
  const output = [];
  const raw = {
    async getAXState() { return states[Math.min(at, states.length - 1)]; },
    async getAXStateAndScreenshot() { return { state: states[Math.min(at, states.length - 1)] }; },
  };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']) {
    raw[name] = async (...args) => { if (args[0] === 99) throw new Error('99 is an invalid element ID'); at++; };
  }
  const context = { app: raw, rawApp: raw, setTimeout, clearTimeout, cua: { getApp: async () => raw, listApps: async () => [] }, nodeRepl: { write: value => output.push(value), emitImage: async () => {} } };
  const run = (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, window, 'changed window', undefined,
    { focused: true, adoptUrl: true, ...(options.outcomeMark ? { outcomes: true } : {}), ...options })} })()`, context);
  const records = mark => output.filter(line => typeof line === 'string' && line.startsWith(mark)).map(line => JSON.parse(line.slice(mark.length)));
  return { run, output, records };
}
const MARK = '[sleight:filtered-read:0123456789abcdef]';

test('the guard records each action with the read that followed it, and sends no typed text', async () => {
  const f = engine([form(), saveSheet, editor('draft').replace(/notes\.txt/g, 'report.txt')]);
  // A sheet's field is new to Claude, so the call names it by ID (the guard refuses numbers it never showed).
  await f.run('await app.click(3); await app.setValue({ id: "saveAsNameTextField" }, "report"); await app.pressKey("Return");', { outcomeMark: MARK, actions: ['click', 'setValue', 'pressKey'] });
  const [record] = f.records(MARK).slice(-1);
  assert.equal(record.planned, 3);
  assert.deepEqual(record.outcomes.map(rec => rec.a), ['click', 'setValue', 'pressKey']);
  assert.deepEqual(record.outcomes[0].f, [{ o: 'opened', d: 'sheet "Save"' }]);
  // Return after setValue goes ahead without a read, so the read after Return settles both.
  assert.equal(record.outcomes[1].g, true);
  assert.deepEqual(record.outcomes[2].f, [{ o: 'window', d: '[redacted 10 chars]' }, { o: 'closed', d: 'sheet' }]);
  assert.equal(record.outcomes[1].c, 6);
  assert.equal(record.outcomes[1].l, 'saveAsNameTextField');
  assert.equal(record.outcomes[1].n, 21);
  assert.equal(record.app, 'TextEdit');
  assert.doesNotMatch(JSON.stringify(record), /"want"|"body"/);
});

test('actions with no read between them share the read that came after, and a stop is recorded as not run', async () => {
  const f = engine([editor(''), editor(''), editor('fixture'), editor('fixture')]);
  await f.run('await app.click(2); await app.paste("fixture"); await app.pressKey("super+s");', { outcomeMark: MARK, actions: ['click', 'paste', 'pressKey'] });
  const outcomes = f.records(MARK).at(-1).outcomes;
  assert.equal(outcomes[1].g, true);
  assert.deepEqual(outcomes[2].f, [{ o: 'value' }]);
  const stopped = engine([form()]);
  await stopped.run('await app.click(3); await app.click(99);', { outcomeMark: MARK, actions: ['click', 'click'] }).catch(() => {});
  const last = stopped.records(MARK).at(-1).outcomes;
  assert.equal(last[1].x, 'failed');
  const refused = engine([form()]);
  await refused.run('await app.click({ label: "Nope" });', { outcomeMark: MARK, actions: ['click'] }).catch(() => {});
  assert.deepEqual(refused.records(MARK).at(-1).outcomes[0], { a: 'click', l: 'Nope', x: 'refused', r: 'element not found' });
});

test('without the mark the guard writes no outcome records', async () => {
  const f = engine([form(), saveSheet]);
  await f.run('await app.click(3);');
  assert.ok(f.output.every(line => !String(line).includes('"outcomes"')));
});

test('the compactor shows outcomes in place of the UI-changed note only when they are on', () => {
  const content = outcomes => [{ type: 'text', text: `${MARK}${JSON.stringify(outcomes)}\n${saveSheet}` }];
  const record = { planned: 1, outcomes: [{ a: 'click', n: 3, f: [{ o: 'opened', d: 'sheet "Save"' }] }] };
  for (const on of [true, false]) {
    const compactor = createReadCompactor({ outcomes: on });
    compactor.process([{ type: 'text', text: form() }]);
    const action = compactor.beginAction('await app.click(3);');
    const text = compactor.process(content(record), { action, code: 'await app.click(3);', filterMark: MARK }).map(item => item.text).join('\n');
    assert.doesNotMatch(text, /filtered-read/);
    if (on) {
      assert.match(text, /sleight outcomes:\n1 click 3: sheet "Save" opened/);
      assert.doesNotMatch(text, /UI changed/);
    } else {
      assert.doesNotMatch(text, /sleight outcomes/);
      assert.match(text, /UI changed \(sheet or dialog\)/);
    }
    assert.deepEqual(compactor.takeOutcomes(), record);
    assert.equal(compactor.takeOutcomes(), undefined);
  }
});

// The relay end to end: its guarded code runs in the fake engine, and the engine's output is the reply.
function relayHarness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => received.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory: mkdtempSync(join(dir, 'lease-')), holder: 'outcomes-test' }), ...options });
  t.after(() => relay.dispose());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { sent, received,
    async call(id, code, name = 'js', args = { code }) {
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      await flush();
    },
    async reply(id, text, isError = false) {
      serverOut.write(JSON.stringify({ id, result: { isError, content: [{ type: 'text', text }], _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
      await flush();
      return received.find(row => row.id === id)?.result;
    },
    sentCode: id => sent.find(message => message.id === id)?.params?.arguments?.code,
  };
}

test('SLEIGHT_OUTCOMES=1 and SLEIGHT_ACTION_LOG reach the relay; both are off by default', () => {
  assert.deepEqual(outcomeOptions({}), { outcomes: false, actionLog: undefined });
  const options = outcomeOptions({ SLEIGHT_OUTCOMES: '1', SLEIGHT_ACTION_LOG: 'env.jsonl' });
  assert.equal(options.outcomes, true);
  assert.ok(options.actionLog instanceof ActionLog);
  assert.equal(options.actionLog.path, join(homedir(), 'Library/Logs/sleight/env.jsonl'));
  assert.equal(outcomeOptions({ SLEIGHT_ACTION_LOG: '/tmp/elsewhere.jsonl' }).actionLog, undefined);
});

test('the relay asks the guard for outcomes and shows them under SLEIGHT_OUTCOMES=1, and logs each action without typed text', async t => {
  const path = join(dir, 'relay.jsonl');
  const h = relayHarness(t, { outcomes: true, actionLog: new ActionLog({ path, root: dir }) });
  await h.call(1, 'let app = await cua.getApp("TextEdit")');
  await h.reply(1, form());
  await h.call(2, 'await app.click(1); await app.typeText("Alice"); await app.pressKey("Tab"); await app.setValue(4, "hunter2");');
  const code = h.sentCode(2);
  assert.match(code, /"outcomeMark":"\[sleight:filtered-read:[0-9a-f]{16}\]"/);
  // The engine's side: the guard with the relay's mark, against a fake handle.
  const onBox = text => text.replace(/The focused UI element is .*$/, 'The focused UI element is 2 check box Remember me, Value: 0');
  const g = engine([form(), form(), form('Alice'), onBox(form('Alice')), onBox(form('Alice', '0', '•'))]);
  const mark = /"outcomeMark":"(\[sleight:filtered-read:[0-9a-f]{16}\])"/.exec(code)[1];
  await g.run('await app.click(1); await app.typeText("Alice"); await app.pressKey("Tab"); await app.setValue(4, "hunter2");', { outcomeMark: mark, actions: ['click', 'typeText', 'pressKey', 'setValue'] });
  const result = await h.reply(2, g.output.join(''));
  const text = result.content.map(item => item.text).join('\n');
  // Tab after typing skips its read (the owner's speed rule), so the read before setValue settles both.
  assert.match(text, /sleight outcomes:\n1 click 1: no visible change\n2 typeText 5 chars into text field "Name", 3 pressKey "Tab": value changed; focus on check box \[redacted 11 chars\]\n4 setValue 4: ran, unverified/);
  assert.doesNotMatch(text, /filtered-read/);
  const log = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(row => [row.call, row.tool, row.app, row.kind, row.result, row.outcome]), [
    [2, 'js', 'TextEdit', 'click', 'ok', 'no visible change'],
    [2, 'js', 'TextEdit', 'typeText', 'ok', 'checked with the next action'],
    [2, 'js', 'TextEdit', 'pressKey', 'ok', 'value changed; focus moved'],
    [2, 'js', 'TextEdit', 'setValue', 'ok', 'unverified'],
  ]);
  assert.deepEqual(log[1].target, { role: 'text field', name: 'Name' });
  assert.deepEqual(log[3].target, { role: 'secure text field', secure: true });
  assert.equal(log[2].key, 'Tab');
  assert.equal(log[1].chars, 5);
  assert.equal(log[3].chars, undefined); // a secure field's length stays out too
  assert.ok(log.every(row => typeof row.time === 'string' && !Number.isNaN(Date.parse(row.time))));
  assert.doesNotMatch(readFileSync(path, 'utf8'), /Alice|hunter2|••/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('outcomes stay out of results by default while the log still gets them', async t => {
  const path = join(dir, 'quiet.jsonl');
  const h = relayHarness(t, { actionLog: new ActionLog({ path, root: dir }) });
  await h.call(1, 'let app = await cua.getApp("TextEdit")');
  await h.reply(1, form());
  await h.call(2, 'await app.click(2);');
  const mark = /"outcomeMark":"(\[sleight:filtered-read:[0-9a-f]{16}\])"/.exec(h.sentCode(2))?.[1];
  assert.ok(mark);
  const g = engine([form(), form('', '1')]);
  await g.run('await app.click(2);', { outcomeMark: mark, actions: ['click'] });
  const text = (await h.reply(2, g.output.join(''))).content.map(item => item.text).join('\n');
  assert.doesNotMatch(text, /sleight outcomes|filtered-read/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8').trim()).outcome, 'now checked');
});

test('without either switch the relay sends no outcome mark', async t => {
  const h = relayHarness(t);
  await h.call(1, 'let app = await cua.getApp("TextEdit")');
  await h.reply(1, form());
  await h.call(2, 'await app.click(2);');
  assert.doesNotMatch(h.sentCode(2), /"outcomeMark":/);
});

test('the log carries what was refused and why, with the category and not the notice text', async t => {
  const path = join(dir, 'refused.jsonl');
  const h = relayHarness(t, { actionLog: new ActionLog({ path, root: dir }) });
  await h.call(1, 'let app = await cua.getApp("TextEdit")');
  await h.reply(1, form());
  await h.call(2, 'await app.click(3);');
  await h.reply(2, 'Input lease stopped this action: window or URL changed. Read the intended window again before acting. Observed {"title":"secret.txt"}', true);
  await h.call(3, 'await app.click(3);', 'drag', { app: 'TextEdit', from: 1, to: 2 });
  await h.reply(3, 'dragged');
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.call, row.tool, row.kind, row.result, row.reason ?? row.outcome]), [
    [2, 'js', 'call', 'refused', 'window changed'],
    [3, 'drag', 'drag', 'ok', 'done'],
  ]);
  assert.equal(rows[1].app, 'TextEdit');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /secret\.txt/);
});

test('turbo steps are logged by origin with their outcome category, never page text or typed values', () => {
  const path = join(dir, 'turbo.jsonl');
  const log = new ActionLog({ path, root: dir, now: () => new Date(0) }); // a fixed clock, so the time can't match a value below
  log.request({ id: 7, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'http://127.0.0.1:5413/settings?token=abc' } } });
  log.reply({ id: 7, result: { content: [{ type: 'text', text: 't2ef http://127.0.0.1:5413\nTitle (untrusted page content): Private' }] } });
  log.request({ id: 8, method: 'tools/call', params: { name: 'browser_act', arguments: { tab: 't2ef', steps: [{ do: 'type', ref: 'e15', text: 'p07' }, { do: 'click', ref: 'e38' }, { do: 'press', ref: 'e38', key: 'Enter' }] } } });
  log.reply({ id: 8, result: { content: [{ type: 'text', text: '1 type e15: 16 lines changed (batch observation below)\n2 click e38: navigated, address (untrusted page content): http://localhost:5414/done?p07\n3 press e38: not reached\n# Changes since snapshot 1' }] } });
  log.request({ id: 9, method: 'tools/call', params: { name: 'browser_fill', arguments: { tab: 't2ef', fields: [{ ref: 'e45', value: 37 }] } } });
  log.reply({ id: 9, result: { content: [{ type: 'text', text: 'e45: set\nsubmit: not requested' }] } });
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.call, row.origin, row.kind, row.target?.ref, row.result, row.outcome ?? row.reason]), [
    [7, 'http://127.0.0.1:5413', 'open', undefined, 'ok', 'opened'],
    [8, 'http://127.0.0.1:5413', 'type', 'e15', 'ok', 'changed'],
    [8, 'http://127.0.0.1:5413', 'click', 'e38', 'ok', 'navigated'],
    [8, 'http://localhost:5414', 'press', 'e38', 'not run', 'earlier step stopped'],
    [9, 'http://localhost:5414', 'fill', 'e45', 'ok', 'set'],
  ]);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /p07|token|Private|done|"37"|:37/);
});

test('the log rotates by size, keeps two old files, and refuses a symlink', () => {
  const path = join(dir, 'rotate.jsonl');
  const log = new ActionLog({ path, root: dir, maxBytes: 400 });
  for (let id = 0; id < 30; id++) {
    log.request({ id, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit', from: 1, to: 2 } } });
    log.reply({ id, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
  assert.ok(statSync(path).size <= 400 + 200);
  assert.ok(existsSync(path + '.1') && existsSync(path + '.2'));
  assert.ok(!existsSync(path + '.3'));
  const target = join(dir, 'elsewhere.jsonl'), link = join(dir, 'link.jsonl');
  writeFileSync(target, '');
  symlinkSync(target, link);
  const linked = new ActionLog({ path: link, root: dir });
  linked.request({ id: 1, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit' } } });
  linked.reply({ id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal(readFileSync(target, 'utf8'), '');
});

// The relay's own guarded code run in a vm (as in tt1n-input-lease.test.mjs), for a call sleight continues after a stop.
async function continued(t, options) {
  const navigation = 'Window: "Parent", App: Fixture Editor.\n0 standard window Parent, URL: file:///tmp/Parent\n\t2 row Child, ID: child\n\t3 button Other';
  const child = navigation.replaceAll('Parent', 'Child');
  let text = navigation, writes = [];
  const raw = { getAXState: async () => text, getAXStateAndScreenshot: async () => ({ state: text }),
    click: async () => { text = child; }, pressKey: async () => { text = child; } };
  const context = createContext({ cua: { getApp: async () => raw, listApps: async () => [{ id: 'org.test.editor', windows: [{ title: 'Parent' }] }] },
    nodeRepl: { write: value => writes.push(String(value)) } });
  const streams = Array.from({ length: 4 }, () => new PassThrough()), [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, runningProbe: () => ({ status: 'responding' }),
    inputLease: new InputLease({ directory: mkdtempSync(join(dir, 'lease-')), holder: 'outcomes continuation' }),
    windowIdentity: async expected => ({ ...expected, windowNumber: 22, hidIdleSeconds: 1000, status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 }),
    ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let next = 0, cursor = 0;
  const call = async code => {
    const id = ++next;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    for (let i = 0; i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
        let error;
        try { await runInContext(`(async () => { ${request.params.arguments.code} })()`, context, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = e; }
        if (/cua\.getApp\(/.test(request.params.arguments.code) && !error) writes.push(text);
        if (error) writes.push(String(error));
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: !!error, content: [{ type: 'text', text: writes.join('\n') }],
          _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } } } } }) + '\n');
      }
      const reply = received.find(msg => msg.id === id);
      if (reply) return reply.result;
    }
    throw new Error('no client result');
  };
  await call('await cua.getApp("Fixture Editor");');
  sent.length = 0; cursor = 0; text = navigation;
  return { call, sent };
}

test('a call sleight continues after its stop shows each action once, numbered across the continuation, and logs no refusal', async t => {
  const path = join(dir, 'continued.jsonl');
  const h = await continued(t, { outcomes: true, actionLog: new ActionLog({ path, root: dir }) });
  const result = await h.call('await app.pressKey("Return"); await app.pressKey("Tab");');
  assert.notEqual(result.isError, true);
  assert.equal(h.sent.length, 2, 'the stop and its continuation');
  const text = result.content.map(item => item.text).join('\n');
  assert.match(text, /sleight outcomes:\n1 pressKey "Return": window now \[redacted 5 chars\]/);
  assert.match(text, /sleight outcomes:\n2 pressKey "Tab": no visible change/);
  assert.doesNotMatch(text, /not run|filtered-read/);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.kind, row.key, row.result, row.outcome]), [['pressKey', 'Return', 'ok', 'window changed'], ['pressKey', 'Tab', 'ok', 'no visible change']]);
});

test('typing with no known plain field target keeps its length out, and so does a secure field', async () => {
  const noFocus = text => text.replace(/\n\nThe focused UI element is .*$/, '');
  const f = engine([noFocus(form()), noFocus(form())]);
  await f.run('await app.typeText("123456");', { outcomeMark: MARK, actions: ['typeText'] });
  assert.deepEqual(f.records(MARK).at(-1).outcomes[0], { a: 'typeText', f: [{ o: 'none' }] });
  const pin = form().replace(/The focused UI element is .*$/, 'The focused UI element is 1 text field (settable) Description: PIN, Value: ');
  const g = engine([pin, pin]);
  await g.run('await app.typeText("4821");', { outcomeMark: MARK, actions: ['typeText'] });
  assert.deepEqual(g.records(MARK).at(-1).outcomes[0], { a: 'typeText', t: { r: 'text field', s: true } });
});

test('a read the engine took without settling can\'t say "no visible change"', async () => {
  for (const settled of [true, false]) {
    const f = engine([form(), form()]);
    await f.run(`await app.click(3); globalThis.__sleightDocumentGuard.noteRead(rawApp, await rawApp.getAXState(), ${settled});`, { outcomeMark: MARK, actions: ['click'] });
    assert.deepEqual(f.records(MARK).at(-1).outcomes[0].f, settled ? [{ o: 'none' }] : undefined);
  }
});

test('an action that completed keeps its outcome when a later guard check throws', async () => {
  const f = engine([form(), form('', '1')]);
  await f.run('const g = globalThis.__sleightDocumentGuard, keep = g.keepOutcome; g.keepOutcome = (...args) => { keep(...args); throw new Error("later check"); }; await app.click(2).catch(() => {});',
    { outcomeMark: MARK, actions: ['click'] });
  const [rec] = f.records(MARK).at(-1).outcomes;
  assert.equal(rec.x, undefined);
  assert.deepEqual(rec.f, [{ o: 'state', d: 'checked' }]);
});

test('with both switches off the guard carries none of the outcome code', () => {
  const pieces = /actionOutcome|noteRead|outcomeRec|keepOutcome|flushOutcomes|refusalOf|attempt\.sent|attempt\.completed|outcomeMark/;
  for (const code of [guardedCode('await app.click(1);', window), readCode('void 0;', { acknowledge: true }), replSetupCode()]) assert.doesNotMatch(code, pieces);
  for (const code of [guardedCode('await app.click(1);', window, 'changed', undefined, { outcomes: true, outcomeMark: MARK }), readCode('void 0;', { outcomes: true }),
    replSetupCode({ outcomes: true })]) assert.match(code, /actionOutcome/);
});

test('the REPL warmup installs the outcome code when a switch is on, so later calls reusing the setup have it', async t => {
  for (const on of [true, false]) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [];
    serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, warmRepl: true,
      ...(on ? { actionLog: new ActionLog({ path: join(dir, 'warm.jsonl'), root: dir }) } : {}) });
    t.after(() => relay.dispose());
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { capabilities: {} } }) + '\n');
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    const warm = sent.find(message => String(message.id).startsWith('sleight-warm-'));
    assert.ok(warm, 'warmup sent');
    assert.equal(/actionOutcome/.test(warm.params.arguments.code), on);
  }
});

test('the log path stays under ~/Library/Logs/sleight/', () => {
  const home = '/Users/someone', root = '/Users/someone/Library/Logs/sleight';
  assert.equal(actionLogPath('actions.jsonl', home), root + '/actions.jsonl');
  assert.equal(actionLogPath('~/Library/Logs/sleight/runs/a.jsonl', home), root + '/runs/a.jsonl');
  assert.equal(actionLogPath(root + '/b.jsonl', home), root + '/b.jsonl');
  for (const value of ['~/x.jsonl', '/tmp/x.jsonl', '~/Library/Logs/sleight/../x.jsonl', 'runs/a.jsonl', '..', '~/Library/Logs/sleight', '']) {
    assert.equal(actionLogPath(value, home), undefined, value);
  }
});

test('the log makes its file 0600, writes only a regular file, and never through a symlinked folder', () => {
  const root = mkdtempSync(join(dir, 'root-')), loose = join(root, 'loose.jsonl'), fresh = join(root, 'fresh.jsonl');
  writeFileSync(loose, ''); chmodSync(loose, 0o644);
  const write = (path, id = 1) => {
    const log = new ActionLog({ path, root });
    log.request({ id, method: 'tools/call', params: { name: 'drag', arguments: { app: 'TextEdit' } } });
    log.reply({ id, result: { content: [{ type: 'text', text: 'ok' }] } });
    return log.failures;
  };
  assert.equal(write(fresh), 0);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
  // A file the log didn't create must already be 0600.
  assert.equal(write(loose), 1);
  assert.equal(readFileSync(loose, 'utf8'), '');
  mkdirSync(join(root, 'folder.jsonl'));
  assert.equal(write(join(root, 'folder.jsonl')), 1);
  const outside = mkdtempSync(join(dir, 'outside-'));
  symlinkSync(outside, join(root, 'away'));
  assert.equal(write(join(root, 'away', 'a.jsonl')), 1);
  assert.ok(!existsSync(join(outside, 'a.jsonl')));
});

test('a hard link at the log path is refused, so a row can never land in another file', () => {
  const root = mkdtempSync(join(dir, 'hard-')), rc = join(root, 'zshrc'), link = join(root, 'linked.jsonl');
  writeFileSync(rc, 'export A=1\n'); chmodSync(rc, 0o600);
  linkSync(rc, link);
  const log = new ActionLog({ path: link, root });
  log.request({ id: 1, method: 'tools/call', params: { name: 'menu_bar', arguments: { op: 'open' } } });
  log.reply({ id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal(log.failures, 1);
  assert.equal(readFileSync(rc, 'utf8'), 'export A=1\n');
});

test('kind, key, role, reason, tool, app and origin come from fixed words or are cleaned, never Claude\'s raw text', () => {
  const root = mkdtempSync(join(dir, 'vocab-')), path = join(root, 'vocab.jsonl');
  const log = new ActionLog({ path, root, names: [], now: () => new Date(0) });
  const call = (id, name, args, text = 'ok', record) => {
    log.request({ id, method: 'tools/call', params: { name, arguments: args } });
    if (record) log.outcomes(id, record);
    log.reply({ id, result: { content: [{ type: 'text', text }] } });
  };
  call(1, 'menu_bar', { op: 'open $(touch /tmp/x)', app: 'Text$(id)`id`Edit' });
  call(2, 'menu_bar', { op: 'choose', app: 'TextEdit' });
  call(3, 'js', { code: '' }, 'ok', { app: 'A$(id)', outcomes: [
    { a: 'click$(id)', t: { r: 'button $(id)' }, k: 'cmd+$(id)', x: 'refused', r: 'window $(id)' },
    { a: 'pressKey', k: 'cmd+s', t: { r: 'text field', m: 'Save' }, f: [{ o: 'opened', d: 'sheet$(id)' }] }] });
  call(4, 'browser_open', { url: 'http://$(id).example/' }, 't1 http://$(id).example/');
  call(5, 'browser_act', { tab: 't9' }, '1 evaluate e2: no visible change\n2 click e3: no visible change');
  call(6, 'tool$(id)', {});
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /[$`\\]|touch/);
  const rows = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].app, 'Text(id)idEdit');
  assert.deepEqual(rows.map(row => [row.tool, row.kind]), [['menu_bar', 'menu_bar'], ['menu_bar', 'menu_bar choose'], ['js', 'action'], ['js', 'pressKey'],
    ['browser_open', 'open'], ['browser_act', 'step'], ['browser_act', 'click'], ['other', 'other']]);
  assert.equal(rows[2].target, undefined);
  assert.equal(rows[2].key, undefined);
  assert.equal(rows[2].reason, 'stopped by sleight');
  assert.equal(rows[3].key, 'cmd+s');
  assert.equal(rows[4].origin, undefined);
});
