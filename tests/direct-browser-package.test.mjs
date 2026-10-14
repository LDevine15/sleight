import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as worlds from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const require = createRequire(import.meta.url);
test('the engine route never loads the bundled Playwright runtime', () => {
  assert.equal(worlds.loadPlaywrightCore({ turbo: false }), null);
  assert.equal(worlds.loadPlaywrightCore(), null);
  assert.equal(Object.keys(require.cache).some(p => p.includes('/vendor/playwright-core/')), false);
});
test('the opted-in runtime loads the pinned complete package without connecting', () => {
  const runtime = worlds.loadPlaywrightCore({ turbo: true });
  assert.equal(runtime.getPlaywrightVersion(), '1.64.0');
  assert.equal(typeof runtime.server.createPlaywright, 'function');
});
for (const mutation of ['changed-file', 'missing-file', 'extra-file', 'symlink-file', 'symlink-root', 'changed-inventory']) {
  test(`package loading refuses ${mutation} before module initialization`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'bp2-p2-package-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const lib = join(root, 'lib/direct-browser'), vendor = join(root, 'vendor/playwright-core');
    cpSync(new URL('../plugins/sleight/lib/direct-browser/', import.meta.url), lib, { recursive: true });
    cpSync(new URL('../plugins/sleight/vendor/playwright-core/', import.meta.url), vendor, { recursive: true });
    const path = join(vendor, 'index.mjs');
    if (mutation === 'changed-file') writeFileSync(path, 'throw Error("must not execute");');
    if (mutation === 'missing-file') rmSync(path);
    if (mutation === 'extra-file') writeFileSync(join(vendor, 'unlisted.js'), 'throw Error("must not execute");');
    if (mutation === 'symlink-file') { rmSync(path); symlinkSync(join(vendor, 'index.js'), path); }
    if (mutation === 'symlink-root') { renameSync(vendor, vendor + '-moved'); symlinkSync(vendor + '-moved', vendor, 'dir'); }
    if (mutation === 'changed-inventory') {
      const inventory = join(lib, 'inspectors/playwright-files.json');
      writeFileSync(inventory, readFileSync(inventory, 'utf8').replace('1.64.0', '1.64.1'));
    }
    const module = await import(pathToFileURL(join(lib, 'worlds.mjs')));
    assert.throws(() => module.loadPlaywrightCore({ turbo: true }), /PLAYWRIGHT_PACKAGE_MISMATCH/);
  });
}
