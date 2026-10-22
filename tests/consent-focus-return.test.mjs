import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// The 2026-10-22 qualification runs: the click that answered a card left the accessory host active with no window, and when the
// worker and its host exited, VS Code (the card's app, its window under the card) came to the front. The host now hands
// activation back when a card closes. These tests drive the decision with fakes; nothing is shown or activated.
const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('a card records who was in front before it shows and hands activation back on every close', () => {
  assert.match(source, /activeAsk = \(id, panel\); focus\.presenting\(data\); panel\.show\(\); return/);
  assert.match(source, /self\.activeAsk = nil; self\.focus\.dismissed\(\); self\.respond\(id, choice\); self\.showNextAsk\(\)/);
  assert.match(source, /func closeAsk\(\) \{ activeAsk\?\.panel\.close\(\); activeAsk = nil; focus\.dismissed\(\) \}/);
  // Showing stays as it was: no activation, the same sound. GB12's guard is untouched.
  assert.match(source, /func show\(\) \{\s*panel.makeKeyAndOrderFront\(nil\)\s*NSSound\(named: "Glass"\)\?\.play\(\)\s*\}/);
  const block = source.match(/\/\/ BEGIN FOCUS RETURN\n([\s\S]*?)\/\/ END FOCUS RETURN/)?.[1];
  assert.ok(block, 'focus return absent');
  assert.doesNotMatch(block, /CGEvent|AXUIElement|NSApp|NSRunningApplication|NSWorkspace/, 'the decision itself touches no system state');
  assert.doesNotMatch(source, /activate\(ignoringOtherApps|activateIgnoringOtherApps/);
});

test('Swift focus return with fakes: back to the person\'s app, never the card\'s app, never over the person\'s own switch', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN FOCUS RETURN\n([\s\S]*?)\/\/ END FOCUS RETURN/)[1];
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-focus-return-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block + `
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
// pids: host 50, Terminal 100, Safari 200, the VS Code fixture 300 (a second copy 301 shares its bundle).
var front: pid_t? = 100, active = false, alive: Set<pid_t> = [50, 100, 200, 300, 301], activated: [pid_t] = []
func make() -> FocusReturn {
    FocusReturn(host: 50, frontmost: { front }, hostActive: { active }, running: { alive.contains($0) },
        pids: { $0 == "com.microsoft.VSCode" ? [300, 301] : [] }, activate: { activated.append($0) })
}
let vscode: [String: Any] = ["kind": "debugger", "app": ["bundleId": "com.microsoft.VSCode", "pid": NSNumber(value: 300)]]
let unlaunched: [String: Any] = ["kind": "debugger", "app": ["bundleId": "com.microsoft.VSCode", "pid": NSNumber(value: 0)]]
let session: [String: Any] = ["kind": "opt-in", "session": "s1", "epoch": 1]
func reset() { front = 100; active = false; alive = [50, 100, 200, 300, 301]; activated = [] }

// The receipts' case: the click activates the host; the card closes; Terminal comes back, before any host exit.
reset(); var focus = make(); focus.presenting(vscode); front = 50; active = true
check(focus.dismissed() == 100 && activated == [100], "click then close returns to Terminal")
// The workspace can still report Terminal while the host is active: activity decides, and Terminal comes back.
reset(); focus = make(); focus.presenting(vscode); active = true
check(focus.dismissed() == 100, "stale frontmost while the host is active")
// The fixture took over while the card was up (or no app holds it): Terminal comes back.
reset(); focus = make(); focus.presenting(vscode); front = 300
check(focus.dismissed() == 100, "fixture in front")
reset(); focus = make(); focus.presenting(vscode); front = 301
check(focus.dismissed() == 100, "another copy of the card's app in front")
reset(); focus = make(); focus.presenting(vscode); front = nil
check(focus.dismissed() == 100, "no app in front")
// The person moved to Safari and the host is not active: Safari stays.
reset(); focus = make(); focus.presenting(vscode); front = 200
check(focus.dismissed() == nil && activated.isEmpty, "the person's own switch stands")
// Nothing took over (a card that timed out unclicked): no call at all.
reset(); focus = make(); focus.presenting(vscode)
check(focus.dismissed() == nil && activated.isEmpty, "Terminal still in front")
// The person was in the card's app, by pid or by bundle (before launch): never activated.
reset(); front = 300; focus = make(); focus.presenting(vscode); active = true
check(focus.dismissed() == nil && activated.isEmpty, "previous is the card's app")
reset(); front = 301; focus = make(); focus.presenting(unlaunched); active = true
check(focus.dismissed() == nil && activated.isEmpty, "previous shares the card's bundle")
// The previous app quit meanwhile: nothing to return to.
reset(); focus = make(); focus.presenting(vscode); active = true; alive.remove(100)
check(focus.dismissed() == nil && activated.isEmpty, "previous app gone")
// A card about no app still returns activation.
reset(); focus = make(); focus.presenting(session); active = true
check(focus.dismissed() == 100, "session card")
// Back-to-back cards: the second shows while the host is still in front, so the first card's record stands.
reset(); focus = make(); focus.presenting(vscode); front = 50; active = true
check(focus.dismissed() == 100, "first card")
focus.presenting(vscode)
check(focus.previous == 100 && focus.dismissed() == 100 && activated == [100, 100], "second card keeps Terminal")
// One close per card: an abort after the answer, or a close with no card, does nothing.
check(focus.dismissed() == nil && activated.count == 2, "second close")
reset(); focus = make(); active = true
check(focus.dismissed() == nil && activated.isEmpty, "no card shown")
// The host never activates itself.
reset(); front = 50; focus = make(); focus.presenting(vscode); active = true
check(focus.previous == nil && focus.dismissed() == nil && activated.isEmpty, "no previous app recorded")
// The card's target: pid only when launched.
check(cardTarget(vscode)?.pid == 300 && cardTarget(vscode)?.bundle == "com.microsoft.VSCode", "launched target")
check(cardTarget(unlaunched)?.pid == nil && cardTarget(unlaunched)?.bundle == "com.microsoft.VSCode", "unlaunched target")
check(cardTarget(session)?.pid == nil && cardTarget(session)?.bundle == nil, "no target")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 180000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.stdout.trim(), 'pass', run.stdout + run.stderr);
});
