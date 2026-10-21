// Recovery only: no launch, worker, host authentication, or ownership-record mutation.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { APPS, LOCK, scrubReceipt } from './electron-qualification.mjs';
import { fixtureHelper, listProcesses } from './electron-qualification-live.mjs';
import { resolveRunPython } from './electron-run-cleanup.mjs';

const execute = promisify(execFile), uid = process.getuid();
const fail = code => { throw Error(code); };
const birthPattern = /^[1-9]\d*\.\d{6}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const contained = (path, root) => typeof path === 'string' && path.startsWith(root + '/') && realpathSync(path) === path;
function owned(path, directory = false, privateMode = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== uid || realpathSync(path) !== path
    || (directory ? !stat.isDirectory() : !stat.isFile()) || privateMode && (stat.mode & 0o077)) fail('RECOVERY_PATH_UNSAFE');
  return stat;
}
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
function requireAbsent(path) {
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('RECOVERY_PROFILE_REAPPEARED');
}
function hasReleaseInfrastructure(rows, plan) {
  const descendants = new Set([plan.fixture.hostPid, plan.fixture.pid, ...plan.fixture.observed.map(pair => pair[0])]);
  for (let changed = true; changed;) { changed = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
  }
  return rows.some(row => descendants.has(row.pid)
    || row.args.split(/[\s"'=,:{}]+/).some(token => token === plan.runRoot || token.startsWith(plan.runRoot + '/')));
}
const errnoNames = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'ETIMEDOUT', 'ENOSPC', 'EROFS']);
function closedFailure(error, stage) {
  const errno = errnoNames.has(error?.code) ? error.code : null;
  const childExitCode = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null;
  const denied = errno === 'EACCES' || errno === 'EPERM' || /permission denied|operation not permitted/i.test(String(error?.stderr ?? ''));
  return { stage, reason: denied ? 'permission-denied' : 'boundary-failed', ...(errno ? { errno } : {}),
    ...(childExitCode !== null ? { childExitCode } : {}),
    ...(positive(error?.probe?.pid) ? { probe: { pid: error.probe.pid, collected: error.probe.collected === true } } : {}) };
}

const PYTHON_IMAGE_PROBE = `import json, os, select, sys
print(json.dumps({'kind': 'sleight-python-image-probe', 'pid': os.getpid()}), flush=True)
if select.select([sys.stdin], [], [], 20)[0]:
    sys.stdin.buffer.read(1)
`;
// The configured interpreter may be a macOS trampoline. Inspect only this newly owned, waiting probe.
export async function resolveRecoveryPythonImage(python, { spawnProcess = spawn, inspect = execute,
  realpath = realpathSync, stat = lstatSync } = {}) {
  const bounded = async (work, ms) => {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('RECOVERY_PYTHON_PROBE_TIMEOUT')), ms); })]); }
    finally { clearTimeout(timer); }
  };
  let child, collected = false, leaderExited = false, image, error, text = '', exit, closed;
  try {
    if (typeof python !== 'string' || !python.startsWith('/') || /[\0\r\n]/.test(python) || realpath(python) !== python) fail('RECOVERY_PYTHON_IMAGE_UNAVAILABLE');
    child = spawnProcess(python, ['-I', '-B', '-c', PYTHON_IMAGE_PROBE], { cwd: '/',
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = new Promise(resolve => child.once('close', (code, signal) => { collected = true; exit = { code, signal }; resolve(exit); }));
    child.once('exit', () => { leaderExited = true; });
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', data => {
        text += data;
        if (text.length > 256) reject(Error('RECOVERY_PYTHON_PROBE_INVALID'));
        if (text.includes('\n')) {
          try {
            const value = JSON.parse(text.trim());
            if (!positive(child.pid) || value.pid !== child.pid || value.kind !== 'sleight-python-image-probe'
              || Object.keys(value).sort().join() !== 'kind,pid') fail('RECOVERY_PYTHON_PROBE_INVALID');
            resolve();
          } catch { reject(Error('RECOVERY_PYTHON_PROBE_INVALID')); }
        }
      });
      child.once('close', () => reject(Error('RECOVERY_PYTHON_PROBE_EXITED')));
    });
    await bounded(ready, 5000);
    if (leaderExited || collected) fail('RECOVERY_PYTHON_PROBE_EXITED');
    const result = await inspect(join(homedir(), '.codex/bin/codex-macos-inspect'), ['process-status', String(child.pid)],
      { timeout: 10_000, maxBuffer: 16384, cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: homedir() } });
    if (leaderExited || collected) fail('RECOVERY_PYTHON_PROBE_EXITED');
    const rows = JSON.parse(String(result.stdout));
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].pid !== child.pid || typeof rows[0].executable !== 'string'
      || typeof rows[0].state !== 'string' || rows[0].state.includes('Z')) fail('RECOVERY_PYTHON_IMAGE_UNAVAILABLE');
    image = rows[0].executable;
    if (!image.startsWith('/') || /[\0\r\n]/.test(image) || realpath(image) !== image) fail('RECOVERY_PYTHON_IMAGE_UNAVAILABLE');
    const metadata = stat(image);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !(metadata.mode & 0o111)) fail('RECOVERY_PYTHON_IMAGE_UNAVAILABLE');
  } catch (caught) { error = caught; }
  finally {
    if (child) {
      try { child.stdin.end(); } catch {}
      for (const kind of [null, 'SIGTERM', 'SIGKILL']) {
        if (collected) break;
        if (kind) try { child.kill(kind); } catch {} // only this helper's uncollected child handle
        try { exit = await bounded(closed, 2000); break; } catch {}
      }
      if (!collected) error = Error('RECOVERY_PYTHON_PROBE_UNCOLLECTED');
      else if (!error) {
        try {
          const value = JSON.parse(text.trim());
          if (exit?.code !== 0 || value.kind !== 'sleight-python-image-probe' || value.pid !== child.pid
            || Object.keys(value).sort().join() !== 'kind,pid') fail('RECOVERY_PYTHON_PROBE_INVALID');
        } catch { error = Error('RECOVERY_PYTHON_PROBE_INVALID'); }
      }
    }
  }
  if (error) {
    const failure = Object.assign(Error(/^RECOVERY_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'RECOVERY_PYTHON_IMAGE_UNAVAILABLE'),
      { code: error.code, stderr: error.stderr, ...(child ? { probe: { pid: child.pid, collected } } : {}) });
    throw failure;
  }
  return image;
}

