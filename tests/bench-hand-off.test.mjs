// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
// Every benchmark arm's sleight server runs with the ghost hand off (SLEIGHT_HAND=0), as the Firefox arms run with
// turbo off, so the hand's panel stays out of timing. Only an explicit setting on the arm (the cost pass) turns it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexSleightRunConfig, codexSleightServers } from '../bench/codex-sleight.mjs';
import { PRIVATE_RUNTIME_KEYS } from '../bench/driver.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { fowlSleightSetup } from '../bench/fowl/surface.mjs';
import { worldAgentSetup, WORLD_SURFACES } from '../bench/world/arms/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SERVER = 'plugin:sleight:computer';
const task = { name: 'fixture', browser: 'firefox', prompt: 'Visit {browser}.', result: 'the answer' };
const firefox = { browser: 'firefox', profileRoot: '/tmp/profile', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate fixture0001', pid: 1 };
const chrome = { browser: 'chrome', profileRoot: '/tmp/profile', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', marker: 'Sleight Gate fixture0002', pid: 2, connectionMode: 'product-remote-debugging' };
const hostOn = { PATH: '/bin', SLEIGHT_HAND: '1' };

test('world and claim arms: the Claude process env and every sleight server env have the hand off, whatever the host says', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hand-off-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const surface of WORLD_SURFACES) {
    assert.equal(worldAgentSetup({ surface, dir: join(dir, 'runs', surface), armRoot: join(dir, 'arms'), hostEnv: hostOn }).env.SLEIGHT_HAND, '0', surface);
  }
  const saved = process.env.SLEIGHT_HAND; process.env.SLEIGHT_HAND = '1';
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_HAND; else process.env.SLEIGHT_HAND = saved; });
  for (const [label, setup] of [
    ['engine arm (Firefox)', realAgentSetup({ task, surface: 'sleight', dir: `${MAC_TMP}/gate-task`, realBrowser: firefox, dryRun: true })],
    ['turbo arm (Chrome)', realAgentSetup({ task: { ...task, browser: 'chrome', prompt: 'Visit http://127.0.0.1:5420/x in {browser}.' },
      surface: 'sleight-turbo', dir: `${MAC_TMP}/gate-task`, realBrowser: chrome, dryRun: true })],
  ]) {
    assert.equal(setup.env.SLEIGHT_HAND, '0', label);
    assert.equal(setup.mcpConfig.mcpServers[SERVER].env.SLEIGHT_HAND, '0', label);
  }
  assert.equal(fowlSleightSetup({ dir: `${MAC_TMP}/fowl`, mcpRoot: '/fixture', sleightRepo: root, label: 'x' }).mcpServers[SERVER].env.SLEIGHT_HAND, '0');
});

test('sleight-in-Codex arms (race and run.mjs suites) write the hand off into config.toml; an arm setting wins', () => {
  for (const surface of ['codex-sleight', 'codex-sleight-sol']) {
    for (const realBrowser of [firefox, chrome]) {
      const setup = realAgentSetup({ task: { ...task, browser: realBrowser.browser }, surface, dir: '/tmp/x', realBrowser, dryRun: true });
      assert.match(setup.codexConfig.toml, /SLEIGHT_HAND = "0"/, `${surface} ${realBrowser.browser}`);
    }
  }
  assert.match(codexSleightRunConfig({ model: 'gpt-6.1-sol', dir: '/tmp/x', suite: 'real' }).toml, /SLEIGHT_HAND = "0"/);
  const servers = mcpEnv => codexSleightServers({ mcpServers: { [SERVER]: { command: '/fixture/sleight-mcp', env: mcpEnv } }, allowed: '', dir: '/tmp/x', policy: 'bench' });
  assert.equal(servers({}).plugin_sleight_computer.env.SLEIGHT_HAND, '0');
  assert.equal(servers({ SLEIGHT_HAND: '1' }).plugin_sleight_computer.env.SLEIGHT_HAND, '1', 'the cost pass turns it on explicitly');
});

test('private passes keep the hand setting, and the FowlBrowser rounds patch and battery pass set it', () => {
  assert.ok(PRIVATE_RUNTIME_KEYS.has('SLEIGHT_HAND'));
  const patch = readFileSync(join(root, 'bench/fowl/sleight-surface.patch'), 'utf8');
  assert.match(patch, /^\+ {4}mcpServers = \{ 'plugin:sleight:computer': .*env: \{ SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_HAND: '0' \} \} \};$/m);
  // Probes that start sleight's server themselves, and the battery, build their env inside live code this test can't start.
  for (const probe of ['ext-speed', 'coldstart-probe', 'dialog-probe', 'download-probe', 'drag-probe', 'startup-probe']) {
    const source = readFileSync(join(root, `bench/fowl/${probe}.mjs`), 'utf8');
    assert.match(source, /SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_HAND: '0' \}/, probe);
    assert.equal(source.match(/SLEIGHT_SURFACES/g).length, source.match(/SLEIGHT_HAND: '0'/g).length, probe);
  }
  assert.match(readFileSync(join(root, 'bench/battery/runtime.mjs'), 'utf8'), /const env = \{ \.\.\.hostFree, \.\.\.auth\.env, SLEIGHT_HAND: '0',/);
});
