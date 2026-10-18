import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createHandClient, handWireFrame } from '../plugins/sleight/lib/hand/client.mjs';
import { handPid, setHandPid } from '../plugins/sleight/lib/hand/pid.mjs';
import * as host from '../plugins/sleight/lib/direct-browser/host.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
function fakeChild(pid = 4242) {
  const child = new EventEmitter(), lines = [];
  child.pid = pid; child.ended = false;
  child.stdin = Object.assign(new EventEmitter(), {
    writableLength: 0,
    write(text) { lines.push(...text.trimEnd().split('\n').map(line => JSON.parse(line))); return true; },
    end() { child.ended = true; },
  });
  child.lines = lines;
  return child;
}
function harness({ enabled = true, built = true, capture = 'hidden', result, now } = {}) {
  const children = [], traces = [], spawns = [];
  let preparing = 0, setting = { enabled, capture };
  const client = createHandClient({
    setting: () => setting, built: () => built, now, watch: () => undefined,
    prepare: async () => { preparing++; return result ?? { status: 'ready', spawn: options => { spawns.push(options); const c = fakeChild(4242 + children.length); children.push(c); return c; } }; },
    trace: (direction, detail) => traces.push([direction, detail]),
  });
  return { client, children, traces, spawns, preparing: () => preparing, set: next => { setting = next; } };
}
const frame = (over = {}) => ({ kind: 'click', pid: 501, windowId: 77, at: [10.123, 20], path: [[0, 0], [10.123, 20]], ...over });

test('send and hide return at once without a promise, and the host gets exact nonce-bound frames with rising seq', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  assert.equal(h.client.enabled, true);
  assert.equal(h.client.send(frame({ text: 'secret', app: 'Fixture' })), undefined);
  assert.equal(h.children.length, 0, 'the spawn happens off the caller\'s path');
  await settle();
  assert.equal(h.children.length, 1);
  h.client.send(frame({ kind: 'drag', delayMs: 470.4, beats: 2 }));
  assert.equal(h.client.hide(), undefined);
  const [first, second, hide] = h.children[0].lines;
  assert.match(first.nonce, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, { hand: 'act', nonce: first.nonce, seq: 1, kind: 'click', pid: 501, windowId: 77, at: [10.12, 20], path: [[0, 0], [10.12, 20]], delayMs: 0, beats: 1 });
  assert.deepEqual(Object.keys(first), ['hand', 'nonce', 'seq', 'kind', 'pid', 'windowId', 'at', 'path', 'delayMs', 'beats']);
  assert.deepEqual([second.seq, second.kind, second.delayMs, second.beats, second.nonce], [2, 'drag', 470, 2, first.nonce]);
  assert.deepEqual(hide, { hand: 'hide', nonce: first.nonce });
  assert.deepEqual(h.spawns, [{ capture: 'hidden' }]);
});

test('the host pid is set while the host runs and cleared when it ends; a dead host only traces and is not respawned', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  assert.equal(handPid(), 4242);
  h.children[0].emit('exit', 65, null);
  assert.equal(handPid(), 0);
  assert.deepEqual(h.traces.find(([d]) => d === 'hand-off'), ['hand-off', { reason: 'exit', code: 65, signal: null }]);
  assert.equal(h.client.enabled, false);
  h.client.send(frame()); h.client.hide(); await settle();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].lines.length, 1);
});

test('a host that is not compiled yet starts the build in the background and this session has no hand', async () => {
  const h = harness({ built: false });
  h.client.send(frame()); await settle();
  assert.equal(h.preparing(), 1); assert.equal(h.children.length, 0);
  assert.equal(h.client.enabled, false);
  assert.ok(h.traces.some(([d, detail]) => d === 'hand-off' && detail.reason === 'building'));
  assert.ok(h.traces.some(([d, detail]) => d === 'hand-built' && detail.status === 'ready'));
  h.client.send(frame()); await settle();
  assert.equal(h.preparing(), 1); assert.equal(h.children.length, 0);
});

test('the hand off: no build, no spawn and no writes', async () => {
  const h = harness({ enabled: false });
  assert.equal(h.client.enabled, false);
  h.client.send(frame()); h.client.hide(); await settle();
  assert.equal(h.preparing(), 0); assert.equal(h.children.length, 0);
});

test('an unavailable build, a throwing spawn, a broken pipe and backpressure only trace', async t => {
  t.after(() => setHandPid(0));
  const unavailable = harness({ result: { status: 'unavailable', code: 'HOST_BUILD_BUSY' } });
  unavailable.client.send(frame()); await settle();
  assert.deepEqual(unavailable.traces.at(-1), ['hand-off', { reason: 'unavailable', code: 'HOST_BUILD_BUSY' }]);
  const throwing = harness({ result: { status: 'ready', spawn: () => { throw Error('HOST_PACKAGE_MISMATCH'); } } });
  throwing.client.send(frame()); await settle();
  assert.deepEqual(throwing.traces.at(-1), ['hand-off', { reason: 'spawn', code: 'HOST_PACKAGE_MISMATCH' }]);
  const h = harness();
  h.client.send(frame()); await settle();
  h.children[0].stdin.emit('error', Object.assign(Error('pipe'), { code: 'EPIPE' }));
  h.children[0].stdin.writableLength = 70000;
  h.client.send(frame());
  assert.deepEqual(h.traces.slice(-2), [['hand-dropped', { reason: 'EPIPE' }], ['hand-dropped', { reason: 'backpressure' }]]);
  h.children[0].stdin.write = () => { throw Object.assign(Error('closed'), { code: 'ERR_STREAM_DESTROYED' }); };
  h.children[0].stdin.writableLength = 0;
  assert.doesNotThrow(() => h.client.send(frame()));
  assert.doesNotThrow(() => h.client.hide());
});

