import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

export function isReleaseVersion(version) {
  if (typeof version !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  return Boolean(match && match[0] === version) && !(match[4]?.split('.').some(part => /^0\d+$/.test(part)));
}

// This reads the installed copy, so doctor also works outside a source checkout.
export function readPluginVersion({ pluginRoot: root = pluginRoot } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  if (!isReleaseVersion(manifest?.version)) throw Error('Plugin manifest has no valid release version');
  return manifest.version;
}

export function doctorVersionLine(options) {
  try { return `sleight ${readPluginVersion(options)}`; }
  catch { return 'sleight version unavailable (plugin manifest is missing or invalid)'; }
}
