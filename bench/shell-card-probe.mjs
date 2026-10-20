#!/usr/bin/env node
// Architect-run qualification. Importing this module does not compile, open UI or touch the shared lock.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';

const hostURL = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
const icon = fileURLToPath(new URL('../plugins/sleight/assets/icon.png', import.meta.url));
export function shellCardSource(source = readFileSync(hostURL, 'utf8')) {
  const entry = '// No arguments: the consent host.';
  const refusal = 'func refuseConsentInput(_ button: NSButton? = nil) {';
  const answer = '        output.write(bytes + Data([10]))';
  if ([entry, refusal, answer].some(marker => source.split(marker).length !== 2)) throw Error('SHELL_CARD_SOURCE_DRIFT');
  return source.slice(0, source.indexOf(entry)).replace(refusal, refusal + '\n    shellReceipt("refused")')
    .replace(answer, '        shellReceipt(choice == "once" ? "accepted" : "cancelled", ["id": id])\n' + answer) +
    readFileSync(new URL('./shell-card-fixture.swift', import.meta.url), 'utf8');
}

export function compileShellCard(directory, { write = writeFileSync, compile = spawnSync } = {}) {
  const source = join(directory, 'main.swift'), host = join(directory, 'shell-card'), poster = join(directory, 'shell-poster');
  write(source, shellCardSource(), { flag: 'wx', mode: 0o600 });
  for (const [file, binary] of [[source, host], [fileURLToPath(new URL('./shell-card-poster.swift', import.meta.url)), poster]]) {
    const result = compile('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'cache'), file, '-o', binary],
      { encoding: 'utf8', timeout: 120000, detached: true });
    if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'SHELL_CARD_COMPILE_FAILED');
  }
  return { host, poster };
}

export function attemptVerdict(receipts, poster) {
  if (receipts.some(r => r.outcome === 'accepted')) return 'accepted';
  if (poster?.outcome === 'permission-absent') return 'permission-absent';
  if (poster?.outcome !== 'attempted') return 'poster-failed';
  if (receipts.some(r => r.outcome === 'refused')) return 'refused';
  if (receipts.some(r => r.outcome === 'cancelled')) return 'cancelled';
  return 'no-receipt';
}

// Same mkdir/rmdir protocol as live-lock.mjs, also checked before every input phase.
// Never remove an existing lock, a replacement lock, or a lock after uncertain child cleanup.
export async function acquireAdmission({ lock = '/tmp/sleight-live.lock', hold = '/tmp/sleight-hold' } = {}) {
  const absent = async () => {
    try { await lstat(hold); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw Error('SHELL_CARD_HOLD');
  };
  await absent();
  await mkdir(lock);
  const owned = await lstat(lock, { bigint: true });
  const identity = async () => {
    const current = await lstat(lock, { bigint: true });
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino || current.birthtimeNs !== owned.birthtimeNs) {
      throw Error('SHELL_CARD_LOCK_IDENTITY');
    }
  };
  const admission = { check: async () => { await absent(); await identity(); }, release: async () => { await identity(); await rmdir(lock); } };
  try { await admission.check(); } catch (error) { await admission.release(); throw error; }
  return admission;
}

