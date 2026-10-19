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

test('the menu bar item starts hidden, carries the glove template glyph and has no title text', () => {
  assert.match(source, /item\.isVisible = false/);
  assert.match(source, /image\.isTemplate = true/);
  assert.doesNotMatch(source, /"sleight disconnected"/);
  assert.match(source, /item\.isVisible = statusVisible\(status, requests: requests\)/);
});

test('Turn Turbo Off asks first, and Settings & Help opens only the fixed docs address', () => {
  assert.match(source, /@objc func confirmOff[\s\S]*?if alert\.runModal\(\) == \.alertFirstButtonReturn \{ respond\(id, choice\) \}/);
  assert.match(source, /URL\(string: "https:\/\/github\.com\/Land-o-Clusters\/sleight\/blob\/main\/docs\/settings\.md#turbo"\)/);
  assert.equal(source.match(/NSWorkspace\.shared\.open/g)?.length, 1);
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
let rows = statusRows(["status": "connected", "browser": "Google Chrome", "payments": "ask", "version": "1.3.0"], ["pause", "disconnect", "turbo-off"])!
check(rows == [.status(title: "Connected to Google Chrome", dot: "green", details: ["Payments: asks unless you named the amount"]),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .confirm("Turn Turbo Off…", choice: "turbo-off"), .help, .separator, .footer("sleight 1.3.0")], "connected menu")
let paused = statusRows(["status": "paused", "browser": "Helium"], ["disconnect", "turbo-off"])!
check(paused.first == .status(title: "Paused · Helium", dot: "orange", details: ["Resumes when Claude next asks, with your OK"]), "paused header")
check(!paused.contains(.action("Pause", choice: "pause")), "no Pause when paused")
check(statusRows(["status": "cleanup-required"], ["cleanup"])! == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .help], "cleanup menu, no footer without a version")
check(statusRows(["status": "connected"], ["pause", "launch"]) == nil, "unknown choice refused")
check(statusRows(["status": "elsewhere"], ["pause"]) == nil, "unknown status refused")
check(statusRows(["status": "connected", "browser": "Chrome<script>"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "odd browser name dropped")
check(statusRows(["status": "connected", "payments": "sometimes", "version": "1.3.0; rm"], ["disconnect"])!.last == .help, "unknown payment value and odd version dropped")
check(statusRows(["status": "connected", "optOut": "failed"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: [optOutFailed]), "failed opt-out shown")
// The host line, from the relay's label of each host's own clientInfo (fixtures in tests/fixtures/host-client-info.json).
for (host, label) in [("claude-code", "Claude Code 2.1.289"), ("codex", "Codex 0.160.0"), ("cursor", "Cursor")] {
  check(statusRows(["status": "connected", "host": label, "payments": "ask"], ["disconnect"])!.first ==
    .status(title: "Connected", dot: "green", details: ["Host: " + label, "Payments: asks unless you named the amount"]), "host line for " + host)
}
check(statusRows(["status": "connected-idle", "host": "Codex 0.160.0"], ["disconnect"])!.first ==
  .status(title: "Connected", dot: "green", details: ["Host: Codex 0.160.0", "Its session has ended"]), "idle session names no host by guess")
check(statusRows(["status": "connected-idle"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: ["Its session has ended"]), "no host, no host line")
check(statusRows(["status": "connected", "host": "Codex\\nmodel gpt"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "odd host dropped")
check(statusRows(["status": "connected", "host": String(repeating: "a", count: 73)], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "long host dropped")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'pass', run.stdout);
});
