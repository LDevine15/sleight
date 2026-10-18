// The apps and sites the user told sleight never to act in, and when sleight last used each standing permission. The blocks
// live in ~/Library/Application Support/sleight/permissions.json, written only by `sleight-mcp permissions` (permissions-command
// .mjs) and the user's click in sleight's menu, and the write guard keeps Claude's file and shell tools away from it. This module
// only reads: the relay checks apps before any action, turbo checks sites, and both read the file again when it changes, so a
// block applies at once in every session. A file that isn't safe to read refuses every action until the user fixes it.
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, utimesSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

const support = home => join(home, 'Library/Application Support/sleight');
export const permissionsPath = (home = userInfo().homedir) => join(support(home), 'permissions.json');
// One empty file per permission whose modification time is its last use (stampUse). Nothing else is ever written there.
export const usedFolder = (home = userInfo().homedir) => join(support(home), 'used');
export const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
// The most blocks of each kind, and the file's size limit, which 256 apps with long names and ids fit inside.
export const LIMIT = 256, PERMISSIONS_BYTES = 262144;
const NAME = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

/** The web origin of an http(s) URL without credentials, lowercased as URL writes it, or undefined. */
export function siteOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}

/** { state: 'absent' | 'ok' | 'unsafe', apps: [{ id, name? }], sites: [origin], only?: [origin] }. Unsafe is a link, another
 *  owner, a mode other than 0600, or anything but { version: 1, apps, sites, only? } with bundle ids and canonical origins. */
export function readPermissions(path = permissionsPath(), uid = process.getuid()) {
  const empty = state => ({ state, apps: [], sites: [] });
  let stat;
  try { stat = lstatSync(path); } catch (error) { return empty(error.code === 'ENOENT' ? 'absent' : 'unsafe'); }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > PERMISSIONS_BYTES) return empty('unsafe');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const origins = list => Array.isArray(list) && list.length <= LIMIT && list.every(site => siteOrigin(site) === site) && new Set(list).size === list.length;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['version', 'apps', 'sites', 'only'].includes(key)) ||
        data.version !== 1 || !Array.isArray(data.apps) || data.apps.length > LIMIT || !origins(data.sites) ||
        data.only !== undefined && (!origins(data.only) || !data.only.length) ||
        !data.apps.every(app => app && typeof app === 'object' && Object.keys(app).every(key => ['id', 'name'].includes(key)) &&
          typeof app.id === 'string' && app.id.length <= 255 && BUNDLE_ID.test(app.id) && (app.name === undefined || NAME(app.name)))) return empty('unsafe');
    return { state: 'ok', apps: data.apps.map(app => ({ ...app })), sites: [...data.sites], ...data.only ? { only: [...data.only] } : {} };
  } catch { return empty('unsafe'); }
}

const UNSAFE = "sleight's permissions file is a link or has another owner, mode or format, so sleight acts nowhere until you fix it (sleight-mcp --doctor says how).";
const words = list => list.length <= 4 ? list.slice(0, -1).join(', ') + (list.length > 1 ? ' and ' : '') + list.at(-1)
  : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;

/** The line Claude relays when the user blocked this app (by bundle id or name, either case), or undefined. */
export function appRefusal(perms, { bundleId, name } = {}) {
  if (perms?.state === 'unsafe') return UNSAFE;
  const keys = [bundleId, name].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLowerCase());
  const hit = keys.length ? perms?.apps?.find(app => keys.includes(app.id.toLowerCase()) || app.name && keys.includes(app.name.toLowerCase())) : undefined;
  return hit && `You blocked sleight in ${hit.name ?? hit.id} (sleight-mcp permissions unblock ${hit.id} lifts it).`;
}

/** The line Claude relays when the user blocked this page's site, or limited sleight to other sites, or undefined. Only web
 *  origins can be blocked; an app's own documents have none. */
export function siteRefusal(perms, url) {
  if (perms?.state === 'unsafe') return UNSAFE;
  const origin = siteOrigin(url);
  if (!origin) return undefined;
  if (perms?.sites?.includes(origin)) return `You blocked sleight on ${origin} (sleight-mcp permissions unblock ${origin} lifts it).`;
  if (perms?.only && !perms.only.includes(origin)) return `You allow sleight only on ${words(perms.only)}, not ${origin} (sleight-mcp permissions lists them).`;
  return undefined;
}

/** The checks the relay and turbo run before acting. The file is read again only when its inode, size or time changes. */
export function createPermissionCheck({ path = permissionsPath(), uid = process.getuid(), read = readPermissions } = {}) {
  let seen, cached;
  const state = () => {
    let key;
    try { const stat = lstatSync(path); key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch (error) { key = error.code ?? 'error'; }
    if (key !== seen || !cached) { seen = key; cached = read(path, uid); }
    return cached;
  };
  return Object.freeze({ state, app: query => appRefusal(state(), query), site: url => siteRefusal(state(), url) });
}

// The app sleight last acted in, for the menu's Never Act in row. The relay notes it; the hand client reads it.
let current;
export function noteCurrentApp(app) {
  current = app && typeof app.bundleId === 'string' && BUNDLE_ID.test(app.bundleId) && app.bundleId.length <= 255
    ? { bundleId: app.bundleId, name: NAME(app.name) ? app.name : app.bundleId } : undefined;
}
export const currentApp = () => current;

const stamped = new Map();
const stampFile = (key, folder) => join(folder, createHash('sha256').update(key).digest('hex').slice(0, 24));
/** Records that a permission was used now: an empty 0600 file named by a digest of the key, with its time set. At most once a
 *  minute per key and process. Never throws: a failed stamp only means an older time in the list. */
export function stampUse(key, { folder = usedFolder(), now = Date.now } = {}) {
  try {
    const at = now(), file = stampFile(key, folder), last = stamped.get(file);
    if (last !== undefined && at >= last && at - last < 60000) return;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
    utimesSync(file, at / 1000, at / 1000);
    stamped.set(file, at);
  } catch {}
}
/** The last use stampUse recorded, in milliseconds, or undefined. */
export function lastUse(key, { folder = usedFolder() } = {}) {
  try { const stat = lstatSync(stampFile(key, folder)); return stat.isFile() ? stat.mtimeMs : undefined; } catch { return undefined; }
}

/** "used 2h ago", for the listing and the menu. */
export function usedWords(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'not used yet';
  const seconds = Math.max(0, (now - at) / 1000);
  return seconds < 60 ? 'used just now' : seconds < 3600 ? `used ${Math.floor(seconds / 60)}m ago`
    : seconds < 86400 ? `used ${Math.floor(seconds / 3600)}h ago` : `used ${Math.floor(seconds / 86400)}d ago`;
}
