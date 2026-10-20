import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shellCardSource, compileShellCard, attemptVerdict, acquireAdmission, runShellCard } from '../bench/shell-card-probe.mjs';

const production = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const block = (source, name) => source.split(`// BEGIN ${name}\n`)[1].split(`// END ${name}`)[0];
test('shell fixture keeps production panel and person guard, with receipt-only instrumentation', () => {
  const source = shellCardSource(production);
  assert.equal(block(source, 'ASK CARD'), block(production, 'ASK CARD'));
  assert.equal(block(source, 'PERSON INPUT').replace('    shellReceipt("refused")\n', ''), block(production, 'PERSON INPUT'));
  assert.equal(source.split('// GB18Q FIXTURE')[0].replace('    shellReceipt("refused")\n', '')
    .replace('        shellReceipt(choice == "once" ? "accepted" : "cancelled", ["id": id])\n', ''),
    production.slice(0, production.indexOf('// No arguments: the consent host.')));
  assert.match(source, /host\.receive\(frame\)/);
  assert.match(source, /host\.review\(row\)/);
  assert.match(source, /host\.channelClosed\(\)/);
  assert.match(source, /consent-reset/);
  assert.match(source, /Fake request/);
  assert.match(source, /cannot approve any app, pay, persist grants or send a real action/);
  assert.doesNotMatch(source.slice(source.indexOf('// GB18Q FIXTURE')), /personModal|runModal|keyEquivalent\s*=(?!=)|\.press\(/);
  assert.throws(() => shellCardSource('drift'), /SOURCE_DRIFT/);
});

test('compile-only builds two visible sources without spawning a running fixture', () => {
  const calls = [];
  compileShellCard('/fake/bank', { write: (...args) => calls.push(['write', ...args]),
    compile: (...args) => { calls.push(['compile', ...args]); return { status: 0 }; } });
  assert.equal(calls.filter(c => c[0] === 'compile').length, 2);
  assert.ok(calls.filter(c => c[0] === 'compile').every(c => c[1] === '/usr/bin/xcrun' && c[2][0] === 'swiftc'));
});

test('absence of permission never counts as refusal, and acceptance takes priority', () => {
  assert.equal(attemptVerdict([], { outcome: 'permission-absent' }), 'permission-absent');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], { outcome: 'permission-absent' }), 'permission-absent');
  assert.equal(attemptVerdict([], { outcome: 'attempted' }), 'no-receipt');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], { outcome: 'attempted' }), 'refused');
  assert.equal(attemptVerdict([{ outcome: 'refused' }, { outcome: 'accepted' }], { outcome: 'attempted' }), 'accepted');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], null), 'poster-failed');
});

test('admission never removes foreign locks and rejects holds, using private fake paths', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'gb18q-admission-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const lock = join(bank, 'lock'), hold = join(bank, 'hold');
  mkdirSync(lock);
  await assert.rejects(acquireAdmission({ lock, hold }), /EEXIST/);
  assert.ok(existsSync(lock));
  rmdirSync(lock); mkdirSync(hold);
  await assert.rejects(acquireAdmission({ lock, hold }), /HOLD/);
  assert.equal(existsSync(lock), false);
  rmdirSync(hold);
  const admission = await acquireAdmission({ lock, hold });
  await admission.check();
  mkdirSync(hold);
  await assert.rejects(admission.check(), /HOLD/);
  rmdirSync(hold);
  renameSync(lock, join(bank, 'original-lock')); mkdirSync(lock);
  await assert.rejects(admission.release(), /LOCK_IDENTITY/);
  assert.ok(existsSync(lock));
});

function fakeRun({ permissionAbsent = false, acceptSynthetic = false, missing = false, interrupt = false,
  eof = false, cleanupMissing = false, wrongPid = false, lifecycleBad = false, lateAcceptance = false,
  cleanupHang = false, posterFailed = false, holdDuringAttempt = false, personMissing = false, hostExit = 0 } = {}) {
  const signal = new EventEmitter(), input = new PassThrough(), receipts = [], children = [];
  let host, step, released = false, ended = false;
  const emit = record => host.stdout.write(JSON.stringify({ step, ...record }) + '\n');
  const launch = (file, args, options) => {
    assert.equal(options.detached, true);
    const child = new EventEmitter();
    child.pid = file === 'host' ? 12345 : 12346;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    children.push(child);
    if (file === 'host') {
      host = child;
      let buffer = '';
      child.stdin.on('data', bytes => {
        buffer += bytes;
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'), command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          step = command.step;
          if (command.op === 'show') {
            emit({ outcome: 'ready', pid: wrongPid ? 9 : host.pid, id: 'gb18q-0004', window: 42, x: 20, y: 30,
              visible: true, cards: 1, protected: true, returnDefault: false });
            if (interrupt) setImmediate(() => signal.emit('SIGINT'));
            if (eof) setImmediate(() => input.end());
          } else if (command.op === 'lifecycle') emit({ outcome: 'lifecycle', ok: !lifecycleBad });
          else if (command.op === 'arm') {
            emit({ outcome: 'armed' });
            if (step === 'person-click' && !personMissing) setImmediate(() => emit({ outcome: 'accepted' }));
          }
        }
      });
      child.stdin.on('finish', () => setImmediate(() => {
        if (cleanupHang) return;
        ended = true;
        if (!cleanupMissing) emit({ outcome: 'cleanup', visible: 0, pending: 0 });
        child.stdout.end(); child.stderr.end(); child.emit('close', hostExit, null);
      }));
      setImmediate(() => emit({ outcome: 'boot', pid: host.pid }));
    } else {
      setImmediate(() => {
        assert.equal(args[1], '12345'); assert.equal(args[2], '42');
        if (!permissionAbsent && !missing && !posterFailed) emit({ outcome: acceptSynthetic ? 'accepted' : 'refused' });
        if (lateAcceptance) setTimeout(() => emit({ outcome: 'accepted' }), 2);
        if (holdDuringAttempt) holdDuringAttempt = 'held';
        child.stdout.end(JSON.stringify({ outcome: posterFailed ? 'poster-failed' : permissionAbsent ? 'permission-absent' : 'attempted' }) + '\n');
        child.stderr.end(); child.emit('close', posterFailed ? 1 : permissionAbsent ? 77 : 0, null);
      });
    }
    return child;
  };
  return { receipts, children, input, signal, get ended() { return ended; }, get released() { return released; },
    options: { directory: '/fake/bank', binaries: { host: 'host', poster: 'poster' }, launch,
      signals: signal, input, say: r => receipts.push(r), prompt: () => {},
      admission: { check: async () => { if (holdDuringAttempt === 'held') throw Error('HOLD'); }, release: async () => { released = true; } },
      // Keep the production observation window for the delayed-acceptance regression.
      // A five-millisecond substitute can expire before Node delivers its timer under load.
      timing: { ready: 100, attempt: 20, settle: lateAcceptance ? 500 : 5, person: 100, cleanup: 100, poll: 1 } } };
}

