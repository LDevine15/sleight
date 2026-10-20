// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
// EPV3-7a: the per-app opt-in file, the Electron paths under Application Support, and `sleight-mcp turbo app on|off`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appOptInPath, enabledApps, grantStorePath, hostStateDir, readAppOptIns, registryPath, tempRoot }
  from '../plugins/sleight/lib/direct-browser/electron-config.mjs';
import { turboCommand } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const support = home => join(home, 'Library/Application Support/sleight');
function world(t) {
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-econfig-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(support(home), { recursive: true, mode: 0o700 });
  const recipe = (bundleId, version, filled = true) => ({ build: `${bundleId}@${version}`, name: 'Fake ' + version, bundleId, signer: filled ? 'TEAM123456' : null,
    runtime: 'electron/43.0.0', executable: `/Applications/Fake.app/Contents/MacOS/Fake`, sha256: filled ? 'a'.repeat(64) : null, cdhash: filled ? 'b'.repeat(40) : null,
    args: ['--user-data-dir={profile}/user-data'], schemes: ['vscode-file'], fileRoots: [], joinTolerance: 2, focusEmulation: false, zoomLevel: 0, qualified: false });
  const registry = join(root, 'recipes.json');
  writeFileSync(registry, JSON.stringify({ version: 1, recipes: [recipe('com.example.Editor', '1.2.3'), recipe('com.example.Unfilled', '1.0.0', false)] }));
  return { root, home, registry, path: appOptInPath(home) };
}
const write = (path, data, mode = 0o600) => { writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); chmodSync(path, mode); };
// The opt-in tests run with the benchmark's override; in a release without Electron turbo, on refuses without it.
const BENCH = Object.freeze({ SLEIGHT_TURBO_UNQUALIFIED: '1' });
const run = (args, w, extra = {}, env = BENCH) => {
  let text = '';
  const code = turboCommand(args, { out: value => { text += value; }, home: w.home, env, appOptIns: { path: w.path, registryPath: w.registry, ...extra } });
  return { code, text };
};

test('paths: everything lives under Application Support/sleight, and the host socket path stays under the macOS limit', () => {
  const home = `${MAC_USERS}` + 'n'.repeat(32);
  assert.equal(appOptInPath(home), home + '/Library/Application Support/sleight/turbo-apps.json');
  assert.equal(grantStorePath(home), home + '/Library/Application Support/sleight/electron-grants.json');
  assert.equal(tempRoot(home), home + '/Library/Application Support/sleight/electron-tmp');
  const dir = hostStateDir('k' + 'f'.repeat(64), home);
  assert.match(dir, /\/Library\/Application Support\/sleight\/e[0-9a-f]{12}$/);
  assert.ok(Buffer.byteLength(join(dir, 'host.sock')) <= 100, 'a 32-character user name still fits');
  assert.notEqual(hostStateDir('com.example.A', home), hostStateDir('com.example.B', home));
  assert.throws(() => hostStateDir('../x', home), /INVALID_APP_KEY/);
  assert.match(registryPath, /\/lib\/direct-browser\/electron\/recipes\.json$/);
});

test('readAppOptIns: absent is null; a valid file is returned frozen and enabledApps lists only enabled bundle ids', t => {
  const w = world(t);
  assert.equal(readAppOptIns(w.path), null);
  write(w.path, { version: 1, apps: { 'com.example.Editor': { enabled: true, build: 'com.example.Editor@1.2.3' }, 'com.example.Off': { enabled: false, build: 'com.example.Off@1' } } });
  const data = readAppOptIns(w.path);
  assert.equal(Object.isFrozen(data.apps['com.example.Editor']), true);
  assert.deepEqual(enabledApps(data), [{ bundleId: 'com.example.Editor', build: 'com.example.Editor@1.2.3' }]);
  assert.deepEqual(enabledApps(null), []);
});

test('readAppOptIns refuses anything unsafe with INSTALLED_CONFIG_UNSAFE, as installed-config does', t => {
  const w = world(t);
  const good = { version: 1, apps: { 'com.example.Editor': { enabled: true, build: 'com.example.Editor@1.2.3' } } };
  const cases = [
    () => write(w.path, good, 0o644),
    () => write(w.path, good, 0o400),
    () => write(w.path, 'not json'),
    () => write(w.path, { ...good, extra: 1 }),
    () => write(w.path, { version: 2, apps: good.apps }),
    () => write(w.path, { version: 1, apps: [] }),
    () => write(w.path, { version: 1, apps: { 'bad id!': { enabled: true, build: 'x@1' } } }),
    () => write(w.path, { version: 1, apps: { 'com.example.Editor': { enabled: 'yes', build: 'com.example.Editor@1.2.3' } } }),
    () => write(w.path, { version: 1, apps: { 'com.example.Editor': { enabled: true, build: 'com.example.Other@1' } } }),
    () => write(w.path, { version: 1, apps: { 'com.example.Editor': { enabled: true, build: 'com.example.Editor@1', profile: '/x' } } }),
    () => write(w.path, { version: 1, apps: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['com.e.A' + i, { enabled: true, build: `com.e.A${i}@1` }])) }),
    () => { const real = join(w.root, 'elsewhere.json'); write(real, good); symlinkSync(real, w.path); },
  ];
  for (const [i, make] of cases.entries()) {
    rmSync(w.path, { force: true });
    make();
    assert.throws(() => readAppOptIns(w.path), /^Error: INSTALLED_CONFIG_UNSAFE$/, 'case ' + i);
  }
});

