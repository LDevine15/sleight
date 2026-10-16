import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { acceptedInstalledPackage, INSTALLED_ENTRIES, readInstalledConfig } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { packageFiles } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
import { detectBrowser, doctorLines, ensureTurboConfig, inspectConfig, statusLines, turboCommand, turboDiagnosis, writeConfigFile }
  from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { ensureInstalledTurbo, prepareInstalledStartup, doctor } from '../plugins/sleight/lib/launch.mjs';

const realPlugin = fileURLToPath(new URL('../plugins/sleight', import.meta.url));
// A temp home with Library/Application Support/sleight/turbo.json, a fake /Applications, and optional browsers.
function world(t, { chrome = false, helium = false, chromeMode = 0o755 } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-turbo-setup-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), apps = join(root, 'Applications');
  mkdirSync(home); mkdirSync(apps);
  const install = (app, binary, mode = 0o755) => {
    const dir = join(apps, app + '.app/Contents/MacOS'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, binary), '#!/bin/sh\n'); chmodSync(join(dir, binary), mode);
  };
  if (chrome) install('Google Chrome', 'Google Chrome', chromeMode);
  if (helium) install('Helium', 'Helium');
  const configPath = join(home, 'Library/Application Support/sleight/turbo.json');
  return { root, home, apps, configPath, install, base: { configPath, home, apps, pluginRoot: realPlugin } };
}
function pluginCopy(t, root) {
  const copy = join(root, 'plugin'); cpSync(realPlugin, copy, { recursive: true });
  return copy;
}

test('a written file is accepted by the real reader and package check', t => {
  const w = world(t, { chrome: true });
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'wrote'); assert.equal(result.browser, 'Google Chrome');
  const config = readInstalledConfig(w.configPath);
  assert.equal(config.enabled, true);
  assert.equal(config.executable, join(w.apps, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.equal(config.profileRoot, join(w.home, 'Library/Application Support/Google/Chrome'));
  assert.deepEqual(Object.keys(config.entryHashes).sort(), [...INSTALLED_ENTRIES].sort());
  assert.deepEqual(config.receipt.files.map(f => f.path).sort(), packageFiles(realPlugin).sort());
  assert.equal(config.receipt.helperMode, 'source'); assert.equal(config.receipt.protocol, 1); assert.equal(config.receipt.node, process.version);
  assert.equal(acceptedInstalledPackage(config, { pluginRoot: realPlugin }).current(), true);
  assert.equal(acceptedInstalledPackage(config).current(), true);
  assert.equal(ensureTurboConfig(w.base).action, 'none');
});

test('the file is private and owned by the user, in a private folder it created', t => {
  const w = world(t, { helium: true });
  ensureTurboConfig(w.base);
  const stat = lstatSync(w.configPath);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.getuid()); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(lstatSync(join(w.home, 'Library/Application Support/sleight')).mode & 0o777, 0o700);
});

test('a write never goes through a linked file or folder', t => {
  const w = world(t, { chrome: true });
  const dir = join(w.home, 'Library/Application Support/sleight'), target = join(w.root, 'elsewhere.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(target, 'precious', { mode: 0o600 });
  symlinkSync(target, w.configPath);
  assert.throws(() => writeConfigFile(w.configPath, { version: 1, enabled: false }), /TURBO_CONFIG_LINKED/);
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  assert.equal(ensureTurboConfig(w.base).state, 'unsafe');
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  const out = []; assert.equal(turboCommand(['on'], { ...w.base, out: x => out.push(x) }), 1);
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  const real = join(w.root, 'real-dir'), link = join(w.root, 'linked-dir'); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, link);
  assert.throws(() => writeConfigFile(join(link, 'turbo.json'), { version: 1, enabled: false }), /TURBO_DIRECTORY_UNSAFE/);
  assert.deepEqual(readdirSync(real), []);
});

