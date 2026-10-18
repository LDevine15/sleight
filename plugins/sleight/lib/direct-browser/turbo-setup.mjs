// The one writer of the operator-owned turbo.json, and the commands around it. Turbo is on by default: the
// launcher calls ensureTurboConfig at startup. `sleight-mcp turbo on|off|status` and the doctor section use the
// rest. The file's format and checks belong to installed-config.mjs and session-host.mjs, and this module builds
// the file from their constants and then proves it with their own readers before and after writing.
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { INSTALLED_ENTRIES, INSTALLED_PLUGIN_ROOT, acceptedInstalledPackage, installedConfigPath, readInstalledConfig,
  readInstalledConfigFile, sha256Hex, validateEnabledConfig } from './installed-config.mjs';
import { packageFiles } from './session-host.mjs';
import { nativeHelpersBuilt } from './host.mjs';
import { browserChoices, browserDefinitions, qualifiedBrowserNames } from './browsers.mjs';
import { signedBrowserAt, verifiedOnDisk, writeClass } from './executable-trust.mjs';
import { BUNDLE_ID, appOptInPath, grantStorePath, readAppOptIns, registryPath as packagedRegistry } from './electron-config.mjs';
import { readRecipeRegistry, recipeFor } from './electron-recipes.mjs';
import { createGrantStore } from './electron-consent.mjs';

const fail = (code, detail) => Object.assign(Error(code), detail === undefined ? {} : { detail });
const unqualifiedMessage = browser => `${browser.name} isn't qualified yet. Live check needed: turn on remote debugging at ${browser.inspectURL}, ` +
  'verify DevToolsActivePort in its profile and prove owned-tab read, input and cleanup, plus a stop when the user changes app, document or focus. ' +
  'The qualification steps are in docs/known-problems.md, and the operator runs them.';

const appRootsFor = (home, apps) => [apps ?? '/Applications', join(home, 'Applications')];

// Mirrors what the connection requires of the browser executable (selected-connection.mjs securePath and
// executable-trust.mjs), so a browser turbo would refuse at connect time is never written into the file. A
// group-writable signed browser passes here on its bundle's signature on disk; the connection then proves the
// running process.
export function executableProblem(path, uid = process.getuid(), { appRoots, verify = verifiedOnDisk, primaryGid = process.getgid() } = {}) {
  let stat;
  try { stat = lstatSync(path); } catch { return 'missing'; }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) return 'not a plain file';
    if (stat.uid !== uid && stat.uid !== 0) return 'owned by another user';
    const writers = writeClass(stat, primaryGid), mode = 'writable by others (mode ' + (stat.mode & 0o777).toString(8) + ')';
    if (!writers) return stat.mode & 0o002 ? mode : `${mode} through group ${stat.gid}, which is neither admin nor your own group`;
    if (writers === 'signature') {
      const signed = signedBrowserAt(path, appRoots ? { appRoots } : {});
      if (!signed) return mode;
      if (!verify(path, signed.requirement, stat)) return `${mode}, and its signature is not ${signed.name}'s from team ${signed.team}`;
    }
    if (!(stat.mode & 0o100)) return 'not executable';
    return undefined;
  } catch { return 'unreadable'; }
}

/** First installed qualified browser in table order, or the one named by `browser`.
 *  Returns { ok: true, id, name, executable, profileRoot } or { ok: false, code, message }. */
export function detectBrowser({ home = userInfo().homedir, apps, browser, uid = process.getuid(),
  problem = path => executableProblem(path, uid, { appRoots: appRootsFor(home, apps) }) } = {}) {
  const all = browserDefinitions(home, apps), selected = all.find(b => b.id === browser);
  if (browser !== undefined && !selected) return { ok: false, code: 'BROWSER_UNKNOWN', message: `--browser takes ${browserChoices()}, not ${JSON.stringify(browser)}.` };
  const wanted = selected ? [selected] : all.filter(b => b.qualified), problems = [];
  for (const found of wanted) {
    const reason = problem(found.executable);
    if (reason === undefined) return { ok: true, ...found };
    if (reason !== 'missing') problems.push(`${found.name} is installed but turbo refuses its executable (${reason}).`);
  }
  if (problems.length) return { ok: false, code: 'BROWSER_EXECUTABLE_UNSAFE', message: problems.join(' ') + ' Fix that, or pick another browser with --browser.' };
  return { ok: false, code: 'BROWSER_NOT_FOUND', message: selected ? `${selected.name} is not installed in /Applications.`
    : `No supported browser found (${qualifiedBrowserNames()} in /Applications).` };
}

