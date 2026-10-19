import { accessSync, constants, lstatSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { createRequire } from 'node:module';

export function commandSkip(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      const file = join(dir, name);
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return false;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return `${name} is not executable on PATH`;
}

export const macCommandSkip = (name, path, platform = process.platform) =>
  platform !== 'darwin' ? `${name} requires macOS` : commandSkip(name, path);

export function packageSkip(name) {
  try { createRequire(import.meta.url).resolve(name); return false; }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return `needs the ${name} dependency`;
  }
}

// The turbo package check refuses group- or world-writable entries (session-host.mjs packageFiles), so tests that
// check the real checkout as a package need one made under umask 022, as macOS and GitHub's runners do.
// Ubuntu's login umask of 002 makes group-writable folders. The folders Claude Code writes are left out, as there.
export function writableTreeSkip(root) {
  const find = folder => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), rel = relative(root, path);
      if (['.in_use', join('.claude-plugin', 'types')].includes(rel)) continue;
      const stat = lstatSync(path);
      if (stat.mode & 0o022) return rel;
      if (stat.isDirectory()) { const found = find(path); if (found) return found; }
    }
  };
  const found = find(root);
  return found ? `${found} is group- or world-writable (umask 002 checkout); the package check refuses that by design` : false;
}
