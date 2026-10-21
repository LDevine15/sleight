import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const location = new URL('../bench/electron-run-recover.mjs', import.meta.url);
const api = existsSync(location) ? await import(location) : {};
const hash = text => createHash('sha256').update(text).digest('hex');

function world(t, overrides = {}) {
  assert.equal(typeof api.recoverElectronRun, 'function', 'recovery entrypoint is required');
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'electron-recovery-'))));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const root = join(bank, 'elr-owned'), base = join(root, 'seq-owned', 'vscode-owned');
  const profile = join(base, 'profiles', 'sleight-ep2-owned'), source = join(bank, 'source'), lock = join(bank, 'live.lock');
  for (const path of [profile, join(base, 'state'), source, lock]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'OWNER.json'), 'owner-marker', { mode: 0o600 });
  writeFileSync(join(base, 'state', 'ownership.json'), 'opaque journal bytes', { mode: 0o600 });
  writeFileSync(join(base, 'recipes.json'), JSON.stringify({ version: 1, recipes: [{ bundleId: 'com.microsoft.VSCode', build: 'com.microsoft.VSCode@1.2',
    executable: '/fixture/Code.app/Contents/MacOS/Code', args: [`--user-data-dir={profile}/user-data`, join(base, 'workspace')] }] }), { mode: 0o600 });
  const started = Math.ceil(Date.now() / 1000), appBirth = `${started + 2}.123456`, hostBirth = `${started + 1}.123456`;
  const at = new Date((started + 10) * 1000).toISOString(), uid = process.getuid();
  const app = { pid: 501, ppid: 601, uid, startedAtMs: (started + 2) * 1000, args: `/fixture/Code.app/Contents/MacOS/Code --user-data-dir=${profile}/user-data` };
  const host = { pid: 601, ppid: 1, uid, startedAtMs: (started + 1) * 1000,
    args: `${process.execPath} ${source}/plugins/sleight/lib/direct-browser/electron-host-run.mjs --state-dir ${base}/state --registry ${base}/recipes.json --temp-root ${base}/profiles --builds com.microsoft.VSCode@1.2 --admin-fd 3 --startup-fd 4 --python /fixture/python3` };
  let rows = [app, host], nativeBirth = new Map([[501, appBirth], [601, hostBirth]]);
  const events = [], planPath = join(bank, 'plan.json'), lockStat = statSync(lock);
  const plan = { at, runRoot: root, base, buildCommit: 'a'.repeat(40), lock: { dev: lockStat.dev, ino: lockStat.ino, entries: [] },
    fixture: { pid: 501, birth: appBirth, profile, hostPid: 601, observed: [[501, appBirth]] }, ownershipSHA256: hash('opaque journal bytes') };
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  const deps = { lockPath: lock, now: () => (started + 20) * 1000, python: '/fixture/python3', pythonImage: '/fixture/python3', readCommit: async () => plan.buildCommit,
    list: async () => rows.map(row => ({ ...row })),
    native: async request => {
      events.push(request.mode);
      if (request.mode === 'births') return { processes: request.pids.map(pid => ({ pid, pidBirth: rows.some(row => row.pid === pid) ? nativeBirth.get(pid) : null })) };
      if (request.mode === 'table') return { processes: rows.some(row => row.pid === 501) ? [{ pid: 501, pidBirth: nativeBirth.get(501), bundle: 'com.microsoft.VSCode', path: '/fixture/Code.app' }] : [] };
      if (request.mode === 'quit') {
        assert.equal(request.pid, 501); assert.equal(request.pidBirth, appBirth); assert.equal(request.allowForce, false);
        if (!overrides.stuckApp) rows = rows.filter(row => row.pid !== 501);
        if (overrides.recycleHost) nativeBirth.set(601, `${started + 19}.000001`);
        return { reason: overrides.stuckApp ? 'deadline' : 'exited' };
      }
      assert.fail('unexpected native request');
    },
    signal: (pid, signal) => { events.push(`signal:${pid}:${signal}`); assert.ok([601, 701].includes(pid)); rows = rows.filter(row => row.pid !== pid); },
    sleep: async () => {}, ...overrides.deps };
  return { plan, planPath, root, base, profile, source, lock, events, deps,
    run: (options = {}) => api.recoverElectronRun({ planPath, sourceRoot: source, run: true, ...options }, deps),
    rewrite() { writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 }); },
    replaceBirth: (pid, birth) => nativeBirth.set(pid, birth), getRows: () => rows, setRows: value => { rows = value; } };
}