/** The receipt and entry hashes for the package at pluginRoot, in the shape readInstalledConfig and
 *  acceptedInstalledPackage verify. Every file under the root is listed, as the check compares the whole tree. */
export function buildReceipt({ pluginRoot = INSTALLED_PLUGIN_ROOT } = {}) {
  const files = packageFiles(pluginRoot).sort().map(path => {
    const bytes = readFileSync(join(pluginRoot, path));
    return { path, sha256: sha256Hex(bytes), bytes: bytes.length };
  });
  const dir = join(pluginRoot, 'lib/direct-browser');
  const entryHashes = Object.fromEntries(INSTALLED_ENTRIES.map(entry => [entry, sha256Hex(readFileSync(join(dir, entry)))]));
  return { receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files }, entryHashes };
}

export function buildConfig({ pluginRoot = INSTALLED_PLUGIN_ROOT, browser } = {}) {
  const { receipt, entryHashes } = buildReceipt({ pluginRoot });
  return { version: 1, enabled: true, profileRoot: browser.profileRoot, executable: browser.executable, receipt, entryHashes };
}

function checkDirectory(dir, uid) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir || stat.uid !== uid || stat.mode & 0o022) throw fail('TURBO_DIRECTORY_UNSAFE');
}

/** Atomic write: a private temp file in the same folder, then rename over turbo.json. Mode 0600, owned by the user.
 *  Refuses a linked turbo.json, a linked or shared folder and a path that is not already canonical. */