test('frames the host would refuse are dropped with a reason, and long paths, delays and beats are fitted to the host\'s limits', () => {
  for (const [over, reason] of [[{ kind: 'hover' }, 'kind'], [{ pid: 0 }, 'target'], [{ pid: true }, 'target'], [{ windowId: 2 ** 32 }, 'target'],
    [{ at: [NaN, 1] }, 'target'], [{ at: [1] }, 'target'], [{ at: [200000, 0] }, 'target'], [{ path: [[0, 0], [0, '1']] }, 'path'], [{ path: 'x' }, 'path']]) {
    assert.equal(handWireFrame(frame(over)), reason, JSON.stringify(over));
  }
  assert.equal(handWireFrame(null), 'kind');
  const long = handWireFrame(frame({ path: Array.from({ length: 500 }, (_, i) => [i, i]), delayMs: 99999, beats: 50 }));
  assert.equal(long.path.length, 64); assert.deepEqual([long.path[0], long.path[63]], [[0, 0], [499, 499]]);
  assert.deepEqual([long.delayMs, long.beats], [10000, 20]);
  assert.deepEqual(handWireFrame({ kind: 'key', pid: 1, windowId: 1, at: [5, 6] }).path, [[5, 6]]);
  assert.deepEqual(handWireFrame(frame({ path: [], delayMs: -5, beats: 0 })), { ...handWireFrame(frame({ path: [[10.123, 20]] })), delayMs: 0, beats: 1 });
  const h = harness();
  h.client.send(frame({ kind: 'hover' }));
  assert.deepEqual(h.traces, [['hand-dropped', { reason: 'kind' }]]);
});

test('frames queued while the host starts keep their timing: the wait comes off delayMs', async t => {
  t.after(() => setHandPid(0));
  let clock = 1000;
  const h = harness({ now: () => clock });
  h.client.send(frame({ delayMs: 500 })); clock += 120;
  h.client.send(frame({ delayMs: 50 }));
  await settle();
  assert.deepEqual(h.children[0].lines.map(line => [line.seq, line.delayMs]), [[1, 380], [2, 50]]);
});

test('close ends the host\'s stdin and the session stops sending', async t => {
  t.after(() => setHandPid(0));
  const h = harness();
  h.client.send(frame()); await settle();
  h.client.close();
  assert.equal(h.children[0].ended, true); assert.equal(h.client.enabled, false);
  h.children[0].emit('exit', 0, null);
  assert.equal(handPid(), 0);
  h.client.send(frame()); await settle();
  assert.equal(h.children[0].lines.length, 1);
});

test('settings are read again once a minute: off stops the host, on restarts it, a new capture mode replaces it', async t => {
  t.after(() => setHandPid(0));
  let clock = 0;
  const h = harness({ now: () => clock });
  h.client.send(frame()); await settle();
  h.set({ enabled: false, capture: 'hidden' });
  clock = 30000; h.client.send(frame()); await settle();
  assert.equal(h.children[0].ended, false, 'no reread inside the minute');
  clock = 61000; h.client.send(frame()); await settle();
  assert.equal(h.children[0].ended, true); assert.equal(h.client.enabled, false);
  h.children[0].emit('exit', 0, null);
  h.set({ enabled: true, capture: 'visible' });
  clock = 122000; h.client.send(frame()); await settle();
  assert.equal(h.client.enabled, true);
  h.client.send(frame()); await settle();
  assert.equal(h.children.length, 2); assert.deepEqual(h.spawns.at(-1), { capture: 'visible' });
  assert.equal(handPid(), 4243);
  h.set({ enabled: true, capture: 'hidden' });
  clock = 183000; h.client.send(frame()); await settle();
  assert.equal(h.children[1].ended, true);
  h.client.send(frame()); await settle();
  // The replaced host exits after its successor started, and the successor's pid stays.
  h.children[1].emit('exit', 0, null);
  assert.equal(h.children.length, 3); assert.deepEqual(h.spawns.at(-1), { capture: 'hidden' }); assert.equal(handPid(), 4244);
  assert.ok(h.traces.some(([d, detail]) => d === 'hand-restart' && detail.capture === 'hidden'));
});

