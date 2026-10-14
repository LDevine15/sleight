import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';
import { createPackageInventory } from './session-host.mjs';

const packageRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const inventoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const entries = ['../launch.mjs', '../../bin/sleight-mcp', '../../hooks/register.tsx'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// The operator-owned file is the only opt-in source. Neither HOME, environment,
// MCP input nor a project settings file can select acceptance or a profile.
export const installedConfigPath = () => join(userInfo().homedir, 'Library/Application Support/sleight/turbo.json');
export function readInstalledConfig(path = installedConfigPath()) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('INSTALLED_CONFIG_UNSAFE'); }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 1048576) throw Error();
    const data = immutableJSON(JSON.parse(readFileSync(path, 'utf8')));
    if (!data || Object.keys(data).some(k => !['version', 'enabled', 'profileRoot', 'executable', 'receipt', 'entryHashes'].includes(k)) ||
        data.version !== 1 || typeof data.enabled !== 'boolean') throw Error();
    if (!data.enabled) return null;
    if (['profileRoot', 'executable'].some(k => typeof data[k] !== 'string' || !isAbsolute(data[k]) || normalize(data[k]) !== data[k]) ||
        data.receipt?.node !== process.version || data.receipt.accepted !== true || data.receipt.protocol !== 1 ||
        data.receipt.helperMode !== 'source' || !Array.isArray(data.receipt.files) || !data.receipt.files.length ||
        !data.entryHashes || Object.keys(data.entryHashes).length !== entries.length ||
        entries.some(k => !/^[a-f0-9]{64}$/.test(data.entryHashes[k] ?? ''))) throw Error();
    return data;
  } catch { throw Error('INSTALLED_CONFIG_UNSAFE'); }
}
export function acceptedInstalledPackage(config) {
  if (!config) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const inventory = createPackageInventory({ root: inventoryRoot, receipt: config.receipt });
  const current = () => inventory.current() && entries.every(path => {
    try {
      const file = join(packageRoot, path), stat = lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file && !(stat.mode & 0o022) &&
        (stat.uid === process.getuid() || stat.uid === 0) && hash(readFileSync(file)) === config.entryHashes[path];
    } catch { return false; }
  });
  if (!current()) throw Error('HOST_PACKAGE_MISMATCH');
  return Object.freeze({ inventory, current });
}
