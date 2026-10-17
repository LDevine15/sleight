import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, chmodSync, utimesSync, rmSync, mkdirSync, copyFileSync, readFileSync, lstatSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { createSelectedConnection } from '../plugins/sleight/lib/direct-browser/selected-connection.mjs';
import { createNativeProcessProvider, isNativeProcessProvider } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { codeRequirement, signedBrowserAt, verifiedOnDisk, writeClass } from '../plugins/sleight/lib/direct-browser/executable-trust.mjs';

class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0; frames = []; closeCalls = 0;
  constructor(url) { super(); this.url = url; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(text) { this.frames.push(JSON.parse(text)); }
  close() { this.closeCalls++; this.readyState = 2; }
  closed() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture(t) {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-selected-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'browser'); writeFileSync(executable, 'synthetic', { mode: 0o700 });
  symlinkSync(hostname() + '-4312', join(root, 'SingletonLock'));
  const active = join(root, 'DevToolsActivePort'); writeFileSync(active, '9222\n/devtools/browser/fixture\n', { mode: 0o600 });
  const start = Date.now() - 10000;
  let processCalls = 0, ownerCalls = 0;
  const f = { root, executable, active, start, pid: 4312, uid: process.getuid(), listeners: [], sockets: [],
    metadata: { uid: process.getuid(), pid: 4312, start, incarnation: 'p4312-s123-u456' },
    ownerOutput: 'p4312\nu' + process.getuid() + '\nf12\nn127.0.0.1:9222\n',
    options: { config: { profileRoot: root, executable }, testDependencies: {
      processMetadata: async (pid, expected) => { assert.equal(pid, 4312); assert.equal(expected, executable); processCalls++; return f.metadata; },
      execFile: async (file, args, options) => { assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args, ['-nP', '-a', '-iTCP:9222', '-sTCP:LISTEN', '-Fpun']); assert.equal(options.timeout, 3000); ownerCalls++; return { stdout: f.ownerOutput }; },
      WebSocket: class extends FakeSocket { constructor(url) { super(url); f.sockets.push(this); } },
      closeTimeoutMs: 20, openTimeoutMs: 100,
    } },
    counts: () => ({ processCalls, ownerCalls }) };
  f.connect = async provider => { const opening = provider.connect(); await new Promise(resolve => setImmediate(resolve)); f.sockets.at(-1)?.open(); return opening; };
  return f;
}
test('resolves pinned identity without opening a socket and verifies both sides of explicit connect', async t => {
  const f = fixture(t), provider = await createSelectedConnection(f.options);
  assert.equal(f.sockets.length, 0); assert.match(provider.browserIncarnation, /^[A-Za-z0-9_-]+$/); assert.match(provider.selectedBrowser, /^b[A-Za-z0-9_-]+$/);
  assert.equal(await f.connect(provider), provider.session);
  assert.equal(f.sockets[0].url, 'ws://127.0.0.1:9222/devtools/browser/fixture');
  assert.equal(f.counts().ownerCalls, 2); assert.equal(await provider.verifyConnection(provider.session, provider.browserIncarnation), true);
  assert.equal(await provider.verifyConnection({ ...provider.session }), false);
  const close = provider.disconnect(); f.sockets[0].closed(); assert.equal(await close, true);
});
test('idle socket loss notifies trusted lifecycle once and fences before notification', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), events = [];
  assert.equal(typeof p.onConnectionLoss, 'function');
  const remove = p.onConnectionLoss(() => {
    events.push('lost'); assert.rejects(p.session.send('Target.getTargets', {}), /SELECTED_CONNECTION_CLOSED/);
  });
  await f.connect(p); f.sockets[0].closed(); f.sockets[0].dispatchEvent(new Event('error'));
  assert.deepEqual(events, ['lost']); remove(); assert.equal(await p.disconnect(), true);
});
test('a root-owned immutable executable may serve the current user owned profile', async t => {
  const f = fixture(t), executable = realpathSync('/usr/bin/true');
  f.options.config.executable = executable;
  f.options.testDependencies.processMetadata = async (_pid, expected) => { assert.equal(expected, executable); return f.metadata; };
  const p = await createSelectedConnection(f.options); await f.connect(p);
  const closing = p.disconnect(); f.sockets[0].closed(); assert.equal(await closing, true);
});
// A group-writable executable at a signed browser's fixed place in a private app root, with codesign answered by
// `sign` (verify: whether the requirement holds; flags: the code directory flags codesign --display prints).
function signedFixture(t, mode = 0o775, sign = { verify: true, flags: '0x12a00(kill,restrict,library-validation,runtime)' }) {
  const f = fixture(t), apps = join(f.root, 'Applications'), name = 'Signed Browser';
  const executable = join(apps, `${name}.app/Contents/MacOS/${name}`);
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'synthetic'); chmodSync(executable, mode);
  const requirement = 'identifier "com.example.signed" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"';
  f.executable = executable; f.options.config.executable = executable; f.codesign = [];
  Object.assign(f.options.testDependencies, {
    signedAppRoots: [apps],
    signedBrowsers: [{ name, bundleId: 'com.example.signed', team: 'ABCDE12345', executable, requirement }],
    processMetadata: async (pid, expected) => { assert.equal(pid, 4312); assert.equal(expected, executable); f.metadataCalls = (f.metadataCalls ?? 0) + 1; return f.metadata; },
  });
  const lsof = f.options.testDependencies.execFile;
  f.options.testDependencies.execFile = async (file, args, options) => {
    if (file !== '/usr/bin/codesign') return lsof(file, args, options);
    f.codesign.push(args); assert.equal(options.env.PATH, '/usr/bin:/bin');
    if (args[0] === '--verify') {
      assert.deepEqual(args, ['--verify', '-R=' + requirement, '4312']);
      f.onVerify?.();
      if (!sign.verify) throw Object.assign(Error('failed'), { code: 3 });
      return { stdout: '', stderr: '' };
    }
    assert.deepEqual(args, ['--display', '--verbose=1', '4312']);
    return { stdout: '', stderr: `Executable=${executable}\nIdentifier=com.example.signed\nCodeDirectory v=20500 size=765 flags=${sign.flags} hashes=13+7 location=embedded\n` };
  };
  return f;
}
test('a group-writable signed browser connects once its running process proves the signature, proved once per incarnation', async t => {
  const f = signedFixture(t), p = await createSelectedConnection(f.options);
  assert.deepEqual(f.codesign.map(args => args[0]), ['--verify', '--display']);
  assert.equal(await f.connect(p), p.session); assert.equal(await p.verifyConnection(p.session), true);
  assert.equal(f.codesign.length, 2, 'the proof is cached for the same incarnation and executable');
  const closing = p.disconnect(); f.sockets[0].closed(); assert.equal(await closing, true);
});
for (const [name, make, code] of [
  ['a world-writable signed browser', t => signedFixture(t, 0o777), /SELECTED_PATH_UNSAFE/],
  ['a group-writable executable outside a signed browser place', t => { const f = fixture(t); chmodSync(f.executable, 0o770); return f; }, /SELECTED_PATH_UNSAFE/],
  ['a signature that fails the browser requirement', t => signedFixture(t, 0o775, { verify: false, flags: '0x12a00(kill,restrict,library-validation,runtime)' }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a signed process without library validation', t => signedFixture(t, 0o775, { verify: true, flags: '0x10200(kill,runtime)' }), /SELECTED_SIGNATURE_UNPROVED/],
  ['an unsigned process', t => signedFixture(t, 0o775, { verify: false, flags: '' }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a pid reused during the signature check', t => { const f = signedFixture(t); f.onVerify = () => { f.metadata = { ...f.metadata, incarnation: 'p4312-s999-u1' }; }; return f; }, /SELECTED_PROCESS_UNPROVED/],
]) test('refuses ' + name + ' before any socket opens', async t => {
  const f = make(t);
  await assert.rejects(async () => { const p = await createSelectedConnection(f.options); await p.connect(); }, code);
  assert.equal(f.sockets.length, 0);
  if (/world/.test(name)) assert.deepEqual(f.codesign, [], 'mode is refused before any signature check');
});
test('real codesign: a group-writable ad hoc signed bundle is accepted only with the requirement and flags (Darwin)', {
  skip: macCommandSkip('codesign'),
}, async t => {
  const f = fixture(t), apps = join(f.root, 'Applications'), name = 'Signed Browser', run = promisify(execFile);
  const bundle = join(apps, `${name}.app`), executable = join(bundle, `Contents/MacOS/${name}`);
  mkdirSync(dirname(executable), { recursive: true });
  const sign = async (path, flags) => { copyFileSync('/bin/sleep', path);
    await run('/usr/bin/codesign', ['-f', '-s', '-', '-i', 'com.sleight.test', ...(flags ? ['-o', flags] : []), path], { timeout: 10000 }); chmodSync(path, 0o775); };
  const attempt = async (path, requirement = 'identifier "com.sleight.test"') => {
    const child = spawn(path, ['30'], { stdio: 'ignore' }), closed = once(child, 'close');
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      rmSync(join(f.root, 'SingletonLock')); symlinkSync(hostname() + '-' + child.pid, join(f.root, 'SingletonLock'));
      writeFileSync(f.active, '9222\n/devtools/browser/fixture\n');
      const metadata = { uid: f.uid, pid: child.pid, start: f.start, incarnation: `p${child.pid}-s123-u456` };
      const options = { config: { profileRoot: f.root, executable: path }, testDependencies: { ...f.options.testDependencies,
        signedAppRoots: [apps], signedBrowsers: [{ name, bundleId: 'com.sleight.test', team: 'ABCDE12345', executable, requirement }],
        processMetadata: async () => metadata,
        execFile: (file, args, opts) => file === '/usr/bin/codesign' ? run(file, args, opts) : { stdout: `p${child.pid}\nu${f.uid}\nf12\nn127.0.0.1:9222\n` } } };
      return await createSelectedConnection(options).then(() => 'accepted', error => error.message);
    } finally { child.kill(); await closed; }
  };
  await sign(executable, 'kill,library,runtime');
  assert.equal(await attempt(executable), 'accepted');
  assert.equal(await attempt(executable, 'identifier "com.sleight.other"'), 'SELECTED_SIGNATURE_UNPROVED');
  assert.equal(await attempt(executable, 'identifier "com.sleight.test" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"'), 'SELECTED_SIGNATURE_UNPROVED');
  await sign(executable, undefined);
  assert.equal(await attempt(executable), 'SELECTED_SIGNATURE_UNPROVED', 'no kill, library-validation and runtime flags');
  copyFileSync('/bin/sleep', executable); chmodSync(executable, 0o775);
  assert.equal(await attempt(executable), 'SELECTED_SIGNATURE_UNPROVED', 'Apple\'s own signature, another identifier');
  chmodSync(executable, 0o777);
  assert.equal(await attempt(executable), 'SELECTED_PATH_UNSAFE');
});
test('real codesign: setup accepts the signed bundle on disk and refuses a tampered or unsigned one (Darwin)', {
  skip: macCommandSkip('codesign'),
}, async t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-signed-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = promisify(execFile), requirement = 'identifier "com.sleight.test"';
  const make = async (label, change) => {
    const executable = join(root, `${label}.app/Contents/MacOS/${label}`); mkdirSync(dirname(executable), { recursive: true });
    copyFileSync('/bin/sleep', executable);
    await run('/usr/bin/codesign', ['-f', '-s', '-', '-i', 'com.sleight.test', '-o', 'kill,library,runtime', executable], { timeout: 10000 });
    await change?.(executable); chmodSync(executable, 0o775);
    return verifiedOnDisk(executable, requirement, lstatSync(executable));
  };
  assert.equal(await make('Signed'), true);
  assert.equal(await make('Tampered', path => { const bytes = readFileSync(path); bytes[0x4000 + 100] ^= 0xff; writeFileSync(path, bytes); }), false);
  assert.equal(await make('Unsigned', path => run('/usr/bin/codesign', ['--remove-signature', path], { timeout: 10000 })), false);
});
test('the browser table yields the Developer ID requirement only at the fixed places', () => {
  const chrome = signedBrowserAt('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', { appRoots: ['/Applications'] });
  assert.equal(chrome.team, 'EQHXZ8M8AV');
  assert.equal(chrome.requirement, codeRequirement({ bundleId: 'com.google.Chrome', team: 'EQHXZ8M8AV' }));
  assert.match(chrome.requirement, /^identifier "com\.google\.Chrome" and anchor apple generic and .*certificate leaf\[subject\.OU\] = "EQHXZ8M8AV"$/);
  assert.equal(signedBrowserAt('/Applications/Helium.app/Contents/MacOS/Helium', { appRoots: ['/Applications'] }).team, 'S4Q33XPHB4');
  for (const path of ['/tmp/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Other',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/x/../Google Chrome.app/Contents/MacOS/Google Chrome'])
    assert.equal(signedBrowserAt(path, { appRoots: ['/Applications'] }), undefined, path);
  assert.deepEqual(['strict', 'signature', undefined, undefined].map((_, i) => writeClass([0o755, 0o775, 0o777, 0o757][i])), ['strict', 'signature', undefined, undefined]);
  assert.throws(() => codeRequirement({ bundleId: 'x" or true', team: 'EQHXZ8M8AV' }), /SIGNATURE_REQUIREMENT_INVALID/);
});
test('CDP routes flattened commands, events and errors without using Browser.getVersion as proof', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0], events = [];
  const listener = event => events.push(event); p.session.on('event', listener);
  const root = p.session.send('Target.getTargets', {}), child = p.session.send('Runtime.enable', {}, 'child-session');
  assert.equal(socket.frames[0].sessionId, undefined); assert.equal(socket.frames[1].sessionId, 'child-session');
  socket.message({ id: socket.frames[1].id, sessionId: 'child-session', result: {} });
  socket.message({ id: socket.frames[0].id, result: { targetInfos: [] } });
  assert.deepEqual(await root, { targetInfos: [] }); assert.deepEqual(await child, {});
  socket.message({ method: 'Runtime.executionContextCreated', params: { context: {} }, sessionId: 'child-session' });
  assert.deepEqual(events, [{ method: 'Runtime.executionContextCreated', params: { context: {} }, sessionId: 'child-session' }]);
  p.session.off('event', listener); socket.message({ method: 'Target.targetCreated', params: {} }); assert.equal(events.length, 1);
  assert.throws(() => p.session.on('unsupported', listener), /INVALID_CDP_EVENT/);
  const failing = p.session.send('Runtime.enable', {}, 'child-session'); socket.message({ id: socket.frames.at(-1).id, sessionId: 'child-session', error: { code: -1, message: 'failure' } });
  await assert.rejects(failing, /CDP_COMMAND_FAILED/);
  const close = p.disconnect(); socket.closed(); assert.equal(await close, true);
});
for (const [name, change] of [
  ['writable root', f => chmodSync(f.root, 0o777)],
  ['writable endpoint file', f => chmodSync(f.active, 0o666)],
  ['stale endpoint timestamp', f => utimesSync(f.active, 1, 1)],
  ['endpoint symlink', f => { rmSync(f.active); symlinkSync(f.executable, f.active); }],
  ['malformed active port', f => writeFileSync(f.active, '9222\nws://evil.example/x')],
  ['wrong executable', f => f.options.config.executable = f.active],
  ['foreign lock host', f => { rmSync(join(f.root, 'SingletonLock')); symlinkSync('other-host-4312', join(f.root, 'SingletonLock')); }],
  ['reused pid metadata', f => f.metadata = { ...f.metadata, pid: 5555 }],
]) test('refuses ' + name + ' before any socket opens', async t => {
  const f = fixture(t); change(f);
  await assert.rejects(async () => { const p = await createSelectedConnection(f.options); await p.connect(); }, /SELECTED_|STALE_INSTANCE/);
  assert.equal(f.sockets.length, 0);
});
for (const [name, output] of [
  ['another owner', 'p4313\nu1000\nf12\nn127.0.0.1:9222\n'],
  ['wildcard address', 'p4312\nuUID\nf12\nn*:9222\n'],
  ['missing listener', ''],
  ['missing file record', 'p4312\nuUID\nn127.0.0.1:9222\n'],
  ['foreign uid', 'p4312\nu99999\nf12\nn127.0.0.1:9222\n'],
  ['ambiguous owner', 'p4312\nuUID\nf12\nn127.0.0.1:9222\np4313\nuUID\nf13\nn127.0.0.1:9222\n'],
]) test('refuses ' + name + ' listener ownership before opening', async t => {
  const f = fixture(t); f.ownerOutput = output.replaceAll('UID', String(f.uid)); const p = await createSelectedConnection(f.options);
  await assert.rejects(p.connect(), /SELECTED_LISTENER_UNPROVED/); assert.equal(f.sockets.length, 0);
});
test('changed listener after open closes exact socket and refuses connection', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), opening = p.connect();
  await new Promise(resolve => setImmediate(resolve)); f.ownerOutput = ''; const socket = f.sockets[0]; socket.open();
  const rejected = assert.rejects(opening, /SELECTED_LISTENER_UNPROVED/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.closeCalls, 1); socket.closed(); await rejected; assert.equal(await p.verifyConnection(p.session), false);
});
test('disconnect fences synchronously but retains in-flight command until response or confirmed closure', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const command = p.session.send('Target.getTargets', {}), closing = p.disconnect();
  await assert.rejects(p.session.send('Runtime.enable', {}), /SELECTED_CONNECTION_CLOSED/);
  socket.message({ id: socket.frames[0].id, result: { targetInfos: [] } }); assert.deepEqual(await command, { targetInfos: [] });
  assert.equal(await closing, false); assert.equal(socket.closeCalls, 1);
  socket.closed(); assert.equal(await p.disconnect(), true); assert.equal(socket.closeCalls, 1);
  await assert.rejects(p.connect(), /SELECTED_CONNECTION_CLOSED/);
});
test('disconnect during pending open prevents late connection and confirms socket closure', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), opening = p.connect();
  await new Promise(resolve => setImmediate(resolve)); const socket = f.sockets[0], closing = p.disconnect();
  const rejected = assert.rejects(opening, /SELECTED_CONNECTION_CLOSED/); socket.open(); socket.closed(); await rejected; assert.equal(await closing, true);
});
test('mismatched response route closes connection and rejects command on actual close', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const command = p.session.send('Runtime.enable', {}, 'child'), rejected = assert.rejects(command, /SELECTED_CONNECTION_CLOSED/);
  socket.message({ id: socket.frames[0].id, sessionId: 'other', result: {} }); assert.equal(socket.closeCalls, 1); socket.closed(); await rejected;
});
test('verification fences a replaced browser incarnation before any further command', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  f.metadata = { ...f.metadata, incarnation: 'p4312-s124-u456' };
  assert.equal(await p.verifyConnection(p.session), false);
  await assert.rejects(p.session.send('Target.getTargets', {}), /SELECTED_CONNECTION_CLOSED/);
  assert.equal(socket.closeCalls, 1); socket.closed(); assert.equal(await p.disconnect(), true);
});
test('native process capability cannot be fabricated from caller metadata', async t => {
  const f = fixture(t); assert.equal(isNativeProcessProvider(f.options.testDependencies.processMetadata), false);
  assert.throws(() => createNativeProcessProvider({}), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  await assert.rejects(createSelectedConnection({ config: f.options.config, processMetadata: f.options.testDependencies.processMetadata }), /SELECTED_PROCESS_UNPROVED/);
});
test('opening timeout fences once and retains unconfirmed socket for cleanup', async t => {
  const f = fixture(t); f.options.testDependencies.openTimeoutMs = 10;
  const p = await createSelectedConnection(f.options), opening = p.connect();
  await assert.rejects(opening, /SELECTED_CONNECTION_TIMEOUT/);
  const socket = f.sockets[0]; assert.equal(socket.closeCalls, 1); assert.equal(await p.disconnect(), false);
  socket.closed(); assert.equal(await p.disconnect(), true);
});
test('identity replacement while explicit connect is pending cannot open a socket', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options);
  writeFileSync(f.active, '9223\n/devtools/browser/replaced\n');
  await assert.rejects(p.connect(), /STALE_INSTANCE/); assert.equal(f.sockets.length, 0);
});
test('verification raced with disconnect cannot restore the fenced connection', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const verifying = p.verifyConnection(p.session), closing = p.disconnect(); socket.closed();
  assert.equal(await verifying, false); assert.equal(await closing, true);
});
test('native peer-host compiles and binds metadata to an owned synthetic child (Darwin host tools)', {
  skip: macCommandSkip('xcrun'),
}, async t => {
  const directory = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-process-helper-'))));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url));
  const helper = join(directory, 'peer-host'), run = promisify(execFile);
  await run('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-lbsm', '-o', helper], { timeout: 30000, maxBuffer: 65536 });
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); process.stdout.write("ready\\n");'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    const expected = realpathSync(process.execPath), result = JSON.parse((await run(helper, ['--process-pid', String(child.pid), expected], { timeout: 3000, maxBuffer: 1024 })).stdout);
    assert.equal(result.pid, child.pid); assert.equal(result.uid, process.getuid()); assert.ok(result.start > 0);
    assert.match(result.incarnation, new RegExp('^p' + child.pid + '-s[1-9]\\d*-u\\d+$'));
    await assert.rejects(run(helper, ['--process-pid', String(child.pid), realpathSync('/usr/bin/true')], { timeout: 3000, maxBuffer: 1024 }), error => error.code === 65);
    await assert.rejects(run(helper, ['--process-pid', '+1', expected], { timeout: 3000, maxBuffer: 1024 }), error => error.code === 64);
  } finally { child.stdin.end(); await closed; }
});
test('v3 filters bind only to the explicitly connected provider and fence on socket loss', async t => {
  const f = fixture(t), provider = await createSelectedConnection(f.options);
  assert.equal(typeof provider.createFilter, 'function');
  assert.throws(() => provider.createFilter(['owned']), /SELECTED_CONNECTION_CLOSED/);
  await f.connect(provider);
  const filter = provider.createFilter(['owned']); t.after(() => filter.dispose());
  assert.equal(filter.owns('owned'), true); assert.equal(filter.owns('foreign'), false);
  const snapshot = filter.session.send('Target.getTargets');
  const request = f.sockets[0].frames.at(-1);
  f.sockets[0].message({ id: request.id, result: { targetInfos: [{ targetId: 'owned', type: 'page' }, { targetId: 'foreign', type: 'page' }] } });
  assert.deepEqual((await snapshot).targetInfos.map(v => v.targetId), ['owned']);
  f.sockets[0].closed();
  await assert.rejects(filter.session.send('Target.getTargets'), /CDP_FILTER_CLOSED/);
});