test('an opt-out is never overwritten at startup, however stale the package looks', t => {
  const w = world(t, { chrome: true });
  assert.equal(turboCommand(['off'], { ...w.base, out() {} }), 0);
  const before = readFileSync(w.configPath, 'utf8');
  assert.deepEqual(JSON.parse(before), { version: 1, enabled: false });
  assert.equal(ensureTurboConfig(w.base).action, 'skipped');
  assert.equal(ensureTurboConfig({ ...w.base, browser: 'chrome' }).state, 'opted-out');
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.equal(readInstalledConfig(w.configPath), null);
  assert.equal(turboCommand(['on'], { ...w.base, out() {} }), 0);
  assert.equal(JSON.parse(readFileSync(w.configPath, 'utf8')).enabled, true);
});

test('a file the reader would refuse is left alone at startup, opt-out or not', t => {
  const w = world(t, { chrome: true });
  mkdirSync(join(w.home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
  writeFileSync(w.configPath, JSON.stringify({ version: 1, enabled: false }), { mode: 0o644 });
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'skipped'); assert.equal(result.state, 'unsafe'); assert.match(result.message, /turbo stays off/);
  assert.equal(lstatSync(w.configPath).mode & 0o777, 0o644);
});

test('a stale receipt is rewritten: changed package, changed node, malformed receipt', t => {
  const w = world(t, { chrome: true, helium: true });
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  assert.equal(ensureTurboConfig(base).action, 'wrote');
  assert.equal(ensureTurboConfig(base).action, 'none');
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// plugin update\n');
  assert.equal(inspectConfig(base).state, 'stale');
  const updated = ensureTurboConfig(base);
  assert.equal(updated.action, 'wrote'); assert.equal(updated.reason, 'package-changed');
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
  const data = JSON.parse(readFileSync(w.configPath, 'utf8'));
  data.receipt.node = 'v0.0.1'; writeFileSync(w.configPath, JSON.stringify(data), { mode: 0o600 });
  assert.equal(ensureTurboConfig(base).reason, 'node-changed');
  assert.equal(readInstalledConfig(w.configPath).receipt.node, process.version);
  writeFileSync(w.configPath, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  assert.equal(ensureTurboConfig(base).reason, 'malformed');
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
});

test('a rewrite keeps the browser the user chose', t => {
  const w = world(t, { chrome: true, helium: true });
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  assert.equal(turboCommand(['on', '--browser', 'helium'], { ...base, out() {} }), 0);
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// update\n');
  assert.equal(ensureTurboConfig(base).browser, 'Helium');
  assert.match(readInstalledConfig(w.configPath).executable, /Helium\.app/);
});

test('no browser means no file and one clear reason', t => {
  const w = world(t);
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'skipped'); assert.equal(result.reason, 'BROWSER_NOT_FOUND');
  assert.match(result.message, /^turbo stays off: No supported browser found/);
  assert.equal(existsSync(w.configPath), false);
  const out = []; assert.equal(turboCommand(['on'], { ...w.base, out: x => out.push(x) }), 1);
  assert.match(out.join(''), /turbo stays off/); assert.equal(existsSync(w.configPath), false);
});

test('detection prefers Chrome, falls back to Helium, and --browser overrides', t => {
  const both = world(t, { chrome: true, helium: true });
  assert.equal(detectBrowser({ home: both.home, apps: both.apps }).id, 'chrome');
  assert.equal(detectBrowser({ home: both.home, apps: both.apps, browser: 'helium' }).id, 'helium');
  assert.equal(detectBrowser({ home: both.home, apps: both.apps, browser: 'chrome' }).id, 'chrome');
  const onlyHelium = world(t, { helium: true });
  const found = detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps });
  assert.equal(found.id, 'helium'); assert.equal(found.profileRoot, join(onlyHelium.home, 'Library/Application Support/net.imput.helium'));
  assert.equal(detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps, browser: 'chrome' }).code, 'BROWSER_NOT_FOUND');
  assert.equal(detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps, browser: 'firefox' }).code, 'BROWSER_UNKNOWN');
  const out = []; assert.equal(turboCommand(['on', '--browser', 'firefox'], { ...onlyHelium.base, out: x => out.push(x) }), 1);
});