export async function runShellCard({ directory, binaries, admission, launch = spawn, input = process.stdin,
  signals = process, say = r => console.log(JSON.stringify(r)), prompt = text => console.error(text), timing = {} }) {
  const ms = { ready: 10000, attempt: 3000, settle: 500, person: 120000, cleanup: 5000, poll: 20, ...timing };
  const result = { passed: false, steps: [], cleanup: { confirmed: false } }, records = [], children = [];
  let stopped, fault, child, lines, cardID, step = 'setup';
  const abort = () => { stopped = 'INTERRUPTED'; }, eof = () => { stopped = 'OPERATOR_EOF'; };
  signals.on('SIGINT', abort); signals.on('SIGTERM', abort);
  input.on('end', eof); input.resume();
  const pause = () => new Promise(resolve => setTimeout(resolve, ms.poll));
  const start = (binary, args) => {
    // Separate process groups keep terminal Ctrl-C on the runner. Shutdown remains EOF on our exact child pipe.
    const proc = launch(binary, args, { cwd: directory, detached: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: directory, TMPDIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    const owned = { proc, closed: false, code: null, signal: null };
    children.push(owned);
    proc.on('error', error => { fault = error; });
    proc.once('close', (code, signal) => { owned.closed = true; owned.code = code; owned.signal = signal; });
    proc.stdin.on('error', error => { fault = error; });
    // Only fixed fixture diagnostics. Keep stderr out of the JSON receipt stream.
    proc.stderr.on('data', () => {});
    return owned;
  };
  const check = async () => {
    // Drain pending signals and stdin EOF before an input phase, including with fake admission I/O.
    await new Promise(resolve => setImmediate(resolve));
    if (input.readableEnded || input.destroyed) stopped = 'OPERATOR_EOF';
    if (stopped) throw Error(stopped);
    if (fault) throw fault;
    await admission.check();
    if (child?.closed) throw Error('SHELL_CARD_CHILD_CLOSED');
  };
  const until = async (predicate, timeout) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      await check();
      if (predicate()) return true;
      if (Date.now() >= deadline) return false;
      await pause();
    }
  };
  const send = command => child.proc.stdin.write(JSON.stringify({ step, ...command }) + '\n');
  const selected = start => records.slice(start).filter(r => r.step === step);
  const command = async (op, outcome) => {
    const start = records.length;
    await check(); send({ op });
    if (!await until(() => selected(start).some(r => r.outcome === outcome), ms.ready)) throw Error(`SHELL_CARD_${op.toUpperCase()}_TIMEOUT`);
    return selected(start).find(r => r.outcome === outcome);
  };
  try {
    await check();
    child = start(binaries.host, [icon]);
    lines = createInterface({ input: child.proc.stdout });
    lines.on('line', line => {
      try {
        const record = JSON.parse(line);
        if (record.outcome) {
          if (record.id && step !== 'setup' && record.id !== cardID) throw Error('SHELL_CARD_ANSWER_IDENTITY');
          records.push(record); say({ card: record });
        }
        // The unchanged ConsentHost.respond writes only to this runner's pipe, never to a relay.
        else if (record.id && ['once', 'cancel'].includes(record.choice)) {
          if (step !== 'setup' && record.id !== cardID) throw Error('SHELL_CARD_ANSWER_IDENTITY');
          say({ protocolAnswer: { step, id: record.id, choice: record.choice } });
        } else if (record.hand !== 'consent-ready') throw Error('UNKNOWN_CARD_RECEIPT');
      } catch (error) { fault = error; }
    });
    if (!await until(() => records.some(r => r.outcome === 'boot' && r.pid === child.proc.pid), ms.ready)) throw Error('SHELL_CARD_BOOT_TIMEOUT');
    const ready = await command('show', 'ready');
    if (ready.pid !== child.proc.pid || !Number.isSafeInteger(ready.window) || ready.window <= 0 ||
      ![ready.x, ready.y].every(Number.isFinite) || ready.visible !== true || ready.cards !== 1 ||
      ready.protected !== true || ready.returnDefault !== false) throw Error('SHELL_CARD_TARGET_IDENTITY');
    const lifecycle = await command('lifecycle', 'lifecycle');
    result.lifecycle = lifecycle;
    if (lifecycle.ok !== true) throw Error('SHELL_CARD_LIFECYCLE');
    // Show a fresh fake action after lifecycle checks, with a new window identity.
    const target = await command('show', 'ready');
    if (target.pid !== ready.pid || target.visible !== true || target.cards !== 1 || target.protected !== true ||
      target.returnDefault !== false || !Number.isSafeInteger(target.window) || target.window <= 0 ||
      ![target.x, target.y].every(Number.isFinite) || !/^gb18q-\d+$/.test(target.id)) throw Error('SHELL_CARD_TARGET_IDENTITY');
    cardID = target.id;
    for (const mode of ['ax', 'pid', 'hid']) {
      step = mode;
      await command('arm', 'armed');
      const offset = records.length;
      await check();
      const poster = start(binaries.poster, [mode, String(target.pid), String(target.window), String(target.x), String(target.y)]);
      const attempts = [], posterLines = createInterface({ input: poster.proc.stdout });
      posterLines.on('line', line => {
        try { const record = JSON.parse(line); attempts.push(record); say({ poster: mode, ...record }); }
        catch (error) { fault = error; }
      });
      poster.proc.stdin.end();
      try {
        if (!await until(() => poster.closed, ms.ready)) throw Error('SHELL_CARD_POSTER_TIMEOUT');
        const posted = attempts.findLast(r => ['attempted', 'permission-absent'].includes(r.outcome));
        const valid = (posted?.outcome === 'attempted' && poster.code === 0) || (posted?.outcome === 'permission-absent' && poster.code === 77);
        if (valid && posted.outcome === 'attempted') {
          await until(() => ['refused', 'accepted', 'cancelled'].includes(attemptVerdict(selected(offset), posted)), ms.attempt);
          // A refusal on mouse-down cannot hide acceptance on mouse-up.
          const end = Date.now() + ms.settle;
          while (Date.now() < end) { await check(); await pause(); }
        }
        const verdict = attemptVerdict(selected(offset), valid ? posted : null);
        const receipt = { step, verdict, ok: verdict === 'refused', posterExit: poster.code };
        result.steps.push(receipt); say(receipt);
        if (['accepted', 'cancelled', 'poster-failed'].includes(verdict)) throw Error('SHELL_CARD_SYNTHETIC_STEP_FAILED');
      } finally { posterLines.close(); }
    }
    step = 'person-click';
    const offset = records.length;
    await command('arm', 'armed');
    prompt(`Fake request only. Click the visible Allow Once button yourself within ${ms.person / 1000} seconds. Do not press Return. Ctrl-C or stdin EOF cancels.`);
    say({ step, outcome: 'waiting-for-person', deadline: new Date(Date.now() + ms.person).toISOString(), pid: target.pid, window: target.window });
    const received = await until(() => selected(offset).some(r => ['accepted', 'refused', 'cancelled'].includes(r.outcome)), ms.person);
    const verdict = received ? attemptVerdict(selected(offset), { outcome: 'attempted' }) : 'no-receipt';
    result.steps.push({ step, verdict, ok: verdict === 'accepted' }); say(result.steps.at(-1));
    result.passed = result.steps.every(r => r.ok);
  } catch (error) { result.error = error.message; say({ outcome: 'stopped', reason: error.message }); }
  finally {
    // EOF is the only shutdown command. The fixture closes its production host and receipts before exiting.
    // No process-name lookup, signals, global input or foreign-lock deletion is used for cleanup.
    if (child && !child.closed) child.proc.stdin.end();
    const deadline = Date.now() + ms.cleanup;
    while (children.some(c => !c.closed) && Date.now() < deadline) await pause();
    const receipt = records.findLast(r => r.outcome === 'cleanup');
    result.cleanup = { confirmed: !child || (receipt?.visible === 0 && receipt?.pending === 0 &&
      children.every(c => c.closed && !c.signal && (c === child ? c.code === 0 : Number.isInteger(c.code)))),
      hostExit: child?.code ?? null, hostSignal: child?.signal ?? null, receipt: receipt ?? null,
      children: children.map(c => ({ pid: c.proc.pid ?? null, closed: c.closed, exit: c.code, signal: c.signal })) };
    say({ cleanup: result.cleanup });
    if (result.cleanup.confirmed) {
      try { await admission.release(); say({ outcome: 'lock-released' }); }
      catch (error) { result.cleanup.confirmed = false; result.error = error.message; say({ outcome: 'lock-retained', reason: error.message }); }
    } else say({ outcome: 'lock-retained', reason: 'CHILD_CLEANUP_UNCONFIRMED', directory });
    result.passed = result.passed && result.cleanup.confirmed;
    lines?.close();
    signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort);
    input.removeListener('end', eof); input.pause();
    for (const owned of children.filter(c => !c.closed)) {
      owned.proc.unref?.(); owned.proc.stdout.destroy(); owned.proc.stderr.destroy();
    }
  }
  return result;
}

