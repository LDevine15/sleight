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
    return { ...ok, title: 'private title', document: 'private document' };
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(8, window);
  await until(() => requests.length >= 2);
  const text = readFileSync(info.path, 'utf8');
  const sample = JSON.parse(text).observations.at(-1);
  assert.equal(sample.windowCount, 0);
  assert.equal(sample.modalCount, 0);
  assert.equal(sample.pid, 123);
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

test('DPi stops close polling after two consecutive failures, with success resetting the count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-fail-')));
  const replies = [{ status: 'unknown' }, ok, undefined, { status: 'denied' }, ok];
  let requests = 0;
  const observer = observers.createCloseRead({ directory, observe: async () => {
    const reply = replies[requests++];
    if (reply === undefined) throw Error('failed metadata');
    return reply;
  } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  const info = observer.begin(1, window);
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(requests, 4);
  assert.equal(JSON.parse(readFileSync(info.path, 'utf8')).observations.at(-1).status, 'denied');
  observer.keyPressed(window.appId);
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 4, 'input cannot restart a failed poller in the same call');
});

test('DPi close samples use a 50 ms cadence and report offline observer CPU per call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-close-cost-')));
  const starts = [], cpu = process.cpuUsage();
  const observer = observers.createCloseRead({ directory, observe: async () => { starts.push(Date.now()); return ok; } });
  t.after(() => { observer.dispose(); removeTemp(directory); });
  observer.begin(1, window);
  t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) { t.mock.timers.tick(10); await new Promise(resolve => setImmediate(resolve)); }
  observer.end(1);
  const cost = process.cpuUsage(cpu);
  assert.equal(starts.length, 21);
  assert.ok(starts.slice(1).every((start, i) => start - starts[i] >= 50));
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
