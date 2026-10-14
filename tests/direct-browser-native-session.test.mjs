import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const native = process.platform === 'darwin' && existsSync('/usr/bin/xcrun');
test('native host admits only session-bound opt-in/resume frames without launching UI', { skip: !native && 'Darwin Swift compiler unavailable' }, t => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const functionSource = source.match(/\/\/ BEGIN SESSION FRAME\n([\s\S]*?)\/\/ END SESSION FRAME/);
  assert.ok(functionSource, 'native session decision protocol absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-native-session-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\nimport CoreFoundation\n' + functionSource[1] + `
let samples: [Bool] = [
  sessionFrame(["kind":"opt-in", "session":"client", "epoch":1], ["enable","cancel"]) != nil,
  sessionFrame(["kind":"resume", "session":"client", "epoch":1], ["resume","cancel"]) != nil,
  sessionFrame(["kind":"opt-in", "session":"client", "epoch":1], ["resume","cancel"]) == nil,
  sessionFrame(["kind":"resume", "session":"client", "epoch":1], ["enable","cancel"]) == nil,
  sessionFrame(["kind":"opt-in", "session":"", "epoch":1], ["enable","cancel"]) == nil,
  sessionFrame(["kind":"opt-in", "session":"client", "epoch":1, "approved":true], ["enable","cancel"]) == nil,
  sessionFrame(["kind":"opt-in", "session":"client", "epoch":false], ["enable","cancel"]) == nil
]
print(samples.allSatisfy { $0 } ? "pass" : "fail")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), 'pass');
});
