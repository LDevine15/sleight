import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { superviseProbe } from '../plugins/sleight/lib/probe-supervisor.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

function fixture(options = {}) {
  const child = new EventEmitter(), owner = new EventEmitter(), input = new PassThrough(), output = new PassThrough();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const signals = [];
  child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
  const supervisor = superviseProbe(child, { input, output, owner, deadlineMs: 100, ...options });
  return { child, owner, input, output, signals, ...supervisor };
}

test('an active probe has a hard deadline even if its caller stops enforcing one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.input.write('{"id":1}\n');
  t.mock.timers.tick(99); assert.deepEqual(f.signals, []);
  t.mock.timers.tick(1); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('a reply clears the deadline while an idle session stays reusable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), replies = [];
  f.output.on('data', chunk => replies.push(String(chunk)));
  f.input.write('{"id":1}\n'); f.child.stdout.write('{"id":1,"status":"responding"}\n');
  t.mock.timers.tick(1000); assert.deepEqual(f.signals, []);
  assert.equal(replies.join(''), '{"id":1,"status":"responding"}\n');
  f.input.write('{"id":2}\n'); t.mock.timers.tick(100); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP', 'disconnect']) test(`parent ${event} collects only the owned probe`, async () => {
  const f = fixture(); f.owner.emit(event); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('parent pipe EOF collects a native helper even during an unanswered query', async () => {
  const f = fixture(); f.input.write('{"id":1}\n'); f.input.end(); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('one-shot probes start their deadline without a stream request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ oneShot: true }); t.mock.timers.tick(100); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

test('one-shot output cannot disable the exit deadline while the child stays alive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ oneShot: true });
  f.child.stdout.write('{"status":"responding"}\n');
  t.mock.timers.tick(100); await Promise.resolve();
  assert.deepEqual(f.signals, ['SIGKILL']);
  await f.done;
});

test('the supervisor has fixed bounded plans for every runtime metadata probe', async () => {
  const { probePlan } = await import('../plugins/sleight/lib/probe-supervisor.mjs');
  const session = probePlan('--session', []);
  assert.equal(session.command, '/usr/bin/osascript'); assert.equal(session.deadlineMs, 35000); assert.equal(session.oneShot, false);
  assert.ok(session.args.some(arg => arg.endsWith('/app-health.js')));
  const once = probePlan('--once', ['"Fixture"', '3']);
  assert.equal(once.deadlineMs, 4500); assert.equal(once.oneShot, true);
  const app = probePlan('--resolve-app', ['Fixture']);
  assert.equal(app.deadlineMs, 10000); assert.equal(app.oneShot, true);
  assert.ok(app.args.some(arg => arg.endsWith('/resolve-app-id.js')));
  const jobs = probePlan('--launchd-jobs', []);
  assert.deepEqual(jobs, { command: '/bin/launchctl', args: ['list'], deadlineMs: 5000, oneShot: true });
  assert.deepEqual(probePlan('--forbidden-targets', []), { command: '/usr/bin/defaults', args: ['read', '-g', 'ComputerUseAllowForbiddenTargets'], deadlineMs: 5000, oneShot: true });
  assert.throws(() => probePlan('--other', []), /Unknown/);
});

test('one-shot stdin EOF is harmless and parent reparenting still kills its probe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const owner = new EventEmitter(); owner.ppid = 100;
  const f = fixture({ owner, oneShot: true, deadlineMs: 1000 });
  f.input.end(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.signals, []);
  owner.ppid = 1; t.mock.timers.tick(100); await f.done;
  assert.deepEqual(f.signals, ['SIGKILL']);
});

for (const mode of ['parent', 'parent-once']) test(`a force-killed ${mode} fixture leaves no native-fake child`, { timeout: 5000 }, async t => {
  const parent = spawn(process.execPath, [fileURLToPath(new URL('fixtures/probe-parent.mjs', import.meta.url)), mode],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => parent.once('close', resolve));
  t.after(() => { parent.stdin.end(); });
  const pid = await new Promise((resolve, reject) => {
    parent.once('error', reject);
    createInterface({ input: parent.stdout }).once('line', line => resolve(JSON.parse(line).ready));
  });
  assert.ok(Number.isInteger(pid));
  parent.kill('SIGKILL'); await closed;
  let absent = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { absent = true; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(absent, true, 'the supervisor reaped its own child after the owner died');
});
