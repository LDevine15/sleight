import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Pinned Playwright 1.64.0 runtime distribution. This loader neither
// creates a browser nor connects to an endpoint. Only a trusted opt-in caller
// can load it; P3 must keep this entry outside model/project settings.
const playwrightManifest = '007e376d16f021289548f7b8b622d3cfd8923842605eb6213ae5f2299326131c';
export function loadPlaywrightCore({ turbo = false } = {}) {
  if (turbo !== true) return null;
  try {
    const root = new URL('../../vendor/playwright-core/', import.meta.url);
    const rootPath = fileURLToPath(root).replace(/\/$/, '');
    if (lstatSync(rootPath).isSymbolicLink() || realpathSync(rootPath) !== rootPath) throw Error();
    const manifestURL = new URL('./inspectors/playwright-files.json', import.meta.url);
    if (lstatSync(manifestURL).isSymbolicLink()) throw Error();
    const manifestBytes = readFileSync(manifestURL);
    if (createHash('sha256').update(manifestBytes).digest('hex') !== playwrightManifest) throw Error();
    const inventory = JSON.parse(manifestBytes);
    if (inventory.package !== 'playwright-core' || inventory.version !== '1.64.0') throw Error();
    const actual = new Set();
    const walk = (directory, prefix = '') => {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error();
      for (const name of readdirSync(directory)) {
        const relative = prefix + name, url = new URL(encodeURIComponent(name), directory);
        const entry = lstatSync(url);
        if (entry.isSymbolicLink()) throw Error();
        if (entry.isDirectory()) walk(new URL(encodeURIComponent(name) + '/', directory), relative + '/');
        else {
          if (!entry.isFile() || !Object.hasOwn(inventory.files, relative) ||
              createHash('sha256').update(readFileSync(url)).digest('hex') !== inventory.files[relative]) throw Error();
          actual.add(relative);
        }
      }
    };
    walk(root);
    if (actual.size !== Object.keys(inventory.files).length) throw Error();
    return createRequire(import.meta.url)('../../vendor/playwright-core/lib/coreBundle.js');
  } catch { throw Error('PLAYWRIGHT_PACKAGE_MISMATCH'); }
}