test('fake run checks lifecycle, all refusal receipts, physical click and exact cleanup', async () => {
  const fake = fakeRun(); const result = await runShellCard(fake.options);
  assert.equal(result.passed, true);
  assert.deepEqual(result.steps.map(r => r.verdict), ['refused', 'refused', 'refused', 'accepted']);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.ended, true); assert.equal(fake.released, true);
});

for (const [name, options, expected] of [
  ['permission absence', { permissionAbsent: true }, 'permission-absent'],
  ['missing receipt', { missing: true }, 'no-receipt'],
  ['synthetic acceptance', { acceptSynthetic: true }, 'accepted'],
  ['late acceptance after refusal', { lateAcceptance: true }, 'accepted'],
]) test(`fake ${name} cannot qualify the guard`, async () => {
  const fake = fakeRun(options); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.steps[0].verdict, expected);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.released, true);
});

for (const [name, options] of [['Ctrl-C', { interrupt: true }], ['operator EOF', { eof: true }],
  ['wrong PID', { wrongPid: true }], ['failed lifecycle', { lifecycleBad: true }]]) {
  test(`fake ${name} stops and proves child cleanup`, async () => {
    const fake = fakeRun(options); const result = await runShellCard(fake.options);
    assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, true);
    assert.equal(fake.released, true); assert.equal(fake.ended, true);
    assert.equal(fake.children.length, 1);
  });
}

test('missing cleanup receipt retains admission even after exit zero', async () => {
  const fake = fakeRun({ cleanupMissing: true }); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, false); assert.equal(fake.released, false);
});

test('poster failure is separate from refusal and still permits proven cleanup', async () => {
  const fake = fakeRun({ posterFailed: true }); const result = await runShellCard(fake.options);
  assert.equal(result.steps[0].verdict, 'poster-failed'); assert.equal(result.passed, false);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.released, true);
});

test('hold appearing during an attempt stops later inputs and cleans the owned fixture', async () => {
  const fake = fakeRun({ holdDuringAttempt: true }); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.error, 'HOLD');
  assert.equal(fake.children.length, 2); assert.equal(result.cleanup.confirmed, true);
});

test('bounded physical-click deadline reports no receipt without acceptance', async () => {
  const fake = fakeRun({ personMissing: true }); const result = await runShellCard(fake.options);
  assert.equal(result.steps.at(-1).verdict, 'no-receipt'); assert.equal(result.passed, false);
  assert.equal(result.cleanup.confirmed, true);
});

for (const options of [{ cleanupHang: true }, { hostExit: 9 }]) test('unproved child exit keeps lock and bank', async () => {
  const fake = fakeRun(options); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, false); assert.equal(fake.released, false);
});

for (const stop of ['SIGINT', 'EOF']) test(`real Node fake child exits with cleanup receipt on ${stop}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gb18q-node-fake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(), signals = new EventEmitter(), receipts = [];
  let owned, released = false;
  const result = await runShellCard({ directory, binaries: { host: 'host' }, input, signals,
    launch: (_file, _args, options) => {
      owned = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/shell-card-fake.mjs', import.meta.url))], options);
      owned.stdout.once('data', () => { if (stop === 'EOF') input.end(); else signals.emit(stop); });
      return owned;
    },
    admission: { check: async () => {}, release: async () => { released = true; } },
    say: r => receipts.push(r), prompt: () => {}, timing: { poll: 1, ready: 1000, cleanup: 1000 },
  });
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.cleanup.hostExit, 0); assert.equal(released, true);
  assert.equal(owned.exitCode, 0); assert.equal(result.cleanup.children[0].pid, owned.pid);
  assert.ok(receipts.some(r => r.card?.outcome === 'cleanup'));
});

test('shell poster uses exact protected button, no-prompt preflights and PID-only posting', () => {
  const source = readFileSync(new URL('../bench/shell-card-poster.swift', import.meta.url), 'utf8');
  assert.match(source, /AXIsProcessTrusted\(\)/); assert.match(source, /CGPreflightPostEventAccess\(\)/);
  assert.match(source, /"Allow Once"/); assert.match(source, /CGWindowListCopyWindowInfo/);
  assert.match(source, /proc_pidpath/);
  assert.match(source, /appendingPathComponent\("shell-card"\)/);
  assert.match(source, /event\.postToPid\(pid\)/);
  assert.doesNotMatch(source, /Always allow|CGRequest|AXIsProcessTrustedWithOptions|event\.post\(tap:/);
});
