import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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
