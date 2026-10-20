import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as live from '../bench/electron-qualification-live.mjs';
import * as worker from '../bench/electron-qualification-worker.mjs';
import { createElectronHost } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { acceptedInstalledPackage, readInstalledConfig } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';

test('worker status retains a fixed parked reason and resumability', () => {
  assert.deepEqual(worker.qualificationStatus({ ownership: { state: 'owned' }, broker: { state: 'parked',
    parked: { reason: 'pipe queue full', resumable: true } }, workers: [] }, 42),
  { ownership: 'owned', hostPid: 42, broker: 'parked', parked: { reason: 'pipe queue full', resumable: true }, workers: [] });
  assert.equal(worker.qualificationStatus({ broker: { parked: { reason: 'page supplied private text' } } }).parked.reason, 'host failure');
});

test('Terminal setup launches only Terminal if absent and verifies its frontmost bundle', async () => {
  const calls = [], fronts = [{ front: 90, bundle: 'fixture.other' }, { front: 42, bundle: 'com.apple.Terminal' }];
  const front = await live.arrangeTerminal({
    exec: async (...args) => { calls.push(args); }, sleep: async () => {},
    inspect: async request => { calls.push(request); return request.mode === 'pids' ? { pids: [] } : request.mode === 'activate' ? { activated: true } : fronts.shift(); },
  });
  assert.equal(front.front, 42);
  assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/open', ['-b', 'com.apple.Terminal']]);
  await assert.rejects(live.arrangeTerminal({ exec: async () => assert.fail('existing Terminal needs no launch'), sleep: async () => {},
    inspect: async request => request.mode === 'pids' ? { pids: [42, 43] } : { front: 90, bundle: 'fixture.other' } }), /BACKGROUND_TERMINAL_AMBIGUOUS/);
  await assert.rejects(live.arrangeTerminal({ sleep: async () => {},
    inspect: async request => request.mode === 'pids' ? { pids: [42] } : request.mode === 'activate' ? { activated: false } : { front: 90, bundle: 'fixture.other' } }), /BACKGROUND_TERMINAL_REQUIRED/);
});

test('the host-loss probe never selects or launches an app after ownership became free', async () => {
  for (const state of ['free', 'unresolved', 'owned']) {
    const result = await worker.probeLaunch({ status: async () => ({ ownership: { state } }),
      start: () => assert.fail('probe never launches') }, async admin => {
      const status = await admin.status();
      assert.equal(status.ownership.state, 'unresolved');
      throw Error('ELECTRON_OWNERSHIP_UNRESOLVED');
    });
    assert.equal(result.code, 'ELECTRON_OWNERSHIP_' + state.toUpperCase());
    assert.equal(result.launched, false);
  }
});

test('the qualification fork alone gets the unqualified override and stop waits for its own exit', async () => {
  const child = new EventEmitter(), sent = [], env = { PATH: '/fixture/bin' };
  child.pid = 123; child.send = () => {}; child.kill = signal => { sent.push(signal); };
  let forkOptions;
  const w = live.qualificationWorker({ env, forkProcess: (_file, _args, options) => { forkOptions = options; return child; } });
  assert.equal(forkOptions.env.SLEIGHT_TURBO_UNQUALIFIED, '1');
  assert.deepEqual(env, { PATH: '/fixture/bin' });
  let stopped = false;
  const stopping = w.stop().then(value => { stopped = true; return value; });
  await Promise.resolve();
  assert.equal(stopped, false);
  child.emit('exit', null, 'SIGKILL');
  assert.equal(await stopping, true);
  assert.deepEqual(sent, ['SIGKILL']);
});

test('a signalled worker that never exits stays unconfirmed', async () => {
  const child = new EventEmitter();
  child.send = () => {}; child.kill = () => true;
  const w = live.qualificationWorker({ forkProcess: () => child, env: {}, exitWaitMs: 1 });
  assert.equal(await w.stop(), false);
});

