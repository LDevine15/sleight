// What the doctor says about Cursor: whether sleight reaches Cursor, and by which route. Read-only. sleight never
// writes Cursor's config; the command printed here is for the user to run. The routes, from Cursor 3.25.6 and
// cursor-agent 2026.09.10 (study: ledger p140 cur1-STUDY.md):
// - a plugin from a marketplace, cached in ~/.cursor/plugins/cache/<marketplace>/sleight/<commit>
// - a local plugin, a folder in ~/.cursor/plugins/local whose .cursor-plugin/plugin.json names sleight. A symlink there
//   loads only if it resolves inside that folder; cursor-agent's loader logs "symlink target ... is outside" otherwise.
// - an entry in ~/.cursor/mcp.json whose command is sleight-mcp
// - sleight's Claude Code plugin, which Cursor imports while its third-party setting is on. cursor-agent's loader keeps
//   one plugin per <marketplace>/<name>, listing Cursor's marketplaces first, so a Cursor plugin from a marketplace
//   with the same name as the Claude Code one (sleight@sleight) replaces that import. Read from cursor-agent only.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const CURSOR_REPO = 'https://github.com/Land-o-Clusters/sleight';
export const CURSOR_INSTALL = `cursor-agent plugin marketplace add ${CURSOR_REPO}`;
const INSTALL_STEP = `${CURSOR_INSTALL}, then install sleight from Cursor's plugin list`;
// The setting's label in Cursor 3.25.6 (storage key thirdPartyExtensibilityEnabled, on by default).
export const CURSOR_IMPORT_SETTING = 'Include Third-Party Plugins, Skills, and Other Configs';

export function cursorStatus({ home = homedir(), read = path => readFileSync(path, 'utf8'), list = readdirSync, exists = existsSync,
  lstat = lstatSync, realpath = realpathSync, app = ['/Applications/Cursor.app', join(home, 'Applications/Cursor.app')] } = {}) {
  const tilde = path => path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
  const dir = join(home, '.cursor');
  const names = path => { try { return list(path).filter(name => !String(name).startsWith('.')).map(String); } catch { return []; } };
  const parse = path => { try { return JSON.parse(read(path)); } catch { return undefined; } };
  let version;
  const appPath = app.find(path => exists(path));
  if (appPath) version = parse(join(appPath, 'Contents/Resources/app/product.json'))?.version;
  if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,31}$/.test(version)) version = undefined;
  const installed = !!appPath || exists(dir);

  const cache = join(dir, 'plugins/cache');
  const marketplace = names(cache).filter(name => exists(join(cache, name, 'sleight')));
  const localDir = join(dir, 'plugins/local');
  const local = [], outside = [];
  let localReal;
  try { localReal = realpath(localDir); } catch { localReal = localDir; }
  for (const name of names(localDir)) {
    const path = join(localDir, name);
    if (parse(join(path, '.cursor-plugin/plugin.json'))?.name !== 'sleight') continue;
    let target;
    try { if (lstat(path).isSymbolicLink()) target = realpath(path); } catch {}
    if (target !== undefined && !target.startsWith(localReal + '/')) outside.push({ name, target: tilde(target) });
    else local.push(name);
  }

  const mcpPath = join(dir, 'mcp.json');
  let mcp = [], mcpError;
  if (exists(mcpPath)) {
    let config;
    try { config = JSON.parse(read(mcpPath)); } catch (err) { mcpError = err instanceof SyntaxError ? 'not JSON' : err.message; }
    const servers = config?.mcpServers;
    if (servers && typeof servers === 'object') mcp = Object.entries(servers)
      .filter(([, server]) => typeof server?.command === 'string' && basename(server.command) === 'sleight-mcp').map(([key]) => key);
  }

  const plugins = parse(join(home, '.claude/plugins/installed_plugins.json'))?.plugins;
  const claudeCode = plugins && typeof plugins === 'object' ? Object.keys(plugins).filter(id => id.split('@')[0] === 'sleight') : [];
  return { installed, version, marketplace, local, outside, mcp, mcpError, claudeCode, localPath: tilde(localDir), mcpPath: tilde(mcpPath) };
}

export function cursorDoctorLines(status) {
  const lines = ['Cursor'];
  if (!status.installed) return [...lines, 'note      Cursor isn\'t installed'];
  if (status.mcpError) lines.push(`PROBLEM   could not read ${status.mcpPath} (${status.mcpError})`);
  for (const { name, target } of status.outside ?? []) {
    const path = `${status.localPath}/${name}`;
    lines.push(`PROBLEM   ${path} links to ${target}, outside ${status.localPath}, so Cursor skips it. Put a copy there in its place: rm ${path} && cp -R ${target} ${path}`);
  }
  const routes = [];
  // A Claude Code copy sleight@<m> shares cursor-agent's key with a Cursor plugin from marketplace <m>.
  const replaced = status.claudeCode.filter(id => status.marketplace.includes(id.slice(id.indexOf('@') + 1)));
  const claudeCode = status.claudeCode.filter(id => !replaced.includes(id));
  for (const market of status.marketplace) {
    const twin = replaced.filter(id => id.endsWith(`@${market}`));
    lines.push(`ok        sleight is installed as a Cursor plugin (sleight from marketplace ${market})` +
      (twin.length ? `. cursor-agent's loader keeps it in place of the Claude Code copy (${twin.join(', ')}).` : ''));
    routes.push(`marketplace ${market}`);
  }
  for (const name of status.local) {
    lines.push(`ok        sleight is a local Cursor plugin (${status.localPath}/${name}). Copy it again after each sleight update.`);
    routes.push(`${status.localPath}/${name}`);
  }
  for (const key of status.mcp) {
    lines.push(`ok        sleight is in ${status.mcpPath} as "${key}"`);
    routes.push(`${status.mcpPath} "${key}"`);
  }
  if (claudeCode.length) {
    lines.push(`note      sleight is installed in Claude Code (${claudeCode.join(', ')}). Cursor runs it from there while "${CURSOR_IMPORT_SETTING}" is on in Cursor's settings.`);
    if (!routes.length) lines.push(`          To install it in Cursor itself: ${INSTALL_STEP}`);
    else routes.push('the Claude Code copy, if that setting is on');
  }
  if (!routes.length && !status.claudeCode.length) lines.push(`note      sleight isn't set up in Cursor${status.version ? ` ${status.version}` : ''}. To add it: ${INSTALL_STEP}`);
  if (routes.length > 1) lines.push(`note      Cursor starts sleight ${routes.length} times (${routes.join(', ')}). Keep one.`);
  return lines;
}
