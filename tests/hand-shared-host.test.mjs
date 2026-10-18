import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// The shared host: one consent-host process per session serves the hand (stdin, toggle events on stdout) and turbo's consent
// channel (fd 3 in, fd 4 out). These tests never show anything: the turbo status is disconnected and the hand is off, so the
// glove stays hidden, and every hand frame names a window that doesn't exist.
const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const skip = macCommandSkip('xcrun');
let built;
function build() {
  if (built) return built;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-shared-host-'))));
  const binary = join(dir, 'consent-host');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return (built = binary);
}
const handNonce = 'a'.repeat(64), consentNonce = 'c'.repeat(64);
const line = frame => JSON.stringify(frame) + '\n';
const menu = (over = {}) => ({ hand: 'menu', nonce: handNonce, enabled: false, capture: 'hidden', version: '1.3.1', ...over });
const act = (seq, over = {}) => ({ hand: 'act', nonce: handNonce, seq, kind: 'click', pid: 2147483647, windowId: 4294967295,
  at: [10, 10], path: [[10, 10]], delayMs: 0, beats: 1, ...over });
const status = (over = {}) => ({ id: 'v3-control-1', nonce: consentNonce, choices: ['connect'], deadline: Date.now() + 60000,
  data: { status: 'disconnected' }, ...over });

// Runs the host with both channels. steps: [fd, frame] pairs or ['end', fd] or ['wait', ms]. Resolves with the exit code and
// every byte written on stdout and fd 4.
function shared(binary, steps, args = ['--hand', '--consent']) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  const out = { stdout: '', consent: '', stderr: '' }, exited = new Promise(resolve => child.on('exit', resolve));
  child.stdout.on('data', d => { out.stdout += d; }); child.stdio[4].on('data', d => { out.consent += d; }); child.stderr.on('data', d => { out.stderr += d; });
  for (const fd of [0, 3]) child.stdio[fd].on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  return (async () => {
    for (const [what, value] of steps) {
      if (what === 'wait') await new Promise(resolve => setTimeout(resolve, value));
      else if (what === 'end') child.stdio[value].end();
      else child.stdio[what].write(typeof value === 'string' ? value + '\n' : line(value));
    }
    const code = await exited;
    clearTimeout(timer);
    return { code, ...out };
  })();
}

test('two senders share one host: consent on fds 3 and 4, the hand on stdin, and turbo ending leaves the hand running', { skip }, async () => {
  const binary = build();
  const result = await shared(binary, [[3, status()], [0, menu()], [0, act(1)], [0, act(2, { kind: 'drag' })], ['wait', 300], ['end', 3], ['wait', 300],
    [0, act(3)], [0, menu({ enabled: true, capture: 'visible' })], [0, menu({ enabled: false })], [0, { hand: 'hide', nonce: handNonce }], ['end', 0]]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '', 'hand frames never produce stdout'); assert.equal(result.consent, '', 'no choice without a click');
});

test('each channel has its own parser and nonce: crossed frames and a shared nonce end the host', { skip }, async () => {
  const binary = build();
  const cases = {
    'a hand frame on the consent channel': [[3, menu()]],
    'a consent frame on the hand channel': [[0, status()]],
    'the consent nonce on the hand channel': [[3, status()], ['wait', 300], [0, menu({ nonce: consentNonce })]],
    'the hand nonce on the consent channel': [[0, menu()], ['wait', 300], [3, status({ nonce: handNonce })]],
    'a second hand nonce': [[0, menu()], [0, act(1, { nonce: 'b'.repeat(64) })]],
    'a second consent nonce': [[3, status()], [3, status({ id: 'v3-control-2', nonce: 'd'.repeat(64) })]],
    'a menu frame with an extra key': [[0, menu({ visible: true })]],
    'a menu frame with a string flag': [[0, menu({ enabled: 'false' })]],
    'a menu frame with an unknown capture': [[0, menu({ capture: 'readOnly' })]],
    'a menu frame with an odd version': [[0, menu({ version: '1.3.1; x' })]],
    'a toggle frame from a sender': [[0, { hand: 'toggle', nonce: handNonce, enabled: true }]],
  };
  for (const [name, steps] of Object.entries(cases)) {
    const result = await shared(binary, [...steps, ['wait', 200], ['end', 3], ['end', 0]]);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
    assert.equal(result.stdout + result.consent, '', name);
  }
});

test('--consent needs its two descriptors, and the arguments stay strict', { skip }, () => {
  const binary = build();
  const run = args => spawnSync(binary, args, { input: '', encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run(['--hand', '--consent']).status, 64, 'no fd 3 or 4');
  for (const args of [['--hand', '--consent', '--capture=visible'], ['--hand', '--consent', '--consent'], ['--consent'], ['--hand-dump', '--consent']]) {
    assert.equal(run(args).status, 64, args.join(' '));
  }
});

test('the dump renders every hookup frame as a template image', { skip }, () => {
  const result = spawnSync(build(), ['--hand-dump'], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).hookup, { frames: 10, rendered: 10, template: true, seconds: 0.8 });
});

test('the menu frame\'s Permissions rows and the status frame\'s site are admitted exactly, and anything else ends the host', { skip }, async () => {
  const binary = build();
  const rows = { grants: [{ title: 'Fixture', detail: 'always', used: 1760000000, target: 'app:Fixture' }, { title: 'Chat', detail: 'debugger, always', used: null, target: 'electron:com.example.chat' },
    { title: 'Browser', detail: 'turbo', used: null, target: 'turbo' }], blocked: ['Blocked App'], current: { title: 'Editor', target: 'com.example.editor' }, only: ['https://a.example'] };
  const site = status({ choices: ['connect', 'block-site'], data: { status: 'disconnected', site: 'https://example.com' } });
  const good = await shared(binary, [[3, site], [0, menu({ permissions: rows })], [0, menu({ permissions: { grants: [], blocked: [] } })], ['wait', 300], ['end', 3], ['end', 0]]);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(good.stdout + good.consent, '', 'rows draw nothing and answer nothing without a click');
  const cases = {
    'an unknown grant target': menu({ permissions: { grants: [{ ...rows.grants[0], target: 'unblock:Fixture' }], blocked: [] } }),
    'a grant with an extra key': menu({ permissions: { grants: [{ ...rows.grants[0], grant: true }], blocked: [] } }),
    'a current app that is no bundle id': menu({ permissions: { grants: [], blocked: [], current: { title: 'x', target: 'x' } } }),
    'an unknown permissions key': menu({ permissions: { grants: [], blocked: [], unblock: ['x'] } }),
  };
  for (const [name, frame] of Object.entries(cases)) {
    const result = await shared(binary, [[0, frame], ['wait', 200], ['end', 3], ['end', 0]]);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
  }
  for (const [name, frame] of Object.entries({ 'a site that is a path': status({ data: { status: 'disconnected', site: 'https://example.com/x' } }),
    'a site choice without a site': status({ choices: ['connect', 'block-site'] }) })) {
    const result = await shared(binary, [[3, frame], ['wait', 200], ['end', 3], ['end', 0]]);
    assert.equal(result.code, 65, name + ': ' + result.stderr);
  }
});
