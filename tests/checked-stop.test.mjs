import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { checkedStop, collectOwnedEngine, stopText } from '../plugins/sleight/lib/checked-stop.mjs';

test('checked stop never releases leases before collecting the engine', async () => {
  const events = [];
  const report = await checkedStop({ inFlight: ['js: typeText'], endTurn: async () => { events.push('end'); return true; },
    collect: async () => { events.push('collect'); return { collected: true, cutOff: false }; },
    release: async () => events.push('release'), inspect: async () => { events.push('inspect'); return { ok: true }; } });
  assert.deepEqual(events, ['end', 'collect', 'release', 'inspect']);
  assert.match(stopText(report), /typeText.*Engine exited and collected.*released and checked.*Checked:/);
});
test('unconfirmed collection keeps leases, and failed inspection never claims input is clear', async () => {
  let released = false;
  const options = { inFlight: [], endTurn: async () => false, collect: async () => ({ collected: false }),
    release: async () => { released = true; }, inspect: async () => ({ ok: false, error: 'tap scan failed' }) };
  const failed = await checkedStop(options);
  assert.equal(released, false); assert.doesNotMatch(stopText(failed), /Checked:/);
  const scanned = await checkedStop({ ...options, collect: async () => ({ collected: true, cutOff: true }) });
  assert.match(stopText(scanned), /cut off and collected.*tap scan failed/);
  assert.doesNotMatch(stopText(scanned), /Checked:/);
});
test('owned engine collection sends TERM then KILL at the exact deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, ended = false;
  const sent = [], closed = new Promise(resolve => { finish = resolve; });
  const child = { stdin: { end() { ended = true; } }, kill(signal) {
    sent.push(signal);
    if (signal === 'SIGKILL') finish({ code: null, signal });
  } };
  const pending = collectOwnedEngine({ child, closed, graceMs: 30, forceMs: 30 });
  assert.equal(ended, true);
  t.mock.timers.tick(29); assert.deepEqual(sent, []);
  t.mock.timers.tick(1); assert.deepEqual(sent, ['SIGTERM']);
  t.mock.timers.tick(29); assert.deepEqual(sent, ['SIGTERM']);
  t.mock.timers.tick(1);
  const report = await pending;
  assert.equal(report.collected, true); assert.equal(report.cutOff, true);
  assert.equal(report.signal, 'SIGKILL'); assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(1000); assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});
test('a real owned engine that ignores EOF and SIGTERM is force-collected before reporting', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  await new Promise(resolve => child.stdout.once('data', resolve));
  const report = await collectOwnedEngine({ child, closed, graceMs: 30, forceMs: 2000 });
  assert.equal(report.collected, true); assert.equal(report.cutOff, true);
  assert.equal(report.signal, 'SIGKILL'); assert.deepEqual(report.signals, ['SIGTERM', 'SIGKILL']);
});
