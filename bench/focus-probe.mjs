// SR1 design C experiment only. Imports are inert; the live entry point is explicit.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { startLoadWorkers } from './load-workers.mjs';
import { launchCommand } from './small-fixes-textedit-lib.mjs';

export function parseArgs(argv) {
  const result = { workers: 0, trials: 20, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { result.help = true; continue; }
    const key = { '--workers': 'workers', '--trials': 'trials' }[argv[i]];
    if (!key || !/^\d+$/.test(argv[i + 1] ?? '')) throw new Error('Expected --workers 0..20 or --trials 1..100');
    result[key] = Number(argv[++i]);
    if (result[key] > (key === 'workers' ? 20 : 100) || (key === 'trials' && result[key] < 1)) throw new Error('Argument out of range');
  }
  return result;
}

export function focusReady(value, baseline) {
  return value?.status === 'ok' && baseline?.status === 'ok' && value.owned === true &&
    ['epoch', 'pid', 'processStart'].every(key => value[key] === baseline[key]) &&
    Number.isSafeInteger(value.element) && value.element > 0 && Number.isSafeInteger(value.surface) &&
    value.surface > 0 && value.surface !== baseline.surface &&
    ['AXTextField', 'AXTextArea', 'AXComboBox'].includes(value.role) &&
    (['AXSheet', 'AXDialog'].includes(value.windowRole) || ['AXDialog', 'AXSystemDialog'].includes(value.windowSubrole));
}

export async function waitForFocus({ baseline, observe, now = () => performance.now(), sleep: pause = sleep }) {
  const start = now(); let polls = 0, last;
  const result = reason => ({ reason, polls, waitMs: now() - start });
  if (baseline?.status !== 'ok') return result('baseline-error');
  for (;;) {
    if (now() - start >= 1500) return result('cap');
    let value;
    polls++;
    try { value = await observe(); } catch { return result('ax-error'); }
    if (now() - start >= 1500) return result('cap');
    if (value?.status !== 'ok') return result('ax-error');
    const key = focusReady(value, baseline) ? JSON.stringify([value.epoch, value.pid, value.processStart,
      value.surface, value.element, value.role, value.subrole, value.windowRole, value.windowSubrole]) : null;
    if (key && key === last) return result(null);
    last = key;
    await pause(Math.min(20, 1500 - (now() - start)));
  }
}

export const folderPath = bank => join(bank, 'd'.repeat(127 - bank.length - 1));

export async function runTrial({ arm, index, path, call, observe, fixture, now = () => performance.now(), sleep: pause = sleep }) {
  const entry = { arm, index, waits: [], correct: false }, start = now();
  const checked = async code => { const reply = await call(code); if (reply?.isError) throw new Error('Engine error; body omitted'); return reply; };
  try {
    const before = await fixture('document');
    assert.ok(before.documentUnchanged && before.clean, 'Fixture is not clean before trial');
    for (const key of ['super+o', 'super+shift+g']) {
      let baseline;
      if (arm === 'focus') { try { baseline = await observe(); } catch { baseline = { status: 'unknown' }; } }
      await checked(`await app.pressKey(${JSON.stringify(key)})`);
      const waitStart = now();
      const wait = arm === 'focus' ? await waitForFocus({ baseline, observe, now, sleep: pause }) : { reason: null, polls: 0 };
      if (arm === 'read' || wait.reason) await checked('await app.getAXState({ disableDiffing: true })');
      entry.waits.push({ opener: key, ...wait, waitMs: now() - waitStart, fallback: arm === 'focus' && !!wait.reason });
      if (key === 'super+o') assert.equal((await fixture('open')).openBound, true, 'Open modal unproved');
    }
    await checked(`await app.typeText(${JSON.stringify(path)})`);
    const field = await fixture('field');
    entry.fullPath = field.value === path; entry.documentUnchanged = field.documentUnchanged;
    assert.ok(entry.fullPath && entry.documentUnchanged, 'Cut path or input into document; stop before Return');
    await checked('await app.pressKey("Return")');
    await checked('await app.getAXState({ disableDiffing: true })');
    entry.documentUnchanged = (await fixture('document')).documentUnchanged;
    entry.correct = entry.fullPath && entry.documentUnchanged;
  } catch (error) { entry.error = error.message; }
  entry.totalCallMs = now() - start;
  return entry;
}

export async function cleanupOwned(inventory) {
  const result = { confirmed: true, resources: [] };
  for (const name of ['fixture', 'engine', 'observer', 'workers', 'bank', 'lock']) {
    if (!inventory[name]) continue;
    if (['bank', 'lock'].includes(name) && !result.confirmed) { result[name + 'Retained'] = true; continue; }
    try { await inventory[name](); result.resources.push({ name, closed: true }); }
    catch (error) { result.confirmed = false; result.resources.push({ name, closed: false, error: error.message }); }
  }
  return result;
}

