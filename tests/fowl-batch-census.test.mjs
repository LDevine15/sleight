import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchCensus, hasSourceParser, intervalUnion, roundBatchCensus } from '../bench/fowl/batch-census.mjs';

const snapshot = (rows = ['textbox "First" [ref=e1]', 'textbox "Second" [ref=e2]'], url = 'https://example.invalid/form') =>
  'Browser: Fixture · Tab: fixture:1 · Form · ' + url + '\nSnapshot 1 of this tab:\n```yaml\n' +
    rows.map(row => '- ' + row).join('\n') + '\n```';
const call = (id, name, input, t) => ({ type: 'assistant', t, message: { id: 'm-' + id,
  content: [{ type: 'tool_use', id, name: 'mcp__fowlbrowser__' + name, input }] } });
const reply = (id, content, t, error = false) => ({ type: 'user', t, message: { content: [
  { type: 'tool_result', tool_use_id: id, content, is_error: error },
] } });
function records({ middle = snapshot(), error = false, second = { tab: 'fixture:1', ref: 'e2', text: 'two' } } = {}) {
  return [call('o', 'tab_open', { url: 'https://example.invalid/form' }, 0), reply('o', snapshot(), 5),
    call('a', 'type', { tab: 'fixture:1', ref: 'e1', text: 'one' }, 10), reply('a', middle, 20, error),
    call('b', 'type', second, 30), reply('b', snapshot(), 40)];
}

test('adjacent inputs on unique previously observed controls are review candidates, with union intervals', () => {
  const out = batchCensus(records());
  assert.equal(out.calls, 3);
  assert.equal(out.candidates, 1);
  assert.equal(out.candidateCalls, 2);
  assert.equal(out.gapMs, 10);
  assert.equal(out.toolMs, 20);
  assert.equal(out.verifiedSavingsMs, 0);
  assert.equal(JSON.stringify(out).includes('First'), false);
});

test('same-URL DOM changes and duplicate labels cannot establish the original control identity', () => {
  for (const rows of [ ['textbox "First" [ref=e1]', 'textbox "Replacement" [ref=e2]'],
    ['textbox "First" [ref=e1]', 'textbox "Second" [ref=e2]', 'textbox "Second" [ref=e3]'] ]) {
    assert.equal(batchCensus(records({ middle: snapshot(rows) })).candidates, 0);
  }
  assert.equal(batchCensus(records({ middle: snapshot(undefined, 'https://example.invalid/other') })).candidates, 0);
});

test('mixed tabs, submit/Return, reads, unknown calls, errors and field failures are barriers', () => {
  assert.equal(batchCensus(records({ second: { tab: 'fixture:2', ref: 'e2', text: 'two' } })).candidates, 0);
  assert.equal(batchCensus(records({ error: true })).candidates, 0);
  assert.equal(batchCensus(records({ middle: 'Filled 1 of 2 fields.\nField 2 failed: missing.' })).candidates, 0);
  for (const [name, input] of [['press_key', { tab: 'fixture:1', key: 'Return' }],
    ['click', { tab: 'fixture:1', ref: 'e2' }], ['snapshot', { tab: 'fixture:1' }],
    ['unknown', { tab: 'fixture:1' }]]) {
    const events = records();
    events.splice(4, 0, call('x', name, input, 22), reply('x', snapshot(), 25));
    assert.equal(batchCensus(events).candidates, 0, name);
  }
});

test('missing ownership, missing results and duplicate conflicting calls/results fail closed', () => {
  const events = records();
  assert.equal(batchCensus(events.slice(2)).candidates, 0);
  assert.equal(batchCensus(events.slice(0, -1)).candidates, 0);
  assert.equal(batchCensus([...events.slice(0, 4), call('a', 'type', { tab: 'fixture:2', ref: 'e1', text: 'other' }, 21), ...events.slice(4)]).candidates, 0);
  assert.equal(batchCensus([...events.slice(0, 4), reply('a', 'permission denied', 21), ...events.slice(4)]).candidates, 0);
  assert.equal(batchCensus([...events, events[2], events[3]]).candidates, 1, 'identical replay records are counted once');
});

test('missing timestamps stay unknown, and overlapping call intervals are counted once', () => {
  const missing = records().map(({ t, ...event }) => event);
  const out = batchCensus(missing);
  assert.equal(out.candidates, 1);
  assert.equal(out.unknownTiming, 1);
  assert.equal(out.gapMs, 0);
  const overlap = records(); overlap[4].t = 15;
  assert.equal(batchCensus(overlap).toolMs, 30);
  assert.equal(batchCensus(overlap).gapMs, 0);
});

