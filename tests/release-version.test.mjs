import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReleaseVersion } from '../scripts/release-version.mjs';
import { doctorVersionLine, readPluginVersion } from '../plugins/sleight/lib/version.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const manifests = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  'plugins/sleight/.claude-plugin/plugin.json',
  'plugins/sleight/.codex-plugin/plugin.json',
  'plugins/sleight/.cursor-plugin/plugin.json',
];
const plugin = host => `plugins/sleight/.${host}-plugin/plugin.json`;
const market = host => host === 'codex' ? manifests[0] : `.${host}-plugin/marketplace.json`;

function fixture(t) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-release-version-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const edit = (path, change) => {
    const value = JSON.parse(readFileSync(join(root, path), 'utf8'));
    change(value); write(path, value);
  };
  for (const host of ['claude', 'codex', 'cursor']) {
    write(plugin(host), { name: 'sleight', version: '1.4.1' });
    write(market(host), { name: 'sleight', plugins: [host === 'codex'
      ? { name: 'sleight', source: { source: 'local', path: './plugins/sleight' } }
      : { name: 'sleight', source: './plugins/sleight', version: '1.4.1' }] });
  }
  write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## 1.4.1 (2026-10-21)\n\n## 1.4.0 (2026-10-20)\n');
  return { root, write, edit, inspect: options => inspectReleaseVersion({ root, ...options }) };
}

test('fixture: manifests, newest release heading, doctor and optional tag agree offline', t => {
  const f = fixture(t);
  const result = f.inspect({ expectedVersion: '1.4.1', tag: 'v1.4.1' });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.manifests, manifests);
  assert.equal(result.version, '1.4.1');
  assert.equal(result.changelogVersion, '1.4.1');
  assert.equal(result.doctorVersion, '1.4.1');
  assert.equal(result.versions.length, 6, 'three plugin fields, two marketplace fields and the Codex source');
  assert.equal(f.inspect().ok, true, 'the newest release is the default expected version');
});

for (const path of manifests) {
  test(`fixture: rejects a stale release version in ${path}`, t => {
    const f = fixture(t);
    // Codex's catalog has no version field. Its local source supplies the version.
    if (path === market('codex')) {
      f.write('plugins/stale/.codex-plugin/plugin.json', { name: 'sleight', version: '1.3.1' });
      f.edit(path, value => { value.plugins[0].source.path = './plugins/stale'; });
    } else f.edit(path, value => { (value.plugins?.[0] ?? value).version = '1.3.1'; });
    const result = f.inspect({ expectedVersion: '1.4.1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes(path) && error.includes('1.3.1')), result.errors.join('\n'));
  });
}

test('fixture: the first release heading wins even when an older heading agrees', t => {
  const f = fixture(t);
  f.write('CHANGELOG.md', '# Changelog\n\n## 1.4.2 (2026-10-22)\n\n## 1.4.1 (2026-10-21)\n');
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  assert.equal(result.changelogVersion, '1.4.2');
  assert.match(result.errors.join('\n'), /CHANGELOG\.md.*1\.4\.2.*1\.4\.1/);
});

test('fixture: bracketed release headings are supported', t => {
  const f = fixture(t);
  f.write('CHANGELOG.md', '# Changelog\n\n## [1.4.1] - 2026-10-21\n');
  assert.equal(f.inspect().ok, true);
});

for (const tag of ['v1.4.0', '1.4.1', '', null]) {
  test(`fixture: rejects mismatched or noncanonical tag ${JSON.stringify(tag)}`, t => {
    const f = fixture(t);
    const result = f.inspect({ tag });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /tag.*v1\.4\.1/);
  });
}

test('fixture: missing and malformed release inputs fail with useful paths', t => {
  const f = fixture(t);
  rmSync(join(f.root, plugin('cursor')));
  f.write(plugin('codex'), '{ broken');
  f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n');
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  for (const path of [plugin('cursor'), plugin('codex'), 'CHANGELOG.md']) {
    assert.ok(result.errors.some(error => error.includes(path)), path);
  }
});

test('fixture: missing plugin and marketplace entry versions fail', t => {
  const f = fixture(t);
  f.edit(plugin('claude'), value => { delete value.version; });
  f.edit(market('cursor'), value => { delete value.plugins[0].version; });
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes(plugin('claude')) && error.includes('version')));
  assert.ok(result.errors.some(error => error.includes(market('cursor')) && error.includes('version')));
  assert.equal(result.doctorVersion, null);
});

