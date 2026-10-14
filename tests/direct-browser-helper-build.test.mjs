import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, lstatSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import * as host from '../plugins/sleight/lib/direct-browser/host.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = process.platform === 'darwin';
const skip = !native && 'Darwin first-use native helpers unavailable';
function fixture(t, options = {}) {
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-turbo-build-')))));
  const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { mode: 0o700 });
  const names = ['peer-host.c', 'consent-host.swift'];
  for (const name of names) writeFileSync(join(sourceRoot, name), 'original ' + name, { mode: 0o600 });
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: names.map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(sourceRoot, name))) })) };
  let builds = 0;
  async function compile({ source, binary, moduleCache, bank, name }) {
    builds++;
    assert.equal(lstatSync(bank).mode & 0o777, 0o700);
    assert.ok(moduleCache.startsWith(bank + '/'));
    writeFileSync(binary, 'built ' + name + ': ' + readFileSync(source), { mode: 0o700 });
  }
  return { root, sourceRoot, cacheRoot, inventory, names, builds: () => builds,
    options: { inventory, sourceRoot, cacheRoot, compile, ...options } };
}
test('first use builds privately, records exact hashes and reuses verified binaries', { skip }, async t => {
  const f = fixture(t);
  assert.equal(typeof host.prepareNativeHelpers, 'function', 'first-use compiler is missing');
  const first = await host.prepareNativeHelpers(f.options);
  assert.equal(first.status, 'ready'); assert.equal(f.builds(), 2);
  const record = JSON.parse(readFileSync(first.record, 'utf8'));
  for (const name of f.names) assert.equal(record.sources[name], hash(readFileSync(join(f.sourceRoot, name))));
  for (const name of ['peer-host', 'consent-host']) {
    assert.equal(record.binaries[name], hash(readFileSync(join(first.directory, name))));
    assert.equal(lstatSync(join(first.directory, name)).mode & 0o777, 0o700);
  }
  assert.equal(lstatSync(f.cacheRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.record).mode & 0o777, 0o600);
  const second = await host.prepareNativeHelpers(f.options);
  assert.equal(second.status, 'ready'); assert.equal(second.directory, first.directory); assert.equal(f.builds(), 2);
  assert.equal(typeof host.createNativePeerProvider(second.receipt), 'function');
});
for (const what of ['binary', 'record', 'source']) test('tampered ' + what + ' is refused before launch and rebuilt from accepted source', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  if (what === 'binary') writeFileSync(join(first.directory, 'peer-host'), 'replaced');
  else if (what === 'record') writeFileSync(first.record, '{}');
  else {
    writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'updated source');
    f.inventory.files[0].sha256 = hash('updated source');
  }
  assert.throws(() => host.createNativePeerProvider(first.receipt), /HOST_PACKAGE_MISMATCH/);
  const next = await host.prepareNativeHelpers(f.options);
  assert.equal(next.status, 'ready'); assert.equal(f.builds(), 4);
  assert.equal(typeof host.createNativePeerProvider(next.receipt), 'function');
});
test('unaccepted source edits and forged local receipts never start a helper', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  assert.throws(() => host.createNativePeerProvider({ ...first.receipt }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'unaccepted replacement');
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_SOURCE_MISMATCH');
  assert.equal(f.builds(), 2);
});
for (const kind of ['writable', 'symlink']) test(kind + ' cache root refuses without changing it', { skip }, async t => {
  const f = fixture(t);
  if (kind === 'writable') mkdirSync(f.cacheRoot, { mode: 0o755 });
  else symlinkSync(f.sourceRoot, f.cacheRoot);
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_CACHE_UNSAFE');
  assert.equal(f.builds(), 0);
  assert.equal(kind === 'symlink' ? lstatSync(f.cacheRoot).isSymbolicLink() : lstatSync(f.cacheRoot).mode & 0o777, kind === 'symlink' ? true : 0o755);
});
for (const code of ['ENOENT', 'BUILD_FAILED']) test('compiler ' + code + ' returns typed unavailable and no local receipt', { skip }, async t => {
  const f = fixture(t, { async compile() { throw Object.assign(Error('private compiler details'), { code }); } });
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'NATIVE_HELPERS_UNAVAILABLE');
  assert.equal(result.fallback, 'engine'); assert.match(result.message, /command-line tools/i);
  assert.doesNotMatch(JSON.stringify(result), /private compiler details/); assert.equal(result.receipt, undefined);
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), false);
});
test('linked cache ancestor refuses before creating anything through the link', { skip }, async t => {
  const f = fixture(t), linked = join(f.root, 'linked'); symlinkSync(f.sourceRoot, linked);
  const result = await host.prepareNativeHelpers({ ...f.options, cacheRoot: join(linked, 'new-cache') });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_CACHE_UNSAFE');
  assert.equal(existsSync(join(f.sourceRoot, 'new-cache')), false);
});
test('host returns unavailable before creating IPC or UI for mismatched source acceptance', { skip }, async t => {
  const f = fixture(t);
  const result = await host.startBrokerHost({ inventory: f.inventory, directory: join(f.root, 'never-created'), contract: {} });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_SOURCE_MISMATCH');
  assert.equal(result.fallback, 'engine'); assert.equal(existsSync(join(f.root, 'never-created')), false);
});
test('concurrent first use retains the builders lock and publishes one complete bank', { skip }, async t => {
  const f = fixture(t); let release;
  const wait = new Promise(resolve => release = resolve);
  const building = host.prepareNativeHelpers({ ...f.options, async compile(data) { await wait; await f.options.compile(data); } });
  // Preparation takes the exclusive lock before its first compiler await.
  const other = await host.prepareNativeHelpers(f.options);
  assert.equal(other.status, 'unavailable'); assert.equal(other.code, 'HOST_BUILD_BUSY');
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), true);
  release(); assert.equal((await building).status, 'ready'); assert.equal(f.builds(), 2);
});
test('source mutation during compilation never publishes a usable receipt', { skip }, async t => {
  const f = fixture(t), compile = f.options.compile;
  const result = await host.prepareNativeHelpers({ ...f.options, async compile(data) {
    await compile(data); writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'changed during build');
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_SOURCE_MISMATCH');
  assert.equal(result.receipt, undefined);
});
test('writable cached executable rebuilds and stale launch receipt refuses', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  chmodSync(join(first.directory, 'peer-host'), 0o777);
  assert.throws(() => host.createNativePeerProvider(first.receipt), /HOST_PACKAGE_MISMATCH/);
  assert.equal((await host.prepareNativeHelpers(f.options)).status, 'ready'); assert.equal(f.builds(), 4);
});
test('peer provider checks again at invocation instead of trusting its earlier path', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  const provider = host.createNativePeerProvider(first.receipt);
  writeFileSync(join(first.directory, 'peer-host'), 'replacement between calls');
  await assert.rejects(provider(null), /HOST_PACKAGE_MISMATCH/);
});
test('Darwin first-use compiler builds both real sources without launching consent UI', {
  skip: !(native && existsSync('/usr/bin/xcrun')) && 'Darwin xcrun native helper compiler unavailable',
}, async t => {
  assert.equal(typeof host.prepareNativeHelpers, 'function', 'first-use compiler is missing');
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-turbo-compile-')))));
  const sourceRoot = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/', import.meta.url)).replace(/\/$/, '');
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: ['peer-host.c', 'consent-host.swift'].map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(sourceRoot, name))) })) };
  const result = await host.prepareNativeHelpers({ inventory, sourceRoot, cacheRoot: join(root, 'cache') });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  for (const name of ['peer-host', 'consent-host']) assert.ok(lstatSync(join(result.directory, name)).size > 1000);
  assert.equal(typeof host.createNativePeerProvider(result.receipt), 'function');
});