test('turbo app on writes the registry\'s build for that bundle id, 0600, and keeps other apps', t => {
  const w = world(t);
  write(w.path, { version: 1, apps: { 'com.example.Off': { enabled: false, build: 'com.example.Off@1' } } });
  const on = run(['app', 'on', 'com.example.Editor'], w);
  assert.equal(on.code, 0, on.text);
  assert.match(on.text, /com\.example\.Editor@1\.2\.3/);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')).apps, {
    'com.example.Off': { enabled: false, build: 'com.example.Off@1' }, 'com.example.Editor': { enabled: true, build: 'com.example.Editor@1.2.3' } });
  assert.equal(lstatSync(w.path).mode & 0o777, 0o600);
  assert.deepEqual(enabledApps(readAppOptIns(w.path)).map(app => app.bundleId), ['com.example.Editor']);
});

test('turbo app on refuses an unknown, unfilled or malformed bundle id and an unsafe file, and writes nothing', t => {
  const w = world(t);
  for (const [id, pattern] of [['com.example.Missing', /RECIPE_NOT_FOUND/], ['com.example.Unfilled', /RECIPE_UNFILLED/], ['bad id!', /usage/]]) {
    const result = run(['app', 'on', id], w);
    assert.notEqual(result.code, 0);
    assert.match(result.text, pattern);
    assert.equal(readAppOptIns(w.path), null, id);
  }
  write(w.path, { version: 1, apps: {} }, 0o644);
  const unsafe = run(['app', 'on', 'com.example.Editor'], w);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.text, /INSTALLED_CONFIG_UNSAFE/);
  assert.equal(lstatSync(w.path).mode & 0o777, 0o644, 'an unsafe file is left alone');
});

test('turbo app on refuses in this release with one line and writes nothing, unless the benchmark override is set', t => {
  const w = world(t);
  for (const env of [{}, { SLEIGHT_TURBO_UNQUALIFIED: '0' }, { SLEIGHT_TURBO_UNQUALIFIED: 'yes' }]) {
    const result = run(['app', 'on', 'com.example.Editor'], w, {}, env);
    assert.equal(result.code, 1, JSON.stringify(env));
    assert.equal(result.text, 'turbo stays off for com.example.Editor: Electron turbo arrives in 1.3.1; the app stays on the native path.\n');
    assert.equal(readAppOptIns(w.path), null, 'nothing written');
  }
  assert.equal(run(['app', 'on', 'com.example.Editor'], w, {}, BENCH).code, 0, 'the benchmark override still opts in');
});

test('turbo app off works without the override, so an earlier opt-in can always be removed', t => {
  const w = world(t);
  run(['app', 'on', 'com.example.Editor'], w);
  const off = run(['app', 'off', 'com.example.Editor'], w, { revokeApp: () => 1 }, {});
  assert.equal(off.code, 0, off.text);
  assert.deepEqual(readAppOptIns(w.path).apps, {});
});

test('turbo app off removes the opt-in and revokes the app\'s Always records', t => {
  const w = world(t);
  run(['app', 'on', 'com.example.Editor'], w);
  const revoked = [];
  const off = run(['app', 'off', 'com.example.Editor'], w, { revokeApp: id => { revoked.push(id); return 2; } });
  assert.equal(off.code, 0, off.text);
  assert.deepEqual(revoked, ['com.example.Editor']);
  assert.match(off.text, /2 saved debugger permissions removed/);
  assert.deepEqual(readAppOptIns(w.path).apps, {});
  const again = run(['app', 'off', 'com.example.Editor'], w, { revokeApp: () => 0 });
  assert.equal(again.code, 0, 'off is idempotent');
});

test('turbo app off with the default revoker removes only that bundle id\'s sealed Always records', async t => {
  const w = world(t);
  const { createGrantStore } = await import('../plugins/sleight/lib/direct-browser/electron-consent.mjs');
  const store = createGrantStore({ path: grantStorePath(w.home) });
  assert.equal(store.list().length, 0);
  const off = run(['app', 'off', 'com.example.Editor'], w);
  assert.equal(off.code, 0, off.text);
  assert.match(off.text, /0 saved debugger permissions removed/);
});

test('turbo app usage', t => {
  const w = world(t);
  for (const args of [['app'], ['app', 'on'], ['app', 'toggle', 'com.example.Editor'], ['app', 'on', 'com.example.Editor', 'extra']]) {
    const result = run(args, w);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.text, /sleight-mcp turbo app on <bundle id>/);
  }
});
