import test from './macos-only.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOwned } from '../bench/preapproved-process.mjs';
import { macCommandSkip } from './requirements.mjs';

for (const scenario of ['safari-setup-policy', 'safari-escape-guards', 'fixture-navigation', 'safari-address', 'safari-recovery', 'safari-profile-submenu', 'safari-profile-proof', 'safari-menu-release', 'safari-retained-close', 'control-command', 'timeout-recovery', 'shop-smoke',
  'window-cleanup-tab', 'window-cleanup-sheet', 'window-cleanup-dialog', 'window-cleanup-refused',
  'window-cleanup-still-listed', 'window-cleanup-second', 'window-cleanup-system',
  'window-cleanup-cancel-refused', 'window-cleanup-dialog-changed', 'window-cleanup-late-sheet',
  'window-cleanup-late-second']) {
  test(`browser regression: ${scenario}`, { skip: macCommandSkip('xcrun') }, async () => {
    const { heliumHelper } = await import('../bench/real-helium.mjs');
    const command = await heliumHelper();
    const result = await runOwned(command, ['--self-test', scenario], { timeoutMs: 15000 });
    assert.equal(result.groupClean, true);
    assert.equal(result.exit.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true });
  });
}

test('Helium acquires creation events and recovers only a retained window reference', { skip: macCommandSkip('xcrun') }, async () => {
  const { heliumHelper } = await import('../bench/real-helium.mjs');
  const command = await heliumHelper();
  const result = await runOwned(command, ['--self-test'], { timeoutMs: 15000 });
  assert.equal(result.groupClean, true);
  assert.equal(result.exit.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { delayedFixture: true, ambiguousCreationRefused: true, existingWindowsRead: 0, retainedRecovery: true, unmatchedCreationUnowned: true, retainedNavigation: true, profileCommands: true, preActionBlankRefused: true, postCommandBlankRefused: true });
  const source = readFileSync(new URL('../bench/real-helium.swift', import.meta.url), 'utf8');
  assert.match(source, /Shop smoke fixtures require retained-url setup/);
  assert.doesNotMatch(source, /NSAppleScript|ScriptingBridge/);
  const acquisition = source.slice(source.indexOf('func fixture('), source.indexOf('    setup = false'));
  assert.doesNotMatch(acquisition, /kAXWindowsAttribute|recoverSetup\(/);
});

// Removing the setup proof must fail here even though navigation also rechecks it.
test('Safari fixture proves the retained window before menu input or navigation', () => {
  const source = readFileSync(new URL('../bench/real-helium.swift', import.meta.url), 'utf8');
  const acquisition = source.slice(source.indexOf('func fixture('), source.indexOf('    setup = false'));
  const steps = ['owned = try retainCreated(created)', 'try awaitSafariProfile(', 'safariProfileProven = true', 'try clearSafariMenu(', 'try navigateRetained('];
  const positions = steps.map(step => acquisition.indexOf(step));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])));
  const escape = source.slice(source.indexOf('func clearSafariMenu('), source.indexOf('func navigateSafariWindow('));
  assert.ok(escape.indexOf('try requireFixtureEscape(') < escape.indexOf('down.postToPid(pid)'));
  assert.match(escape, /SLEIGHT_STUCK_ESCAPE/);
  assert.match(escape, /combinedSessionState/);
  assert.match(escape, /UInt32.max/);
});