test('recovery quits the exact existing fixture before infrastructure, preserves originals and releases only its pinned lock', async t => {
  const f = world(t), result = await f.run();
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.equal(result.interrupted, true);
  assert.equal(result.lockReleased, true);
  assert.ok(f.events.indexOf('quit') < f.events.findIndex(event => event.startsWith('signal:')));
  assert.equal(existsSync(f.lock), false);
  assert.equal(existsSync(f.root), true);
  assert.equal(readFileSync(join(f.profile, 'OWNER.json'), 'utf8'), 'owner-marker');
  assert.equal(JSON.parse(readFileSync(result.receipt, 'utf8')).confirmed, true);
});

test('a recycled app PID prevents Quit, infrastructure signals and lock release', async t => {
  const f = world(t); f.replaceBirth(501, '9999999999.000001');
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.includes('quit'), false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('normal Quit uncertainty retains infrastructure and exact lock', async t => {
  const f = world(t, { stuckApp: true }), result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('host birth is rechecked after app Quit and a recycled host is never signalled', async t => {
  const f = world(t, { recycleHost: true }), result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('wrong owner digest or lock identity fails before native control', async t => {
  for (const change of [f => { f.plan.ownershipSHA256 = 'b'.repeat(64); }, f => { f.plan.lock.ino++; }]) {
    const f = world(t); change(f); f.rewrite(); const result = await f.run();
    assert.equal(result.confirmed, false);
    assert.equal(f.events.includes('quit'), false);
    assert.equal(f.events.some(event => event.startsWith('signal:')), false);
    assert.equal(existsSync(f.lock), true);
  }
});

test('inspection mode confirms identity but never quits, signals or releases', async t => {
  const f = world(t), result = await f.run({ run: false });
  assert.equal(result.ready, true);
  assert.equal(result.confirmed, false);
  assert.equal(f.events.includes('quit'), false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('an unknown executable naming the retained root is never adopted for cleanup', async t => {
  const f = world(t), host = f.getRows().find(row => row.pid === 601);
  f.setRows([...f.getRows(), { ...host, pid: 701, args: `/unrecognized --state-dir ${f.base}/state` }]);
  f.replaceBirth(701, String(Number(f.plan.fixture.birth) - 0.5));
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.includes('quit'), false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('source checkout HEAD must equal the recorded run commit before control', async t => {
  const f = world(t, { deps: { readCommit: async () => 'b'.repeat(40) } }), result = await f.run();
  assert.equal(result.error, 'RECOVERY_COMMIT_CHANGED');
  assert.equal(f.events.includes('quit'), false);
  assert.equal(existsSync(f.lock), true);
});

test('a missing lock still saves a closed failure receipt', async t => {
  const f = world(t); rmSync(f.lock, { recursive: true });
  const result = await f.run();
  assert.equal(result.error, 'RECOVERY_LOCK_ABSENT');
  assert.equal(JSON.parse(readFileSync(result.receipt, 'utf8')).error, 'RECOVERY_LOCK_ABSENT');
  assert.equal(f.events.includes('quit'), false);
});

test('the exact sequence sampler is included and closed after app absence', async t => {
  const f = world(t), host = f.getRows().find(row => row.pid === 601);
  const request = { mode: 'sample', intervalMs: 50, durationMs: 6 * 3600 * 1000, stop: join(f.root, 'seq-owned', 'sampler.stop') };
  const liveSource = readFileSync(new URL('../bench/electron-qualification-live.mjs', import.meta.url), 'utf8');
  assert.match(liveSource, /new URL\('\.\/electron-qualification\.js'/);
  f.setRows([...f.getRows(), { ...host, pid: 701, args: `/usr/bin/osascript -l JavaScript ${f.source}/bench/electron-qualification.js ${JSON.stringify(request)}` }]);
  f.replaceBirth(701, String(Number(f.plan.fixture.birth) - 0.5));
  const result = await f.run();
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.ok(f.events.includes('signal:701:SIGTERM'));
  assert.ok(f.events.indexOf('quit') < f.events.indexOf('signal:701:SIGTERM'));
});

test('a same-user unrelated Node script naming the run is never adopted', async t => {
  const f = world(t), host = f.getRows().find(row => row.pid === 601);
  f.setRows([...f.getRows(), { ...host, pid: 701, args: `${process.execPath} unrelated.mjs ${f.base}/state` }]);
  f.replaceBirth(701, String(Number(f.plan.fixture.birth) - 0.5));
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.includes('quit'), false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
});

test('opaque owner and operator plan are rechecked immediately before Quit', async t => {
  for (const tamper of [f => writeFileSync(join(f.base, 'state', 'ownership.json'), 'changed'), f => { f.plan.at = new Date().toISOString(); f.rewrite(); }]) {
    const f = world(t), list = f.deps.list; let scans = 0;
    f.deps.list = async () => { if (++scans === 2) tamper(f); return list(); };
    const result = await f.run();
    assert.equal(result.confirmed, false);
    assert.equal(f.events.includes('quit'), false);
    assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  }
});

test('original observed app descendants remain a closure gate after reparenting', async t => {
  const f = world(t), app = f.getRows().find(row => row.pid === 501), birth = f.plan.fixture.birth;
  f.plan.fixture.observed.push([701, birth]); f.rewrite(); f.replaceBirth(701, birth);
  f.setRows([...f.getRows(), { ...app, pid: 701, ppid: 1, args: '/fixture/helper' }]);
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('a new process naming the exact root prevents final lock release', async t => {
  const f = world(t), native = f.deps.native;
  f.deps.native = async request => { const result = await native(request); if (request.mode === 'quit') f.setRows([...f.getRows(), {
    pid: 801, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: `/unknown ${f.root}` }]); return result; };
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(existsSync(f.lock), true);
});

test('an unrelated interpreter child of the host does not become cleanup authority', async t => {
  const f = world(t), host = f.getRows().find(row => row.pid === 601);
  f.setRows([...f.getRows(), { ...host, pid: 701, ppid: 601, args: `${process.execPath} unrelated.mjs` }]);
  f.replaceBirth(701, f.plan.fixture.birth);
  const result = await f.run();
  assert.equal(result.error, 'RECOVERY_INFRA_EXECUTABLE_UNPROVED');
  assert.equal(f.events.includes('quit'), false);
});

test('owner mutation after Quit prevents infrastructure signals and lock release', async t => {
  const f = world(t), native = f.deps.native;
  f.deps.native = async request => { const result = await native(request); if (request.mode === 'quit')
    writeFileSync(join(f.base, 'state', 'ownership.json'), 'changed'); return result; };
  const result = await f.run();
  assert.equal(result.error, 'RECOVERY_OWNER_CHANGED');
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('a host child created during Quit without root argv prevents infrastructure signals and lock release', async t => {
  const f = world(t), native = f.deps.native;
  f.deps.native = async request => { const result = await native(request); if (request.mode === 'quit') {
    f.setRows([...f.getRows(), { pid: 701, ppid: 601, uid: process.getuid(), startedAtMs: 1, args: `${process.execPath} unknown-child.mjs` }]);
    f.replaceBirth(701, f.plan.fixture.birth);
  } return result; };
  const result = await f.run();
  assert.equal(result.confirmed, false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
  assert.ok(result.unprovedDescendants.some(row => row.pid === 701));
});

test('private plan, journal and state modes are pinned before Quit and infrastructure control', async t => {
  for (const target of ['plan', 'journal', 'state']) for (const afterQuit of [false, true]) {
    const f = world(t), path = target === 'plan' ? f.planPath : join(f.base, 'state', ...(target === 'journal' ? ['ownership.json'] : []));
    const tamper = () => chmodSync(path, target === 'state' ? 0o755 : 0o644);
    if (afterQuit) { const native = f.deps.native; f.deps.native = async request => { const result = await native(request); if (request.mode === 'quit') tamper(); return result; }; }
    else { const list = f.deps.list; let scans = 0; f.deps.list = async () => { if (++scans === 2) tamper(); return list(); }; }
    const result = await f.run();
    assert.equal(result.confirmed, false, `${target}/${afterQuit}`);
    assert.equal(f.events.some(event => event.startsWith('signal:')), false);
    if (!afterQuit) assert.equal(f.events.includes('quit'), false);
    assert.equal(existsSync(f.lock), true);
  }
});

test('closed diagnostics identify denied commit, census and native boundaries without raw details', async t => {
  for (const [dependency, stage, error] of [
    ['readCommit', 'source-commit', Object.assign(Error('private-owner-content'), { code: 'EACCES', stderr: 'secret path' })],
    ['list', 'process-census', Object.assign(Error('private-owner-content'), { code: 1, stderr: 'Operation not permitted: secret path' })],
    ['native', 'native-births', Object.assign(Error('private-owner-content'), { code: 'EPERM', stderr: 'secret path' })],
  ]) {
    const f = world(t); f.deps[dependency] = async () => { throw error; };
    const result = await f.run({ run: false });
    assert.equal(result.failure.stage, stage);
    assert.equal(result.failure.reason, 'permission-denied');
    if (typeof error.code === 'number') assert.equal(result.failure.childExitCode, error.code);
    else assert.equal(result.failure.errno, error.code);
    assert.equal(JSON.stringify(result).includes('private-owner-content'), false);
    assert.equal(JSON.stringify(result).includes('secret path'), false);
    assert.equal(f.events.includes('quit'), false);
  }
});

test('unsupported keeper refusal reports only bounded PID/PPID and fixed vector classification', async t => {
  const f = world(t), host = f.getRows().find(row => row.pid === 601);
  f.setRows([...f.getRows(), { ...host, pid: 701, ppid: 601,
    args: `/fixture/python3 -I -B ${f.source}/plugins/sleight/lib/direct-browser/electron/launch.py --keeper --socket ${f.base}/state/private-keeper.sock` }]);
  f.replaceBirth(701, f.plan.fixture.birth);
  const result = await f.run({ run: false });
  assert.deepEqual(result.failure.infrastructure, [{ pid: 701, ppid: 601, reason: 'keeper-vector-unsupported' }]);
  assert.equal(JSON.stringify(result).includes('private-keeper.sock'), false);
  assert.equal(f.events.includes('quit'), false);
});

test('a trampoline interpreter adapter needs the exact probed image, host parent and full birth', async t => {
  for (const valid of [true, false]) {
    const f = world(t), host = f.getRows().find(row => row.pid === 601);
    f.deps.pythonImage = '/fixture/Python.app/Contents/MacOS/Python';
    f.setRows([...f.getRows(), { ...host, pid: 701, ppid: valid ? 601 : 1,
      args: `${f.deps.pythonImage} -I -B ${f.source}/plugins/sleight/lib/direct-browser/electron/launch.py --adapter --registry ${f.base}/recipes.json --temp-root ${f.base}/profiles` }]);
    f.replaceBirth(701, f.plan.fixture.birth);
    const result = await f.run();
    assert.equal(result.confirmed, valid, JSON.stringify(result));
    assert.equal(f.events.includes('signal:701:SIGTERM'), valid);
    if (!valid) assert.equal(f.events.includes('quit'), false);
  }
});

test('a reparented crashpad with the exact profile path is app closure-only and never signalled', async t => {
  for (const stuck of [false, true]) {
    const f = world(t), app = f.getRows().find(row => row.pid === 501), native = f.deps.native;
    f.setRows([...f.getRows(), { ...app, pid: 801, ppid: 1,
      args: `/fixture/Code.app/Contents/Frameworks/Electron.framework/Helpers/chrome_crashpad_handler --database=${f.profile}/user-data/Crashpad` }]);
    f.replaceBirth(801, f.plan.fixture.birth);
    f.deps.native = async request => { const result = await native(request);
      if (request.mode === 'quit' && !stuck) f.setRows(f.getRows().filter(row => row.pid !== 801)); return result; };
    const result = await f.run();
    assert.equal(result.confirmed, !stuck, JSON.stringify(result));
    assert.equal(f.events.some(event => event.startsWith('signal:801:')), false);
    if (stuck) { assert.equal(f.events.some(event => event.startsWith('signal:')), false); assert.equal(existsSync(f.lock), true); }
  }
});

function pythonProbeWorld({ inspectFails = false, wrongPid = false, malformed = false, wrongHandshake = false, unsafeImage = false, probeExited = false } = {}) {
  const events = [], child = new EventEmitter(); child.pid = 901;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.once('finish', () => { events.push('stdin-close'); queueMicrotask(() => { events.push('collected'); child.emit('close', 0, null); }); });
  child.kill = () => assert.fail('healthy bounded probe exits through stdin EOF');
  const deps = { spawnProcess: (command, args, options) => {
    assert.equal(command, '/fixture/python3'); assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']);
    assert.equal(args[3].includes('ctypes'), false); assert.equal(args[3].includes('os.getpid()'), true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    queueMicrotask(() => child.stdout.write(JSON.stringify({ kind: 'sleight-python-image-probe', pid: wrongHandshake ? 902 : 901 }) + '\n'));
    return child;
  }, inspect: async (command, args) => {
    events.push('inspect'); assert.ok(command.endsWith('/.codex/bin/codex-macos-inspect'));
    assert.deepEqual(args, ['process-status', '901']);
    if (probeExited) child.emit('exit', 0, null);
    if (inspectFails) throw Object.assign(Error('private diagnostic'), { code: 'EPERM' });
    return { stdout: malformed ? 'not json' : JSON.stringify([{ pid: wrongPid ? 902 : 901, executable: '/fixture/Python.app/Contents/MacOS/Python', state: 'S' }]) };
  }, realpath: path => path, stat: () => ({ isFile: () => true, isSymbolicLink: () => unsafeImage, mode: 0o755 }) };
  return { deps, events };
}

test('the owned Python probe uses only the fixed inspector on its exact PID and collects through stdin EOF', async () => {
  assert.equal(typeof api.resolveRecoveryPythonImage, 'function');
  const f = pythonProbeWorld(), image = await api.resolveRecoveryPythonImage('/fixture/python3', f.deps);
  assert.equal(image, '/fixture/Python.app/Contents/MacOS/Python');
  assert.deepEqual(f.events, ['inspect', 'stdin-close', 'collected']);
});

test('Python probe refusal still closes and collects its child without exposing private text', async () => {
  assert.equal(typeof api.resolveRecoveryPythonImage, 'function');
  for (const options of [{ inspectFails: true }, { wrongPid: true }, { malformed: true }, { wrongHandshake: true }, { unsafeImage: true }, { probeExited: true }]) {
    const f = pythonProbeWorld(options);
    await assert.rejects(api.resolveRecoveryPythonImage('/fixture/python3', f.deps), error => {
      assert.equal(error.message.startsWith('RECOVERY_'), true);
      assert.equal(error.probe.collected, true);
      return true;
    });
    assert.deepEqual(f.events, [...(options.wrongHandshake ? [] : ['inspect']), 'stdin-close', 'collected']);
  }
});

function collectedWorld(t) {
  const f = world(t), bank = join(f.planPath, '..'), priorPath = join(bank, 'interrupted-recovery-original.json');
  const prior = { version: 1, kind: 'electron-interrupted-recovery', interrupted: true, ready: true, confirmed: false,
    lockReleased: false, keepLock: true, receipt: priorPath, appExited: true, error: 'RECOVERY_OWNER_CHANGED',
    failure: { stage: 'owner-recheck', reason: 'boundary-failed' }, actions: [{ action: 'normal-quit', pid: 501 }],
    hostBirthProof: { originalBirthRecorded: false, derivedBirth: f.plan.fixture.birth.replace(/\d+\./, value => `${Number(value.slice(0, -1)) - 1}.`),
      lowerBoundMs: Math.max(statSync(f.root).birthtimeMs, statSync(f.lock).birthtimeMs), upperBoundMs: Number(f.plan.fixture.birth) * 1000 } };
  writeFileSync(priorPath, JSON.stringify(prior), { mode: 0o600 });
  const at = Math.max(Math.ceil(statSync(priorPath).birthtimeMs) + 1, Date.parse(f.plan.at) + 1);
  const journal = { record: { state: 'none', hostId: 'A'.repeat(22), hostPid: 601, at }, sealed: 'opaque-not-accessed' };
  writeFileSync(join(f.base, 'state', 'ownership.json'), JSON.stringify(journal), { mode: 0o600 });
  utimesSync(priorPath, new Date(at + 1), new Date(at + 1));
  rmSync(f.profile, { recursive: true }); f.setRows(f.getRows().filter(row => row.pid !== 501));
  const continuationPath = join(bank, 'continuation.json');
  // The fake run clock is ahead of filesystem wall time. Model the operator's later file creation separately.
  f.deps.continuationBirthTime = () => at + 10;
  const continuation = { version: 1, kind: 'electron-post-collection-continuation',
    originalPlan: { path: f.planPath, sha256: hash(readFileSync(f.planPath)) }, priorReceipt: { path: priorPath, sha256: hash(readFileSync(priorPath)) } };
  const rewriteContinuation = () => writeFileSync(continuationPath, JSON.stringify(continuation), { mode: 0o600 });
  rewriteContinuation();
  return { ...f, prior, priorPath, continuation, continuationPath, journal,
    rewriteContinuation,
    rewritePrior() { writeFileSync(priorPath, JSON.stringify(prior)); utimesSync(priorPath, new Date(at + 1), new Date(at + 1));
      continuation.priorReceipt.sha256 = hash(readFileSync(priorPath)); rewriteContinuation(); },
    rewriteJournal() { writeFileSync(join(f.base, 'state', 'ownership.json'), JSON.stringify(journal)); },
    resume: (options = {}) => f.run({ continuationPath, ...options }) };
}

test('explicit post-collection continuation binds original plan and Quit receipt, proves absence and cleans only infrastructure', async t => {
  const f = collectedWorld(t), originalPlan = readFileSync(f.planPath), originalPrior = readFileSync(f.priorPath);
  const result = await f.resume();
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.equal(result.phase, 'post-collection');
  assert.equal(result.originalPlanSHA256, hash(originalPlan));
  assert.equal(result.priorReceiptSHA256, hash(originalPrior));
  assert.equal(result.continuationSHA256, hash(readFileSync(f.continuationPath)));
  assert.equal(f.events.includes('quit'), false);
  assert.deepEqual(result.actions, [{ action: 'SIGTERM', pid: 601 }]);
  assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(f.planPath).equals(originalPlan), true);
  assert.equal(readFileSync(f.priorPath).equals(originalPrior), true);
});

test('original recovery mode still refuses a collected profile instead of refreshing its owner proof', async t => {
  const f = collectedWorld(t), result = await f.run();
  assert.equal(result.confirmed, false); assert.equal(f.events.includes('quit'), false);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false); assert.equal(existsSync(f.lock), true);
});

test('post-collection rejects wrong continuation hashes, prior Quit action, host birth and journal state/time/shape', async t => {
  for (const [change, expected] of [
    [f => { f.continuation.originalPlan.sha256 = 'b'.repeat(64); f.rewriteContinuation(); }, 'RECOVERY_CONTINUATION_INVALID'],
    [f => { f.continuation.priorReceipt.sha256 = 'b'.repeat(64); f.rewriteContinuation(); }, 'RECOVERY_CONTINUATION_INVALID'],
    [f => { f.prior.actions[0].pid++; f.rewritePrior(); }, 'RECOVERY_PRIOR_RECEIPT_INVALID'],
    [f => { f.prior.hostBirthProof.derivedBirth = '9999999999.000001'; f.rewritePrior(); }, 'RECOVERY_HOST_IDENTITY_UNPROVED'],
    [f => { f.journal.record.state = 'running'; f.rewriteJournal(); }, 'RECOVERY_COLLECTION_UNPROVED'],
    [f => { f.journal.record.hostPid++; f.rewriteJournal(); }, 'RECOVERY_COLLECTION_UNPROVED'],
    [f => { f.journal.record.at += 99999; f.rewriteJournal(); }, 'RECOVERY_COLLECTION_UNPROVED'],
    [f => { f.journal.record.nonce = 'private-not-to-emit'; f.rewriteJournal(); }, 'RECOVERY_COLLECTION_UNPROVED'],
    [f => { f.continuation.extra = true; f.rewriteContinuation(); }, 'RECOVERY_CONTINUATION_INVALID'],
  ]) {
    const f = collectedWorld(t); change(f); const result = await f.resume();
    assert.equal(result.confirmed, false, JSON.stringify(result));
    assert.equal(result.error, expected);
    assert.equal(f.events.includes('quit'), false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
    assert.equal(existsSync(f.lock), true); assert.equal(JSON.stringify(result).includes('private-not-to-emit'), false);
  }
});

test('a reappearing app or exact profile refuses post-collection control', async t => {
  for (const app of [false, true]) {
    const f = collectedWorld(t);
    if (app) f.setRows([...f.getRows(), { pid: 501, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: '/fixture/reappeared' }]);
    else mkdirSync(f.profile);
    const result = await f.resume();
    assert.equal(result.confirmed, false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
    assert.equal(existsSync(f.lock), true);
  }
});

test('post-collection inspection never controls or releases and later evidence mutation blocks signals', async t => {
  const f = collectedWorld(t), inspected = await f.resume({ run: false });
  assert.equal(inspected.ready, true, JSON.stringify(inspected)); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  const list = f.deps.list; let scans = 0;
  f.deps.list = async () => { if (++scans === 2) { f.journal.record.at++; f.rewriteJournal(); } return list(); };
  const result = await f.resume();
  assert.equal(result.confirmed, false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('continuation and prior receipt permissions/timestamps stay pinned before control', async t => {
  for (const change of [f => chmodSync(f.continuationPath, 0o644), f => chmodSync(f.priorPath, 0o644),
    f => utimesSync(f.priorPath, new Date(), new Date())]) {
    const f = collectedWorld(t), list = f.deps.list; let changed = false;
    f.deps.list = async () => { if (!changed) { change(f); changed = true; } return list(); };
    const result = await f.resume();
    assert.equal(result.confirmed, false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
    assert.equal(existsSync(f.lock), true);
  }
});

test('post-collection rechecks app absence before final release and refuses late infrastructure descendants', async t => {
  for (const lateApp of [false, true]) {
    const f = collectedWorld(t);
    if (lateApp) { const signal = f.deps.signal;
      f.deps.signal = (pid, kind) => { signal(pid, kind); f.setRows([...f.getRows(), { pid: 501, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: '/fixture/reappeared' }]); };
    } else { const list = f.deps.list; let scans = 0;
      f.deps.list = async () => { if (++scans === 4) { f.setRows([...f.getRows(), { pid: 701, ppid: 601, uid: process.getuid(), startedAtMs: 1, args: '/fixture/late-child' }]); f.replaceBirth(701, f.plan.fixture.birth); } return list(); };
    }
    const result = await f.resume();
    assert.equal(result.confirmed, false); assert.equal(existsSync(f.lock), true);
    if (!lateApp) assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  }
});

test('the CLI propagates the explicit continuation flag through read-only inspection', async t => {
  const f = collectedWorld(t), log = console.log; let result;
  console.log = () => {};
  try { result = await api.main(['--plan', f.planPath, '--source-worktree', f.source, '--continuation', f.continuationPath], f.deps); }
  finally { console.log = log; }
  assert.equal(result, 0); assert.equal(existsSync(f.lock), true);
  assert.equal(f.events.includes('quit'), false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
});

test('delayed collection publication may follow the Quit receipt but must precede continuation creation', async t => {
  for (const afterContinuation of [false, true]) {
    const f = collectedWorld(t);
    f.journal.record.at = afterContinuation ? f.deps.continuationBirthTime() + 1 : Math.ceil(statSync(f.priorPath).mtimeMs) + 5;
    f.rewriteJournal(); const result = await f.resume({ run: false });
    assert.equal(result.ready, !afterContinuation, JSON.stringify(result));
    if (afterContinuation) assert.equal(result.error, 'RECOVERY_COLLECTION_UNPROVED');
    assert.equal(f.events.some(event => event.startsWith('signal:')), false); assert.equal(existsSync(f.lock), true);
  }
});

test('continuation creation time remains pinned until infrastructure control', async t => {
  const f = collectedWorld(t), born = f.deps.continuationBirthTime(), list = f.deps.list; let changed = false;
  f.deps.list = async () => { if (!changed) { f.deps.continuationBirthTime = () => born + 1; changed = true; } return list(); };
  const result = await f.resume();
  assert.equal(result.confirmed, false); assert.equal(f.events.some(event => event.startsWith('signal:')), false);
  assert.equal(existsSync(f.lock), true);
});

test('post-collection host self-exit permits only exact lock release with prior proof and zero signals/probes', async t => {
  const f = collectedWorld(t); f.setRows([]);
  Object.defineProperty(f.deps, 'python', { get() { assert.fail('release-only continuation must not resolve or launch Python'); } });
  Object.defineProperty(f.deps, 'pythonImage', { get() { assert.fail('release-only continuation must not probe Python'); } });
  const result = await f.resume();
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.equal(result.closureOnly, true); assert.equal(result.lockReleased, true);
  assert.deepEqual(result.actions, []); assert.equal(existsSync(f.lock), false);
  assert.deepEqual(result.hostBirthProof, f.prior.hostBirthProof);
  assert.deepEqual(result.hostAbsenceProof, { censusAbsent: true, nativeBirth: null, descendantsAbsent: true });
  assert.equal(f.events.every(event => event === 'births'), true);
});

test('absent-host continuation refuses any remaining adapter, root-bound process or host descendant', async t => {
  for (const kind of ['adapter', 'root', 'descendant']) {
    const f = collectedWorld(t), host = f.getRows()[0];
    f.setRows([{ ...host, pid: 701, ppid: kind === 'root' ? 1 : 601,
      args: kind === 'adapter' ? `/fixture/python3 -I -B ${f.source}/plugins/sleight/lib/direct-browser/electron/launch.py --adapter --registry ${f.base}/recipes.json --temp-root ${f.base}/profiles`
        : kind === 'root' ? `/fixture/unknown ${f.root}` : '/fixture/unknown-child' }]);
    f.replaceBirth(701, f.plan.fixture.birth);
    const result = await f.resume();
    assert.equal(result.confirmed, false); assert.equal(result.error, 'RECOVERY_INFRA_REMAIN_WITHOUT_HOST');
    assert.equal(f.events.some(event => event.startsWith('signal:')), false); assert.equal(existsSync(f.lock), true);
  }
});

test('absent host census with a native birth is incoherent and cannot release the lock', async t => {
  const f = collectedWorld(t), native = f.deps.native; f.setRows([]);
  f.deps.native = async request => { const result = await native(request);
    if (request.mode === 'births') for (const row of result.processes) if (row.pid === 601) row.pidBirth = f.prior.hostBirthProof.derivedBirth;
    return result; };
  const result = await f.resume();
  assert.equal(result.confirmed, false); assert.equal(existsSync(f.lock), true);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
});

test('release-only continuation repeats absence and detects a new child before final lock release', async t => {
  const f = collectedWorld(t), list = f.deps.list; f.setRows([]); let scans = 0;
  f.deps.list = async () => { if (++scans === 4) { f.setRows([{ pid: 701, ppid: 601, uid: process.getuid(), startedAtMs: 1, args: '/fixture/new-child' }]); f.replaceBirth(701, f.plan.fixture.birth); } return list(); };
  const result = await f.resume();
  assert.equal(result.confirmed, false); assert.equal(existsSync(f.lock), true);
  assert.equal(f.events.some(event => event.startsWith('signal:')), false);
});

test('a release-only child observed initially remains a refusal after reparenting outside the next census tree', async t => {
  for (const seenAt of [1, 2]) {
    const f = collectedWorld(t), list = f.deps.list; let scans = 0; f.setRows([]);
    f.replaceBirth(701, f.plan.fixture.birth);
    f.deps.list = async () => { if (++scans === seenAt) f.setRows([{ pid: 701, ppid: 601, uid: process.getuid(), startedAtMs: 1, args: '/fixture/original-child' }]);
      const rows = await list(); if (scans === seenAt) f.setRows(rows.map(row => ({ ...row, ppid: 1 }))); return rows; };
    const result = await f.resume();
    assert.equal(result.confirmed, false, JSON.stringify(result));
    assert.equal(result.error, 'RECOVERY_INFRA_REMAIN_WITHOUT_HOST');
    assert.deepEqual(result.actions, []); assert.equal(existsSync(f.lock), true);
  }
});

test('host accepted argv preserves the exact ensureHost producer order', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/electron-admin.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("[script, '--state-dir', stateDir, '--registry', registryPath, '--temp-root', tempRoot, '--builds', builds.join(','), '--admin-fd', '3', '--startup-fd', '4'"));
});

function nativeSource() {
  const output = [], dollar = text => ({ dataUsingEncoding: () => text });
  dollar.NSFileHandle = { fileHandleWithStandardOutput: { writeData: text => output.push(text) } };
  const sandbox = { ObjC: { import() {}, bindFunction() {} }, $: dollar, console };
  runInNewContext(readFileSync(new URL('../bench/real-electron.js', import.meta.url), 'utf8'), sandbox);
  return { sandbox, output };
}

test('native recovery mode reads births only for bounded explicit PIDs', () => {
  const { sandbox, output } = nativeSource(), asked = [];
  sandbox.processBirth = pid => { asked.push(pid); return pid === 501 ? '1234.000001' : null; };
  sandbox.run([JSON.stringify({ mode: 'births', bundle: 'com.microsoft.VSCode', pids: [501, 601] })]);
  assert.deepEqual(asked, [501, 601]);
  assert.deepEqual(JSON.parse(output[0]), { stage: 'births', processes: [{ pid: 501, pidBirth: '1234.000001' }, { pid: 601, pidBirth: null }] });
  for (const pids of [[], [501, 501], [-1], Array(65).fill(501)]) assert.throws(() => sandbox.run([JSON.stringify({ mode: 'births', bundle: 'com.microsoft.VSCode', pids })]));
});

test('recovery normal Quit refuses force termination after its deadline', () => {
  const { sandbox } = nativeSource(); let time = 0, forced = false;
  const target = { pid: 501, bundle: 'com.microsoft.VSCode', path: '/fixture/Code.app', pidBirth: '1234.000001',
    terminate: () => true, forceTerminate: () => { forced = true; } };
  assert.throws(() => sandbox.quitElectron({ pid: 501, bundle: target.bundle, appPath: target.path, pidBirth: target.pidBirth,
    waitMs: 100, allowForce: false }, { running: () => target, dontSave: () => [] },
  { now: () => time, wait: ms => { time += ms; }, emit() {} }), /FIXTURE_NORMAL_QUIT_UNCONFIRMED/);
  assert.equal(forced, false);
});
