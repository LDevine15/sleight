import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// The ghost hand's host is the consent host in hand mode. These tests build it and feed it frames, but never show the panel:
// every frame names a window that doesn't exist, so the host validates it and draws nothing.
const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const source = readFileSync(sourcePath, 'utf8');
const section = name => source.match(new RegExp(`// BEGIN ${name}\\n([\\s\\S]*?)// END ${name}`))?.[1];
const nonce = 'a'.repeat(64), other = 'b'.repeat(64);
// pid 2^31-1 and window 2^32-1 belong to nothing, so the window lookup fails and nothing is drawn.
const act = (seq, over = {}) => ({ hand: 'act', nonce, seq, kind: 'click', pid: 2147483647, windowId: 4294967295,
  at: [100.5, 200], path: [[40, 60], [100.5, 200]], delayMs: 0, beats: 1, ...over });
const line = frame => (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n';

test('hand source: it never posts input, moves the pointer, activates, takes key or writes stdout', () => {
  const host = section('HAND HOST'), frame = section('HAND FRAME'), art = section('HAND ART');
  assert.ok(host && frame && art, 'hand sections absent');
  for (const text of [host, frame, art]) {
    assert.doesNotMatch(text, /CGEvent|CGWarp|NSCursor|activate\(|makeKey|makeMain|becomeKey\(|orderFront\(|AXUIElement|standardOutput|print\(|NSLog/);
  }
  assert.match(host, /orderFrontRegardless\(\)/);
  assert.match(host, /IsSecureEventInputEnabled\(\)/);
  assert.match(host, /CAKeyframeAnimation\(keyPath: "position"\)/);
  // The timings sleight-arch set until the art director delivers.
  assert.match(host, /glide = 0\.3, flourish = 0\.15, fade = 0\.3, silence = 1\.5/);
});

// One compile for the file, removed when the process exits.
let built;
function build() {
  if (built) return built;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-host-'))));
  const binary = join(dir, 'consent-host');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return (built = binary);
}
const run = (binary, args, input) => spawnSync(binary, args, { input, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });

test('hand mode: 1,000 hand frames and a hide give 0 bytes on stdout and a clean exit', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const kinds = ['click', 'double', 'right', 'key', 'type', 'drag', 'scroll'];
  let input = '';
  for (let seq = 1; seq <= 1000; seq++) {
    input += line(act(seq, { kind: kinds[seq % kinds.length], beats: 1 + seq % 3, delayMs: seq % 2 ? 0 : 5,
      path: Array.from({ length: 1 + seq % 64 }, (_, i) => [i * 3.25, -i * 1.5]) }));
    if (seq % 250 === 0) input += line({ hand: 'hide', nonce });
  }
  const result = run(binary, ['--hand'], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout), 0);
});

test('hand mode: what the client writes is what the host accepts, for every kind and fitted value', { skip: macCommandSkip('xcrun') }, async () => {
  const binary = build();
  const { createHandClient } = await import('../plugins/sleight/lib/hand/client.mjs');
  const { setHandPid } = await import('../plugins/sleight/lib/hand/pid.mjs');
  let text = '';
  const child = Object.assign(new (await import('node:events')).EventEmitter(), { pid: 1,
    stdin: Object.assign(new (await import('node:events')).EventEmitter(), { writableLength: 0, write: chunk => { text += chunk; }, end() {} }) });
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const kinds = ['click', 'double', 'right', 'key', 'type', 'drag', 'scroll'];
  for (let i = 0; i < 300; i++) {
    client.send({ kind: kinds[i % 7], pid: 2147483647, windowId: 4294967295, at: [i * 1.337, -i / 3],
      path: i % 5 ? Array.from({ length: i % 90 }, (_, j) => [j / 7, j * 1.1]) : undefined, delayMs: i % 3 ? i * 41 : undefined, beats: i % 30 });
    if (i % 100 === 99) client.hide();
    await new Promise(resolve => setImmediate(resolve));
  }
  setHandPid(0);
  assert.equal(text.split('\n').length - 1, 303);
  const result = run(binary, ['--hand'], text);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('hand mode: each malformed, unbound or replayed frame exits 65 with nothing on stdout', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const cases = {
    'not JSON': 'click 1 2',
    'consent frame': { id: 'x', nonce, choices: ['once', 'cancel'], deadline: Date.now() + 60000, data: {} },
    'unknown verb': { hand: 'show', nonce },
    'short nonce': act(1, { nonce: 'a'.repeat(63) }),
    'upper-case nonce': act(1, { nonce: 'A'.repeat(64) }),
    'hide with extra key': { hand: 'hide', nonce, seq: 1 },
    'extra key': act(1, { text: 'secret' }),
    'missing key': (({ beats, ...rest }) => rest)(act(1)),
    'unknown kind': act(1, { kind: 'hover' }),
    'boolean pid': act(1, { pid: true }),
    'zero pid': act(1, { pid: 0 }),
    'fractional window': act(1, { windowId: 1.5 }),
    'window past 32 bits': act(1, { windowId: 4294967296 }),
    'string point': act(1, { at: ['1', 2] }),
    'three-number point': act(1, { at: [1, 2, 3] }),
    'far point': act(1, { at: [100001, 0] }),
    'empty path': act(1, { path: [] }),
    'path of 65': act(1, { path: Array.from({ length: 65 }, () => [0, 0]) }),
    'bad point in path': act(1, { path: [[0, 0], [0, null]] }),
    'negative delay': act(1, { delayMs: -1 }),
    'long delay': act(1, { delayMs: 10001 }),
    'no beats': act(1, { beats: 0 }),
    'too many beats': act(1, { beats: 21 }),
    'negative seq': act(-1),
    'oversized line': JSON.stringify(act(1)).replace('"click"', '"click"' + ' '.repeat(9000)),
  };
  for (const [name, frame] of Object.entries(cases)) {
    const result = run(binary, ['--hand'], line(frame));
    assert.equal(result.status, 65, name + ': ' + result.stderr);
    assert.equal(result.stdout, '', name);
  }
  // The first frame binds the nonce; a later frame with another nonce, or a seq that doesn't increase, ends the host.
  for (const [name, frames] of Object.entries({
    'second nonce': [act(1), act(2, { nonce: other })],
    'hide with another nonce': [act(1), { hand: 'hide', nonce: other }],
    'repeated seq': [act(1), act(1)],
    'seq going back': [act(5), act(4)],
  })) {
    const result = run(binary, ['--hand'], frames.map(line).join(''));
    assert.equal(result.status, 65, name); assert.equal(result.stdout, '', name);
  }
  // Valid frames before the bad one were drawn or skipped quietly, and still nothing reached stdout.
  const good = run(binary, ['--hand'], [act(1), act(2), { hand: 'hide', nonce }].map(line).join(''));
  assert.equal(good.status, 0, good.stderr); assert.equal(good.stdout, '');
});

test('hand mode: arguments other than its own modes exit 64 without drawing', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  for (const args of [['--hand', 'extra'], ['--hand-demo'], ['--hand-demo', '1,2,3'], ['--hand-demo', '0,0,0,10'], ['--hand-demo', 'a,b,c,d'], ['--unknown'],
    ['--hand', '--capture=shown'], ['--hand', '--capture='], ['--hand', '--capture=visible', '--capture=hidden'], ['--hand', '--capture', 'visible'],
    ['--hand-dump', '--capture=readOnly'], ['--hand-demo', '0,0,10,10', '--capture=none'], ['--capture=visible', '--hand']]) {
    const result = run(binary, args, '');
    assert.equal(result.status, 64, args.join(' ')); assert.equal(result.stdout, '');
  }
  // Both capture modes run hand mode the same way.
  for (const capture of ['hidden', 'visible']) {
    const result = run(binary, ['--hand', '--capture=' + capture], [act(1), act(2, { kind: 'drag' }), { hand: 'hide', nonce }].map(line).join(''));
    assert.equal(result.status, 0, capture + ': ' + result.stderr); assert.equal(result.stdout, '');
  }
});

test('hand dump: capture visible makes the panel readOnly so screenshots show it, and nothing else changes', { skip: macCommandSkip('xcrun') }, () => {
  const binary = build();
  const dumps = [[], ['--capture=hidden'], ['--capture=visible']].map(args => {
    const result = run(binary, ['--hand-dump', ...args], '');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual([dumps[0].capture, dumps[0].panel.sharingType], ['hidden', 'none']);
  assert.deepEqual(dumps[1], dumps[0]);
  assert.deepEqual([dumps[2].capture, dumps[2].panel.sharingType], ['visible', 'readOnly']);
  assert.deepEqual({ ...dumps[2], capture: 'hidden', panel: { ...dumps[2].panel, sharingType: 'none' } }, dumps[0]);
});

test('hand dump: the panel has exactly the flags of the design, never shown, with the art at 1x and 2x', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const result = run(binary, ['--hand-dump'], '');
  assert.equal(result.status, 0, result.stderr);
  const dump = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(dump.art));
  assert.deepEqual(dump.panel, {
    borderless: true, nonactivatingPanel: true, canBecomeKey: false, canBecomeMain: false, ignoresMouseEvents: true,
    hasShadow: false, opaque: false, backgroundAlpha: 0, level: 3, sharingType: 'none',
    collectionBehavior: ['fullScreenAuxiliary', 'ignoresCycle', 'stationary', 'transient'],
    accessibilityElement: false, contentAccessibilityElement: false, hidesOnDeactivate: false, visible: false,
  });
  assert.equal(dump.capture, 'hidden');
  assert.deepEqual(dump.timing,{ glide: 0.3, flourish: 0.15, fade: 0.3, silence: 1.5 });
  assert.equal(dump.art.height, 32); assert.equal(dump.art.opacity, 0.7);
  assert.ok(dump.art.width > 32 && dump.art.width < 64, String(dump.art.width));
  assert.deepEqual(dump.art.pixels, [[Math.round(dump.art.width), 32], [Math.round(dump.art.width * 2), 64]]);
  // Mostly white glove with a thin dark outline, so it reads on light and dark windows.
  const [white, dark] = dump.art.tones;
  assert.ok(white > 300 && dark > 100 && dark < white * 2, JSON.stringify(dump.art.tones));
  // The hand's action point is the glyph's pointer tip, near the top right of the art.
  assert.ok(dump.art.anchor[0] > 0.5 && dump.art.anchor[0] < 1 && dump.art.anchor[1] > 0.8 && dump.art.anchor[1] <= 1, JSON.stringify(dump.art.anchor));
  // A route from (100, 100) to (160, 200) gets a panel of its box plus 48 pt, clipped to a window at (60, 0) sized 200 by 200,
  // in global top-left points as [x, y, width, height].
  assert.deepEqual(dump.box, { unclipped: [52, 52, 156, 196], clipped: [60, 52, 148, 148] });
  // After the fade's release the host holds no panel and no scheduled work.
  assert.equal(dump.idle, true);
});
