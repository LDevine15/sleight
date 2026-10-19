import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runOwned } from './preapproved-process.mjs';
import { heliumHelper } from './real-helium.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./real-fixture.js', import.meta.url));

// Setup capabilities belong to browser data. The older Firefox grid/spa tasks
// retain their IDs and setup outside this catalog.
export const webBrowsers = [
  { id: 'safari', app: 'Safari', bundle: 'com.apple.Safari', extension: false, legacyKinds: [], fixtureHelper: 'created-window', fixtureLaunch: 'retained-url' },
  { id: 'helium', app: 'Helium', bundle: 'net.imput.helium', extension: true, legacyKinds: [], fixtureHelper: 'created-window', fixtureLaunch: 'new-instance' },
  { id: 'chrome', app: 'Google Chrome', bundle: 'com.google.Chrome', extension: true, legacyKinds: [], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
  { id: 'firefox', app: 'Firefox', bundle: 'org.mozilla.firefox', extension: false, legacyKinds: ['grid', 'spa'], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
  { id: 'arc', app: 'Arc', bundle: 'company.thebrowser.Browser', extension: true, legacyKinds: [], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
];

// A long-lived JXA host read an owned Excel process as gone while an independent inspector found the same pid alive
// (Office investigation, 2026-10-17). An exit the JXA helpers report counts only when the kernel agrees: no such pid,
// another user's process, a zombie, or one that started after the launched app did (a reused pid).
export async function processExitConfirmed(pid, startedAtMs, { kill = (id, signal) => process.kill(id, signal), ps = processState } = {}) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try { kill(pid, 0); } catch (error) { if (error.code === 'ESRCH' || error.code === 'EPERM') return true; throw error; }
  const state = await ps(pid);
  if (!state || state.zombie) return true;
  return startedAtMs > 0 && state.startedAtMs > startedAtMs + 5000;
}

async function processState(pid) {
  let stdout;
  try { ({ stdout } = await execute('/bin/ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 })); }
  catch (error) { if (error.code === 1 && !String(error.stdout ?? '').trim()) return null; throw error; }
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout);
  if (!match) throw new Error(`Process ${pid} state unreadable`);
  return { zombie: match[1].startsWith('Z'), startedAtMs: new Date(match[2]).getTime() };
}

async function fixtureHelper(request, signal) {
  return webBrowsers.find(browser => browser.bundle === request.bundle)?.fixtureHelper === 'created-window'
    ? { command: await heliumHelper(signal), args: [] }
    : { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', script] };
}

// The child retains its AX window reference through cleanup. It never needs a
// window inventory or an Apple Event. Only a retained reference permits closing
// a window; a missing reference leaves cleanup unconfirmed.
// A document app launched without these restores the owner's windows and iCloud "Untitled" documents (TextEdit did, 2026-10-16),
// and then can't quit cleanly. The other bench launchers pass the same flags (bench/tasks.mjs).
const DOCUMENT_LAUNCH = ['--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO',
  '-NSDocumentSaveNewDocumentsToCloud', 'NO'];
export async function openFixture(ctx, request, { run = runOwned, open = execute, launch, helper = fixtureHelper, exited = processExitConfirmed } = {}) {
  const fixtureLaunch = webBrowsers.find(browser => browser.bundle === request.bundle)?.fixtureLaunch;
  const createdWindow = ['retained-url', 'new-instance'].includes(fixtureLaunch);
  const blankWindow = fixtureLaunch === 'retained-url' || (request.fixtureKind === 'web-page' && fixtureLaunch !== 'new-instance');
  if ((request.fixtureKind === 'web-page' || fixtureLaunch === 'retained-url') && ctx.ownerAway !== true) {
    throw Object.assign(new Error('Browser blank-window setup requires an explicit owner-away boundary'), { noMutation: true });
  }
  request = { ...request, runToken: ctx.nonce || request.runToken, fixtureLaunch,
    stopOnAppDialog: ctx.stopOnAppDialog || request.stopOnAppDialog, ownerAway: ctx.ownerAway === true };
  ctx.signal?.throwIfAborted();
  ctx.cleanupSignal?.throwIfAborted();
  const startedAtMs = Date.now();
  ctx.windowLeases ??= [];
  const launchedProcesses = ctx.windowLeases.filter(lease => lease.launched && lease.running === false &&
    lease.setupCase === 'cold-launch' && lease.bundle === request.bundle && lease.pid > 0 && lease.processStartedAtMs > 0)
    .map(({ pid, bundle, processStartedAtMs }) => ({ pid, bundle, processStartedAtMs }));
  const control = join(ctx.dir, `window-${ctx.windowLeases.length}-control.json`);
  const signal = ctx.signal;
  const controller = new AbortController();
  // Ordinary cancellation still needs this child's retained window reference.
  // A permission stop ends all AX activity immediately instead.
  const helperSignal = AbortSignal.any([controller.signal, ctx.cleanupSignal].filter(Boolean));
  const stages = new Map();
  const diagnostics = { app: request.app, bundle: request.bundle, retries: [], totalWaitMs: 0, actionTaken: false };
  (ctx.fixtureDiagnostics ??= []).push(diagnostics);
  const stage = name => {
    if (!stages.has(name)) stages.set(name, Promise.withResolvers());
    return stages.get(name);
  };
  // A disagreement keeps the live lock: executeRealTask and the runner read ctx.exitDisagreements before releasing it.
  const confirmExit = async (processes, step) => {
    for (const { pid, processStartedAtMs } of processes) {
      let gone = false, failure;
      try { gone = await exited(pid, processStartedAtMs); } catch (error) { failure = error.message; }
      if (gone) continue;
      diagnostics.cleanup = 'unconfirmed';
      diagnostics.exitDisagreement = { step, pid, ...(failure && { failure }) };
      (ctx.exitDisagreements ??= []).push({ app: request.app, bundle: request.bundle, step, pid });
      throw new Error(`Owned ${request.app} exit disagreement after ${step}: the JXA helper read pid ${pid} as gone, ` +
        `${failure ? `and the independent check failed (${failure})` : 'but the process is still running'}; live lock kept`);
    }
  };
  let buffer = '', response, completed;
  const untouched = result => result.groupClean === true && result.stdout?.split('\n').some(line => {
    try {
      const event = JSON.parse(line);
      return event.stage === 'untouched' || (event.stage === 'setup-failure' &&
        ['nothing created', 'closed retained fixture', 'unconfirmed'].includes(event.cleanup) &&
        (!createdWindow || event.cleanup !== 'unconfirmed') && !event.cleanupError);
    } catch { return false; }
  });
  const lease = {
    app: request.app,
    pids: [],
    launched: false,
    diagnostics,
    // The cold-launch lease of this run whose exact process (pid, bundle, start time) this lease attached to, if any.
    ownerLease() {
      if (lease.running !== true || !(lease.pid > 0) || !(lease.processStartedAtMs > 0) || lease.bundle !== request.bundle) return undefined;
      if (!launchedProcesses.some(item => item.pid === lease.pid && item.bundle === request.bundle &&
        item.processStartedAtMs === lease.processStartedAtMs)) return undefined;
      return ctx.windowLeases.find(other => other !== lease && other.running === false && other.launched && other.setupCase === 'cold-launch' &&
        other.pid === lease.pid && other.bundle === request.bundle && other.processStartedAtMs === lease.processStartedAtMs);
    },
    async quit({ final = false } = {}) {
      if (lease.running !== false || !lease.launched || request.app === 'Finder' || diagnostics.appQuit) return;
      if (createdWindow && diagnostics.windowCleanupConfirmed !== true) {
        throw new Error(`Owned ${request.app} window cleanup unconfirmed; app quit refused`);
      }
      const collected = await lease.dispose();
      diagnostics.helperCollectionConfirmed = collected;
      if (!collected && !final) throw new Error('Fixture helper collection unconfirmed; app quit refused');
      // Final native termination cannot answer a permission dialog or perform AX
      // actions. It still requires the exact PID and bundle this run launched.
      if (!final) { await ctx.beforeFixtureCleanup?.(); ctx.cleanupSignal?.throwIfAborted(); }
      if (!lease.pid) throw new Error('Launched app identity unconfirmed; quit refused');
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', script,
        JSON.stringify({ bundle: lease.bundle || request.bundle, mode: 'quit', pid: Number(lease.pid),
          ...(lease.processStartedAtMs > 0 && { processStartedAtMs: lease.processStartedAtMs }),
          ...(request.fixtureKind && { fixtureKind: request.fixtureKind, target: request.target }), ...(request.stopOnLiveHold && { stopOnLiveHold: true }) })], {
        signal: final ? undefined : ctx.cleanupSignal, timeoutMs: 35000,
      });
      for (const line of result.stdout?.split('\n') ?? []) {
        try { const event = JSON.parse(line); if (event.stage === 'quit' && event.quitWait) diagnostics.quitWait = event.quitWait; } catch {}
      }
      if (!result.groupClean || result.exit?.code !== 0) throw new Error(`Launched ${request.app} quit unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
      await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'quit');
      diagnostics.appQuit = true;
    },
    async close() {
      if (completed && untouched(completed)) { diagnostics.windowCleanupConfirmed = true; return; }
      if (ctx.cleanupSignal?.aborted) { await lease.dispose(); throw new Error('Fixture cleanup stopped by a permission window'); }
      writeControl('close');
      let timer;
      const result = await Promise.race([response, new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ error: 'Fixture cleanup timed out', groupClean: false });
      }, 30000); })]).finally(() => clearTimeout(timer));
      if (untouched(result)) { diagnostics.windowCleanupConfirmed = true; return; }
      const closed = result.stdout?.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.stage === 'closed');
      if (!result.groupClean || result.error || result.exit.code !== 0 || !closed) {
        diagnostics.closeFailure = result.stderr?.trim() || result.error;
        diagnostics.cleanup = 'unconfirmed';
        throw new Error(`Owned ${request.app} fixture window cleanup unconfirmed${diagnostics.closeFailure ? ': ' + diagnostics.closeFailure : ''}`);
      }
      // The helper skips the close when it reads the app as gone. That read came from a long-lived host, so the kernel must agree.
      if (closed.appAbsent === true) await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'window cleanup');
      diagnostics.windowCleanupConfirmed = true;
    },
    async recover() {
      if (request.mode !== 'document') throw new Error('Fixture recovery requires a document fixture');
      // A second document opened in the app an earlier lease of this run launched (textedit-two-windows and
      // textedit-window-drag). That lease recovers first and quits the app, which takes this window with it, so this one
      // only confirms the exact process is gone. Before this, such a cleanup failure stopped its pass (2 on 2026-10-19).
      const owner = createdWindow || !lease.launched ? undefined : lease.ownerLease();
      if (owner) {
        if (owner.diagnostics.appQuit !== true) throw new Error('Fixture recovery requires the launching lease to quit its app first');
        diagnostics.appQuit = false;
        diagnostics.helperCollectionConfirmed = await lease.dispose();
        if (!diagnostics.helperCollectionConfirmed) throw new Error('Fixture helper collection unconfirmed; recovery refused');
        await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'recovery');
        diagnostics.cleanup = 'closed with launched app';
        diagnostics.windowCleanupConfirmed = true;
        diagnostics.appQuit = true;
        return;
      }
      if (createdWindow || lease.running !== false || !lease.launched) throw new Error('Fixture recovery requires an app launched by this run');
      diagnostics.appQuit = false;
      diagnostics.helperCollectionConfirmed = await lease.dispose();
      if (!diagnostics.helperCollectionConfirmed) throw new Error('Fixture helper collection unconfirmed; recovery refused');
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify({
        ...request, mode: 'recover', fixtureMode: request.mode, running: lease.running, launched: lease.launched,
        fixtureDir: ctx.dir, runToken: ctx.nonce || request.token, startedAtMs,
        pids: [...new Set([...lease.pids, lease.pid].filter(pid => Number.isInteger(pid) && pid > 0))],
      })], { signal: ctx.cleanupSignal, timeoutMs: 90000 });
      const receipt = result.stdout?.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.stage === 'recovered');
      if (!result.groupClean || result.exit?.code !== 0 || !receipt) throw new Error(`Owned ${request.app} fixture recovery unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
      const starts = new Map((Array.isArray(receipt.processes) ? receipt.processes : []).map(item => [item.pid, item.processStartedAtMs]));
      if (lease.pid > 0 && lease.processStartedAtMs > 0) starts.set(lease.pid, lease.processStartedAtMs);
      const quitPids = [...new Set([lease.pid, ...(Array.isArray(receipt.pids) ? receipt.pids : [])].filter(pid => Number.isInteger(pid) && pid > 0))];
      await confirmExit(quitPids.map(pid => ({ pid, processStartedAtMs: starts.get(pid) })), 'recovery');
      diagnostics.cleanup = 'closed retained fixture';
      diagnostics.windowCleanupConfirmed = true;
      diagnostics.appQuit = true;
    },
    async dispose() { controller.abort(); return (await response).groupClean === true; },
  };
  let command;
  const writeControl = command => writeFileSync(control, JSON.stringify({
    command, launched: lease.launched,
    ...(lease.simulatorBooted === true ? { simulatorBooted: true } : {}),
  }), { mode: 0o600 });
  const beginLaunch = (launched = true) => {
    lease.launched = launched;
    diagnostics.launched = launched;
    writeControl('launching');
  };
  Object.defineProperty(beginLaunch, 'simulatorBooted', {
    set(value) { lease.simulatorBooted = value === true; },
    get() { return lease.simulatorBooted === true; },
  });
  try { command = await helper(request, signal); }
  catch (error) { if (error.noMutation === true) diagnostics.cleanup = 'nothing created'; throw error; }
  ctx.windowLeases.push(lease);
  response = run(command.command, [...command.args, JSON.stringify({ ...request, control, startedAtMs, launchedProcesses })], {
    signal: helperSignal, timeoutMs: 600000, graceMs: 1000,
    onStdout: data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (typeof event.running === 'boolean') { lease.running = event.running; diagnostics.running = event.running; }
        if (event.pid > 0) { lease.pid = event.pid; diagnostics.pid = event.pid; }
        if (event.bundle) { lease.bundle = event.bundle; diagnostics.observedBundle = event.bundle; }
        if (event.processStartedAtMs > 0) { lease.processStartedAtMs = event.processStartedAtMs; diagnostics.processStartedAtMs = event.processStartedAtMs; }
        if (event.setupCase) lease.setupCase = event.setupCase;
        const recorded = [...(Array.isArray(event.pids) ? event.pids : []), event.pid,
          event.processHandoff?.fromPid, event.processHandoff?.toPid].filter(pid => Number.isInteger(pid) && pid > 0);
        if (recorded.length) { lease.pids = [...new Set([...lease.pids, ...recorded])]; diagnostics.pids = lease.pids; }
        if (event.processHandoff) diagnostics.processHandoff = event.processHandoff;
        // A fixture save prompt the helper answered at cleanup: which button, on which window, from where.
        if (event.fixtureSheet) (diagnostics.fixtureSheets ??= []).push(event.fixtureSheet);
        if (event.appDialog) {
          (diagnostics.appDialogs ??= []).push(event.appDialog);
          if (event.appDialog.stop !== false) diagnostics.appDialog = event.appDialog;
          ctx.onAppDialog?.(event.appDialog);
        }
        if (event.stage === 'retry') {
          const retry = { code: event.code, waitMs: event.waitMs, totalWaitMs: event.totalWaitMs, setupCase: event.setupCase };
          if (['cleanup', 'observation'].includes(event.phase)) {
            (diagnostics[event.phase + 'Retries'] ??= []).push(retry);
            diagnostics[event.phase + 'TotalWaitMs'] = event.totalWaitMs;
          } else diagnostics.retries.push(retry);
        }
        for (const key of ['fixtureWindow', 'menuCleanup', 'menuCleanupError', 'menuCleared', 'menuEscapePid', 'windows', 'fresh', 'totalWaitMs', 'actionTaken', 'cleanup', 'cleanupError', 'menuCancelled', 'menuCancelMethod', 'menuItems', 'menuCommands', 'readiness', 'navigation', 'creation', 'foregroundFallback', 'launchWait', 'readWait', 'cleanupReadWait', 'observationReadWait', 'setupCase', 'inheritReady', 'placement']) {
          if (event[key] !== undefined) diagnostics[key] = event[key];
        }
        ctx.onFixtureDiagnostics?.(diagnostics);
        if (event.stage) stage(event.stage).resolve(event);
      }
    },
  }).catch(error => ({ error: error.message, groupClean: false })).then(result => { completed = result; return result; });
  const waitStage = async name => {
    let timer;
    try {
      return await Promise.race([stage(name).promise, response.then(result => {
        throw Object.assign(new Error(`Fixture setup failed: ${result.stderr?.trim() || result.error || 'helper exited before readiness'}`),
          { noMutation: untouched(result) });
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture setup readiness timed out')), 40000); })]);
    } finally { clearTimeout(timer); }
  };
  try {
  if (blankWindow) {
    await waitStage('launch');
    beginLaunch();
    await open('/usr/bin/open', fixtureLaunch === 'retained-url' ? ['-g', '-a', request.app, '--args', '-ApplePersistenceIgnoreState', 'YES'] : ['-g', '-b', request.bundle], { signal, timeout: 15000 });
  }
  await waitStage('armed');
  signal?.throwIfAborted();
  if (launch) await launch(beginLaunch);
  else if (request.fixtureKind === 'web-page' && fixtureLaunch !== 'retained-url' && fixtureLaunch !== 'new-instance') {
    await open('/usr/bin/open', ['-g', '-b', request.bundle, request.target], { signal, timeout: 15000 });
  } else if (fixtureLaunch !== 'retained-url') {
    beginLaunch();
    const args = fixtureLaunch === 'new-instance'
      ? ['-n', '-g', '-a', request.app, '--args', '--new-window', request.target]
      : ['-g', '-a', request.app, ...(request.target ? [request.target] : []), ...(request.mode === 'document' ? DOCUMENT_LAUNCH : [])];
    await open('/usr/bin/open', args, { signal, timeout: 15000 });
  }
  writeControl('opened');
  await waitStage('ready');
  return lease;
  } catch (error) {
    // LaunchServices errors and readiness deadlines can precede the helper's
    // recovery receipt. Await that receipt before deciding acquisition status.
    try { await ctx.beforeFixtureCleanup?.(); await lease.close(); error.noMutation = true; } catch {}
    error.fixtureDiagnostics = diagnostics;
    throw error;
  }
}

export async function closeFixtures(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close(); } catch (error) { errors.push(error.message); }
    try {
      if (lease.running === false && lease.launched) {
        if (!await lease.dispose()) throw new Error('Fixture helper collection unconfirmed; app quit refused');
        await lease.quit();
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export async function retryFixtureCleanup(ctx) {
  const leases = ctx.windowLeases ?? [];
  if (!leases.length || ctx.pendingAcquisitions?.size) throw new Error('Fixture recovery ownership unconfirmed');
  // A lease that attached to an app another lease launched recovers after it, once that lease has quit the app.
  const adopted = lease => typeof lease.ownerLease === 'function' && !!lease.ownerLease();
  const ordered = [...leases].reverse();
  for (const lease of ordered.filter(lease => !adopted(lease))) await lease.recover();
  for (const lease of ordered.filter(adopted)) await lease.recover();
}
