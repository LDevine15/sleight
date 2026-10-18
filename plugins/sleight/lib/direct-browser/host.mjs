import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';

// Fixed entry. The installed loader supplies source acceptance outside model or
// project input. Only this local compiler can issue a native launch receipt.
const sources = fileURLToPath(new URL('./native/', import.meta.url)).replace(/\/$/, '');
const nativeBuilds = new WeakMap();
const helperSources = { 'peer-host': 'peer-host.c', 'consent-host': 'consent-host.swift' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const processProviders = new WeakSet();
export const isNativeProcessProvider = value => typeof value === 'function' && processProviders.has(value);
function ordinary(path, mode) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.mode & 0o022 || stat.uid !== process.getuid() && stat.uid !== 0 ||
      mode !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode)) throw Error('HOST_PACKAGE_MISMATCH');
  return readFileSync(path);
}
function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!isAbsolute(path) || normalize(path) !== path || !stat.isDirectory() || stat.isSymbolicLink() ||
      realpathSync(path) !== path || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('HOST_CACHE_UNSAFE');
}
function createPrivateCache(path) {
  if (!isAbsolute(path) || normalize(path) !== path) throw Error('HOST_CACHE_UNSAFE');
  // Check existing ancestors before recursive mkdir so a linked parent cannot
  // redirect even a rejected build's directory creation.
  for (let parent = path; ; parent = dirname(parent)) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw Error('HOST_CACHE_UNSAFE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 }); privateDirectory(path);
}
function sourceBytes(sourceRoot, hashes) {
  const bytes = {};
  for (const name of Object.values(helperSources)) {
    bytes[name] = ordinary(join(sourceRoot, name));
    if (digest(bytes[name]) !== hashes[name]) throw Error('HOST_SOURCE_MISMATCH');
  }
  return bytes;
}
function validateBuild(build) {
  privateDirectory(build.cacheRoot); privateDirectory(build.directory);
  sourceBytes(build.sourceRoot, build.sources);
  if (digest(ordinary(build.record, 0o600)) !== build.recordHash) throw Error('HOST_PACKAGE_MISMATCH');
  for (const name of Object.keys(helperSources))
    if (digest(ordinary(join(build.directory, name), 0o700)) !== build.binaries[name]) throw Error('HOST_PACKAGE_MISMATCH');
}
function executable(name, receipt) {
  const build = nativeBuilds.get(receipt);
  if (process.platform !== 'darwin' || !build || build.node !== process.version) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  try { validateBuild(build); return join(build.directory, name); }
  catch { throw Error('HOST_PACKAGE_MISMATCH'); }
}
const environment = () => ({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });

// A cold module cache rebuilds AppKit's modules: over 120 s at load 31 to 38 (2026-10-14), so first use allows 300 s.
async function compileNative({ name, source, binary, moduleCache }) {
  const args = name === 'peer-host' ? ['clang', '-Wall', '-Werror', '-fmodules-cache-path=' + moduleCache, source, '-lbsm', '-o', binary]
    : ['swiftc', '-module-cache-path', moduleCache, source, '-o', binary];
  await promisify(execFile)('/usr/bin/xcrun', args, { env: environment(), timeout: 300000, maxBuffer: 65536 });
}

function helperSourceHashes(inventory) {
  const hashes = {};
  for (const name of Object.values(helperSources)) {
    const entries = inventory.files.filter(file => file.path === 'native/' + name || file.path?.endsWith('/native/' + name));
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
    hashes[name] = entries[0].sha256;
  }
  return hashes;
}
const helperBuildKey = hashes => digest(JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes }));
const defaultHelperCache = () => join(userInfo().homedir, 'Library/Caches/sleight/turbo-host');

// Read-only: whether the helpers for this receipt are already compiled. Doctor uses it. It never builds or validates a binary.
export function nativeHelpersBuilt({ inventory, cacheRoot = defaultHelperCache() } = {}) {
  try {
    const hashes = helperSourceHashes(inventory), directory = join(cacheRoot, helperBuildKey(hashes));
    const data = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8'));
    return data.protocol === 1 && data.arch === process.arch && JSON.stringify(data.sources) === JSON.stringify(hashes) &&
      Object.keys(helperSources).every(name => lstatSync(join(directory, name)).isFile());
  } catch { return false; }
}

