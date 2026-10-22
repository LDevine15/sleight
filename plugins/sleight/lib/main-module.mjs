import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Whether this process was started with the module at moduleUrl as its script. Node resolves symlinks for the main module's
// import.meta.url but leaves process.argv[1] as typed, so a plugin path through a symlink (a symlinked ~/.claude, or /tmp on
// macOS) would never match a plain comparison and the entry point would exit silently. Both sides are resolved here.
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const own = fileURLToPath(moduleUrl);
  // A path that can't be resolved (a sandbox refusing the stat) falls back to the plain comparison.
  try { return realpathSync(argv1) === realpathSync(own); } catch { return resolve(argv1) === own; }
}