test('fixture: checks optional marketplace versions as well as each entry', t => {
  const f = fixture(t);
  f.edit(market('claude'), value => { value.metadata = { version: '1.3.1' }; });
  f.edit(market('cursor'), value => { value.version = '1.3.1'; });
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /metadata\.version.*1\.3\.1/);
  assert.match(result.errors.join('\n'), /marketplace\.json version.*1\.3\.1/);
});

test('fixture: discovers additional production manifests and ignores dependency and test versions', t => {
  const f = fixture(t);
  f.write('plugins/extra/.claude-plugin/plugin.json', { name: 'extra', version: '1.3.1' });
  for (const prefix of ['tests/fixtures', 'node_modules/dependency', 'plugins/sleight/vendor/dependency']) {
    f.write(`${prefix}/.claude-plugin/plugin.json`, { version: '0.0.1' });
  }
  f.write('package.json', { dependencies: { dependency: '0.0.1' } });
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  assert.equal(result.manifests.length, 7);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /plugins\/extra\/.*1\.3\.1/);
});

for (const host of ['claude', 'codex', 'cursor']) {
  for (const boundary of ['plugin', 'manifest']) {
    for (const location of ['contained', 'outside']) {
      test(`fixture: rejects unlisted ${location} symlink at ${host} ${boundary} directory`, t => {
        const f = fixture(t);
        const target = location === 'contained' ? join(f.root, 'tests/fixtures/linked-release')
          : trackTemp(mkdtempSync(join(tmpdir(), 'sleight-release-outside-')));
        if (location === 'outside') t.after(() => rmSync(target, { recursive: true, force: true }));
        const manifestDirectory = boundary === 'plugin' ? join(target, `.${host}-plugin`) : target;
        mkdirSync(manifestDirectory, { recursive: true });
        writeFileSync(join(manifestDirectory, 'plugin.json'), JSON.stringify({ name: 'extra', version: '1.3.1' }));
        const path = boundary === 'plugin' ? 'plugins/extra' : `plugins/extra/.${host}-plugin`;
        mkdirSync(dirname(join(f.root, path)), { recursive: true });
        symlinkSync(target, join(f.root, path));
        const result = f.inspect();
        assert.equal(result.ok, false, 'an unlisted symlink must not bypass discovery');
        assert.ok(result.errors.some(error => error.includes(`${path}:`) && error.includes('symlink')), result.errors.join('\n'));
      });
    }
  }
}

for (const path of ['catalog/.agents', 'catalog/.agents/plugins', 'catalog/plugins']) {
  test(`fixture: rejects a symlink at catalog directory ${path}`, t => {
    const f = fixture(t);
    mkdirSync(dirname(join(f.root, path)), { recursive: true });
    symlinkSync(f.root, join(f.root, path));
    const result = f.inspect();
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes(`${path}:`) && error.includes('symlink')), result.errors.join('\n'));
  });
}

for (const target of ['missing', '.']) {
  test(`fixture: rejects a dangling or cyclic plugin directory symlink to ${target}`, t => {
    const f = fixture(t);
    symlinkSync(target, join(f.root, 'plugins/extra'));
    const result = f.inspect();
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /plugins\/extra:.*symlink/);
  });
}

test('fixture: excluded symlink directories do not enter production discovery', t => {
  const f = fixture(t);
  for (const path of ['tests', 'node_modules', 'vendor', 'bench', '.vale', '.git', 'plugins/sleight/vendor']) {
    mkdirSync(dirname(join(f.root, path)), { recursive: true });
    symlinkSync(f.root, join(f.root, path));
  }
  symlinkSync(join(f.root, 'CHANGELOG.md'), join(f.root, 'release-notes.md'));
  const result = f.inspect();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.manifests, manifests);
});