test('the macOS temporary path from the failed run exceeds the product socket bound; runner roots fit every phase', async t => {
  const old = '/private/var/folders/1x/q5_9hz5j3gs1fcf2z5yz477m0000gn/T/sleight-eq-XXXXXX/vscode-XXXXXX/state';
  assert.equal(Buffer.byteLength(join(old, 'host.sock')), 104);
  // The real product refuses before constructing an adapter, so this cannot launch an app.
  const root = live.createRunRoot('elr-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const suffix of ['vscode-XXXXXX/state', 'arm-XXXXXX/vscode-XXXXXX/state', 'relaunch-XXXXXX/state']) {
    const dir = join(root, suffix);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assert.doesNotThrow(() => live.assertHostPath(dir));
  }
  assert.throws(() => live.assertHostPath(old), /STATE_DIR_TOO_LONG.*104.*100/);
  const long = join(root, 'x'.repeat(100));
  mkdirSync(long, { mode: 0o700 });
  await assert.rejects(createElectronHost({ stateDir: long, Broker: class {}, createAdapter: () => assert.fail('no adapter') }), /STATE_DIR_TOO_LONG/);
});

test('turbo preflight preserves Node mismatch and checks package entry acceptance without starting native helpers', async () => {
  for (const code of ['INSTALLED_CONFIG_UNSAFE', 'HOST_PACKAGE_MISMATCH']) {
    const config = { receipt: { node: process.version } };
    await assert.rejects(live.turboAcceptance({ readConfig: () => { if (code === 'INSTALLED_CONFIG_UNSAFE') throw Error(code); return config; },
      accept: () => { throw Error(code); } }), new RegExp(code));
  }
  let accepted;
  assert.equal(await live.turboAcceptance({ readConfig: () => ({ enabled: true }), accept: config => { accepted = config; return { current: () => true }; } }), true);
  assert.equal(accepted.enabled, true);
});

test('preflight uses the real receipt reader and rejects changed entry bytes as well as a different Node', async t => {
  const root = live.createRunRoot('eqcfg-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, 'plugin'), files = ['lib/direct-browser/host.mjs', 'lib/direct-browser/native/peer-host.c',
    'lib/direct-browser/native/consent-host.swift', 'lib/direct-browser/playwright-files.json', 'lib/launch.mjs', 'bin/sleight-mcp', 'hooks/register.tsx'];
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const file of files) {
    mkdirSync(join(pluginRoot, file, '..'), { recursive: true });
    writeFileSync(join(pluginRoot, file), file);
  }
  const data = { version: 1, enabled: true, executable: '/fixture/browser', profileRoot: '/fixture/profile',
    receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files: files.map(path => {
      const bytes = readFileSync(join(pluginRoot, path)); return { path, bytes: bytes.length, sha256: digest(bytes) };
    }) }, entryHashes: { '../launch.mjs': digest('lib/launch.mjs'), '../../bin/sleight-mcp': digest('bin/sleight-mcp'), '../../hooks/register.tsx': digest('hooks/register.tsx') } };
  const path = join(root, 'turbo.json');
  const write = () => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  write();
  const deps = { readConfig: () => readInstalledConfig(path), accept: config => acceptedInstalledPackage(config, { pluginRoot }) };
  assert.equal(await live.turboAcceptance(deps), true);
  // Only the entry receipt differs. The package inventory still matches every byte on disk.
  data.entryHashes['../launch.mjs'] = '0'.repeat(64); write();
  await assert.rejects(live.turboAcceptance(deps), /HOST_PACKAGE_MISMATCH/);
  data.receipt.node = 'v0.0.0'; write();
  await assert.rejects(live.turboAcceptance(deps), /INSTALLED_CONFIG_UNSAFE/);
});