async function main(args) {
  const mode = args[0];
  if (process.platform !== 'darwin' || !['--compile-only', '--live'].includes(mode) || args.length !== 3 ||
    args[1] !== '--receipt' || !isAbsolute(args[2])) {
    console.error('usage on macOS: node bench/shell-card-probe.mjs --compile-only|--live --receipt /absolute/new.jsonl');
    process.exitCode = 2; return;
  }
  const fd = openSync(args[2], 'wx', 0o600), run = randomUUID();
  const say = record => {
    const line = JSON.stringify({ run, at: new Date().toISOString(), ...record }) + '\n';
    writeFileSync(fd, line); fsyncSync(fd); process.stdout.write(line);
  };
  let directory, admission, result, retain = false;
  let interrupted = false;
  const abort = () => { interrupted = true; };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    say({ outcome: 'start', mode, sourceSHA256: createHash('sha256').update(readFileSync(hostURL)).digest('hex') });
    if (mode === '--live') { admission = await acquireAdmission(); say({ outcome: 'admitted' }); }
    if (interrupted) throw Error('INTERRUPTED_BEFORE_COMPILE');
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-shell-card-')));
    const binaries = compileShellCard(directory);
    say({ outcome: 'compiled', launched: false });
    if (interrupted) throw Error('INTERRUPTED_BEFORE_LAUNCH');
    if (mode === '--live') {
      console.error('Only this fake panel is targeted. Do not interact until the physical-click prompt. Existing Accessibility and Post-event permissions are required; this runner requests none.');
      result = await runShellCard({ directory, binaries, admission, say });
      admission = null; retain = !result.cleanup.confirmed;
      say({ summary: result }); process.exitCode = result.passed ? 0 : 1;
    }
  } catch (error) { say({ outcome: 'failed', reason: error.message }); process.exitCode = 1; }
  finally {
    if (admission) {
      try { await admission.release(); say({ outcome: 'lock-released', launched: false }); }
      catch (error) { retain = true; say({ outcome: 'lock-retained', reason: error.message }); }
    }
    if (directory && !retain) rmSync(directory, { recursive: true, force: true });
    if (retain) say({ outcome: 'bank-retained', directory });
    closeSync(fd);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
