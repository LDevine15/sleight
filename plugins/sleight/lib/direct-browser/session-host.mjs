import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';

// The fixed installed loader selects the root and accepted receipt outside model
// and project input. Test inventories do not accept a package for a real user.
export function createPackageInventory({ root = fileURLToPath(new URL('../..', import.meta.url)), receipt }) {
  const manifest = immutableJSON(receipt), minimum = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'];
  if (!isAbsolute(root) || normalize(root) !== root || !manifest || Object.keys(manifest).some(k =>
    !['accepted', 'protocol', 'node', 'helperMode', 'files'].includes(k)) || manifest.accepted !== true || manifest.protocol !== 1 ||
    manifest.helperMode !== 'source' || manifest.node !== process.version || !Array.isArray(manifest.files) || !manifest.files.length ||
    manifest.files.length > 4096) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || Object.keys(file).length !== 3 || typeof file.path !== 'string' || !file.path || isAbsolute(file.path) ||
        normalize(file.path) !== file.path || file.path.split('/').some(p => ['..', '.', ''].includes(p)) ||
        paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error('HOST_PACKAGE_MISMATCH');
    paths.add(file.path);
  }
  if (minimum.some(name => ![...paths].some(path => path === name || path.endsWith('/' + name)))) throw Error('HOST_PACKAGE_MISMATCH');
  let identity;
  const current = () => {
    try {
      const dir = lstatSync(root), uid = process.getuid?.();
      if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(root) !== root || dir.mode & 0o022 ||
          uid !== undefined && dir.uid !== uid && dir.uid !== 0 || identity && (dir.dev !== identity.dev || dir.ino !== identity.ino)) return false;
      const actual = [];
      const walk = (folder, prefix = '') => {
        for (const name of readdirSync(folder)) {
          const relative = prefix + name, path = join(folder, name), stat = lstatSync(path);
          if (stat.isSymbolicLink() || stat.mode & 0o022 || uid !== undefined && stat.uid !== uid && stat.uid !== 0) throw Error();
          if (stat.isDirectory()) walk(path, relative + '/');
          else if (stat.isFile()) actual.push(relative); else throw Error();
        }
      };
      walk(root);
      if (actual.length !== paths.size || actual.some(path => !paths.has(path))) return false;
      for (const file of manifest.files) {
        const bytes = readFileSync(join(root, file.path));
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return false;
      }
      identity ??= { dev: dir.dev, ino: dir.ino };
      return process.version === manifest.node;
    } catch { return false; }
  };
  return Object.freeze({ current });
}