export function summarize(trials, count = 20) {
  const median = values => { const sorted = values.sort((a, b) => a - b), n = sorted.length;
    return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null; };
  const arms = Object.fromEntries(['focus', 'read'].map(arm => {
    const rows = trials.filter(trial => trial.arm === arm);
    return [arm, { count: rows.length, correct: rows.filter(row => row.correct).length,
      medianMs: median(rows.map(row => row.totalCallMs)), fallbacks: rows.flatMap(row => row.waits ?? []).filter(row => row.fallback).length }];
  }));
  const complete = Object.values(arms).every(arm => arm.count === count && arm.correct === count);
  const savingMs = arms.read.medianMs === null || arms.focus.medianMs === null ? null : arms.read.medianMs - arms.focus.medianMs;
  const kill = trials.some(trial => trial.arm === 'focus' && !trial.correct) || (savingMs !== null && savingMs < 500);
  return { arms, savingMs, kill, qualified: complete && !kill, pilotOnly: true };
}

// Serial persistent JXA process, following guard-window-observer's no-queue pattern. A
// timed-out helper is retired; late replies cannot satisfy the next request.
export function startHelper(script, args = [], { spawnHelper = () => spawn('/usr/bin/osascript',
  ['-l', 'JavaScript', fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'pipe'] }) } = {}) {
  const child = spawnHelper(); let pending, nextId = 0, failed, exited = false, closing;
  const stopped = new Promise(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const fail = error => { failed = error; pending?.finish(error); pending = undefined; };
  child.on('error', fail); child.on('exit', () => fail(new Error('Helper exited'))); child.stdin.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply; try { reply = JSON.parse(line); } catch { fail(new Error('Invalid helper reply')); return; }
    if (!pending || reply.id !== pending.id) return;
    const slot = pending; pending = undefined;
    slot.finish(reply.ok === false ? new Error(reply.error ?? 'AX error') : null, reply);
  });
  const request = (payload, timeoutMs = 2000) => new Promise((accept, reject) => {
    if (failed || closing || pending) { reject(failed ?? new Error('Helper busy or closing')); return; }
    const id = nextId++, timer = setTimeout(() => fail(new Error('AX helper deadline exceeded')), timeoutMs);
    pending = { id, finish: (error, reply) => { clearTimeout(timer); error ? reject(error) : accept(reply); } };
    child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
  });
  const close = () => closing ||= (async () => {
    fail(new Error('Helper closing')); child.stdin.end();
    const gentle = setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 500);
    const force = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1500);
    try { return await stopped; } finally { clearTimeout(gentle); clearTimeout(force); lines.close(); }
  })();
  return { request, close };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log('node bench/focus-probe.mjs [--workers 20] [--trials 20]\nLive TextEdit probe: sleight-arch only, owner away. Writes bench/results/focus-probe-*.json.'); return; }
  assert.equal(process.platform, 'darwin', 'Live probe requires macOS');
  const report = { started: new Date().toISOString(), options, load: loadavg(), trials: [], records: [] };
  let release, bank, fixture, observer, client, stopWorkers, opened = false, attached = false, cancelled = false;
  const ensureFree = async () => {
    assert.ok(!cancelled, 'Cancelled');
    try { await access('/tmp/sleight-hold'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Live hold exists; stopping input');
  };
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const checked = async code => {
    await ensureFree(); const reply = await client.call('js', { code });
    assert.ok(!reply?.isError, 'Engine error; body omitted'); return reply;
  };
  const fixtureState = async op => {
    const value = await fixture.request({ op }, 5000);
    const bytes = await readFile(join(bank, 'exact.txt'));
    value.documentUnchanged = value.text === 'SR1 owned fixture\n' && bytes.equals(Buffer.from('SR1 owned fixture\n'));
    return value;
  };
  const dismiss = async () => {
    for (let i = 0; i < 4; i++) {
      const state = await fixture.request({ op: 'inventory' }, 5000);
      if (state.clean) return;
      assert.ok(state.owned && client, 'Panel ownership or cleanup engine unconfirmed');
      // Cleanup may finish after SIGINT/hold, but sends only Escape to confirmed owned panels.
      const reply = await client.call('js', { code: 'await app.pressKey("Escape"); await app.getAXState({ disableDiffing: true })' });
      assert.ok(!reply?.isError, 'Panel cleanup failed');
    }
    throw new Error('Owned panels remain after cleanup');
  };
  try {
    await ensureFree(); release = await acquireLiveLock();
    bank = await mkdtemp('/private/tmp/sleight-exact-'); report.bank = bank;
    const path = join(bank, 'exact.txt'), folder = folderPath(bank);
    await mkdir(folder); await writeFile(path, 'SR1 owned fixture\n');
    fixture = startHelper('./focus-probe-fixture.js', [path]);
    const preflight = await fixture.request({ op: 'preflight' }, 5000);
    assert.ok(preflight.safe, 'TextEdit must be absent or empty and in the background');
    const [command, args] = launchCommand(path);
    await ensureFree(); opened = true;
    await promisify(execFile)(command, args, { timeout: 10000 });
    for (const deadline = Date.now() + 8000; ;) {
      const reply = await fixture.request({ op: 'attach' }, 5000);
      if (reply.attached) { attached = true; break; }
      assert.ok(Date.now() < deadline, 'Fixture attachment timed out'); await sleep(100);
    }
    const server = resolveServer(); assert.ok(!server.error, server.error); report.engineVersion = server.version;
    client = await probeClient(server, { relay: false, label: 'focus-probe', record: entry => {
      if (entry.event) report.records.push({ event: entry.event, code: entry.code, signal: entry.signal });
    } });
    const acquired = await checked('var app = await cua.getApp("com.apple.TextEdit")');
    assert.equal(windowFromText((acquired.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n'))?.url,
      pathToFileURL(path).href, 'Engine selected another document; no input sent');
    // Metadata observer starts only after the engine has approved and read the owned app.
    observer = startHelper('./focus-probe-ax.js', [path]);
    assert.equal((await observer.request({ op: 'bind' }, 5000)).status, 'ok');
    const observe = () => observer.request({ op: 'focus', timeoutMs: 100 }, 1500);
    await observe(); // Warm the persistent process before timing.
    if (options.workers) stopWorkers = startLoadWorkers(options.workers, { onError: error => { cancelled = true; report.workerError = error.message; } });
    for (let index = 1; index <= options.trials; index++) for (const arm of ['focus', 'read']) {
      await dismiss(); await ensureFree();
      const trial = await runTrial({ arm, index, path: folder, call: checked, observe, fixture: fixtureState });
      report.trials.push(trial); console.log(JSON.stringify(trial));
      if (!trial.correct) throw new Error('Trial failed; stopping input');
    }
    await dismiss();
    if (options.workers) {
      // Design D uses a single numbered click on the owned document's text area, then one
      // AXRole fetch (1 s messaging timeout), an engine read and a second idle engine read.
      const treeReply = await checked('await app.getAXState({ disableDiffing: true })');
      const tree = (treeReply.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      const numbers = [...tree.matchAll(/^\s*(\d+) text area\b/gm)].map(match => Number(match[1]));
      assert.equal(numbers.length, 1, 'No unique owned text area for load click');
      await fixtureState('document'); await checked(`await app.click(${numbers[0]})`);
      const start = performance.now(), attribute = await observer.request({ op: 'attribute', timeoutMs: 1000 }, 2000);
      report.loadComparison = { attributeMs: performance.now() - start, attributeStatus: attribute.status };
      for (const name of ['readMs', 'idleReadMs']) { const at = performance.now(); await checked('await app.getAXState({ disableDiffing: true })');
        report.loadComparison[name] = performance.now() - at; }
    }
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    report.cleanup = await cleanupOwned({
      ...(fixture ? { fixture: async () => {
        try {
          if (opened) { if (!attached) assert.ok((await fixture.request({ op: 'attach' }, 5000)).attached, 'Cleanup attachment unconfirmed');
            await dismiss(); assert.ok((await fixture.request({ op: 'close' }, 5000)).closed); }
        } finally { await fixture.close(); }
      } } : {}),
      ...(client ? { engine: () => client.close() } : {}), ...(observer ? { observer: () => observer.close() } : {}),
      ...(stopWorkers ? { workers: stopWorkers } : {}), ...(bank ? { bank: () => rm(bank, { recursive: true }) } : {}),
      ...(release ? { lock: release } : {}),
    });
    report.summary = summarize(report.trials, options.trials);
    if (!report.cleanup.confirmed || !report.summary.qualified) process.exitCode = 1;
    report.finished = new Date().toISOString(); report.loadAfter = loadavg();
    const outputDirectory = fileURLToPath(new URL('./results/', import.meta.url)); await mkdir(outputDirectory, { recursive: true });
    const output = join(outputDirectory, `focus-probe-${Date.now()}.json`);
    await writeFile(output, JSON.stringify(report, null, 2).replaceAll(homedir(), '~') + '\n');
    console.log(`Published ${output.replaceAll(homedir(), '~')}`);
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
