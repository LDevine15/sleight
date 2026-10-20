// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { traceEnv, abFlags, realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';

const task = { name: 'form-checkout', browser: 'chrome', prompt: 'Select delivery at http://127.0.0.1:5413/checkout', result: 'Delivery selected' };

for (const value of ['0', '1', undefined]) test('MC1 A/B forwarding: ' + String(value), () => {
  const host = value === undefined ? {} : { SLEIGHT_MC1: value };
  assert.deepEqual(traceEnv(host), host);
  assert.equal(abFlags(host).SLEIGHT_MC1, value !== '0');
  const setup = turboSetup({ task, repo: '/fixture/repo', dir: `${MAC_TMP}/fixture-task`, prompt: task.prompt, env: host });
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_MC1, value);
});

for (const value of ['0', '1']) test('MC1 real gate forwards ' + value + ' into turbo under Claude and Codex', t => {
  const saved = process.env.SLEIGHT_MC1;
  process.env.SLEIGHT_MC1 = value;
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_MC1; else process.env.SLEIGHT_MC1 = saved; });
  for (const surface of ['sleight-turbo', 'codex-sleight-sol']) {
    const setup = realAgentSetup({ task, surface, dir: `${MAC_TMP}/fixture-task`,
      realBrowser: { browser: 'chrome', profileRoot: `${MAC_TMP}/profile`, marker: 'Sleight Gate fixture' } });
    if (surface === 'sleight-turbo') assert.equal(setup.mcpConfig.mcpServers['sleight-turbo'].env.SLEIGHT_MC1, value);
    else assert.match(setup.codexConfig.toml, new RegExp('SLEIGHT_MC1 = "' + value + '"'));
  }
});

test('MC1 rollback switch survives the race env list and installed Codex passthrough', () => {
  const script = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const start = script.indexOf('if [ -n "$REAL" ]; then');
  const branch = script.slice(start, script.indexOf('fi\n', start));
  assert.match(branch, /env -i[\s\S]*\$\{SLEIGHT_MC1:\+SLEIGHT_MC1="\$SLEIGHT_MC1"\}[\s\S]*node tools\/rounds\.mjs/);
  const config = JSON.parse(readFileSync(new URL('../plugins/sleight/.codex-plugin/mcp.json', import.meta.url), 'utf8'));
  assert.ok(Object.values(config.mcpServers).every(server => server.env_vars.includes('SLEIGHT_MC1')));
});