test('a change to the settings folder (the menu row or the hand command) hides this session\'s hand at once', async t => {
  t.after(() => setHandPid(0));
  let fire, closed = 0, setting = { enabled: true }, watched;
  const children = [];
  const client = createHandClient({ setting: () => setting, built: () => true, now: () => 0,
    watch: (folder, listener) => { watched = folder; fire = listener; return { close() { closed++; }, unref() {} }; },
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); children.push(c); return c; } }) });
  assert.match(watched, /Library\/Application Support\/sleight$/);
  client.send(frame()); await settle();
  setting = { enabled: false };
  fire('rename', 'hand.json'); await settle();
  assert.equal(children[0].ended, true, 'no wait for the minute');
  assert.equal(client.enabled, false);
  fire('change', 'turbo.json'); await settle();
  setting = { enabled: true };
  fire('rename', 'hand.json'); await settle();
  assert.equal(client.enabled, true);
  client.close(); assert.equal(closed, 1);
});

test('the tools check asks xcode-select, never xcrun, and needs swiftc and clang under the developer folder', async () => {
  const calls = [];
  const run = dir => async (command, args, options) => { calls.push([command, args, options.env]); if (dir instanceof Error) throw dir; return { stdout: dir + '\n' }; };
  const tools = ['swiftc', 'clang'];
  const present = paths => path => paths.some(prefix => tools.some(tool => path === prefix + '/' + tool));
  assert.equal(await host.appleToolsPresent({ run: run('/Library/Developer/CommandLineTools'), exists: present(['/Library/Developer/CommandLineTools/usr/bin']) }), true);
  assert.deepEqual(calls[0], ['/usr/bin/xcode-select', ['-p'], { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }]);
  assert.equal(await host.appleToolsPresent({ run: run('/Applications/Xcode.app/Contents/Developer'),
    exists: present(['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin']) }), true);
  assert.equal(await host.appleToolsPresent({ run: run(Object.assign(Error('unable to get active developer directory'), { code: 2 })), exists: () => true }), false);
  assert.equal(await host.appleToolsPresent({ run: run('relative/dir'), exists: () => true }), false);
  assert.equal(await host.appleToolsPresent({ run: run('/Library/Developer/CommandLineTools'), exists: path => path.endsWith('/swiftc') }), false);
  assert.ok(calls.every(([command]) => command === '/usr/bin/xcode-select'));
});

test('close kills a host that ignores the end of its input', async t => {
  t.after(() => setHandPid(0));
  const children = [];
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true, killAfterMs: 10,
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); c.kill = () => { c.killed = true; }; children.push(c); return c; } }) });
  client.send(frame()); await settle();
  client.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children[0].ended, true); assert.equal(children[0].killed, true);
  // A host that exits on its own is not killed.
  const quiet = createHandClient({ setting: () => ({ enabled: true }), built: () => true, killAfterMs: 10,
    prepare: async () => ({ status: 'ready', spawn: () => { const c = fakeChild(); c.kill = () => { c.killed = true; }; c.stdin.end = () => { c.exitCode = 0; c.emit('exit', 0, null); }; children.push(c); return c; } }) });
  quiet.send(frame()); await settle();
  quiet.close();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children[1].killed, undefined);
});

test('prepareHandHost builds through the helper pipeline and its handle starts only the hand, with the capture mode', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-build-')))));
  const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(sourceRoot, name), 'source ' + name, { mode: 0o600 });
  let builds = 0;
  // Each fake helper writes its arguments next to itself.
  const compile = async ({ binary }) => { builds++; writeFileSync(binary, '#!/bin/sh\nprintf "%s" "$*" > "$0.args"\n', { mode: 0o700 }); };
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), false);
  // Without Apple's command-line tools nothing compiles, so xcrun never gets to open macOS's install dialog.
  assert.deepEqual(await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => false }), { status: 'unavailable', code: 'APPLE_TOOLS_MISSING' });
  assert.equal(builds, 0);
  const ready = await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => true });
  assert.equal(ready.status, 'ready'); assert.equal(builds, 2);
  assert.deepEqual(Object.keys(ready).sort(), ['spawn', 'status'], 'no receipt leaves the hand handle');
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), true);
  for (const capture of [undefined, 'visible']) {
    const child = ready.spawn(capture ? { capture } : undefined);
    child.stdin.end();
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
    const key = createHash('sha256').update(JSON.stringify({ protocol: 1, arch: process.arch,
      sources: Object.fromEntries(['peer-host.c', 'consent-host.swift'].map(name => [name, createHash('sha256').update('source ' + name).digest('hex')])) })).digest('hex');
    assert.equal(readFileSync(join(cacheRoot, key, 'consent-host.args'), 'utf8'), '--hand --capture=' + (capture ?? 'hidden'));
  }
  assert.throws(() => ready.spawn({ capture: 'readOnly' }), /HAND_CAPTURE_INVALID/);
  // The cached build is reused without asking for the tools, and a changed source is a different build.
  assert.equal((await host.prepareHandHost({ cacheRoot, sourceRoot, compile, tools: async () => false })).status, 'ready'); assert.equal(builds, 2);
  writeFileSync(join(sourceRoot, 'consent-host.swift'), 'changed', { mode: 0o600 });
  assert.equal(host.handHostBuilt({ cacheRoot, sourceRoot }), false);
  assert.deepEqual(await host.prepareHandHost({ cacheRoot, sourceRoot: join(root, 'missing'), compile }), { status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' });
});
