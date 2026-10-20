import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as observers from '../plugins/sleight/lib/light-return.mjs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const window = { appId: 'fixture.app', nativeIdentity: { pid: 123, processStart: 1 } };
const ok = { status: 'ok', ...window, pid: 123, processStart: 1, running: true, windowCount: 0, modalCount: 0 };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
test('DPk close observations keep fixed failure codes and discard arbitrary exception text', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-reason-')));
  t.after(() => removeTemp(directory));
  for (const unknownReason of ['cgs-unbound', 'cgs-error', 'predicate-error', 'deadline', 'private error']) {
    const observer = observers.createCloseRead({ directory, observe: async () => ({ status: 'unknown', unknownReason, error: 'private' }) });
    const info = observer.begin(1, window);
    await until(() => JSON.parse(readFileSync(info.path, 'utf8')).observations.length > 0);
    const sample = JSON.parse(readFileSync(info.path, 'utf8')).observations[0];
    observer.dispose();
    assert.equal(sample.unknownReason, unknownReason === 'private error' ? 'helper-error' : unknownReason);
    assert.ok(!JSON.stringify(sample).includes('private'));
  }
});
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(); }
  assert.fail('observer did not settle');
}
test('DPh observes leased metadata during the call, strips content and cleans up at its end', async t => {
  assert.equal(typeof observers.createCloseRead, 'function');
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-test-')));
  const requests = [];
  const observer = observers.createCloseRead({ directory, observe: async request => {
    requests.push(request);
    return { ...ok, closedWindowPresent: true, title: 'private title', document: 'private document' };
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(8, window);
  await until(() => requests.length >= 2);
  const text = readFileSync(info.path, 'utf8');
  const sample = JSON.parse(text).observations.at(-1);
  assert.equal(sample.windowCount, 0);
  assert.equal(sample.modalCount, 0);
  assert.equal(sample.pid, 123);
  assert.equal(sample.closedWindowPresent, true);
  assert.ok(sample.start <= sample.end);
  assert.ok(!text.includes('private'));
  assert.ok(requests.every(request => request.closeCount === true && request.nativeIdentity.pid === 123));
  observer.end(8);
  assert.equal(existsSync(info.path), false);
});
test('DPh ending a call during a native sample cannot recreate its observation file', async t => {
  assert.equal(typeof observers.createCloseRead, 'function');
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-end-')));
  let finish;
  const observer = observers.createCloseRead({ directory, observe: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(1, window);
  await until(() => finish);
  observer.end(1);
  finish(ok);
  await pause();
  assert.equal(existsSync(info.path), false);
});

test('DPo keeps sampling through consecutive failures until usable metadata returns', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-fail-')));
  const replies = [{ status: 'unknown' }, undefined, { status: 'denied' }, ok];
  let requests = 0;
  const observer = observers.createCloseRead({ directory, observe: async () => {
    const reply = replies[Math.min(requests++, replies.length - 1)];
    if (reply === undefined) throw Error('failed metadata');
    return reply;
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(1, window);
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(25); await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(requests >= 4);
  assert.equal(JSON.parse(readFileSync(info.path, 'utf8')).observations.at(-1).status, 'ok');
});

function observerClock() {
  let time = 0;
  const pending = new Set(), fired = [], cleared = [];
  return {
    now: () => time,
    setTimer(fn, ms) { const timer = { fn, ms, at: time + ms }; pending.add(timer); return timer; },
    clearTimer(timer) { if (pending.delete(timer)) cleared.push(timer); },
    async tick(ms) {
      time += ms;
      for (const timer of [...pending]) if (timer.at <= time) { pending.delete(timer); fired.push(timer); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
    pending, fired, cleared,
  };
}

test('DPr bounds close sampling to two seconds after the last matching key and can restart it', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-bound-')));
  const clock = observerClock(), starts = [];
  const observer = observers.createCloseRead({ directory, ...clock, observe: async () => { starts.push(clock.now()); return ok; } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  await clock.tick(0);
  for (let i = 0; i < 60; i++) await clock.tick(25);
  observer.keyPressed(window.appId);
  for (let i = 0; i < 40; i++) await clock.tick(25);
  assert.ok(starts.at(-1) >= 2475, 'the matching key extends sampling beyond begin + 2 s');
  observer.keyPressed('other.app');
  for (let i = 0; i < 80; i++) await clock.tick(25);
  assert.ok(starts.at(-1) < 3500, 'sampling stops at last matching key + 2 s');
  assert.equal(clock.pending.size, 0);
  const before = starts.length;
  observer.keyPressed(window.appId);
  await clock.tick(80);
  assert.equal(starts.length, before + 1);
  observer.end(1);
  assert.equal(clock.pending.size, 0, 'end clears the pending sample timer');
  assert.ok(clock.cleared.length > 0);
});

test('DPr backs off non-ok samples, resets after recovery and clears a paused wait', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-backoff-')));
  const clock = observerClock(), starts = [];
  const observer = observers.createCloseRead({ directory, ...clock, observe: async () => {
    starts.push(clock.now());
    return starts.length < 4 ? { status: 'denied' } : ok;
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  await clock.tick(0);
  for (let i = 0; i < 9; i++) await clock.tick(25);
  assert.deepEqual(starts.slice(0, 6), [0, 25, 75, 175, 200, 225]);
  observer.pause(1);
  assert.equal(clock.pending.size, 0);
  await clock.tick(2000);
  assert.equal(starts.length, 6);
});

test('DPr persistent helper failures stop by two seconds with capped backoff', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-denied-')));
  const clock = observerClock(), starts = [];
  const observer = observers.createCloseRead({ directory, ...clock, observe: async () => { starts.push(clock.now()); return { status: 'unknown' }; } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  await clock.tick(0);
  for (let i = 0; i < 120; i++) await clock.tick(25);
  assert.deepEqual(starts, [0, 25, 75, 175, 375, 775, 1175, 1575, 1975]);
  assert.equal(clock.pending.size, 0);
});

test('DPo a decided call stops sampling and discards an in-flight reply until end removes the file', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-pause-')));
  let requests = 0, finish;
  const observer = observers.createCloseRead({ directory, observe: () => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(1, window);
  t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  observer.pause(1);
  finish(ok);
  await new Promise(resolve => setImmediate(resolve));
  observer.keyPressed(window.appId);
  t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(JSON.parse(readFileSync(info.path, 'utf8')).observations.length, 0);
  observer.end(1);
  assert.equal(existsSync(info.path), false);
});

test('DPn close samples refresh every 25 ms and report offline observer CPU per call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-cost-')));
  const starts = [], cpu = process.cpuUsage();
  const observer = observers.createCloseRead({ directory, observe: async () => { starts.push(Date.now()); return ok; } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(25); await new Promise(resolve => setImmediate(resolve)); }
  observer.end(1);
  const cost = process.cpuUsage(cpu);
  assert.equal(starts.length, 41);
  assert.ok(starts.slice(1).every((start, i) => start - starts[i] === 25));
  t.diagnostic(JSON.stringify({ simulatedCallMs: 1000, samples: starts.length,
    observerUserCpuMs: cost.user / 1000, observerSystemCpuMs: cost.system / 1000,
    nativeHelperCpu: 'not measured, fake metadata only' }));
});

test('DPj leaves at least 25 ms after slow close samples before the next sample', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-gap-')));
  const starts = [], ends = [];
  const observer = observers.createCloseRead({ directory, observe: async () => {
    starts.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 80));
    ends.push(Date.now());
    return ok;
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 30; i++) { t.mock.timers.tick(10); await new Promise(resolve => setImmediate(resolve)); }
  observer.end(1);
  assert.ok(starts.length >= 2);
  assert.ok(starts.slice(1).every((start, i) => start - ends[i] >= 25), JSON.stringify({ starts, ends }));
});