test('a browser executable the connection would refuse is skipped, with the reason', t => {
  const shared = world(t, { chrome: true, helium: true, chromeMode: 0o775 });
  assert.equal(detectBrowser({ home: shared.home, apps: shared.apps }).id, 'helium');
  const only = world(t, { chrome: true, chromeMode: 0o775 });
  const refused = detectBrowser({ home: only.home, apps: only.apps });
  assert.equal(refused.code, 'BROWSER_EXECUTABLE_UNSAFE'); assert.match(refused.message, /writable by others \(mode 775\)/);
  assert.equal(ensureTurboConfig(only.base).action, 'skipped'); assert.equal(existsSync(only.configPath), false);
});

test('writes are atomic: no partial file, no temp leftovers, the old file survives a failed write', t => {
  const w = world(t, { chrome: true });
  ensureTurboConfig(w.base);
  const before = readFileSync(w.configPath, 'utf8'), dir = join(w.home, 'Library/Application Support/sleight');
  const circular = {}; circular.self = circular;
  assert.throws(() => writeConfigFile(w.configPath, circular), /circular|cyclic/i);
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['turbo.json']);
  writeConfigFile(w.configPath, { version: 1, enabled: false });
  assert.deepEqual(readdirSync(dir), ['turbo.json']);
  assert.equal(lstatSync(w.configPath).mode & 0o777, 0o600);
});

test('status and doctor report each state with the one fix', t => {
  const none = world(t);
  assert.match(doctorLines(turboDiagnosis(none.base)).join('\n'), /not set up yet[\s\S]*fix: No supported browser found/);
  const w = world(t, { helium: true }), cache = join(w.root, 'cache');
  assert.match(doctorLines(turboDiagnosis({ ...w.base, helperCache: cache })).join('\n'), /fix: start a new Claude Code session, or run sleight-mcp turbo on/);
  ensureTurboConfig(w.base);
  let d = turboDiagnosis({ ...w.base, helperCache: cache }), text = doctorLines(d).join('\n');
  assert.equal(d.enabled, true); assert.equal(d.port, false); assert.equal(d.helpers, false);
  assert.match(text, /ok +config: on/); assert.match(text, /ok +browser: Helium/);
  assert.match(text, /PROBLEM +native helpers: not compiled yet\n +fix: .*xcode-select --install/);
  assert.match(text, /PROBLEM +remote debugging: off[\s\S]*fix: turn on remote debugging in Helium: chrome:\/\/inspect\/#remote-debugging/);
  assert.match(statusLines(d).join('\n'), /turbo +on\nbrowser +Helium\nprofile +.*net\.imput\.helium\nremote debugging +off/);
  mkdirSync(d.browser.profileRoot, { recursive: true }); writeFileSync(join(d.browser.profileRoot, 'DevToolsActivePort'), '9222\n/devtools/browser/x\n');
  d = turboDiagnosis({ ...w.base, helperCache: cache }); text = doctorLines(d).join('\n');
  assert.equal(d.port, true); assert.match(text, /ok +remote debugging: on/); assert.doesNotMatch(text, /turn on remote debugging/);
  assert.match(statusLines(d).join('\n'), /remote debugging +on/);
  const copy = pluginCopy(t, w.root), stale = { ...w.base, pluginRoot: copy };
  ensureTurboConfig(stale); writeFileSync(join(copy, 'lib/relay.mjs'), 'changed\n');
  assert.match(doctorLines(turboDiagnosis(stale)).join('\n'), /PROBLEM +config: receipt stale \(plugin files changed\)\n +fix: start a new Claude Code session/);
  turboCommand(['off'], { ...w.base, out() {} });
  assert.match(doctorLines(turboDiagnosis(w.base)).join('\n'), /you turned turbo off\n +fix: sleight-mcp turbo on/);
  assert.match(statusLines(turboDiagnosis(w.base)).join('\n'), /turbo +off \(you turned it off\)/);
});

test('turbo commands: on, off, status, usage', t => {
  const w = world(t, { chrome: true, helium: true });
  const run = args => { const out = []; const code = turboCommand(args, { ...w.base, out: x => out.push(x) }); return { code, text: out.join('') }; };
  assert.equal(run([]).code, 2); assert.equal(run(['bogus']).code, 2); assert.equal(run(['off', '--browser', 'chrome']).code, 2); assert.equal(run(['status', 'x']).code, 2);
  assert.match(run(['status']).text, /turbo +off \(not set up yet\)/);
  const on = run(['on', '--browser', 'helium']);
  assert.equal(on.code, 0); assert.match(on.text, /turbo is on with Helium[\s\S]*chrome:\/\/inspect\/#remote-debugging/);
  assert.match(run(['status']).text, /turbo +on\nbrowser +Helium/);
  assert.match(run(['off']).text, /turbo is off/);
  assert.match(run(['status']).text, /turbo +off \(you turned it off\)/);
  assert.equal(run(['on']).code, 0); assert.match(run(['status']).text, /browser +Google Chrome/);
});

test('startup hashing time on the real package', t => {
  const w = world(t, { chrome: true });
  const first = ensureTurboConfig(w.base), second = ensureTurboConfig(w.base);
  t.diagnostic(`files ${packageFiles(realPlugin).length}; absent -> written ${first.ms} ms; current check ${second.ms} ms`);
  assert.equal(first.action, 'wrote'); assert.equal(second.action, 'none');
  assert.ok(first.ms < 5000 && second.ms < 5000);
});

test('launcher startup: ensure runs before the bridge, only when asked, and never blocks startup', async t => {
  const order = [];
  await prepareInstalledStartup(() => { order.push('bridge'); return null; }, () => {}, { ensure: async () => { order.push('ensure'); } });
  assert.deepEqual(order, ['ensure', 'bridge']);
  order.length = 0;
  await prepareInstalledStartup(() => { order.push('bridge'); return null; }, () => {});
  assert.deepEqual(order, ['bridge']);
  const result = await prepareInstalledStartup(() => null, () => {}, { ensure: async () => { throw Error('SETUP_BROKE'); } });
  assert.equal(result.directBrowser, undefined); assert.equal(result.turboUnavailable, undefined);
});

test('launcher startup writes when absent or stale, logs one line, and leaves an opt-out alone', async t => {
  const w = world(t, { chrome: true }), copy = pluginCopy(t, w.root), lines = [];
  const ensure = log => ensureInstalledTurbo(log, { ...w.base, pluginRoot: copy });
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(readInstalledConfig(w.configPath).enabled, true);
  assert.equal(lines.length, 1); assert.match(lines[0], /^sleight: turbo is on with Google Chrome/);
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 1);
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// update\n');
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 2);
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
  turboCommand(['off'], { ...w.base, pluginRoot: copy, out() {} });
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 2); assert.equal(readInstalledConfig(w.configPath), null);
  assert.deepEqual(JSON.parse(readFileSync(w.configPath, 'utf8')), { version: 1, enabled: false });
});

