import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('the menu bar item starts hidden, carries the two-hands template glyph and has no title text', () => {
  assert.match(source, /item\.isVisible = false/);
  assert.match(source, /image\.isTemplate = true/);
  assert.doesNotMatch(source, /"sleight disconnected"/);
  assert.match(source, /item\.isVisible = statusVisible\(status, requests: requests\)/);
});

test('the status menu shows only while turbo is in use and admits only the worker\'s known choices', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN STATUS MENU\n([\s\S]*?)\/\/ END STATUS MENU/);
  assert.ok(block, 'status menu block absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-status-menu-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block[1] + `
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
check(!statusVisible("disconnected", requests: 0), "hidden when disconnected")
check(!statusVisible(nil, requests: 0), "hidden before any status")
check(statusVisible("disconnected", requests: 1), "shown for a waiting request")
for s in ["connected", "connected-idle", "paused", "cleanup-required"] { check(statusVisible(s, requests: 0), "shown when " + s) }
let rows = statusRows(["status": "connected", "browser": "Google Chrome", "payments": "ask"], ["pause", "disconnect", "turbo-off"])!
check(rows.map { $0.0 } == ["sleight turbo: Connected", "Browser: Google Chrome", "Payment check: ask when the amount isn't in your message", "-", "Pause", "Disconnect", "Turn turbo off"], "rows")
check(rows.map { $0.1 } == [nil, nil, nil, nil, "pause", "disconnect", "turbo-off"], "choices")
check(statusRows(["status": "connected"], ["pause", "launch"]) == nil, "unknown choice refused")
check(statusRows(["status": "elsewhere"], ["pause"]) == nil, "unknown status refused")
check(statusRows(["status": "paused", "browser": "Chrome<script>"], ["disconnect"])!.map { $0.0 } == ["sleight turbo: Paused", "-", "Disconnect"], "odd browser name dropped")
check(statusRows(["status": "paused", "payments": "sometimes"], ["disconnect"])!.count == 3, "unknown payment value dropped")
check(statusRows(["status": "connected", "optOut": "failed"], ["disconnect"])!.map { $0.0 }.contains("Turning turbo off failed. Run sleight-mcp turbo off."), "failed opt-out shown")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'pass', run.stdout);
});