test('a host startup refusal closes the unused consent UI and retains its real stage and code on every attempt', async () => {
  let opened = 0, closed = 0, hosts = 0, cards = 0;
  const modules = {
    'installed-config.mjs': { readInstalledConfig: () => ({ receipt: {} }), acceptedInstalledPackage: () => ({ current: () => true }) },
    'host.mjs': { prepareNativeHelpers: async () => ({ status: 'ready', receipt: {} }), createNativeUi: () => { opened++; return { close() { closed++; } }; } },
    'electron-consent.mjs': { createGrantStore: () => ({}), createElectronConsent: () => ({ requestDebugger() { cards++; }, requestRelaunch() {}, grantFor() {} }) },
    'electron-runtime.mjs': { connectAppHost: async () => { hosts++; throw Error('STATE_DIR_TOO_LONG'); } },
    'worlds.mjs': { loadPlaywrightCore: () => ({ inprocess: { playwright: {} } }) }, 'worker.mjs': {}, 'v3-context.mjs': {},
  };
  for (let n = 0; n < 2; n++) await assert.rejects(worker.prepareWorker({ stateDir: '/fixture/state', allowlist: [] }, { loadModule: async name => modules[name] }),
    error => error.message === 'STATE_DIR_TOO_LONG' && error.stage === 'app-host');
  assert.deepEqual({ opened, closed, hosts, cards }, { opened: 2, closed: 2, hosts: 2, cards: 0 });
});