test('launcher startup logs one line and keeps the engine when setup cannot write', async t => {
  const none = world(t), lines = [];
  await prepareInstalledStartup(() => null, () => {}, { ensure: log => ensureInstalledTurbo(log, none.base), log: x => lines.push(x) });
  assert.equal(lines.length, 1); assert.match(lines[0], /turbo stays off: No supported browser found/); assert.equal(existsSync(none.configPath), false);
  const w = world(t, { chrome: true }), failures = [];
  const support = join(w.home, 'Library/Application Support');
  mkdirSync(support, { recursive: true }); chmodSync(support, 0o500);
  let result;
  try { result = await ensureInstalledTurbo(x => failures.push(x), w.base); } finally { chmodSync(support, 0o700); }
  assert.equal(result.action, 'failed'); assert.equal(failures.length, 1); assert.match(failures[0], /turbo stays off: could not write turbo\.json/);
  assert.equal(existsSync(w.configPath), false);
});

test('doctor prints the turbo section first, read-only', async t => {
  const w = world(t, { helium: true }), lines = [];
  const code = await doctor({ env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' }, log: x => lines.push(x),
    turbo: async () => doctorLines(turboDiagnosis(w.base)) });
  assert.equal(code, 1);
  assert.equal(lines[0], 'turbo (direct browser path)'); assert.match(lines.join('\n'), /not set up yet/);
  assert.equal(existsSync(w.configPath), false);
});
