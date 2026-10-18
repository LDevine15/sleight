// The reviewed Electron recipe registry (EPV3-6): electron/recipes.json, which launch.py also reads. JS checks the
// same launch rules launch.py does (absolute executable, hex sha256, string arguments, an isolated {profile},
// forbidden switches) and the fields only JS uses. A recipe describes packaging and isolation, never app selectors.
// sha256, signer (team) and cdhash stay null until the qualification harness fills them from the installed bundle, and recipeFor
// refuses such a recipe, so nothing launches or binds from a hand-written hash.
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { appRecipe, deriveAppInstance } from './electron-identity.mjs';

const keys = ['build', 'name', 'bundleId', 'signer', 'runtime', 'executable', 'sha256', 'cdhash', 'args', 'schemes', 'fileRoots',
  'joinTolerance', 'focusEmulation', 'zoomLevel', 'qualified'];
// launch.py's list, matched the same way (lower-cased prefix).
const FORBIDDEN = ['--inspect', '--remote-debugging', '--no-sandbox', '--disable-web-security', '--ignore-certificate'];
// A profile switch that names any folder but the temporary profile would open the user's own data.
const PROFILE_DIRS = ['--user-data-dir', '--extensions-dir', '--shared-data-dir'];
const registries = new WeakSet(), recipes = new WeakSet();
const fail = code => { throw Error(code); };
const invalid = reason => { const error = Error('INVALID_RECIPE_REGISTRY'); error.reason = reason; throw error; };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const printable = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const bundleId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);

function checkRecipe(recipe) {
  if (!plain(recipe) || Object.keys(recipe).length !== keys.length || !keys.every(key => Object.hasOwn(recipe, key))) invalid('fields');
  if (!bundleId(recipe.bundleId)) invalid('bundleId');
  const at = typeof recipe.build === 'string' ? recipe.build.lastIndexOf('@') : -1;
  if (at < 0 || recipe.build.slice(0, at) !== recipe.bundleId || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(recipe.build.slice(at + 1))) invalid('build');
  if (!printable(recipe.name, 256) || !printable(recipe.runtime, 128)) invalid('fields');
  if (!printable(recipe.executable, 4096) || !isAbsolute(recipe.executable) || normalize(recipe.executable) !== recipe.executable) invalid('executable');
  if (new Set([recipe.sha256 === null, recipe.signer === null, recipe.cdhash === null]).size !== 1) invalid('unfilled');
  if (recipe.sha256 !== null && !/^[0-9a-f]{64}$/.test(recipe.sha256)) invalid('sha256');
  if (recipe.cdhash !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recipe.cdhash)) invalid('cdhash');
  if (recipe.signer !== null && !printable(recipe.signer, 256)) invalid('fields');
  const args = recipe.args;
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) invalid('args');
  if (args.some(arg => FORBIDDEN.some(prefix => arg.toLowerCase().startsWith(prefix)))) invalid('forbidden');
  if (!args.some(arg => arg.includes('{profile}'))) invalid('profile');
  if (args.some(arg => /[{}]/.test(arg.replaceAll('{profile}', '')))) invalid('substitution');
  if (args.some(arg => PROFILE_DIRS.some(name => arg.toLowerCase().startsWith(name) && !arg.startsWith(name + '={profile}')))) invalid('profile-dir');
  try { appRecipe({ schemes: recipe.schemes, fileRoots: recipe.fileRoots }); } catch { invalid('recipe'); }
  if (!Number.isInteger(recipe.joinTolerance) || recipe.joinTolerance < 0 || recipe.joinTolerance > 64) invalid('joinTolerance');
  if (typeof recipe.focusEmulation !== 'boolean') invalid('focusEmulation');
  if (!Number.isInteger(recipe.zoomLevel)) invalid('zoomLevel');
  if (typeof recipe.qualified !== 'boolean' || recipe.qualified && recipe.sha256 === null) invalid('qualified');
  const frozen = Object.freeze({ ...recipe, args: Object.freeze([...args]), schemes: Object.freeze([...recipe.schemes]), fileRoots: Object.freeze([...recipe.fileRoots]) });
  recipes.add(frozen);
  return frozen;
}

/** The registry file, validated as a whole. Throws INVALID_RECIPE_REGISTRY with error.reason naming the rule. */
export function readRecipeRegistry(path) {
  let text;
  try {
    const stat = lstatSync(path);
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw Error();
    text = readFileSync(path, 'utf8');
  } catch { invalid('file'); }
  let data;
  try { data = JSON.parse(text); } catch { invalid('format'); }
  if (!plain(data) || Object.keys(data).sort().join() !== 'recipes,version' || data.version !== 1 || !Array.isArray(data.recipes) || data.recipes.length > 64) invalid('format');
  const list = data.recipes.map(checkRecipe);
  if (new Set(list.map(recipe => recipe.build)).size !== list.length) invalid('duplicate');
  const registry = Object.freeze({ version: 1, recipes: Object.freeze(list) });
  registries.add(registry);
  return registry;
}

/** The one recipe for a bundle id in a registry read above. */
export function recipeFor(registry, id) {
  if (!registries.has(registry)) fail('INVALID_RECIPE_REGISTRY');
  const found = registry.recipes.filter(recipe => recipe.bundleId === id);
  if (!found.length) fail('RECIPE_NOT_FOUND');
  if (found.length > 1) fail('RECIPE_AMBIGUOUS');
  if (found[0].sha256 === null) fail('RECIPE_UNFILLED');
  return found[0];
}

/** The AppInstance a debugger card names, derived from the installed code (deriveAppInstance) and pinned to the recipe:
 * a bundle whose id, team, version, runtime or cdhash differs from the reviewed build is RECIPE_BUILD_CHANGED.
 * pid 0 with pidBirth 'unlaunched' is the form before launch. inspect is deriveAppInstance's seam for tests. */
export function instanceFromRecipe(recipe, { profile, pid = 0, pidBirth = 'unlaunched', temporary, inspect } = {}) {
  if (!recipes.has(recipe) || recipe.signer === null) fail('INVALID_RECIPE_REGISTRY');
  if ((pid === 0) !== (pidBirth === 'unlaunched')) fail('INVALID_APP_INSTANCE');
  const at = recipe.executable.lastIndexOf('.app/Contents/MacOS/');
  if (at < 0) fail('INVALID_APP_PROCESS');
  // validateAppInstance takes the unlaunched form once EPV3-7 lands; until then the derivation runs with a stand-in process.
  const derived = deriveAppInstance({ bundle: recipe.executable.slice(0, at + 4), executable: recipe.executable, profile, temporary,
    pid: pid === 0 ? 1 : pid, pidBirth: pid === 0 ? 'unlaunched-check' : pidBirth }, inspect ? { inspect } : {});
  const version = recipe.build.slice(recipe.build.lastIndexOf('@') + 1);
  if (derived.bundleId !== recipe.bundleId || derived.signer !== recipe.signer || derived.version !== version || derived.runtime !== recipe.runtime ||
      derived.cdhash !== recipe.cdhash) fail('RECIPE_BUILD_CHANGED');
  return Object.freeze({ ...derived, pid, pidBirth });
}
