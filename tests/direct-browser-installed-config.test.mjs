import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
const config = await import('../plugins/sleight/lib/direct-browser/installed-config.mjs').catch(() => ({}));
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-installed-config-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true })); return join(root, 'turbo.json');
}
test('installed turbo defaults off when the fixed user config is absent', t => {
  assert.equal(typeof config.readInstalledConfig, 'function'); assert.equal(config.readInstalledConfig(fixture(t)), null);
});
for (const mode of ['linked', 'public', 'extra', 'relative-root', 'wrong-node']) test('installed turbo rejects ' + mode + ' configuration', t => {
  assert.equal(typeof config.readInstalledConfig, 'function');
  const file = fixture(t), data = { version: 1, enabled: true, profileRoot: '/fixture/profile', executable: '/fixture/browser',
    receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files: [] }, entryHashes: {} };
  if (mode === 'extra') data.project = true;
  if (mode === 'relative-root') data.profileRoot = 'profile';
  if (mode === 'wrong-node') data.receipt.node = 'wrong';
  writeFileSync(file, JSON.stringify(data), { mode: mode === 'public' ? 0o644 : 0o600 });
  if (mode === 'linked') { const target = file + '.real'; writeFileSync(target, JSON.stringify(data), { mode: 0o600 }); rmSync(file); symlinkSync(target, file); }
  assert.throws(() => config.readInstalledConfig(file), /INSTALLED_CONFIG_UNSAFE/);
});
test('project and environment opt-in values do not replace the absent user config', t => {
  assert.equal(typeof config.readInstalledConfig, 'function');
  const prior = process.env.SLEIGHT_TURBO; process.env.SLEIGHT_TURBO = '1';
  try { assert.equal(config.readInstalledConfig(fixture(t)), null); } finally {
    if (prior === undefined) delete process.env.SLEIGHT_TURBO; else process.env.SLEIGHT_TURBO = prior;
  }
});
test('installed acceptance covers the whole plugin including relay, hook and vendored dependencies', () => {
  const root = fileURLToPath(new URL('../plugins/sleight/', import.meta.url)), files = [];
  function walk(prefix = '') {
    for (const name of readdirSync(join(root, prefix))) {
      const path = prefix + name;
      if (lstatSync(join(root, path)).isDirectory()) walk(path + '/');
      else { const bytes = readFileSync(join(root, path)); files.push({ path, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
  }
  walk();
  const data = { receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files },
    entryHashes: Object.fromEntries(['../launch.mjs', '../../bin/sleight-mcp', '../../hooks/register.tsx'].map(path =>
      [path, createHash('sha256').update(readFileSync(new URL('../plugins/sleight/lib/direct-browser/' + path, import.meta.url))).digest('hex')])) };
  assert.equal(config.acceptedInstalledPackage(data).current(), true);
  const partial = { ...data, receipt: { ...data.receipt, files: files.filter(row => row.path !== 'lib/relay.mjs') } };
  assert.throws(() => config.acceptedInstalledPackage(partial), /HOST_PACKAGE_MISMATCH/);
});
