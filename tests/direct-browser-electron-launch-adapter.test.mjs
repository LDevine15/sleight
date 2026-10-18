// The resident host over the real Python launch adapter, with a Python fake standing in for Electron.
// No app, no browser, no engine: the fake is tests/fixtures/fake-electron.py --fake-host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronBroker } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';
import { createElectronHost, createPythonAdapter } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { parseHostArguments, readAdminSecret, runHostEntry } from '../plugins/sleight/lib/direct-browser/electron-host-entry.mjs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const launch = join(here, '../plugins/sleight/lib/direct-browser/electron/launch.py'), fake = join(here, 'fixtures/fake-electron.py');
const python = spawnSync('python3', ['-c', 'import os,sys,ctypes.util;print(os.path.realpath(sys.executable))'], { encoding: 'utf8' });
const skip = python.status !== 0 ? 'python3 is unavailable' : process.platform === 'win32' ? 'POSIX launch primitive unavailable' : false;
const BUILD = 'adapter-fixture';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, ms = 8000) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > ms) throw Error('timed out waiting for ' + label); await sleep(20); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function environment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'eadp-')));
  const executable = python.stdout.trim();
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, recipes: [{ build: BUILD, executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    args: [fake, '--fake-host', '{profile}'] }] }));
  const tempRoot = join(root, 'tmp'); mkdirSync(tempRoot);
  const stateDir = join(root, 's');
  return { root, registryPath, tempRoot, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const lockPath = e => join(e.tempRoot, 'sleight-ep2-lock-' + createHash('sha256').update(BUILD).digest('hex'));
const tmpEntries = e => readdirSync(e.tempRoot);

async function realHost(e, options = {}) {
  const kids = new Set();
  const host = await createElectronHost({
    stateDir: e.stateDir, Broker: ElectronBroker, builds: [BUILD], brokerOptions: { identityMaxAgeMs: 0 },
    createAdapter: async () => createPythonAdapter({ script: launch, registryPath: e.registryPath, tempRoot: e.tempRoot }),
    authorizeLaunch: async () => true, authorizeIssue: async () => true, admitTarget: async info => info.type === 'page',
    requestQuit: async () => { await host.broker.pipe.request('Fake.quit', {}, { sessionId: undefined }).catch(() => {}); },
    ...options,
  });
  return { host, kids };
}
async function worker(host, session = 'w') {
  const connection = await createElectronConnection({ handle: await host.issueTicket({ session }) });
  await connection.connect();
  return connection;
}

for (const [flag, mode] of [['--census-test'], ...['exact', 'wrong-nonce', 'replaced-directories', 'profile-outside-root', 'missing-marker'].map(m => ['--recover-test', m]),
  ...['arguments', 'protocol', 'host-gone'].map(m => ['--adapter-test', m])]) {
  test('python launch adapter: ' + flag.slice(2) + (mode ? ' ' + mode : ''), { skip }, () => {
    const result = spawnSync('python3', [fake, flag, ...(mode ? [mode] : [])], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    if (/^SKIP:/m.test(result.stderr + result.stdout)) return;
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /checks passed/);
  });
}

test('handshake over host-created pipes: the app sees only descriptors 3 and 4, a plain environment, and no debugging port', { skip }, async () => {
  const e = environment(); const { host } = await realHost(e);
  try {
    const receipt = await host.start({ build: BUILD });
    assert.equal(receipt.phase, 'verified');
    const connection = await worker(host);
    const version = await connection.session.send('Browser.getVersion');
    assert.equal(version.pid, connection.identity.pid, 'the process that answers is the one the adapter spawned');
    const { fds } = await connection.session.send('Browser.getVersion', {}).then(() => host.broker.pipe.request('Fake.fds'));
    assert.equal(fds['0'], 'chr', 'stdin is /dev/null');
    assert.equal(fds['1'], 'reg'); assert.equal(fds['2'], 'reg');
    assert.ok(['sock', 'fifo'].includes(fds['3']) && ['sock', 'fifo'].includes(fds['4']));
    assert.deepEqual(Object.keys(fds).map(Number).filter(fd => fd > 4 && fds[fd] !== 'chr'), [], 'no pipe, file or socket leaked past descriptor 4');
    const info = await host.broker.pipe.request('Fake.argv');
    assert.ok(info.argv.includes('--remote-debugging-pipe'));
    assert.ok(!info.argv.some(arg => /^--(remote-debugging-port|inspect|no-sandbox)/.test(arg)), JSON.stringify(info.argv));
    assert.deepEqual(Object.keys(info.env).sort(), ['LANG', 'PATH'].concat(Object.keys(info.env).filter(k => k.startsWith('__CF'))).sort());
    assert.equal(existsSync(lockPath(e)), true);
    await connection.disconnect();
  } finally { await finishReal(host, e); }
});

async function finishReal(host, e) {
  try { host.broker?.pipe?.request('Fake.quit').catch(() => {}); } catch { /* none */ }
  await sleep(150);
  host._crashForTest();
  await sleep(150);
  e.cleanup();
}

test('worker loss and a new worker: one app, one writer, no relaunch', { skip }, async () => {
  const e = environment(); const { host } = await realHost(e);
  try {
    await host.start({ build: BUILD });
    const first = await worker(host, 'a');
    const pid = first.identity.pid;
    first.session.send('Browser.getVersion', {}).catch(() => {});
    await first.disconnect();
    const second = await worker(host, 'b');
    assert.equal(second.identity.pid, pid);
    assert.equal((await second.session.send('Browser.getVersion')).pid, pid);
    assert.equal(alive(pid), true);
    assert.equal(tmpEntries(e).filter(name => name.startsWith('sleight-ep2-') && !name.includes('lock')).length, 1, 'one profile directory');
  } finally { await finishReal(host, e); }
});

test('quit and collect through the adapter: exact descendant census, profile and lock removed, then a new launch is allowed', { skip }, async () => {
  const e = environment(); const { host } = await realHost(e);
  let orphan;
  try {
    await host.start({ build: BUILD });
    const pid = host.broker.identity.pid;
    ({ pid: orphan } = await host.broker.pipe.request('Fake.spawnChild'));
    await host.broker.inspect();                         // the broker sees the child and journals it
    const journal = JSON.parse(readFileSync(join(e.stateDir, 'ownership.json'), 'utf8')).record;
    assert.ok(journal.observed.some(([id]) => id === orphan), 'the descendant is durable');
    const receipt = await host.quit(async () => true);   // the app's own quit; its child outlives it
    assert.equal(receipt.cleanup, 'retained', JSON.stringify(receipt));
    assert.equal(alive(pid), false);
    assert.equal(existsSync(lockPath(e)), true, 'the lock is kept while a recorded descendant may still run');
    process.kill(orphan);
    await until(() => !alive(orphan), 'orphan gone');
    const done = await host.collect();
    assert.equal(done.cleanup, 'removed', JSON.stringify(done));
    assert.equal(existsSync(lockPath(e)), false);
    assert.deepEqual(tmpEntries(e), [], 'the profile directory is gone');
    assert.equal(host.status().ownership.state, 'free');
    assert.equal(JSON.parse(readFileSync(join(e.stateDir, 'ownership.json'), 'utf8')).record.state, 'none');
    await host.start({ build: BUILD });                 // a second launch is fine once ownership is resolved
    assert.equal(host.broker.state, 'ready');
  } finally {
    if (orphan && alive(orphan)) process.kill(orphan);
    await finishReal(host, e);
  }
});

test('resident crash: the app is told by pipe EOF, the new host reports possible exit, refuses a launch, and recovers only with proof', { skip }, async () => {
  const e = environment();
  const child = spawn(process.execPath, [join(here, 'fixtures/electron-host-process.mjs'), BUILD, '--state-dir', e.stateDir, '--registry', e.registryPath, '--temp-root', e.tempRoot,
    '--builds', BUILD, '--adapter-script', launch], { stdio: ['ignore', 'pipe', 'pipe'] });
  let started, text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  let second;
  try {
    await until(() => text.split('\n').filter(Boolean).some(line => JSON.parse(line).started), 'host started', 20000);
    started = JSON.parse(text.split('\n').filter(Boolean).find(line => JSON.parse(line).started));
    assert.equal(alive(started.pid), true);
    const connection = await createElectronConnection({ handle: started.handle });
    await connection.connect();
    assert.equal((await connection.session.send('Browser.getVersion')).pid, started.pid);
    child.kill('SIGKILL');                               // the resident host crashes
    await until(() => !alive(started.pid), 'fake app exits on pipe EOF');   // Electron quits when its controller vanishes
    await until(() => connection.session.send('Runtime.evaluate', {}).then(() => false, () => true), 'worker told');
    assert.equal(existsSync(lockPath(e)), true, 'ownership is still on disk');
    const reborn = await realHost(e);
    second = reborn.host;
    const status = second.status();
    assert.equal(status.ownership.state, 'unresolved');
    assert.equal(status.ownership.reason, 'host-crash-possible-app-exit');
    assert.equal(status.ownership.possibleAppExit, true);
    await assert.rejects(second.start({ build: BUILD }), /ownership unresolved/);
    assert.equal(existsSync(lockPath(e)), true);
    // The journal is recreated empty: that is still not proof.
    writeFileSync(join(e.stateDir, 'ownership.json'), '{}', { mode: 0o600 });
    assert.equal((await second.reconcile()).resolved, false);
    assert.equal(existsSync(lockPath(e)), true);
    const outcome = await second.reconcile({ acceptDiskEvidence: true });   // disk evidence plus a complete census of the dead app
    assert.equal(outcome.resolved, true, JSON.stringify(outcome));
    assert.equal(existsSync(lockPath(e)), false);
    assert.deepEqual(tmpEntries(e), []);
    await second.start({ build: BUILD });
    assert.equal(second.broker.state, 'ready');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (started && alive(started.pid)) process.kill(started.pid);
    if (second) await finishReal(second, e); else e.cleanup();
  }
});

test('the host entry is inert without a trusted parent and accepts only exact, absolute arguments', { skip }, async () => {
  const direct = spawnSync(process.execPath, [fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/electron-host-entry.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(direct.status, 2);
  assert.match(direct.stderr, /inert/);
  const ok = ['--state-dir', '/tmp/s', '--registry', '/tmp/r.json', '--temp-root', '/tmp/t', '--builds', 'a,b'];
  assert.equal(parseHostArguments(ok).builds.length, 2);
  assert.equal(parseHostArguments([...ok, '--admin-fd', '3']).adminFd, 3);
  for (const fd of ['1', '2', 'x', '-1', '300']) assert.throws(() => parseHostArguments([...ok, '--admin-fd', fd]), /ARGUMENTS_INVALID/, fd);
  const line = Buffer.alloc(32, 7).toString('base64url') + '\n';
  assert.deepEqual(readAdminSecret(3, () => line), Buffer.alloc(32, 7), 'the parent secret arrives on a descriptor, never a file');
  for (const bad of ['', 'short', Buffer.alloc(16, 1).toString('base64url'), 'not base64url!'.repeat(4)]) assert.throws(() => readAdminSecret(3, () => bad), /ADMIN_SECRET_INVALID/);
  for (const bad of [[], ok.slice(2), [...ok, '--wild', 'x'], [...ok, '--state-dir', '/tmp/s2'], ['--state-dir', 'rel', ...ok.slice(2)], ['--state-dir', '/tmp/../s', ...ok.slice(2)],
    [...ok.slice(0, 6), '--builds', 'a;rm'], [...ok, '--python'], [...ok.slice(0, 6), '--builds', '']]) {
    assert.throws(() => parseHostArguments(bad), /ARGUMENTS_INVALID/, JSON.stringify(bad));
  }
  const e = environment();
  await assert.rejects(runHostEntry({ argv: ['--state-dir', e.stateDir, '--registry', e.registryPath, '--temp-root', e.tempRoot, '--builds', BUILD], deps: {} }), /APPROVAL_REQUIRED/);
  e.cleanup();
});