export function writeConfigFile(path, data, uid = process.getuid()) {
  if (!isAbsolute(path) || normalize(path) !== path) throw fail('TURBO_PATH_UNSAFE');
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDirectory(dir, uid);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw fail('TURBO_CONFIG_LINKED');
    if (!stat.isFile()) throw fail('TURBO_CONFIG_NOT_A_FILE');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(dir, `.turbo.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(data) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw fail('TURBO_CONFIG_UNSAFE');
}

/** What turbo.json is now: absent, opted-out, unsafe (hands off), stale (rewritable) or current. */
export function inspectConfig({ configPath = installedConfigPath(), pluginRoot = INSTALLED_PLUGIN_ROOT } = {}) {
  let data;
  try { data = readInstalledConfigFile(configPath); } catch { return { state: 'unsafe' }; }
  if (!data) return { state: 'absent' };
  if (!data.enabled) return { state: 'opted-out' };
  try { validateEnabledConfig(data); } catch {
    return { state: 'stale', reason: data.receipt?.node !== undefined && data.receipt.node !== process.version ? 'node-changed' : 'malformed', data };
  }
  try { acceptedInstalledPackage(data, { pluginRoot }); } catch { return { state: 'stale', reason: 'package-changed', data }; }
  return { state: 'current', data };
}

function store(configPath, pluginRoot, browser, uid) {
  const data = buildConfig({ pluginRoot, browser });
  validateEnabledConfig(data);
  acceptedInstalledPackage(data, { pluginRoot });
  writeConfigFile(configPath, data, uid);
  // A format round trip through the real reader, not its connect-time qualification gate.
  try { readInstalledConfig(configPath, { SLEIGHT_TURBO_UNQUALIFIED: '1' }); } catch (error) { try { unlinkSync(configPath); } catch {} throw error; }
  return data;
}

const reuseBrowser = (data, home, apps, problem) => {
  if (!data) return undefined;
  const known = browserDefinitions(home, apps).find(b => b.executable === data.executable && b.profileRoot === data.profileRoot);
  return known && problem(known.executable) === undefined ? { ok: true, ...known } : undefined;
};

/** Startup: write turbo.json when it is absent, or its receipt, hashes or node version no longer match. An
 *  opted-out file (enabled: false) and an unsafe file are never touched. Never throws.
 *  Returns { action: 'none'|'wrote'|'skipped'|'failed', state, reason?, message?, ms }. */
export function ensureTurboConfig({ configPath = installedConfigPath(), pluginRoot = INSTALLED_PLUGIN_ROOT, home = userInfo().homedir, apps,
  browser, uid = process.getuid(), now = () => performance.now() } = {}) {
  const started = now(), done = result => ({ ...result, ms: Math.round((now() - started) * 10) / 10 });
  try {
    const seen = inspectConfig({ configPath, pluginRoot });
    if (seen.state === 'current') return done({ action: 'none', state: 'current' });
    if (seen.state === 'opted-out') return done({ action: 'skipped', state: 'opted-out' });
    if (seen.state === 'unsafe') return done({ action: 'skipped', state: 'unsafe',
      message: 'turbo.json is not safe to read (a link, or another owner or mode), so turbo stays off. Delete it and run sleight-mcp turbo on.' });
    const problem = path => executableProblem(path, uid, { appRoots: appRootsFor(home, apps) });
    const chosen = browser ? detectBrowser({ home, apps, browser, uid }) : reuseBrowser(seen.data, home, apps, problem) ?? detectBrowser({ home, apps, uid });
    if (!chosen.ok) return done({ action: 'skipped', state: seen.state, reason: chosen.code, message: `turbo stays off: ${chosen.message}` });
    if (!chosen.qualified) return done({ action: 'skipped', state: seen.state, reason: 'BROWSER_UNQUALIFIED', message: `turbo stays off: ${unqualifiedMessage(chosen)}` });
    store(configPath, pluginRoot, chosen, uid);
    return done({ action: 'wrote', state: seen.state, reason: seen.reason, browser: chosen.name,
      message: `turbo is on with ${chosen.name}. Turn on remote debugging in it once (${chosen.inspectURL}); sleight-mcp turbo off turns turbo off.` });
  } catch (error) {
    return done({ action: 'failed', state: 'failed', reason: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'TURBO_SETUP_FAILED',
      message: `turbo stays off: could not write turbo.json (${/^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : error?.code ?? 'TURBO_SETUP_FAILED'}). The engine path is used.` });
  }
}

/** What `sleight-mcp turbo status` and the doctor section both read. Read-only. */
export function turboDiagnosis({ configPath = installedConfigPath(), pluginRoot = INSTALLED_PLUGIN_ROOT, home = userInfo().homedir, apps,
  helperCache, exists = existsSync } = {}) {
  const seen = inspectConfig({ configPath, pluginRoot });
  const browsers = browserDefinitions(home, apps).map(b => {
    const problem = executableProblem(b.executable, undefined, { appRoots: appRootsFor(home, apps) });
    return { ...b, installed: problem !== 'missing', executableProblem: problem };
  });
  const known = browsers.find(b => b.executable === seen.data?.executable);
  const browser = seen.data ? { id: known?.id, name: known?.name ?? seen.data.executable.split('/').at(-1), inspectURL: known?.inspectURL,
    qualified: known?.qualified, executable: seen.data.executable, profileRoot: seen.data.profileRoot } : undefined;
  let port;
  if (browser) { try { port = exists(join(browser.profileRoot, 'DevToolsActivePort')); } catch { port = undefined; } }
  const helpers = seen.state === 'current' ? nativeHelpersBuilt({ inventory: seen.data.receipt, ...(helperCache ? { cacheRoot: helperCache } : {}) }) : undefined;
  const problem = browser ? executableProblem(browser.executable) : undefined;
  const found = browser ? undefined : detectBrowser({ home, apps });
  return { state: seen.state, reason: seen.reason, enabled: seen.state === 'current', browser, browsers, executableProblem: problem, port, helpers, detected: found };
}

export function statusLines(d) {
  const lines = [`turbo     ${d.enabled ? 'on' : 'off'}${d.state === 'opted-out' ? ' (you turned it off)' : d.state === 'absent' ? ' (not set up yet)' : d.state === 'stale' ? ' (receipt out of date)' : d.state === 'unsafe' ? ' (turbo.json is unsafe)' : ''}`];
  if (d.browser) {
    lines.push(`browser   ${d.browser.name}`, `profile   ${d.browser.profileRoot}`,
      `remote debugging  ${d.port === true ? 'on (DevToolsActivePort present)' : d.port === false ? 'off (no DevToolsActivePort; it exists only while the browser runs with debugging on)' : 'unknown'}`);
  }
  return lines;
}

/** Doctor section: each problem is followed by the one action that fixes it. */
export function doctorLines(d) {
  const fix = action => `          fix: ${action}`;
  const lines = ['turbo (direct browser path)'];
  for (const browser of d.browsers ?? []) lines.push(`known     ${browser.name}: ${browser.installed ? 'installed' : 'not installed'}, ${browser.qualified ? 'qualified' : 'unqualified'}`);
  const row = (ok, label, text) => lines.push(`${ok ? 'ok     ' : 'PROBLEM'}   ${label}: ${text}`);
  if (d.state === 'opted-out') { row(false, 'config', 'off, you turned turbo off'); lines.push(fix('sleight-mcp turbo on')); return lines; }
  if (d.state === 'unsafe') { row(false, 'config', 'turbo.json is a link or has another owner or mode, so turbo stays off'); lines.push(fix('delete ~/Library/Application Support/sleight/turbo.json, then run sleight-mcp turbo on')); return lines; }
  if (d.state === 'absent') {
    row(false, 'config', 'not set up yet (sleight writes it when a session starts)');
    lines.push(fix(d.detected?.ok ? 'start a new Claude Code session, or run sleight-mcp turbo on' : d.detected?.message ?? `install ${qualifiedBrowserNames()}`));
    return lines;
  }
  row(d.state === 'current', 'config', d.state === 'current' ? 'on' : `receipt stale (${d.reason === 'node-changed' ? 'node version changed' : d.reason === 'package-changed' ? 'plugin files changed' : 'malformed'})`);
  if (d.state === 'stale') lines.push(fix('start a new Claude Code session (sleight rewrites it), or run sleight-mcp turbo on'));
  row(!d.executableProblem, 'browser', `${d.browser.name}, ${d.browser.executable}${d.executableProblem ? ` (${d.executableProblem})` : ''}`);
  if (d.browser.qualified === false) lines.push(fix(unqualifiedMessage(d.browser)));
  if (d.executableProblem) lines.push(fix(d.executableProblem === 'missing' ? `reinstall the browser, or run sleight-mcp turbo on --browser ${browserChoices()}`
    : /signature/.test(d.executableProblem) ? `reinstall ${d.browser.name} from its maker, or choose a qualified browser with sleight-mcp turbo on --browser`
    : `make the executable writable only by you (chmod go-w '${d.browser.executable}'), or choose a qualified browser with sleight-mcp turbo on --browser`));
  if (d.state === 'current') {
    row(d.helpers === true, 'native helpers', d.helpers ? 'compiled' : 'not compiled yet');
    if (!d.helpers) lines.push(fix('they compile on the first turbo use and need Apple\'s command-line tools (xcode-select --install)'));
  }
  row(d.port === true, 'remote debugging', d.port === true ? 'on (DevToolsActivePort present)' : d.port === false ? 'off (no DevToolsActivePort)' : 'unknown');
  if (d.port !== true) lines.push(fix(d.browser.inspectURL ? `turn on remote debugging in ${d.browser.name}: ${d.browser.inspectURL}` : 'check the selected browser documentation for its remote debugging address'));
  return lines;
}

// Removes the saved (Always) debugger permissions for one bundle id. A grant held in memory by a running worker ends
// with its session; this process cannot reach it.
function revokeSavedApp(bundleId, home) {
  const store = createGrantStore({ path: grantStorePath(home) });
  let removed = 0;
  for (const record of store.list()) if (record.bundleId === bundleId && store.remove(record.key)) removed++;
  return removed;
}

/** `sleight-mcp turbo app on|off <bundle id>`: the per-app opt-in for Electron turbo. on writes the registry's build for
 *  that bundle id; off removes the entry and the app's saved debugger permissions. */
function turboAppCommand([op, bundleId, ...rest], { out, home, uid, path = appOptInPath(home), registryPath = packagedRegistry,
  revokeApp = id => revokeSavedApp(id, home) }) {
  if (!['on', 'off'].includes(op) || typeof bundleId !== 'string' || !BUNDLE_ID.test(bundleId) || rest.length) {
    out('usage: sleight-mcp turbo app on <bundle id>\n       sleight-mcp turbo app off <bundle id>\n'); return 2;
  }
  const code = error => /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'TURBO_APP_FAILED';
  let current;
  try { current = readAppOptIns(path); } catch (error) { out(`turbo app ${op} failed: ${code(error)} (${path} is a link or has another owner or mode; delete it first)\n`); return 1; }
  const apps = { ...(current?.apps ?? {}) };
  if (op === 'on') {
    let recipe;
    try { recipe = recipeFor(readRecipeRegistry(registryPath), bundleId); } catch (error) {
      const reason = code(error) === 'RECIPE_UNFILLED' ? ' (this build is not reviewed yet: the qualification harness fills its hashes)' : '';
      out(`turbo stays off for ${bundleId}: ${code(error)}${reason}\n`); return 1;
    }
    apps[bundleId] = { enabled: true, build: recipe.build };
  } else delete apps[bundleId];
  try {
    writeConfigFile(path, { version: 1, apps }, uid);
    readAppOptIns(path);
  } catch (error) { out(`turbo app ${op} failed: ${code(error)}\n`); return 1; }
  if (op === 'on') { out(`turbo is on for ${bundleId} (${apps[bundleId].build}). The debugger asks once per app in sleight's own window.\n`); return 0; }
  let removed;
  try { removed = revokeApp(bundleId); } catch (error) { out(`turbo is off for ${bundleId}, but its saved debugger permissions were not removed: ${code(error)}\n`); return 1; }
  out(`turbo is off for ${bundleId}. ${removed} saved debugger permissions removed.\n`); return 0;
}

/** `sleight-mcp turbo on|off|status`. Exit code 0 on success, 1 on failure, 2 on usage. */
export function turboCommand(args, { out = text => process.stdout.write(text), configPath = installedConfigPath(), pluginRoot = INSTALLED_PLUGIN_ROOT,
  home = userInfo().homedir, apps, uid = process.getuid(), diagnose = turboDiagnosis, env = process.env, appOptIns = {} } = {}) {
  const [op, ...rest] = args;
  if (op === 'app') return turboAppCommand(rest, { out, home, uid, ...appOptIns });
  const usage = () => { out(`usage: sleight-mcp turbo on [--browser ${browserChoices()}]\n       sleight-mcp turbo off\n       sleight-mcp turbo status\n` +
    '       sleight-mcp turbo app on|off <bundle id>\n'); return 2; };
  let browser;
  if (rest.length) {
    if (op !== 'on' || rest.length !== 2 || rest[0] !== '--browser') return usage();
    browser = rest[1];
  }
  if (op === 'status') { out(statusLines(diagnose({ configPath, pluginRoot, home, apps })).join('\n') + '\n'); return 0; }
  if (op === 'off') {
    try { writeConfigFile(configPath, { version: 1, enabled: false }, uid); } catch (error) { out(`turbo off failed: ${error.message}\n`); return 1; }
    out('turbo is off. sleight-mcp turbo on turns it back on.\n'); return 0;
  }
  if (op === 'on') {
    const requested = browserDefinitions(home, apps).find(b => b.id === browser);
    if (requested && !requested.qualified && env.SLEIGHT_TURBO_UNQUALIFIED !== '1') { out(`turbo stays off: ${unqualifiedMessage(requested)}\n`); return 1; }
    const chosen = detectBrowser({ home, apps, browser, uid });
    if (!chosen.ok) { out(`turbo stays off: ${chosen.message}\n`); return 1; }
    try { store(configPath, pluginRoot, chosen, uid); } catch (error) { out(`turbo on failed: ${/^[A-Z][A-Z0-9_]+$/.test(error?.message) ? error.message : error?.code ?? 'TURBO_SETUP_FAILED'}\n`); return 1; }
    const d = diagnose({ configPath, pluginRoot, home, apps });
    out(`turbo is on with ${chosen.name}.\n` + (d.port === true ? 'Remote debugging is on. Start a new Claude Code session.\n'
      : `Next: turn on remote debugging in ${chosen.name} once (${chosen.inspectURL}), then start a new Claude Code session.\n`));
    return 0;
  }
  return usage();
}