// Internal loader options, never exposed as tool arguments. Compile staged exact
// source bytes and publish the bank only after both artifacts pass validation.
export async function prepareNativeHelpers({ inventory, cacheRoot = defaultHelperCache(),
  sourceRoot = sources, compile = compileNative } = {}) {
  if (inventory?.accepted !== true || inventory.protocol !== 1 || inventory.helperMode !== 'source' ||
      inventory.node !== process.version || !Array.isArray(inventory.files)) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const hashes = helperSourceHashes(inventory);
  const unavailable = code => Object.freeze({ status: 'unavailable', code, fallback: 'engine',
    message: code === 'NATIVE_HELPERS_UNAVAILABLE' ? 'Turbo native helpers need Apple command-line tools and a successful local build. Keep using the engine path.'
      : 'Turbo native helpers are unavailable. Keep using the engine path.' });
  if (process.platform !== 'darwin') return unavailable('NATIVE_HELPERS_UNAVAILABLE');
  let bank, locked = false;
  const lock = join(cacheRoot, 'build.lock');
  try {
    const bytes = sourceBytes(sourceRoot, hashes);
    createPrivateCache(cacheRoot);
    const key = helperBuildKey(hashes);
    const directory = join(cacheRoot, key), record = join(directory, 'build.json');
    const cached = () => {
      const contents = ordinary(record, 0o600), data = JSON.parse(contents);
      if (data.protocol !== 1 || data.arch !== process.arch || JSON.stringify(data.sources) !== JSON.stringify(hashes)) throw Error();
      const build = { cacheRoot, directory, record, sourceRoot, sources: hashes, binaries: data.binaries, recordHash: digest(contents), node: process.version };
      validateBuild(build);
      const receipt = Object.freeze({}); nativeBuilds.set(receipt, build);
      return Object.freeze({ status: 'ready', directory, record, receipt });
    };
    try { return cached(); } catch {}
    try { mkdirSync(lock, { mode: 0o700 }); locked = true; }
    catch (error) { if (error.code === 'EEXIST') return unavailable('HOST_BUILD_BUSY'); throw error; }
    bank = mkdtempSync(join(cacheRoot, 'build-')); chmodSync(bank, 0o700);
    const moduleCache = join(bank, 'module-cache'); mkdirSync(moduleCache, { mode: 0o700 });
    const binaries = {};
    for (const [name, filename] of Object.entries(helperSources)) {
      const source = join(bank, filename), binary = join(bank, name);
      writeFileSync(source, bytes[filename], { mode: 0o600, flag: 'wx' });
      await compile({ name, source, binary, moduleCache, bank });
      chmodSync(binary, 0o700); binaries[name] = digest(ordinary(binary, 0o700));
      if (digest(ordinary(source, 0o600)) !== hashes[filename]) throw Error('HOST_SOURCE_MISMATCH');
    }
    sourceBytes(sourceRoot, hashes);
    writeFileSync(join(bank, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, binaries }), { mode: 0o600, flag: 'wx' });
    // Replacement is limited to our validated private bank, never a linked or
    // external directory. Running processes retain their old executable inode.
    try { privateDirectory(directory); rmSync(directory, { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(bank, directory); bank = undefined;
    return cached();
  } catch (error) {
    return unavailable(['HOST_CACHE_UNSAFE', 'HOST_SOURCE_MISMATCH'].includes(error.message) ? error.message : 'NATIVE_HELPERS_UNAVAILABLE');
  } finally {
    if (bank) rmSync(bank, { recursive: true, force: true });
    if (locked) rmdirSync(lock);
  }
}

/** Parses peer-host output for pid: --process-pid (code false) or --code-status (code true, which adds the kernel's
 *  code-signing status flags, the running architecture and the running cdhash). Throws on any other shape. */
export function parseProcessMetadata(stdout, pid, code = false) {
  const metadata = immutableJSON(JSON.parse(stdout));
  if (Object.keys(metadata).length !== (code ? 7 : 4) || metadata.uid !== process.getuid() || metadata.pid !== pid ||
      !Number.isFinite(metadata.start) || metadata.start <= 0 ||
      !new RegExp('^p' + pid + '-s[1-9]\\d*-u\\d+$').test(metadata.incarnation)) throw Error();
  if (code && (!Number.isSafeInteger(metadata.flags) || metadata.flags < 0 || metadata.flags > 0xffffffff ||
      !/^(arm64e?|x86_64h?)$/.test(metadata.arch) || !/^[0-9a-f]{40}$/.test(metadata.cdhash))) throw Error();
  return metadata;
}

// Private loader capability. Only the compiled, receipt-bound peer helper may
// observe a selected PID; callers cannot supply native output or an executable
// helper. The helper checks UID, canonical executable and birth on both reads.
// provider.codeStatus reads the same metadata plus the live code-signing status (executable-trust.mjs).
export function createNativeProcessProvider(receipt) {
  executable('peer-host', receipt);
  const read = (mode, code, failure) => async (pid, expected) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof expected !== 'string' ||
        !isAbsolute(expected) || normalize(expected) !== expected) throw Error(failure);
    try {
      const { stdout } = await promisify(execFile)(executable('peer-host', receipt),
        [mode, String(pid), expected], { env: environment(), timeout: 3000, maxBuffer: 1024 });
      return parseProcessMetadata(stdout, pid, code);
    } catch { throw Error(failure); }
  };
  const provider = read('--process-pid', false, 'SELECTED_PROCESS_UNPROVED');
  provider.codeStatus = read('--code-status', true, 'SELECTED_SIGNATURE_UNPROVED');
  Object.freeze(provider);
  processProviders.add(provider); return provider;
}

