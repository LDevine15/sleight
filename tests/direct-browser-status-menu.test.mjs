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
  assert.match(source, /item\.isVisible = menuVisible\(status, requests: requests, handEnabled: hand\?\.enabled \?\? false, sinceAct: since\)/);
  // The hookup runs on the bar button only, starts on a connect transition and leaves no timer behind.
  assert.match(source, /if hookupConnects\(from: previous, to: status\)/);
  assert.match(source, /if index == hookupFrameCount \{ timer\.invalidate\(\); self\.hookupTimer = nil \}/);
});

test('the Ghost Hand row is a checkmark item that answers with its own choice, without asking', () => {
  assert.match(source, /case let \.toggle\(title, choice, on\):[\s\S]*?entry\.state = on \? \.on : \.off/);
  assert.match(source, /case let \.toggle\(title, choice, on\):[\s\S]*?#selector\(control\(_:\)\)/);
});

test('Turn Turbo Off asks first, and Settings & Help opens only the fixed docs address', () => {
  assert.match(source, /@objc func confirmOff[\s\S]*?let answer = modal\.run\(abort: \{ NSApp\.abortModal\(\) \}\) \{ alert\.runModal\(\) \}\n\s*if answer == \.alertFirstButtonReturn \{ respond\(id, choice\) \}/);
  assert.match(source, /URL\(string: "https:\/\/github\.com\/Land-o-Clusters\/sleight\/blob\/main\/docs\/settings\.md#" \+ \(status == nil \? "ghost-hand" : "turbo"\)\)/);
  assert.equal(source.match(/NSWorkspace\.shared\.open/g)?.length, 1);
});

test('the status menu shows only while turbo is in use and admits only the worker\'s known choices', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN STATUS MENU\n([\s\S]*?)\/\/ END STATUS MENU/);
  const hookup = source.match(/\/\/ BEGIN HOOKUP\n([\s\S]*?)\/\/ END HOOKUP/);
  assert.ok(block, 'status menu block absent'); assert.ok(hookup, 'hookup block absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-status-menu-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block[1] + hookup[1] + `
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
// The Ghost Hand row: a checkmark showing the hand's setting, whose one choice flips it.
check(statusRows(["status": "connected", "hand": "on"], ["pause", "disconnect", "hand-off", "turbo-off"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .toggle("Ghost Hand", choice: "hand-off", on: true), .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "hand on row")
check(statusRows(["status": "paused", "hand": "off"], ["disconnect", "hand-on", "turbo-off"])!.contains(.toggle("Ghost Hand", choice: "hand-on", on: false)), "hand off row")
check(statusRows(["status": "cleanup-required", "hand": "on"], ["cleanup", "hand-off"])! == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .toggle("Ghost Hand", choice: "hand-off", on: true), .help], "hand row while cleanup waits")
check(statusRows(["status": "connected", "hand": "on"], ["hand-on"]) == nil, "the choice must flip the shown state")
check(statusRows(["status": "connected", "hand": "off"], ["hand-off"]) == nil, "the choice must flip the shown state, off")
check(statusRows(["status": "connected"], ["disconnect", "hand-off"]) == nil, "a hand choice needs the hand state")
check(statusRows(["status": "connected", "hand": "on"], ["disconnect", "hand-off", "hand-on"]) == nil, "one hand choice at most")
check(statusRows(["status": "connected", "hand": "maybe"], ["disconnect"]) == nil, "unknown hand state refused")
check(statusRows(["status": "connected", "hand": "on"], ["disconnect"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Disconnect", choice: "disconnect"), .separator, .help], "no row without its choice")
// The shared host: the glove shows for turbo, a waiting request, or an enabled hand that acted in the last five minutes.
check(handIdleWindow == 300, "five minutes")
check(!menuVisible(nil, requests: 0, handEnabled: true, sinceAct: nil), "hand on, no action yet")
check(menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 0), "hand just acted")
check(menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 299.9), "inside the window")
check(!menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 300), "past the window")
check(!menuVisible(nil, requests: 0, handEnabled: false, sinceAct: 1), "hand off")
check(!menuVisible("disconnected", requests: 0, handEnabled: true, sinceAct: nil), "turbo disconnected, hand idle")
check(menuVisible("paused", requests: 0, handEnabled: false, sinceAct: nil), "turbo paused")
check(menuVisible(nil, requests: 1, handEnabled: false, sinceAct: nil), "a waiting request")
// Without turbo, the hand's own block: its toggle, Settings & Help, the version.
check(handRows(enabled: true, version: "1.3.1") == [.toggle("Ghost Hand", choice: "hand-toggle", on: true), .separator, .help, .separator, .footer("sleight 1.3.1")], "hand-only menu")
check(handRows(enabled: false, version: "1.3; x") == [.toggle("Ghost Hand", choice: "hand-toggle", on: false), .separator, .help], "hand-only menu, odd version dropped")
// With turbo, the hand channel's toggle joins the turbo menu once, before Turn Turbo Off.
check(withHand(statusRows(["status": "connected"], ["pause", "disconnect", "turbo-off"])!, enabled: true) == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: true), .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "turbo menu with the hand")
check(withHand(statusRows(["status": "cleanup-required"], ["cleanup"])!, enabled: false) == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: false), .help], "cleanup menu with the hand")
let workerRow = statusRows(["status": "connected", "hand": "on"], ["disconnect", "hand-off"])!
check(withHand(workerRow, enabled: true) == workerRow, "never a second Ghost Hand row")
// Turbo's connect hookup: the four dabs flow in and settle on the glyph in under a second.
check(Double(hookupFrameCount) * hookupInterval < 1 && Double(hookupFrameCount) * hookupInterval >= 0.5, "under a second")
check(hookupFrame(menuGlyph, hookupFrameCount - 1) == menuGlyph, "settles on the glyph")
check((0..<(hookupFrameCount - 1)).allSatisfy { hookupFrame(menuGlyph, $0) != menuGlyph }, "moves until the last frame")
check(hookupFrame(menuGlyph, 0).contains("fill-opacity") && hookupFrame(menuGlyph, 0).components(separatedBy: "<rect").count == 5, "four dabs fading in")
check(hookupFrame(menuGlyph, 0).replacingOccurrences(of: #"<rect[^>]*/>"#, with: "", options: .regularExpression)
  == menuGlyph.replacingOccurrences(of: #"<rect[^>]*/>"#, with: "", options: .regularExpression), "only the dabs move")
check(hookupConnects(from: nil, to: "connected") && hookupConnects(from: "disconnected", to: "connected") && hookupConnects(from: "paused", to: "connected"), "connecting")
check(!hookupConnects(from: "connected", to: "connected") && !hookupConnects(from: "connected-idle", to: "connected") && !hookupConnects(from: nil, to: "paused"), "not connecting")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'pass', run.stdout);
});
