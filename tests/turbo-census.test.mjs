import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const load = async () => {
  const mod = await import('../bench/turbo/census.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(mod, 'v3 per-task census is missing'); return mod;
};
const use = (id, name, input = {}) => ({ type: 'assistant', message: {
  content: [{ type: 'tool_use', id, name: 'mcp__sleight-turbo__' + name, input }] } });
const result = (id, text, is_error = false) => ({ type: 'user', message: {
  content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error }] } });

test('census counts standalone reads per action call, batches, fills and delivered text once', async () => {
  const { censusEvents } = await load();
  const events = [use('o', 'browser_open'), result('o', 'open'),
    use('r', 'browser_read'), result('r', 'read🙂'), result('r', 'read🙂'),
    use('a', 'browser_act', { steps: [{ do: 'click', ref: 'e1' }, { do: 'press', key: 'Enter' }] }),
    result('a', 'no visible change'),
    use('f', 'browser_fill', { fields: [{ ref: 'e2', value: 'private' }, { ref: 'e3', value: true }], submit: 'e4' }),
    result('f', 'failed', true), use('p', 'browser_act', { steps: [{ do: 'click', ref: 'e5' }] }),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch', input: {} }] } },
    result('unknown', 'orphan private text')];
  events.push(events[2]);
  const row = censusEvents(events);
  assert.equal(row.calls, 6); assert.equal(row.reads, 1); assert.equal(row.actionCalls, 3);
  assert.equal(row.readsPerAction, 1 / 3); assert.equal(row.stepsRequested, 3);
  assert.equal(row.fieldsRequested, 2); assert.equal(row.submitsRequested, 1);
  assert.equal(row.errors, 1); assert.equal(row.unresolved, 2); assert.equal(row.toolSearch, 1);
  assert.equal(row.characters, 32); // 4 + 5 Unicode characters + 17 + 6.
  assert.equal(row.tools.browser_read.characters, 5);
  assert.equal(row.duplicateResults, 1); assert.equal(row.orphanResults, 1);
  assert.doesNotMatch(JSON.stringify(row), /private|e[1-5]|visible change/);
});

test('census keeps other paths separate and does not invent ratios or zero coverage', async () => {
  const { censusEvents, observations } = await load();
  const row = censusEvents([{ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'engine', name: 'mcp__plugin_sleight_computer__js', input: { code: 'private' } }] } },
  result('engine', 'engine')]);
  assert.equal(row.actionCalls, 0); assert.equal(row.readsPerAction, null); assert.equal(row.otherCalls, 1);
  assert.deepEqual(observations(), { focusEvents: null, observedFocusEvents: null, turboTabsLeft: null,
    tabsAfterBrowserClose: null, tabsLeft: null, cleanupProved: false });
  const unknown = observations({ focusGrade: { cell: 'unqualified', events: [{ kind: 'host-front' }] } });
  assert.equal(unknown.focusEvents, null); assert.equal(unknown.observedFocusEvents, 1);
  const measured = observations({ focusGrade: { cell: 'ok', events: [] } }, [
    { version: 3, phase: 'cleanup', turboTabsLeft: 2, tabsAfterBrowserClose: 0,
      browserClosed: true, profileDeleted: true, socketsClosed: true }]);
  assert.equal(measured.focusEvents, 0); assert.equal(measured.turboTabsLeft, 2);
  assert.equal(measured.tabsLeft, null, 'combined engine tabs are not covered by turbo closure');
  assert.equal(measured.cleanupProved, true);
});

test('round census and CLI emit aggregate task data, retain missing coverage and reject malformed or linked inputs', async t => {
  const { censusRound, renderCensus } = await load();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  mkdirSync(join(dir, 'fixture'));
  const file = join(dir, 'fixture/events.jsonl');
  writeFileSync(file, [use('r', 'browser_read'), result('r', 'SECRET https://private.invalid')].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: 'fixture', prompt: 'SECRET' },
    focusGrade: { cell: 'FAIL: 1', events: [{ kind: 'host-front', app: 'PRIVATE-APP' }] } }]));
  writeFileSync(join(dir, 'fixture/turbo-metrics.jsonl'), JSON.stringify({ version: 3, phase: 'cleanup',
    turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true }) + '\n');
  const round = censusRound(dir);
  assert.equal(round.tasks.fixture.characters, 30);
  assert.equal(round.tasks.fixture.focusEvents, 1); assert.equal(round.tasks.fixture.turboTabsLeft, 0);
  assert.doesNotMatch(JSON.stringify(round), /SECRET|private.invalid|PRIVATE-APP/);
  assert.match(renderCensus([round]), /fixture/); assert.match(renderCensus([round]), /unavailable/);
  const cli = spawnSync(process.execPath, ['bench/turbo/census.mjs', '--json', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).rounds[0].tasks.fixture.reads, 1);
  writeFileSync(file, '{bad json\n'); assert.throws(() => censusRound(dir), /events.jsonl:1/);
  writeFileSync(file, ''); symlinkSync(file, join(dir, 'linked'));
  assert.throws(() => censusRound(dir), /symbolic link/);
});

test('a results-only task remains visible with unavailable transcript counts, including prototype-like task names', async t => {
  const { censusRound, renderCensus } = await load();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-census-')));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: '__proto__' },
    focusGrade: { cell: 'ok', events: [] } }]));
  const round = censusRound(dir);
  assert.equal(Object.hasOwn(round.tasks, '__proto__'), true);
  assert.equal(round.tasks.__proto__.transcriptAvailable, false);
  assert.equal(round.tasks.__proto__.reads, null); assert.equal(round.tasks.__proto__.characters, null);
  assert.equal(round.tasks.__proto__.focusEvents, 0);
  assert.match(renderCensus([round]), /__proto__ \| unavailable/);
});
