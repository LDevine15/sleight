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