export async function recoverElectronRun({ planPath, continuationPath, sourceRoot = fileURLToPath(new URL('..', import.meta.url)), run = false }, deps = {}) {
  const receipt = { version: 1, kind: 'electron-interrupted-recovery', interrupted: true, ready: false,
    confirmed: false, lockReleased: false, keepLock: true, actions: [] };
  let stage = 'plan-validation';
  const boundary = async (name, work) => {
    const previous = stage; stage = name;
    const value = await work(); stage = previous; return value;
  };
  const list = async () => {
    const rows = await boundary('process-census', deps.list ?? listProcesses);
    if (continuationPath && plan && hasReleaseInfrastructure(rows, plan)) observedReleaseInfrastructure = true;
    return rows;
  };
  const nativeHelper = deps.native ?? fixtureHelper(APPS.vscode.bundleId);
  const native = request => boundary(`native-${request.mode}`, () => nativeHelper(request));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const signal = deps.signal ?? process.kill, now = deps.now ?? Date.now;
  const began = now(), deadline = began + 120_000;
  let fd, plan, pinnedLock, rootStat, planStat, lockPath, infrastructureRefusals, prior, priorPath, priorStat, priorHash, continuationHash, continuationStat, continuationBorn;
  let observedReleaseInfrastructure = false;
  const continuationBirthTime = path => deps.continuationBirthTime ? deps.continuationBirthTime(path) : lstatSync(path).birthtimeMs;
  const save = () => {
    if (fd === undefined) return;
    const text = JSON.stringify(receipt, null, 2) + '\n';
    writeSync(fd, text, 0, 'utf8'); ftruncateSync(fd, Buffer.byteLength(text));
  };
  const checkDeadline = () => { if (now() >= deadline) fail('RECOVERY_DEADLINE'); };
  try {
    planPath = resolve(planPath); planStat = owned(planPath, false, true);
    if (planStat.size > 65536) fail('RECOVERY_PLAN_INVALID');
    const planBytes = readFileSync(planPath), planHash = createHash('sha256').update(planBytes).digest('hex');
    plan = JSON.parse(planBytes.toString('utf8'));
    const { runRoot: root, base, fixture } = plan;
    if (!/^elr-[A-Za-z0-9_-]+$/.test(basename(root ?? '')) || !contained(base, root)
      || !/^seq-[A-Za-z0-9_-]+$/.test(basename(dirname(base))) || !/^vscode-[A-Za-z0-9_-]+$/.test(basename(base))
      || !(continuationPath ? typeof fixture?.profile === 'string' && fixture.profile === join(base, 'profiles', basename(fixture.profile))
        : contained(fixture?.profile, join(base, 'profiles'))) || !/^sleight-ep2-[A-Za-z0-9_-]+$/.test(basename(fixture.profile))
      || !positive(fixture.pid) || !positive(fixture.hostPid) || !birthPattern.test(fixture.birth)
      || !Array.isArray(fixture.observed) || fixture.observed.length > 64 || fixture.observed.some(pair => !Array.isArray(pair)
        || pair.length !== 2 || !positive(pair[0]) || !birthPattern.test(pair[1]))
      || new Set(fixture.observed.map(pair => pair[0])).size !== fixture.observed.length
      || !/^[a-f0-9]{40}$/.test(plan.buildCommit ?? '') || !/^[a-f0-9]{64}$/.test(plan.ownershipSHA256 ?? '')
      || !Number.isFinite(Date.parse(plan.at)) || Date.parse(plan.at) > now()) fail('RECOVERY_PLAN_INVALID');
    rootStat = owned(root, true, true); owned(dirname(base), true); owned(base, true); owned(join(base, 'profiles'), true);
    if (continuationPath) {
      stage = 'continuation-validation';
      continuationPath = resolve(continuationPath); owned(dirname(planPath), true, true);
      continuationStat = owned(continuationPath, false, true);
      continuationBorn = continuationBirthTime(continuationPath);
      if (dirname(continuationPath) !== dirname(planPath) || continuationPath === planPath || continuationStat.size > 65536) fail('RECOVERY_CONTINUATION_INVALID');
      const bytes = readFileSync(continuationPath); continuationHash = createHash('sha256').update(bytes).digest('hex');
      const continuation = JSON.parse(bytes.toString('utf8'));
      if (!keysAre(continuation, ['version', 'kind', 'originalPlan', 'priorReceipt']) || continuation.version !== 1
        || continuation.kind !== 'electron-post-collection-continuation' || !keysAre(continuation.originalPlan, ['path', 'sha256'])
        || !keysAre(continuation.priorReceipt, ['path', 'sha256']) || continuation.originalPlan.path !== planPath
        || continuation.originalPlan.sha256 !== planHash || !/^[a-f0-9]{64}$/.test(continuation.priorReceipt.sha256 ?? '')
        || typeof continuation.priorReceipt.path !== 'string') fail('RECOVERY_CONTINUATION_INVALID');
      priorPath = continuation.priorReceipt.path;
      priorStat = owned(priorPath, false, true);
      if (dirname(priorPath) !== dirname(planPath) || [planPath, continuationPath].includes(priorPath) || priorStat.size > 65536
        || priorStat.mtimeMs > now() || !Number.isFinite(continuationBorn) || continuationBorn < priorStat.birthtimeMs
        || continuationBorn > now()) fail('RECOVERY_CONTINUATION_INVALID');
      priorHash = hashFile(priorPath);
      if (priorHash !== continuation.priorReceipt.sha256) fail('RECOVERY_CONTINUATION_INVALID');
      prior = JSON.parse(readFileSync(priorPath, 'utf8'));
      if (prior.version !== 1 || prior.kind !== 'electron-interrupted-recovery' || prior.receipt !== priorPath
        || prior.interrupted !== true || prior.ready !== true || prior.appExited !== true || prior.confirmed !== false
        || prior.keepLock !== true || prior.lockReleased !== false || prior.error !== 'RECOVERY_OWNER_CHANGED'
        || prior.failure?.stage !== 'owner-recheck' || !Array.isArray(prior.actions) || prior.actions.length !== 1
        || !keysAre(prior.actions[0], ['action', 'pid']) || prior.actions[0].action !== 'normal-quit' || prior.actions[0].pid !== fixture.pid
        || prior.hostBirthProof?.originalBirthRecorded !== false || !birthPattern.test(prior.hostBirthProof?.derivedBirth ?? '')
        || !Number.isFinite(prior.hostBirthProof?.lowerBoundMs) || prior.hostBirthProof?.upperBoundMs !== Number(fixture.birth) * 1000)
        fail('RECOVERY_PRIOR_RECEIPT_INVALID');
      requireAbsent(fixture.profile); requireAbsent(join(fixture.profile, 'OWNER.json'));
      Object.assign(receipt, { phase: 'post-collection', originalPlanSHA256: planHash, priorReceiptSHA256: priorHash,
        continuationSHA256: continuationHash, continuationCreatedAtMs: continuationBorn,
        bindingLimitation: 'legacy-quit-receipt-has-no-plan-hash; operator-continuation-pins-both' });
    } else { owned(fixture.profile, true); owned(join(fixture.profile, 'OWNER.json')); }
    owned(join(base, 'state'), true, true);
    if (run) {
      receipt.receipt = join(dirname(planPath), `interrupted-recovery-${randomUUID()}.json`);
      fd = openSync(receipt.receipt, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      save();
    }
    const journal = join(base, 'state', 'ownership.json'); owned(journal, false, true);
    // Initial mode compares opaque bytes only. Continuation projects only the closed post-collection record.
    const journalHash = hashFile(journal);
    if (!prior && journalHash !== plan.ownershipSHA256) fail('RECOVERY_OWNER_CHANGED');
    if (prior) {
      stage = 'post-collection-journal';
      if (lstatSync(journal).size > 65536 || journalHash === plan.ownershipSHA256) fail('RECOVERY_COLLECTION_UNPROVED');
      const envelope = JSON.parse(readFileSync(journal, 'utf8')), record = envelope?.record;
      // Never access sealed/nonce values or host.key. This supports the external receipt/kernel proofs, not seal authentication.
      if (!keysAre(envelope, ['record', 'sealed']) || !keysAre(record, ['state', 'hostId', 'hostPid', 'at'])
        || record.state !== 'none' || record.hostPid !== fixture.hostPid || typeof record.hostId !== 'string'
        || !/^[A-Za-z0-9_-]{22}$/.test(record.hostId) || !Number.isSafeInteger(record.at)
        || record.at < Math.max(priorStat.birthtimeMs - 1, Date.parse(plan.at)) || record.at > continuationBorn || record.at > now())
        fail('RECOVERY_COLLECTION_UNPROVED');
    }
    const registry = join(base, 'recipes.json'); owned(registry, false, true);
    const recipes = JSON.parse(readFileSync(registry, 'utf8')).recipes;
    if (!Array.isArray(recipes) || recipes.length !== 1 || recipes[0].bundleId !== APPS.vscode.bundleId
      || typeof recipes[0].executable !== 'string' || !recipes[0].executable.endsWith('/Contents/MacOS/Code')
      || !recipes[0].build?.startsWith(APPS.vscode.bundleId + '@')) fail('RECOVERY_RECIPE_INVALID');
    const recipe = recipes[0], appPath = recipe.executable.slice(0, -'/Contents/MacOS/Code'.length);
    const pinnedPaths = [planPath, root, dirname(base), base, join(base, 'profiles'),
      ...(prior ? [continuationPath, priorPath] : [fixture.profile, join(fixture.profile, 'OWNER.json')]), join(base, 'state'), journal, registry].map(path => {
      const stat = lstatSync(path); return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(),
        mode: stat.mode & 0o7777, hash: stat.isFile() ? hashFile(path) : null,
        ...(path === priorPath ? { birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs } : {}),
        ...(path === continuationPath ? { creationBirthMs: continuationBorn } : {}) };
    });
    if (pinnedPaths.find(row => row.path === planPath).dev !== planStat.dev
      || pinnedPaths.find(row => row.path === planPath).ino !== planStat.ino
      || pinnedPaths.find(row => row.path === planPath).hash !== planHash
      || pinnedPaths.find(row => row.path === journal).hash !== (prior ? journalHash : plan.ownershipSHA256)
      || prior && (pinnedPaths.find(row => row.path === priorPath).hash !== priorHash
        || pinnedPaths.find(row => row.path === priorPath).dev !== priorStat.dev || pinnedPaths.find(row => row.path === priorPath).ino !== priorStat.ino
        || pinnedPaths.find(row => row.path === priorPath).birthtimeMs !== priorStat.birthtimeMs || pinnedPaths.find(row => row.path === priorPath).mtimeMs !== priorStat.mtimeMs
        || pinnedPaths.find(row => row.path === continuationPath).hash !== continuationHash
        || pinnedPaths.find(row => row.path === continuationPath).dev !== continuationStat.dev
        || pinnedPaths.find(row => row.path === continuationPath).ino !== continuationStat.ino)) fail('RECOVERY_OWNER_CHANGED');
    sourceRoot = realpathSync(sourceRoot); owned(sourceRoot, true);
    const readCommit = deps.readCommit ?? (async root => String((await execute('/usr/bin/git',
      ['-C', root, 'rev-parse', '--verify', 'HEAD'], { timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } })).stdout).trim());
    if (await boundary('source-commit', () => readCommit(sourceRoot)) !== plan.buildCommit) fail('RECOVERY_COMMIT_CHANGED');
    const hostScript = join(sourceRoot, 'plugins/sleight/lib/direct-browser/electron-host-run.mjs');
    try { lockPath = realpathSync(deps.lockPath ?? LOCK); } catch (error) {
      if (error.code === 'ENOENT') fail('RECOVERY_LOCK_ABSENT'); throw error;
    }
    pinnedLock = owned(lockPath, true);
    const verifyLock = () => {
      const current = owned(lockPath, true);
      if (current.dev !== plan.lock?.dev || current.ino !== plan.lock?.ino || (current.mode & 0o7777) !== (pinnedLock.mode & 0o7777)
        || readdirSync(lockPath).length) fail('RECOVERY_LOCK_CHANGED');
    };
    verifyLock();
    if (prior && prior.hostBirthProof.lowerBoundMs !== Math.max(rootStat.birthtimeMs, pinnedLock.birthtimeMs)) fail('RECOVERY_PRIOR_RECEIPT_INVALID');
    const verifyOwnership = () => {
      stage = 'owner-recheck';
      verifyLock();
      for (const expected of pinnedPaths) {
        const current = owned(expected.path, expected.directory);
        if (current.dev !== expected.dev || current.ino !== expected.ino || (current.mode & 0o7777) !== expected.mode
          || expected.mtimeMs !== undefined && (current.birthtimeMs !== expected.birthtimeMs || current.mtimeMs !== expected.mtimeMs)
          || expected.creationBirthMs !== undefined && continuationBirthTime(expected.path) !== expected.creationBirthMs
          || expected.hash !== null && hashFile(expected.path) !== expected.hash)
          fail('RECOVERY_OWNER_CHANGED');
      }
      if (prior) { requireAbsent(fixture.profile); requireAbsent(join(fixture.profile, 'OWNER.json')); }
    };
    const births = async pids => {
      if (!pids.length) return new Map();
      if (pids.length > 64 || new Set(pids).size !== pids.length || pids.some(pid => !positive(pid))) fail('RECOVERY_PROCESS_AMBIGUOUS');
      const result = await native({ mode: 'births', pids, bundle: APPS.vscode.bundleId });
      if (!Array.isArray(result.processes) || result.processes.length !== pids.length) fail('RECOVERY_BIRTH_UNAVAILABLE');
      const map = new Map(result.processes.map(row => [row.pid, row.pidBirth]));
      if (map.size !== pids.length || pids.some(pid => !map.has(pid) || map.get(pid) !== null && !birthPattern.test(map.get(pid)))) fail('RECOVERY_BIRTH_UNAVAILABLE');
      return map;
    };
    const original = await list(), appRow = original.find(row => row.pid === fixture.pid), hostRow = original.find(row => row.pid === fixture.hostPid);
    const snapshot = await births([...new Set([fixture.pid, fixture.hostPid])]);
    const verifyPostCollectionAbsence = async () => {
      if (!prior) return;
      const pids = [...new Set([fixture.pid, ...fixture.observed.map(pair => pair[0])])], current = await births(pids), rows = await list();
      if ([...current.values()].some(value => value !== null) || rows.some(row => pids.includes(row.pid)
        || row.args.split(/[\s"'=,:{}]+/).some(token => token === fixture.profile || token.startsWith(fixture.profile + '/'))))
        fail('RECOVERY_APP_DESCENDANTS_REMAIN');
    };
    await verifyPostCollectionAbsence();
    const verifyObserved = async () => {
      const current = await births(fixture.observed.map(pair => pair[0]));
      for (const [pid, birth] of fixture.observed) if (current.get(pid) !== null && current.get(pid) !== birth)
        fail('RECOVERY_OBSERVED_IDENTITY_CHANGED');
    };
    await verifyObserved();
    const appBirthMs = Number(fixture.birth) * 1000;
    const checkAppRow = row => row.uid === uid && row.startedAtMs === Math.floor(Number(fixture.birth)) * 1000
      && row.args.startsWith(recipe.executable + ' ') && row.args.split(/\s+/).includes(`--user-data-dir=${fixture.profile}/user-data`);
    if (appRow && (!checkAppRow(appRow) || snapshot.get(fixture.pid) !== fixture.birth)) fail('RECOVERY_APP_IDENTITY_CHANGED');
    if (!appRow && snapshot.get(fixture.pid) !== null) fail('RECOVERY_APP_CENSUS_INCOHERENT');
    if (appRow) {
      const table = await native({ mode: 'table', bundle: APPS.vscode.bundleId });
      const matches = table.processes?.filter(row => row.pid === fixture.pid) ?? [];
      if (matches.length !== 1 || matches[0].pidBirth !== fixture.birth || matches[0].bundle !== APPS.vscode.bundleId
        || matches[0].path !== appPath) fail('RECOVERY_APP_IDENTITY_CHANGED');
    }
    const hostBirth = snapshot.get(fixture.hostPid);
    if (prior && !hostRow) {
      if (hostBirth !== null) fail('RECOVERY_HOST_CENSUS_INCOHERENT');
      // An idle, free host exits by itself. Absence grants only lock release, never new signal authority.
      const releasePids = [...new Set([fixture.hostPid, fixture.pid, ...fixture.observed.map(pair => pair[0])])];
      const refuseObservedInfrastructure = rows => {
        if (observedReleaseInfrastructure || hasReleaseInfrastructure(rows, plan))
          fail('RECOVERY_INFRA_REMAIN_WITHOUT_HOST');
      };
      // Any observed unknown child refuses this attempt, even if it reparents before a later census.
      refuseObservedInfrastructure(original);
      const verifyReleaseOnlyAbsence = async () => {
        checkDeadline(); verifyOwnership(); stage = 'release-only-absence';
        const rows = await list(); refuseObservedInfrastructure(rows);
        const current = await births(releasePids);
        if ([...current.values()].some(value => value !== null) || rows.some(row => releasePids.includes(row.pid))) fail('RECOVERY_HOST_ABSENCE_UNPROVED');
        verifyOwnership();
      };
      await verifyReleaseOnlyAbsence();
      Object.assign(receipt, { closureOnly: true, ready: true, appExited: true, infrastructureExited: true,
        hostBirthProof: { originalBirthRecorded: false, derivedBirth: prior.hostBirthProof.derivedBirth,
          lowerBoundMs: prior.hostBirthProof.lowerBoundMs, upperBoundMs: prior.hostBirthProof.upperBoundMs },
        hostAbsenceProof: { censusAbsent: true, nativeBirth: null, descendantsAbsent: true } });
      if (!run) return receipt;
      await verifyReleaseOnlyAbsence(); save();
      await verifyReleaseOnlyAbsence();
      verifyOwnership(); rmdirSync(lockPath);
      receipt.confirmed = true; receipt.lockReleased = true; receipt.keepLock = false;
      return receipt;
    }
    const python = deps.python ?? await boundary('python-resolution', () => resolveRunPython('python3', { exec: execute }));
    const pythonImage = deps.pythonImage ?? await boundary('python-image-probe', () => resolveRecoveryPythonImage(python));
    const hostArgs = `${process.execPath} ${hostScript} --state-dir ${base}/state --registry ${registry} --temp-root ${base}/profiles --builds ${recipe.build} --admin-fd 3 --startup-fd 4`;
    const hostMatches = row => row.uid === uid && [hostArgs, hostArgs + ` --python ${python}`].includes(row.args);
    if (hostRow && (!hostMatches(hostRow) || !birthPattern.test(hostBirth ?? '')
      || hostRow.startedAtMs !== Math.floor(Number(hostBirth)) * 1000
      || Number(hostBirth) * 1000 < Math.max(rootStat.birthtimeMs, pinnedLock.birthtimeMs) - 1
      || Number(hostBirth) * 1000 > appBirthMs)) fail('RECOVERY_HOST_IDENTITY_UNPROVED');
    if (!hostRow && hostBirth !== null) fail('RECOVERY_HOST_CENSUS_INCOHERENT');
    if (prior && (!hostRow || hostBirth !== prior.hostBirthProof.derivedBirth)) fail('RECOVERY_HOST_IDENTITY_UNPROVED');
    receipt.hostBirthProof = { originalBirthRecorded: false, derivedBirth: hostBirth,
      lowerBoundMs: Math.max(rootStat.birthtimeMs, pinnedLock.birthtimeMs), upperBoundMs: appBirthMs };
    const appPids = new Set([fixture.pid]);
    for (const [pid] of fixture.observed) appPids.add(pid);
    for (const row of original) if (row.args.includes(fixture.profile + '/')) appPids.add(row.pid);
    for (let changed = true; changed;) { changed = false;
      for (const row of original) if (appPids.has(row.ppid) && !appPids.has(row.pid)) { appPids.add(row.pid); changed = true; }
    }
    const appDescendants = [...new Set([...appPids, ...original.filter(row => row.args.includes(fixture.profile + '/')).map(row => row.pid)])];
    const appClosure = new Set(appDescendants);
    const namesRoot = row => row.args.split(/[\s"'=,:{}]+/).some(token => token === root || token.startsWith(root + '/'));
    const samplerArgs = stop => `/usr/bin/osascript -l JavaScript ${sourceRoot}/bench/electron-qualification.js ${JSON.stringify({
      mode: 'sample', intervalMs: 50, durationMs: 6 * 3600 * 1000, stop })}`;
    const adapterArgs = `${pythonImage} -I -B ${sourceRoot}/plugins/sleight/lib/direct-browser/electron/launch.py --adapter --registry ${registry} --temp-root ${base}/profiles`;
    // Exact project entrypoints and arguments prove ownership; a known interpreter alone does not.
    const infrastructureMatches = row => row.uid === uid && (row.pid === fixture.hostPid && hostMatches(row)
      || row.args === adapterArgs && row.ppid === fixture.hostPid && !!hostRow
      || [root, dirname(base)].some(path => row.args === samplerArgs(join(path, 'sampler.stop'))));
    const refuseInfrastructure = rows => {
      stage = 'infrastructure-validation';
      infrastructureRefusals = rows.slice(0, 16).map(row => ({ pid: positive(row.pid) ? row.pid : null,
        ppid: positive(row.ppid) ? row.ppid : null, reason: row.uid !== uid ? 'uid-mismatch'
          : row.pid === fixture.hostPid ? 'host-vector-mismatch'
            : row.args.startsWith(`${python} -I -B ${sourceRoot}/plugins/sleight/lib/direct-browser/electron/launch.py --keeper --socket `) ? 'keeper-vector-unsupported'
              : row.args.startsWith(process.execPath + ' ') ? 'node-vector-mismatch'
                : row.args.startsWith(python + ' ') ? 'python-vector-mismatch'
                  : row.args.startsWith('/usr/bin/osascript ') ? 'sampler-vector-mismatch' : 'unknown-executable' }));
      fail('RECOVERY_INFRA_EXECUTABLE_UNPROVED');
    };
    const infra = original.filter(row => !appClosure.has(row.pid) && (row.pid === fixture.hostPid || namesRoot(row)));
    if (infra.some(row => !infrastructureMatches(row))) refuseInfrastructure(infra.filter(row => !infrastructureMatches(row)));
    // A parent link alone does not prove an arbitrary interpreter's script belongs to this run.
    for (let changed = true; changed;) { changed = false;
      for (const row of original) if (!appClosure.has(row.pid) && !infra.some(value => value.pid === row.pid)
        && infra.some(parent => parent.pid === row.ppid)) {
        if (!infrastructureMatches(row)) refuseInfrastructure([row]);
        infra.push(row); changed = true;
      }
    }
    const infraBirths = await births(infra.map(row => row.pid));
    const knownInfra = new Map(infra.map(row => [row.pid, { ...row, birth: infraBirths.get(row.pid) }]));
    for (const row of infra) if (!birthPattern.test(infraBirths.get(row.pid) ?? '')
      || Number(infraBirths.get(row.pid)) * 1000 < rootStat.birthtimeMs - 1
      || Number(infraBirths.get(row.pid)) * 1000 > Date.parse(plan.at)) fail('RECOVERY_INFRA_IDENTITY_UNPROVED');
    for (const row of infra) if (row.args === adapterArgs && Number(infraBirths.get(row.pid)) < Number(hostBirth)) fail('RECOVERY_INFRA_IDENTITY_UNPROVED');
    const verifyInfraDescendants = async () => {
      const rows = await list(), descendants = new Set(knownInfra.keys());
      const currentBirths = await births([...knownInfra.keys()]);
      for (const [pid, expected] of knownInfra) {
        const row = rows.find(value => value.pid === pid), birth = currentBirths.get(pid);
        if (!row && birth === null) continue;
        if (!row || row.uid !== uid || row.args !== expected.args || row.startedAtMs !== expected.startedAtMs || birth !== expected.birth)
          fail('RECOVERY_INFRA_IDENTITY_CHANGED');
      }
      for (let changed = true; changed;) { changed = false;
        for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
      }
      const added = rows.filter(row => descendants.has(row.pid) && !knownInfra.has(row.pid));
      if (added.length) {
        const addedBirths = await births(added.map(row => row.pid));
        receipt.unprovedDescendants = added.map(row => ({ pid: row.pid, birth: addedBirths.get(row.pid) })); save();
        fail('RECOVERY_INFRA_DESCENDANT_UNPROVED');
      }
    };
    if (prior) { await verifyPostCollectionAbsence(); verifyOwnership(); }
    receipt.ready = true;
    if (!run) return receipt;
    // Recheck every action target's full birth. Never adopt an unknown process during cleanup.
    verifyOwnership();
    if (appRow) {
      const fresh = (await list()).find(row => row.pid === fixture.pid);
      if (!fresh || !checkAppRow(fresh) || (await births([fixture.pid])).get(fixture.pid) !== fixture.birth) fail('RECOVERY_APP_IDENTITY_CHANGED');
      await verifyObserved();
      verifyOwnership();
      receipt.actions.push({ action: 'normal-quit', pid: fixture.pid }); save();
      const quit = await native({ mode: 'quit', pid: fixture.pid, pidBirth: fixture.birth,
        bundle: APPS.vscode.bundleId, appPath, allowForce: false, waitMs: 20_000 });
      if (!['exited', 'already-exited'].includes(quit.reason) || quit.forced === true) fail('RECOVERY_NORMAL_QUIT_UNCONFIRMED');
    }
    for (let attempt = 0; ; attempt++) {
      checkDeadline();
      const rows = await list(), currentBirths = await births(appDescendants);
      const left = appDescendants.filter(pid => rows.some(next => next.pid === pid) || currentBirths.get(pid) !== null);
      if (!left.length && !rows.some(row => row.args.includes(fixture.profile + '/'))) break;
      if (attempt === 40) fail('RECOVERY_APP_DESCENDANTS_REMAIN');
      await sleep(250);
    }
    receipt.appExited = true; save();
    await verifyInfraDescendants();
    for (const kind of ['SIGTERM', 'SIGKILL']) {
      for (const [pid, expected] of knownInfra) {
        checkDeadline(); verifyOwnership();
        const row = (await list()).find(value => value.pid === pid), birth = (await births([pid])).get(pid);
        if (!row && birth === null) continue;
        if (!row || birth !== expected.birth || row.uid !== uid || row.args !== expected.args || row.startedAtMs !== expected.startedAtMs) fail('RECOVERY_INFRA_IDENTITY_CHANGED');
        await verifyInfraDescendants();
        await verifyPostCollectionAbsence();
        verifyOwnership();
        receipt.actions.push({ action: kind, pid }); save(); signal(pid, kind);
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        checkDeadline();
        const rows = await list();
        if (!rows.some(row => knownInfra.has(row.pid))) break;
        await sleep(250);
      }
    }
    await verifyInfraDescendants();
    const remaining = await list(), finalBirths = await births([...knownInfra.keys()]);
    if (remaining.some(row => knownInfra.has(row.pid) || namesRoot(row))
      || [...finalBirths.values()].some(value => value !== null)) fail('RECOVERY_PROCESS_EXIT_UNCONFIRMED');
    receipt.infrastructureExited = true; receipt.confirmed = true; save();
    await verifyPostCollectionAbsence();
    verifyOwnership(); rmdirSync(lockPath); receipt.lockReleased = true; receipt.keepLock = false;
  } catch (error) {
    receipt.confirmed = false;
    receipt.error = /^RECOVERY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'RECOVERY_FAILED';
    receipt.failure = { ...closedFailure(error, stage), ...(infrastructureRefusals ? { infrastructure: infrastructureRefusals } : {}) };
  } finally { try { save(); } finally { if (fd !== undefined) closeSync(fd); } }
  return receipt;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let planPath, sourceRoot, continuationPath, run = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run' && !run) { run = true; continue; }
    if (!['--plan', '--source-worktree', '--continuation'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) return 2;
    const key = argv[i++]; if (key === '--plan') { if (planPath) return 2; planPath = argv[i]; }
    else if (key === '--source-worktree') { if (sourceRoot) return 2; sourceRoot = argv[i]; }
    else { if (continuationPath) return 2; continuationPath = argv[i]; }
  }
  if (!planPath) return 2;
  const receipt = await recoverElectronRun({ planPath, sourceRoot, continuationPath, run }, deps);
  console.log(JSON.stringify(scrubReceipt(receipt)));
  return run ? receipt.confirmed && receipt.lockReleased ? 0 : 1 : receipt.ready ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
