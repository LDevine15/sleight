// Which browser executables turbo connects to. The connection (selected-connection.mjs) enforces it, and setup
// (turbo-setup.mjs) mirrors it so a browser the connection would refuse is never written into turbo.json.
//
// The base rule: a plain file at its canonical path, owned by the user or root, executable, and writable by nobody
// else. A file another account can write could be swapped before the browser starts, and turbo would then drive that
// account's program with the user's pages and typing.
//
// The one relaxation: a drag install into /Applications by an admin user leaves the bundle mode 775 with group admin,
// and macOS App Management stops the user from changing another app's bundle. Such an executable (group-writable,
// never world-writable) is accepted only at a signed browser's fixed place in /Applications or ~/Applications, and then
// only after the running browser process proves its code. Its dynamic signature must satisfy that browser's Developer
// ID requirement (bundle identifier and Apple-issued Team ID), and its code directory must carry the kill,
// library-validation and runtime flags. With those, every library the process loads must be signed by the same team
// or Apple, DYLD environment injection is ignored, and a code page that fails validation kills the process. The proof
// is about the process turbo talks to, so it holds whatever happens to the file afterwards; it is cached per process
// incarnation (pid plus start time) and executable inode, mtime and ctime.
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { browserDefinitions } from './browsers.mjs';

const CODESIGN = '/usr/bin/codesign';
const environment = { PATH: '/usr/bin:/bin', LANG: 'C' };
// CS_KILL 0x200, CS_REQUIRE_LV 0x2000, CS_RUNTIME 0x10000 (xnu cs_blobs.h).
export const REQUIRED_CODE_FLAGS = 0x200 | 0x2000 | 0x10000;

const team = value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value);

/** The Developer ID requirement for a bundle identifier and Team ID: Apple's anchor, the Developer ID intermediate and
 *  leaf markers, and the leaf's Team ID, the same shape as Chrome's and Helium's own designated requirements. */
export function codeRequirement({ bundleId, team: teamId }) {
  if (!identifier(bundleId) || !team(teamId)) throw Error('SIGNATURE_REQUIREMENT_INVALID');
  return `identifier "${bundleId}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] ` +
    `and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}"`;
}

export const defaultAppRoots = () => ['/Applications', join(userInfo().homedir, 'Applications')];

/** The signed browser whose fixed executable path this is, or undefined. Only exact
 *  <root>/<Name>.app/Contents/MacOS/<Name> paths under the given roots match, and only browsers with a Team ID. */
export function signedBrowserAt(path, { appRoots = defaultAppRoots(), browsers } = {}) {
  if (typeof path !== 'string') return undefined;
  for (const root of appRoots) {
    const table = browsers ?? browserDefinitions(undefined, root);
    for (const browser of table) {
      if (!browser.team || browser.executable !== join(root, `${browser.name}.app/Contents/MacOS/${browser.name}`) ||
          browser.executable !== path) continue;
      return Object.freeze({ name: browser.name, bundleId: browser.bundleId, team: browser.team, requirement: browser.requirement ?? codeRequirement(browser) });
    }
  }
  return undefined;
}

/** 'strict' when nobody else can write the file, 'signature' when only its group can, otherwise undefined. */
export function writeClass(mode) {
  if (!(mode & 0o022)) return 'strict';
  if (!(mode & 0o002)) return 'signature';
  return undefined;
}

export const proofKey = (incarnation, stat) => [incarnation, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size, stat.mode].join(':');

function codeFlags(text) {
  const lines = String(text).split('\n').filter(line => line.startsWith('CodeDirectory '));
  const match = lines.length === 1 && / flags=0x([0-9a-f]{1,8})\(/.exec(lines[0]);
  if (!match) throw Error();
  return Number.parseInt(match[1], 16);
}

/** Proves the running process pid is the signed browser: its dynamic signature satisfies the requirement and its code
 *  directory has REQUIRED_CODE_FLAGS. run is execFile in promise form. The caller binds pid to one incarnation by
 *  reading process metadata before and after. Throws SELECTED_SIGNATURE_UNPROVED. */
export async function proveRunningCode(run, pid, requirement) {
  try {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 || typeof requirement !== 'string') throw Error();
    const options = { env: environment, timeout: 5000, maxBuffer: 65536 };
    await run(CODESIGN, ['--verify', '-R=' + requirement, String(pid)], options);
    const shown = await run(CODESIGN, ['--display', '--verbose=1', String(pid)], options);
    const flags = codeFlags(String(shown?.stderr ?? '') + '\n' + String(shown?.stdout ?? ''));
    if ((flags & REQUIRED_CODE_FLAGS) !== REQUIRED_CODE_FLAGS) throw Error();
    return true;
  } catch { throw Error('SELECTED_SIGNATURE_UNPROVED'); }
}

const onDisk = new Map();

/** Setup's static mirror: the executable's bundle on disk satisfies the requirement, and its code directory has the
 *  same flags. runSync has spawnSync's shape. Cached per inode, mtime and ctime. Returns true or false, never throws.
 *  It decides only what setup writes; the connection still proves the running process. */
export function verifiedOnDisk(executable, requirement, stat, runSync = spawnSync) {
  const key = [executable, requirement, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
  if (onDisk.has(key)) return onDisk.get(key);
  let ok = false;
  try {
    const bundle = dirname(dirname(dirname(executable)));
    const options = { env: environment, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' };
    if (bundle.endsWith('.app') && runSync(CODESIGN, ['--verify', '--strict', '-R=' + requirement, bundle], options).status === 0) {
      const shown = runSync(CODESIGN, ['--display', '--verbose=1', executable], options);
      ok = shown.status === 0 && (codeFlags(String(shown.stderr ?? '') + '\n' + String(shown.stdout ?? '')) & REQUIRED_CODE_FLAGS) === REQUIRED_CODE_FLAGS;
    }
  } catch { ok = false; }
  if (onDisk.size > 64) onDisk.clear();
  onDisk.set(key, ok);
  return ok;
}
