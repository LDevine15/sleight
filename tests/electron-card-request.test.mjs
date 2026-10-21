import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCardWatcher, locateCard } from '../bench/electron-live-runner.mjs';

test('worker reports a request start without claiming the native card was visible', () => {
  const worker = readFileSync(new URL('../bench/electron-qualification-worker.mjs', import.meta.url), 'utf8');
  assert.ok(worker.includes("event: 'requested'"));
  assert.doesNotMatch(worker, /target\.shown = true/);
  assert.match(worker, /target\.requested = true/);
});

for (const event of ['requested', 'shown']) test(`watcher treats ${event} as request evidence and waits for observed visibility`, async () => {
  const entries = [{ event, id: 'request1', kind: 'debugger', app: 'Fixture', temporary: false, at: 1000, requestedAt: 1000, deadlineAt: 121000 }];
  let geometry = null, receipt, clock = 1000;
  const logs = [];
  const watcher = createCardWatcher({ cardLog: 'memory', outDir: 'memory', read: () => entries.map(JSON.stringify).join('\n'),
    locate: async () => geometry, write: (_path, data) => { receipt = JSON.parse(data); }, remove: () => {}, now: () => clock, log: line => logs.push(line) });
  await watcher.poll(); await watcher.poll();
  assert.equal(watcher.cards.length, 1);
  assert.equal(receipt.requestedAt, new Date(1000).toISOString());
  assert.equal(receipt.visibleObservedAt, undefined);
  assert.match(receipt.steps, /automatically/);
  assert.match(receipt.steps, /fallback/i);
  assert.doesNotMatch(logs.join('\n'), /\) shown /);
  assert.equal(receipt.secondsLeft, 120);
  geometry = { ax: true, windows: [{ pid: 9, layer: 8, onScreen: true, x: 400, y: 200, width: 400, height: 420 }],
    buttons: [{ pid: 9, title: 'Always allow', x: 640, y: 540, width: 140, height: 28 }] };
  clock = 2000; await watcher.poll();
  assert.equal(receipt.visibleObservedAt, undefined);
  assert.equal(receipt.locationCorrelation, 'uncorrelated');
  assert.equal(watcher.observations()[0].observedAt, new Date(2000).toISOString());
  assert.match(receipt.steps, /Always allow.*\(710, 554\)/);
  entries.push({ event: 'answered', id: 'request1', at: 3000, status: 'granted', scope: 'always' });
  await watcher.poll();
  assert.equal(watcher.summary()[0].latencyMs, 2000);
  assert.equal(watcher.summary()[0].visibleObservedAt, undefined);
  assert.equal(watcher.summary()[0].sourceEvent, event);
});

for (const completed of [false, true]) test(`${completed ? 'completed A and current B in one batch' : 'simultaneous same-choice requests'} never attribute one visible card to request rows`, async () => {
  const entries = [{ event: 'requested', id: 'a', kind: 'debugger', temporary: false, at: 1000 }];
  if (completed) entries.push({ event: 'answered', id: 'a', at: 1500, status: 'granted' });
  entries.push({ event: 'requested', id: 'b', kind: 'debugger', temporary: false, at: 2000 });
  let reads = 0;
  const watcher = createCardWatcher({ cardLog: 'memory', outDir: 'memory', read: () => entries.map(JSON.stringify).join('\n'),
    locate: async () => { reads++; return { ax: true,
      windows: [{ pid: 9, layer: 8, onScreen: true, x: 400, y: 200, width: 400, height: 420 }],
      buttons: [{ pid: 9, title: 'Always allow', x: 640, y: 540, width: 140, height: 28 }] }; },
    write: () => {}, remove: () => {}, now: () => 3000, log: () => {} });
  await watcher.poll();
  assert.equal(reads, 1);
  assert.equal(watcher.summary().length, 2);
  assert.ok(watcher.summary().every(row => !('visibleObservedAt' in row)));
  assert.equal(watcher.observations().length, 1);
  assert.equal(watcher.observations()[0].correlation, 'uncorrelated');
  assert.equal(watcher.observations()[0].id, undefined);
  assert.equal(watcher.observations()[0].requestedAt, undefined);
});

test('styled modal panel geometry is preferred when its actual button is observed', () => {
  const result = locateCard({ ax: true, windows: [
    { pid: 9, layer: 0, onScreen: true, x: 0, y: 0, width: 1000, height: 700 },
    { pid: 9, layer: 8, onScreen: true, x: 400, y: 200, width: 400, height: 420 },
  ], buttons: [{ pid: 9, title: 'Always allow', x: 640, y: 540, width: 140, height: 28 }] }, 'Always allow');
  assert.deepEqual(result.alert, { x: 400, y: 200, width: 400, height: 420 });
});

for (const mismatch of ['foreign-pid', 'outside-window']) test(`card button location refuses ${mismatch}`, () => {
  const result = locateCard({ ax: true, windows: [{ pid: 9, layer: 8, onScreen: true, x: 400, y: 200, width: 400, height: 420 }],
    buttons: [{ pid: mismatch === 'foreign-pid' ? 10 : 9, title: 'Always allow', x: mismatch === 'outside-window' ? 1000 : 640,
      y: 540, width: 140, height: 28 }] }, 'Always allow');
  assert.equal(result.button, null);
});
