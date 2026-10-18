import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, resolveTask, planSuite } from '../bench/world/suite.mjs';

test('the world catalog retains the published browser list and adds seven local claim tasks', async () => {
  const browser = JSON.parse(readFileSync(new URL('../bench/world/tasks/fowlbrowser.json', import.meta.url)));
  assert.deepEqual(suite.browser.filter(t => t.source === 'fowlbrowser').map(t => t.task), browser.map(t => t.name));
  assert.equal(suite.browser.filter(t => t.source === 'world').length, 7);
  assert.equal(browser.length, 14); // The runner file has 14 rows, despite the ledger's 13.
  assert.equal(suite.native.length, 23);
  assert.equal(suite.handoff.length, 3);
  const ids = Object.values(suite).filter(Array.isArray).flat().map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of ['browser', 'native', 'handoff']) for (const row of suite[group]) {
    const task = await resolveTask(row.id);
    assert.equal(task.id ?? task.name, row.task);
    assert.ok(row.check && row.fixture && row.runner);
  }
});

test('world variants retain existing file checks without changing the source tasks', async () => {
  const { tasks } = await import('../bench/tasks.mjs');
  const { realTasks } = await import('../bench/tasks-real.mjs');
  assert.equal((await resolveTask('native/textedit-drag')).check, tasks.find(t => t.id === 'textedit-drag').check);
  assert.equal((await resolveTask('native/finder-files')).check, realTasks.find(t => t.id === 'finder-files').check);
  await assert.rejects(resolveTask('native/unknown'), /unknown world task/);
});

test('the unattended claim plan excludes owner data and known-answer pages', () => {
  const rows = planSuite();
  assert.equal(rows.length, 47);
  for (const id of ['calendar', 'reminders', 'notes', 'system-settings-version', 'textedit-save-shortcut']) assert.equal(rows.some(t => t.task === id), false);
  assert.ok(rows.filter(t => ['wikipedia', 'mdn', 'takeover'].includes(t.task)).every(t => t.claim === false));
  assert.ok(rows.filter(t => t.claim).every(t => !t.requires.some(r => /owner present|owner participates/.test(r))));
  assert.ok(suite.native.filter(t => /word|excel|powerpoint|pages|numbers|keynote/.test(t.task)).length <= 2);
  assert.ok(rows.every(t => t.live === false));
});

test('every row carries neutral task text, a deadline, a half and an executable runner', async () => {
  const { getTasks } = await import('../bench/tasks.mjs');
  const registered = getTasks('world');
  for (const row of planSuite()) {
    assert.ok(['browser', 'native', 'cross-app'].includes(row.half), row.id);
    assert.equal(typeof row.prompt, 'string', row.id);
    assert.doesNotMatch(row.prompt, /in the background|sleight\.|playwright\.|cua\./i);
    assert.ok(Number.isInteger(row.timeoutMs) && row.timeoutMs > 0, row.id);
    if (row.source !== 'fowlbrowser' && row.source !== 'handoff') {
      assert.match(row.runner, /bench\/run.mjs --suite world/);
      assert.ok(registered.some(t => t.id === row.task), row.id);
    }
  }
});

test('the seven macOSWorld candidates stay outside scored results until host qualification', () => {
  const candidate = JSON.parse(readFileSync(new URL('../bench/world/macosworld.json', import.meta.url)));
  assert.equal(candidate.tasks.length, 7);
  assert.equal(candidate.liveQualified, false);
  assert.ok(candidate.excludedCommands.some(c => c.includes('env_init_command')));
  assert.ok(candidate.tasks.every(t => t.check && t.requires && t.status.includes('excluded')));
  assert.ok(candidate.tasks.every(t => !planSuite().some(row => row.task === t.path)));
});