test('fixture: broken or escaping marketplace sources fail without running a host', t => {
  const f = fixture(t);
  f.edit(market('claude'), value => { value.plugins = []; });
  f.edit(market('cursor'), value => { value.plugins[0].source = '../outside'; });
  f.edit(market('codex'), value => { value.plugins[0].source = { source: 'remote', path: './plugins/sleight' }; });
  const result = f.inspect({ expectedVersion: '1.4.1' });
  assert.equal(result.ok, false);
  for (const host of ['claude', 'cursor', 'codex']) assert.ok(result.errors.some(error => error.includes(market(host))));
});

for (const version of [undefined, '', '01.4.1', '1.4', '1.4.1\n', '1.4.1-01', 141]) {
  test(`fixture: invalid manifest version ${JSON.stringify(version)} fails`, t => {
    const f = fixture(t);
    f.edit(plugin('claude'), value => { value.version = version; });
    assert.equal(f.inspect({ expectedVersion: '1.4.1' }).ok, false);
    assert.throws(() => readPluginVersion({ pluginRoot: join(f.root, 'plugins/sleight') }));
    assert.equal(doctorVersionLine({ pluginRoot: join(f.root, 'plugins/sleight') }), 'sleight version unavailable (plugin manifest is missing or invalid)');
  });
}

test('fixture: invalid expected versions and malformed newest headings fail', t => {
  const f = fixture(t);
  assert.equal(f.inspect({ expectedVersion: '1.4' }).ok, false);
  f.write('CHANGELOG.md', '# Changelog\n\n## 1.4 (2026-10-22)\n\n## 1.4.1 (2026-10-21)\n');
  assert.equal(f.inspect({ expectedVersion: '1.4.1' }).ok, false);
});

test('fixture: extra null manifests and symlinked source escapes fail', t => {
  const f = fixture(t);
  f.write('plugins/extra/.claude-plugin/plugin.json', 'null');
  const outside = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-release-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, '.codex-plugin'));
  writeFileSync(join(outside, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'sleight', version: '1.4.1' }));
  symlinkSync(outside, join(f.root, 'plugins/linked'));
  f.edit(market('codex'), value => { value.plugins[0].source.path = './plugins/linked'; });
  const result = f.inspect();
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /plugins\/extra\/.*expected a manifest object/);
  assert.match(result.errors.join('\n'), /marketplace\.json.*cannot read plugins\/linked\//);
});

test('doctor version comes from the installed plugin manifest before host diagnostics', t => {
  const f = fixture(t);
  const pluginRoot = join(f.root, 'plugins/sleight');
  assert.equal(doctorVersionLine({ pluginRoot }), 'sleight 1.4.1');
  f.edit(plugin('claude'), value => { value.version = '9.8.7'; });
  assert.equal(doctorVersionLine({ pluginRoot }), 'sleight 9.8.7');
  // Inspect the wiring without importing launch.mjs or calling any doctor diagnostics.
  const launch = readFileSync(join(repo, 'plugins/sleight/lib/launch.mjs'), 'utf8');
  assert.match(launch, /import \{ doctorVersionLine \} from '\.\/version\.mjs';/);
  const body = launch.slice(launch.indexOf('export async function doctor('));
  assert.ok(body.indexOf('log(doctorVersionLine());') >= 0);
  assert.ok(body.indexOf('log(doctorVersionLine());') < body.indexOf('await turbo()'));
});

test('fixture: current release files agree when the matching heading is present', t => {
  const f = fixture(t);
  const version = readPluginVersion();
  for (const path of manifests) f.write(path, readFileSync(join(repo, path), 'utf8'));
  f.write('CHANGELOG.md', `## ${version} (2026-10-21)\n\n${readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')}`);
  const result = f.inspect({ expectedVersion: version, tag: `v${version}` });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(doctorVersionLine(), `sleight ${version}`);
});

test('repository release versions agree with the newest CHANGELOG release', () => {
  const result = inspectReleaseVersion({ root: repo });
  assert.deepEqual(result.manifests, manifests);
  assert.equal(result.ok, true, result.errors.join('\n'));
});
