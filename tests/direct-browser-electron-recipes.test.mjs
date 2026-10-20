// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// EPV3-6: the reviewed recipe registry that launch.py reads, validated on the JS side the same way plus the
// fields only JS uses. A missing module is the expected failure before the build.
const api = await import('../plugins/sleight/lib/direct-browser/electron-recipes.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const shipped = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/electron/recipes.json', import.meta.url));
const hex = 'a'.repeat(64);
const good = (extra = {}) => ({ build: 'invalid.fixture.app@1.2.3', name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456',
  runtime: 'electron/39.0.0', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', sha256: hex, cdhash: 'c'.repeat(40),
  args: ['--user-data-dir={profile}/user-data', '--new-window', '{profile}/workspace'], schemes: ['fixture'], fileRoots: [],
  joinTolerance: 2, focusEmulation: false, zoomLevel: 0, qualified: false, ...extra });
const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-recipes-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const write = value => { const path = join(dir, `r${++files}.json`); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
const registry = (...recipes) => write({ version: 1, recipes });
const refused = (path, reason) => assert.throws(() => api.readRecipeRegistry(path), error => error.message === 'INVALID_RECIPE_REGISTRY' && error.reason === reason, reason);

test('a valid registry reads back frozen, with the JS-only fields kept', () => {
  assert.equal(typeof api.readRecipeRegistry, 'function', 'EPV3-6 must provide the recipe registry reader');
  const value = api.readRecipeRegistry(registry(good()));
  assert.equal(value.version, 1);
  assert.deepEqual(value.recipes[0], good());
  assert.ok(Object.isFrozen(value.recipes[0]) && Object.isFrozen(value.recipes[0].args));
});

for (const [reason, recipe] of [
  ['executable', good({ executable: 'Fixture.app/Contents/MacOS/Fixture' })],
  ['executable', good({ executable: '/Applications/Fixture.app/Contents/MacOS/../MacOS/Fixture' })],
  ['sha256', good({ sha256: 'A'.repeat(64) })],
  ['sha256', good({ sha256: 'abc' })],
  ['args', good({ args: ['--user-data-dir={profile}', 7] })],
  ['args', good({ args: ['--user-data-dir={profile}\0'] })],
  ['profile', good({ args: ['--new-window'] })],
  ['substitution', good({ args: ['--user-data-dir={profile}', '{home}/x'] })],
  ['forbidden', good({ args: ['--user-data-dir={profile}', '--remote-debugging-port=9222'] })],
  ['forbidden', good({ args: ['--user-data-dir={profile}', '--INSPECT=1'] })],
  ['forbidden', good({ args: ['--user-data-dir={profile}', '--no-sandbox'] })],
  ['profile-dir', good({ args: [`--user-data-dir=${MAC_USERS}someone/Library/Application Support/Code`, '{profile}/workspace'] })],
  ['recipe', good({ schemes: ['https'] })],
  ['recipe', good({ fileRoots: ['relative/root'] })],
  ['joinTolerance', good({ joinTolerance: 65 })],
  ['joinTolerance', good({ joinTolerance: 1.5 })],
  ['focusEmulation', good({ focusEmulation: 'no' })],
  ['zoomLevel', good({ zoomLevel: 0.5 })],
  ['qualified', good({ qualified: 'yes' })],
  ['qualified', good({ qualified: true, sha256: null, signer: null, cdhash: null })],
  ['cdhash', good({ cdhash: 'xyz' })],
  ['unfilled', good({ cdhash: null })],
  ['build', good({ build: 'other.app@1.2.3' })],
  ['build', good({ build: 'invalid.fixture.app' })],
  ['bundleId', good({ bundleId: '../x', build: '../x@1' })],
  ['fields', good({ title: 'Fixture' })],
  ['fields', (({ zoomLevel, ...rest }) => rest)(good())],
  ['unfilled', good({ sha256: null })],
]) test(`registry rule: ${reason} (${JSON.stringify(recipe).slice(0, 80)})`, () => refused(registry(recipe), reason));

test('registry rules on the file and its top level', () => {
  refused(write({ version: 2, recipes: [] }), 'format');
  refused(write({ version: 1, recipes: [], extra: true }), 'format');
  refused(write('{ not json'), 'format');
  refused(registry(good(), good()), 'duplicate');
  refused('relative.json', 'file');
  const link = join(dir, 'link.json'); symlinkSync(registry(good()), link);
  refused(link, 'file');
  refused(write(' '.repeat(1048577)), 'file');
});

test('recipeFor names exactly one recipe by bundle id and refuses one the harness has not filled', () => {
  const value = api.readRecipeRegistry(registry(good(), good({ build: 'invalid.fixture.app@1.2.4' }), good({ bundleId: 'invalid.other.app', build: 'invalid.other.app@1' }),
    good({ bundleId: 'invalid.unfilled.app', build: 'invalid.unfilled.app@1', sha256: null, signer: null, cdhash: null })));
  assert.equal(api.recipeFor(value, 'invalid.other.app').build, 'invalid.other.app@1');
  assert.throws(() => api.recipeFor(value, 'invalid.fixture.app'), /^Error: RECIPE_AMBIGUOUS$/);
  assert.throws(() => api.recipeFor(value, 'invalid.absent.app'), /^Error: RECIPE_NOT_FOUND$/);
  assert.throws(() => api.recipeFor(value, 'invalid.unfilled.app'), /^Error: RECIPE_UNFILLED$/);
  assert.throws(() => api.recipeFor({ version: 1, recipes: [good()] }, 'invalid.fixture.app'), /^Error: INVALID_RECIPE_REGISTRY$/, 'only a registry this module read');
});

// deriveAppInstance's inspect seam: what codesign and the bundle plists would report for the fixture bundle.
const signature = bundle => ({ executable: bundle + '/Contents/MacOS/Fixture', identifier: 'invalid.fixture.app', cdhash: 'c'.repeat(40), team: 'TEAM123456' });
const facts = (extra = {}) => bundle => ({ verified: true, codesign: signature(bundle), electron: { CFBundleVersion: '39.0.0' },
  info: { CFBundleIdentifier: 'invalid.fixture.app', CFBundleName: 'Fixture App', CFBundleShortVersionString: '1.2.3' }, ...extra });
test('instanceFromRecipe derives the card instance from the installed code and pins it to the recipe, unlaunched by default', () => {
  const recipe = api.recipeFor(api.readRecipeRegistry(registry(good())), 'invalid.fixture.app');
  const seen = [];
  const card = api.instanceFromRecipe(recipe, { profile: `${MAC_TMP}/sleight-ep2-x/profile`, temporary: true, inspect: bundle => { seen.push(bundle); return facts()(bundle); } });
  assert.deepEqual(seen, ['/Applications/Fixture.app']);
  assert.deepEqual(card, { name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456', version: '1.2.3', runtime: 'electron/39.0.0',
    profile: `${MAC_TMP}/sleight-ep2-x/profile`, pid: 0, pidBirth: 'unlaunched', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture',
    cdhash: 'c'.repeat(40), temporary: true });
  assert.ok(Object.isFrozen(card));
  assert.equal(api.instanceFromRecipe(recipe, { profile: `${MAC_TMP}/p`, pid: 4100, pidBirth: '1700000000.000001', temporary: true, inspect: facts() }).pid, 4100);
  for (const options of [{ profile: 'relative', temporary: true }, { profile: '/p', temporary: 'yes' }, { profile: '/p', temporary: true, pid: 0, pidBirth: '1.2' },
    { profile: '/p', temporary: true, pid: 5, pidBirth: 'unlaunched' }, { profile: '/p', temporary: true, pid: -1 }])
    assert.throws(() => api.instanceFromRecipe(recipe, { ...options, inspect: facts() }), /^Error: (INVALID_APP_INSTANCE|INVALID_APP_PROCESS)$/, JSON.stringify(options));
  for (const changed of [{ codesign: { ...signature('/Applications/Fixture.app'), cdhash: 'd'.repeat(40) } }, { codesign: { ...signature('/Applications/Fixture.app'), team: 'OTHERTEAM1' } },
    { info: { CFBundleIdentifier: 'invalid.fixture.app', CFBundleName: 'Fixture App', CFBundleShortVersionString: '1.2.4' } }, { electron: { CFBundleVersion: '40.0.0' } }])
    assert.throws(() => api.instanceFromRecipe(recipe, { profile: '/p', temporary: true, inspect: facts(changed) }), /^Error: RECIPE_BUILD_CHANGED$/, JSON.stringify(changed));
  assert.throws(() => api.instanceFromRecipe(recipe, { profile: '/p', temporary: true, inspect: facts({ verified: false }) }), /^Error: CODE_IDENTITY_UNAVAILABLE$/);
  assert.throws(() => api.instanceFromRecipe({ ...recipe }, { profile: '/p', temporary: true, inspect: facts() }), /^Error: INVALID_RECIPE_REGISTRY$/);
});

test('the shipped registry holds VS Code and Cursor, unqualified, waiting for the harness to fill hash and signer', () => {
  const value = api.readRecipeRegistry(shipped);
  assert.deepEqual(value.recipes.map(recipe => recipe.bundleId), ['com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92']);
  for (const recipe of value.recipes) {
    assert.equal(recipe.qualified, false); assert.equal(recipe.sha256, null); assert.equal(recipe.signer, null); assert.equal(recipe.cdhash, null);
    assert.deepEqual(recipe.schemes, ['vscode-file', 'vscode-webview']);
    assert.equal(recipe.zoomLevel, 0); assert.equal(recipe.focusEmulation, false); assert.equal(recipe.joinTolerance, 2);
    assert.ok(recipe.args.includes('--use-inmemory-secretstorage') && recipe.args.at(-1) === '{profile}/workspace');
    assert.throws(() => api.recipeFor(value, recipe.bundleId), /^Error: RECIPE_UNFILLED$/);
  }
});
