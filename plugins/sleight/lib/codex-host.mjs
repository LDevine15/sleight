// What the doctor and setup say about Codex: whether sleight is installed and enabled as a Codex plugin, and whether
// Codex's own Computer Use plugins are on beside it. Read-only. sleight never writes Codex's config.toml; the
// commands printed here are for the user to run.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_INSTALL = 'codex plugin marketplace add Land-o-Clusters/sleight && codex plugin add sleight@sleight';
// The plugins whose tools or skill put a second computer-use surface beside sleight's in Codex.
export const BUNDLED_COMPUTER_USE = ['computer-use@openai-bundled', 'unified-computer-use@openai-bundled'];
// Turns the bundled Computer Use plugin off for one Codex session. Measured on a plugin of the same shape in a
// throwaway home (2026-10-19): its skill left the model's list. The `computer_use` feature flag did not remove it.
export const BUNDLED_OFF_FOR_SESSION = `codex -c 'plugins."computer-use@openai-bundled".enabled=false'`;

// `[plugins."<name>@<marketplace>"]` tables and their `enabled` key, from Codex's config.toml. Only what this reader
// needs: other tables, subtables such as `[plugins."x".mcp_servers.y]`, and other keys are skipped.
// The dotted forms are read too: `"<id>".enabled = …` under `[plugins]`, and `plugins."<id>".enabled = …` at the top level.
export function pluginStates(text) {
  const states = new Map();
  let current, table;
  const set = (id, value) => states.set(id, value === undefined ? states.get(id) : value === 'true');
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    const header = /^\[\s*plugins\s*\.\s*"([^"]+)"\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) { current = header[1]; table = undefined; if (!states.has(current)) states.set(current, undefined); continue; }
    if (line.startsWith('[')) { current = undefined; table = /^\[\s*plugins\s*\]\s*(?:#.*)?$/.test(line) ? 'plugins' : line; continue; }
    const enabled = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (current && enabled) { set(current, enabled[1]); continue; }
    const dotted = /^(plugins\s*\.\s*)?"([^"]+)"\s*\.\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (dotted && (dotted[1] ? table === undefined && current === undefined : table === 'plugins')) set(dotted[2], dotted[3]);
  }
  return states;
}

export function codexStatus({ env = process.env, home = homedir(), read = path => readFileSync(path, 'utf8'), list = readdirSync, exists = existsSync } = {}) {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const configPath = join(codexHome, 'config.toml');
  let text;
  try { text = read(configPath); } catch { return { codexHome, configPath, config: false }; }
  const states = pluginStates(text);
  const sleight = [...states].filter(([id]) => id.split('@')[0] === 'sleight').map(([id, enabled]) => {
    const marketplace = id.slice(id.indexOf('@') + 1);
    let versions = [];
    try { const dir = join(codexHome, 'plugins', 'cache', marketplace, 'sleight'); if (exists(dir)) versions = list(dir).filter(name => !name.startsWith('.')); } catch {}
    return { id, enabled: enabled === true, versions };
  });
  const bundled = BUNDLED_COMPUTER_USE.filter(id => states.has(id)).map(id => ({ id, enabled: states.get(id) === true }));
  return { codexHome, configPath, config: true, sleight, bundled };
}

export function codexDoctorLines(status) {
  const lines = ['Codex'];
  if (!status.config) {
    lines.push(`note      no Codex config at ${status.configPath}. To use sleight in Codex: ${CODEX_INSTALL}`);
    return lines;
  }
  const on = status.sleight.filter(plugin => plugin.enabled);
  if (on.length) for (const plugin of on) lines.push(`ok        sleight is installed and enabled in Codex (${plugin.id}${plugin.versions.length ? ` ${plugin.versions.join(', ')}` : ''})`);
  else if (status.sleight.length) lines.push(`note      sleight is installed in Codex but turned off (${status.sleight.map(plugin => plugin.id).join(', ')}). Turn it on in Codex's Plugins settings.`);
  else lines.push(`note      sleight isn't installed in Codex. To add it: ${CODEX_INSTALL}`);
  const bundledOn = status.bundled.filter(plugin => plugin.enabled);
  if (bundledOn.length) {
    lines.push(`note      Codex's own Computer Use is also on (${bundledOn.map(plugin => plugin.id).join(', ')}).` +
      (on.length ? " sleight's skill tells the model to use sleight's tools." : ''));
    if (bundledOn.some(plugin => plugin.id === 'computer-use@openai-bundled')) lines.push(`          To start Codex without it: ${BUNDLED_OFF_FOR_SESSION}`);
  } else lines.push("ok        Codex's own Computer Use plugin is off");
  return lines;
}