// Pure private channel parser. read/write are inherited pipes of the selected
// child, never a local socket, page bridge or model endpoint. Tests inject streams
// solely to test framing/replay logic, not to claim native-user authentication.
export function createUiChannel({ read, write, onLoss = () => {} }) {
  const nonce = randomBytes(32).toString('hex'), pending = new Map(), events = new WeakSet();
  let buffer = '', closed = false;
  const lose = () => { if (closed) return; closed = true; pending.clear(); onLoss(); };
  read.on('data', chunk => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const raw = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        const record = pending.get(raw.id);
        if (!record || raw.nonce !== nonce || Object.keys(raw).length !== 3 ||
            !record.choices.includes(raw.choice) || Date.now() >= record.deadline) throw Error();
        pending.delete(raw.id);
        const event = Object.freeze({ id: raw.id, choice: raw.choice, action: raw.choice,
          selection: record.selection });
        events.add(event); Promise.resolve(record.deliver(event)).catch(lose);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  const channel = Object.freeze({
    present(id, data, choices, deliver, { selection, deadline = Date.now() + 30000 } = {}) {
      for (const [key, record] of pending) if (Date.now() >= record.deadline || data?.status && record.status) pending.delete(key);
      if (closed || pending.has(id) || pending.size >= 32 || typeof id !== 'string' ||
          !Array.isArray(choices) || !choices.length || typeof deliver !== 'function' ||
          !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 300000) throw Error('TRUSTED_UI_UNAVAILABLE');
      const frame = immutableJSON({ id, nonce, data, choices, deadline });
      if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw Error('TRUSTED_UI_UNAVAILABLE');
      pending.set(id, { choices: [...choices], deliver, status: data?.status,
        selection: selection && immutableJSON(selection), deadline });
      write.write(JSON.stringify(frame) + '\n');
    },
    authenticate(event) { if (!event || !events.has(event)) return false; events.delete(event); return !closed; },
    revoke() { pending.clear(); },
    close() { lose(); write.end(); },
  });
  return channel;
}

// The ghost hand runs the consent host's binary with --hand, from the same build and cache. Its inventory is the helper sources
// on disk, hashed now: the hand only draws, so it needs no turbo acceptance, and its handle can start only the hand, never the
// consent channel or the peer helper. A build for one serves the other when the sources match.
function handInventory(sourceRoot) {
  return { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: Object.values(helperSources).map(name => ({ path: 'native/' + name, sha256: digest(ordinary(join(sourceRoot, name))) })) };
}
export function handHostBuilt({ cacheRoot = defaultHelperCache(), sourceRoot = sources } = {}) {
  try { return nativeHelpersBuilt({ inventory: handInventory(sourceRoot), cacheRoot }); } catch { return false; }
}
export async function prepareHandHost({ cacheRoot = defaultHelperCache(), sourceRoot = sources, compile = compileNative } = {}) {
  let inventory;
  try { inventory = handInventory(sourceRoot); } catch { return Object.freeze({ status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' }); }
  const built = await prepareNativeHelpers({ inventory, cacheRoot, sourceRoot, compile });
  if (built.status !== 'ready') return Object.freeze({ status: built.status, code: built.code });
  const { receipt } = built;
  // capture is 'hidden' (absent from every capture) or 'visible' (screenshots and recordings show the hand).
  return Object.freeze({ status: 'ready', spawn: ({ capture = 'hidden' } = {}) => {
    if (!['hidden', 'visible'].includes(capture)) throw Error('HAND_CAPTURE_INVALID');
    return spawn(executable('consent-host', receipt), ['--hand', '--capture=' + capture], { env: environment(), stdio: ['pipe', 'ignore', 'ignore'] });
  } });
}

export function createNativeUi(receipt, onLoss) {
  const path = executable('consent-host', receipt);
  const child = spawn(path, [], { env: environment(), stdio: ['pipe', 'pipe', 'ignore'] });
  const channel = createUiChannel({ read: child.stdout, write: child.stdin, onLoss });
  child.on('error', () => channel.close()); child.on('close', () => channel.close());
  return channel;
}