test('the qualification worker uses its message sink and ignores the ambient path', async t => {
  const root = live.createRunRoot('eqstart-'), sink = join(root, 'upstream.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(sink, '', { mode: 0o600 });
  const before = { diagnostic: process.env.SLEIGHT_ELECTRON_DIAG, unqualified: process.env.SLEIGHT_TURBO_UNQUALIFIED };
  t.after(() => {
    for (const [key, value] of [['SLEIGHT_ELECTRON_DIAG', before.diagnostic], ['SLEIGHT_TURBO_UNQUALIFIED', before.unqualified]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.SLEIGHT_ELECTRON_DIAG = '/ambient/ignored';
  process.env.SLEIGHT_TURBO_UNQUALIFIED = '1';
  let startup = '', argv;
  const modules = {
    'installed-config.mjs': { readInstalledConfig: () => ({ receipt: {} }), acceptedInstalledPackage: () => ({ current: () => true }) },
    'host.mjs': { prepareNativeHelpers: async () => ({ status: 'ready', receipt: {} }), createNativeUi: () => ({ close() {} }) },
    'electron-consent.mjs': { createGrantStore: () => ({}), createElectronConsent: () => ({ requestDebugger() {}, requestRelaunch() {}, grantFor() {} }) },
    'electron-runtime.mjs': { connectAppHost: async ({ dependencies }) => {
      return dependencies.ensureHost({ stateDir: join(root, 'state'), tempRoot: join(root, 'profiles'), registryPath: join(root, 'r.json'), build: 'fake-build', timeoutMs: 1,
        spawn(_node, args) {
          argv = args;
          const child = new EventEmitter();
          child.stdout = new PassThrough(); child.stdio = [null, child.stdout, null, new PassThrough(), new PassThrough()];
          child.stdio[4].on('data', bytes => { startup += bytes; }); child.kill = () => {};
          return child;
        } });
    } },
    'worlds.mjs': { loadPlaywrightCore: () => ({ inprocess: { playwright: {} } }) }, 'worker.mjs': {}, 'v3-context.mjs': {},
  };
  await assert.rejects(worker.prepareWorker({ stateDir: root, allowlist: [], python: '/run/python3', qualificationDiagnosticPath: sink }, { loadModule: async name => modules[name] }), /ELECTRON_HOST_START_FAILED/);
  assert.deepEqual(JSON.parse(startup), { diagnostic: sink });
  assert.equal(argv[argv.indexOf('--python') + 1], '/run/python3');
  startup = '';
  await assert.rejects(worker.prepareWorker({ stateDir: root, allowlist: [] }, { loadModule: async name => modules[name] }), /ELECTRON_HOST_START_FAILED/);
  assert.deepEqual(JSON.parse(startup), {}, 'an ambient path cannot enable capture without a message path');
});


test('the default relaunch fork enables its explicit host sink without changing the parent environment', async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { liveRelaunchDriver } = await import('../bench/electron-relaunch-live.mjs');
  const { APPS } = await import('../bench/electron-qualification.mjs');
  const { readQualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-host-run.mjs');
  const root = live.createRunRoot('eqrf-'), sink = join(root, 'relaunch.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(sink, '', { mode: 0o600 });
  const originalFlag = process.env.SLEIGHT_TURBO_UNQUALIFIED;
  delete process.env.SLEIGHT_TURBO_UNQUALIFIED;
  t.after(() => { if (originalFlag === undefined) delete process.env.SLEIGHT_TURBO_UNQUALIFIED; else process.env.SLEIGHT_TURBO_UNQUALIFIED = originalFlag; });
  const before = { ...process.env };
  let forkEnv, startup = '', hostEnv, hostArgs;
  const modules = {
    'installed-config.mjs': { readInstalledConfig: () => ({ receipt: {} }), acceptedInstalledPackage: () => ({ current: () => true }) },
    'host.mjs': { prepareNativeHelpers: async () => ({ status: 'ready', receipt: {} }), createNativeUi: () => ({ close() {} }) },
    'electron-consent.mjs': { createGrantStore: () => ({}), createElectronConsent: () => ({ requestDebugger() {}, requestRelaunch() {}, grantFor() {} }) },
    'electron-runtime.mjs': { connectAppHost: async ({ dependencies }) => dependencies.ensureHost({
      stateDir: join(root, 'state'), tempRoot: join(root, 'profiles'), registryPath: join(root, 'r.json'), build: 'fake-build', timeoutMs: 1,
      env: forkEnv, connect() { const socket = new EventEmitter(); queueMicrotask(() => socket.emit('error')); return socket; },
      spawn(_node, args, options) {
        hostEnv = options.env; hostArgs = args;
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stdio = [null, child.stdout, null, new PassThrough(), new PassThrough()];
        child.stdio[4].on('data', bytes => { startup += bytes; }); child.kill = () => {};
        return child;
      } }) },
    'worlds.mjs': { loadPlaywrightCore: () => ({ inprocess: { playwright: {} } }) }, 'worker.mjs': {}, 'v3-context.mjs': {},
  };
  const forkMock = t.mock.method(childProcess, 'fork', (_file, _args, options) => {
    forkEnv = options.env ?? { ...process.env };
    const child = new EventEmitter();
    child.kill = () => { child.emit('exit', null, 'SIGKILL'); };
    child.send = msg => { void worker.prepareWorker(msg, { loadModule: async name => modules[name] })
      .then(() => assert.fail('fake host never becomes ready'), error => child.emit('message', { id: msg.id, ok: false, error: error.message })); };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { forkMock.mock.restore(); syncBuiltinESMExports(); });
  const driver = liveRelaunchDriver(APPS.vscode, { root, python: '/run/expanded/python3', qualificationDiagnosticPath: sink });
  await assert.rejects(driver.nextTurn(), /ELECTRON_HOST_START_FAILED/);
  assert.ok(Object.keys(process.env).length === Object.keys(before).length && Object.entries(before).every(([key, value]) => process.env[key] === value),
    'fork and startup leave the parent environment unchanged');
  assert.equal(forkEnv.SLEIGHT_TURBO_UNQUALIFIED, '1');
  assert.equal(hostEnv.SLEIGHT_TURBO_UNQUALIFIED, '1');
  assert.equal(hostEnv.SLEIGHT_ELECTRON_DIAG, undefined);
  assert.equal(hostArgs[hostArgs.indexOf('--python') + 1], '/run/expanded/python3');
  assert.deepEqual(JSON.parse(startup), { diagnostic: sink });
  const record = readQualificationDiagnostic({ fd: 4, unqualified: hostEnv.SLEIGHT_TURBO_UNQUALIFIED,
    stat: () => ({ isSocket: () => true }), read: () => startup, close() {} });
  assert.equal(typeof record, 'function');
  record({ method: 'park', message: 'relaunch upstream cause' });
  assert.match(readFileSync(sink, 'utf8'), /relaunch upstream cause/);
});