test('escaped labels are decoded without executing saved input', () => {
  const events = records({ middle: snapshot(['textbox "First" [ref=e1]', 'textbox "A\\"B" [ref=e2]']) });
  events[1] = reply('o', snapshot(['textbox "First" [ref=e1]', 'textbox "A\\"B" [ref=e2]']), 5);
  events[5] = reply('b', snapshot(['textbox "First" [ref=e1]', 'textbox "A\\"B" [ref=e2]']), 40);
  assert.equal(batchCensus(events).candidates, 1);
});

test('overlapping dispatches and an unobserved duplicate label cannot be batching candidates', () => {
  const events = records();
  assert.equal(batchCensus([events[0], events[1], events[2], events[4], events[3], events[5]]).candidates, 0);
  events[1] = reply('o', snapshot(['textbox "First" [ref=e1]', 'textbox "Second" [ref=e2]', 'textbox "Second" [ref=e3]']), 5);
  assert.equal(batchCensus(events).candidates, 0);
  assert.equal(intervalUnion([[10, 20], [15, 40], [30, 35]]), 30);
});

test('a future snapshot cannot give an overlapping action identity or seed a later pair', () => {
  const events = records();
  events[1] = reply('o', snapshot(['textbox "First" [ref=e1]']), 5);
  const out = batchCensus([events[0], events[1], events[2],
    call('b', 'type', { tab: 'fixture:1', ref: 'e2', text: 'two' }, 15), events[3],
    reply('b', snapshot(), 25), call('c', 'type', { tab: 'fixture:1', ref: 'e2', text: 'three' }, 30),
    reply('c', snapshot(), 40)]);
  assert.equal(out.candidates, 0); assert.equal(out.candidateCalls, 0);
  assert.equal(out.gapMs, 0); assert.equal(out.toolMs, 0);
});

test('pending setup does not grant ownership or establish a future snapshot', () => {
  const events = records();
  const out = batchCensus([events[0], events[2], events[1], events[3], events[4], events[5]]);
  assert.equal(out.candidates, 0); assert.equal(out.candidateCalls, 0);
});

test('a confirmed sequential setup and input observations still establish a pair', () => {
  const out = batchCensus(records());
  assert.equal(out.candidates, 1); assert.equal(out.candidateCalls, 2);
  assert.equal(out.gapMs, 10); assert.equal(out.toolMs, 20);
});

test('sleight literal fill calls retain owned tab and exact unique labels, with escaped strings', {
  skip: !hasSourceParser && 'needs the typescript dev dependency',
}, () => {
  const engine = 'Browser tab: 1, Title: "Form", URL: "https://example.invalid/form".\n0 AXWebArea Form\n' +
    '\t1 text field (settable) Description: First, ID: first\n\t2 text field (settable) Description: A"B, ID: second';
  const js = (id, code, t) => ({ ...call(id, 'js', { code }, t), message: { id: 'm-' + id,
    content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code } }] } });
  const events = [js('o', 'const b = await cua.getBrowser({id:"b"}); const tab = await cua.createBrowserTab(b.browserId,"https://example.invalid/form"); tab', 0),
    reply('o', engine, 5), js('a', 'await tab.playwright.locator("#first").fill("one")', 10), reply('a', engine, 20),
    js('b', 'await tab.playwright.getByLabel("A\\"B",{exact:true}).fill("two")', 30), reply('b', engine, 40)];
  assert.equal(batchCensus(events).candidates, 1);
  for (const code of ['await other.playwright.locator("#second").fill("two")',
    'await tab.playwright.getByLabel("First").fill("two")', 'await tab.pressKey(null,"Return")',
    'await tab.playwright.locator("#second").fill(secret)', 'await tab.click(1); await tab.getAXState()']) {
    events[4] = js('b', code, 30);
    assert.equal(batchCensus(events).candidates, 0, code);
  }
});

test('the shared round reader retains malformed coverage and ignores symlinked artifacts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-census-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'run'));
  writeFileSync(join(dir, 'run/events.jsonl'), records().map(event => JSON.stringify(event)).join('\n') + '\nnot-json\n');
  symlinkSync(join(dir, 'run'), join(dir, 'linked-run'));
  mkdirSync(join(dir, 'linked-record'));
  symlinkSync(join(dir, 'run/events.jsonl'), join(dir, 'linked-record/events.jsonl'));
  const result = roundBatchCensus(dir);
  assert.equal(result.runs, 1);
  assert.equal(result.candidates, 1);
  assert.equal(result.malformed, 1);
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
});
