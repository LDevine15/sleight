// The live part of the compatibility suite: one Calculator task and one engine-path page read in Safari, through
// sleight's launcher. Both open windows, so they run only with --owner-away, outside another project's hold, under the
// benchmark's live lock, and only on an app this run launched itself: an app that was already running may be the owner's.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hasIdentifier, hasLabel } from '../../plugins/sleight/lib/document-scope.mjs';
import { calculatorValue } from '../calculator-value.mjs';
import { textOf } from './client.mjs';

const execute = promisify(execFile);
const FIXTURE_SCRIPT = fileURLToPath(new URL('../waits-targeting-fixture.js', import.meta.url));
export const CALCULATOR = 'com.apple.calculator';
export const SAFARI = 'com.apple.Safari';
export const COMPAT_APPS = ['Calculator', CALCULATOR, 'Safari', SAFARI];
// The engine's window header and element lines, as document-scope.mjs and helper-health.mjs parse them.
export const WINDOW_HEADER = /^Window: (.*), App: (.+)\r?$/m;
const ELEMENT_LINE = /^\t*\d+ \S/m;
const BENCHMARK_PROFILE = 'sleight benchmark';
export function fixtureWindowTitle(title, marker) {
  const value = String(title ?? '').replace(/^"(.*)"$/, '$1');
  return value === marker || value === `${BENCHMARK_PROFILE} \u2014 ${marker}`;
}

const result = (id, status, reason, detail) => ({ id, status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300);

// Is the live part allowed to start? Every "no" is a pending result with its reason, never a failure.
export function liveGate({ ownerAway, holdPath = '/tmp/sleight-hold', idleSeconds, minIdleSeconds = 0, exists = existsSync }) {
  if (!ownerAway) return { pending: 'not requested: the live checks open Calculator and a Safari window, so they need --owner-away' };
  if (exists(holdPath)) return { pending: `${holdPath} exists (another project's timed window)` };
  if (minIdleSeconds > 0 && !(idleSeconds >= minIdleSeconds)) {
    return { pending: `the Mac was in use (idle ${Number.isFinite(idleSeconds) ? Math.round(idleSeconds) : 'unknown'} s, needs ${minIdleSeconds} s)` };
  }
  return { ok: true };
}

// Seconds since the last keyboard or pointer input, from IOHIDSystem's HIDIdleTime (nanoseconds).
export function parseIdle(ioreg) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg ?? '');
  return match ? Number(match[1]) / 1e9 : undefined;
}
export async function idleSeconds() {
  try { return parseIdle((await execute('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 10000, maxBuffer: 8 << 20 })).stdout); }
  catch { return undefined; }
}

// The keypad numbers for 17 × 23 from Calculator's tree. History-open trees can list a button twice, byte-identical
// apart from the number (2026-10-11); identical copies are the same button, and differing ones stop the plan.
function button(tree, id, label) {
  const hits = [];
  for (const line of tree.split('\n')) {
    const match = /^\t*(\d+) (button(?: .*)?)$/.exec(line);
    if (match && ((id && hasIdentifier(match[2], id)) || (label && hasLabel(match[2], label)))) hits.push({ n: Number(match[1]), line: match[2] });
  }
  return hits.length && hits.every(hit => hit.line === hits[0].line) ? hits[0].n : undefined;
}
export function keypadPlan(tree) {
  const wanted = [['One', '1'], ['Seven', '7'], [undefined, 'Multiply'], ['Two', '2'], ['Three', '3'], [undefined, 'Equals']];
  const clear = button(tree, 'AllClear', 'All Clear') ?? button(tree, undefined, 'Clear');
  const keys = wanted.map(([id, label]) => button(tree, id, label));
  const missing = wanted.filter((_, i) => keys[i] === undefined).map(([id, label]) => id ?? label);
  if (missing.length) return { error: `Calculator's tree has no unique ${missing.join(', ')} button` };
  const numbers = [...(clear === undefined ? [] : [clear]), ...keys];
  return { numbers, expected: '391', code: numbers.map(n => `await app.click(${n})`).join('; ') };
}

// getAXState prints its tree itself unless emit is false, so writing it too printed the tree twice. The first live run
// (2026-10-19) then found two edit fields and failed on a display that read 391.
const readCode = handle => `nodeRepl.write(await ${handle}.getAXState({ emit: false, disableDiffing: true }))`;

export async function runCalculator(client, { appState, launchApp, quitApp }) {
  const started = Date.now();
  const before = await appState(CALCULATOR);
  if (before.running) return result('live-calculator', 'skip', 'Calculator was already running, so it may be the owner\'s; the check uses only a Calculator it launches');
  let launched, outcome;
  try {
    launched = await launchApp(CALCULATOR);
    const acquired = await client.call('js', { code: `var app = await cua.getApp(${JSON.stringify(CALCULATOR)})`, timeout_ms: 60000 });
    const text = textOf(acquired);
    if (acquired?.isError) outcome = result('live-calculator', 'fail', 'getApp returned an error', firstLine(text));
    else if (!WINDOW_HEADER.test(text) || !ELEMENT_LINE.test(text)) outcome = result('live-calculator', 'fail', 'getApp returned no "Window: …, App: …" header and numbered element lines');
    else {
      const tree = await client.call('js', { code: readCode('app'), timeout_ms: 60000 });
      const plan = keypadPlan(textOf(tree));
      if (tree?.isError) outcome = result('live-calculator', 'fail', 'getAXState returned an error', firstLine(textOf(tree)));
      else if (plan.error) outcome = result('live-calculator', 'fail', plan.error);
      else {
        const clicked = await client.call('js', { code: plan.code, timeout_ms: 60000 });
        let display;
        try { display = clicked?.isError ? undefined : calculatorValue(textOf(await client.call('js', { code: readCode('app'), timeout_ms: 60000 }))); }
        catch (error) { display = error.message; }
        const shot = await client.call('js', { code: 'await app.getScreenshot()', timeout_ms: 30000 });
        const image = (shot?.content ?? []).find(item => item?.type === 'image' && /^image\//.test(item.mimeType ?? '') && item.data);
        if (clicked?.isError) outcome = result('live-calculator', 'fail', 'a click returned an error', firstLine(textOf(clicked)));
        else if (display !== plan.expected) outcome = result('live-calculator', 'fail', `the display didn't read ${plan.expected}`, String(display).slice(0, 80));
        else if (shot?.isError || !image) outcome = result('live-calculator', 'fail', 'getScreenshot returned no image', shot?.isError ? firstLine(textOf(shot)) : undefined);
        else outcome = result('live-calculator', 'pass', `17 × 23 = 391 in ${plan.numbers.length} clicks, read back, and a screenshot`);
      }
    }
  } catch (error) {
    outcome = result('live-calculator', 'error', 'the check stopped', firstLine(error.message));
  } finally {
    // A launch that failed part way may still have started Calculator; quitApp leaves any process it can't prove is ours.
    const cleanup = await quitApp(CALCULATOR, launched).then(() => undefined, error => error.message);
    outcome ??= result('live-calculator', 'fail', 'no result');
    if (cleanup) outcome = { ...outcome, cleanup, ...(outcome.status === 'pass' ? { status: 'fail', reason: 'passed, but quitting the Calculator it launched failed' } : {}) };
  }
  return { ...outcome, ms: Date.now() - started };
}

// One engine-path page read: a page served on 127.0.0.1 in a Safari window this run created, chosen by its title through
// sleight's select_window, then acquired and read with getApp as Claude would.
export async function runBrowserRead(client, { appState, openPage, axTrusted, quitLaunchedSince,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), titleWaitMs = 10000 }) {
  const started = Date.now();
  const before = await appState(SAFARI);
  if (before.running) return result('live-browser-read', 'skip', 'Safari was already running, so it may be the owner\'s; the check uses only a Safari it launches');
  // The fixture helper reads Safari's windows through Accessibility. Without a grant (a launchd job has none) macOS would
  // ask the owner, so the check skips instead.
  if (axTrusted && !(await axTrusted())) return result('live-browser-read', 'skip', 'this process has no Accessibility grant, so the fixture window can\'t be opened without a macOS prompt; run npm run compat -- --owner-away from a terminal');
  let page, outcome, opening, diagnostics;
  try {
    opening = Date.now();
    page = await openPage();
    diagnostics = page.diagnostics;
    // Native listApps may omit windows. The helper's retained reference supplies
    // profile proof. Its title may still be the loading URL.
    const conflictingTitle = String(page.window?.title ?? '').endsWith(` \u2014 ${page.marker}`) && !fixtureWindowTitle(page.window.title, page.marker);
    if (page.window?.profile !== BENCHMARK_PROFILE || conflictingTitle) {
      outcome = result('live-browser-read', 'fail', 'the fixture has no verified benchmark-profile window receipt');
    }
    else {
      const expectedTitle = `${page.window.profile} \u2014 ${page.marker}`;
      // The title window starts when the first attempt ends, since a cold first getApp can take seconds (2026-10-19:
      // a 3 s window that included it left the retries 1 ms). Every attempt keeps the full engine budgets.
      let deadline;
      const reasons = [];
      for (let attempt = 0; attempt <= Math.ceil(titleWaitMs / 100); attempt++) {
        try {
          const selected = await client.call('select_window', { app: 'Safari', title: expectedTitle }, 30000);
          const read = selected?.isError ? undefined : await client.call('js', { code: `var page = await cua.getApp(${JSON.stringify(SAFARI)})`, timeout_ms: 60000 });
          const text = textOf(read);
          const header = WINDOW_HEADER.exec(text);
          if (selected?.isError) outcome = result('live-browser-read', 'fail', 'select_window returned an error', firstLine(textOf(selected)));
          else if (read?.isError) outcome = result('live-browser-read', 'fail', 'getApp returned an error', firstLine(text));
          else if (!header || !fixtureWindowTitle(header[1], page.marker)) outcome = result('live-browser-read', 'fail', 'the read shows another window or profile than the fixture page');
          else if (!text.includes(page.body)) outcome = result('live-browser-read', 'fail', "the read has the fixture window but not the page's text");
          else outcome = result('live-browser-read', 'pass', 'read the fixture page through the engine path');
        } catch (error) { outcome = result('live-browser-read', 'fail', 'the fixture title was not ready', firstLine(error.message)); }
        deadline ??= Date.now() + titleWaitMs;
        if (outcome.status !== 'pass' && !reasons.includes(outcome.reason)) reasons.push(outcome.reason);
        if (outcome.status === 'pass' || Date.now() >= deadline || attempt === Math.ceil(titleWaitMs / 100)) {
          if (outcome.status !== 'pass' && reasons.length > 1) outcome = { ...outcome, attempts: reasons };
          break;
        }
        await sleep(100);
      }
    }
  } catch (error) {
    diagnostics = error.fixtureDiagnostics;
    outcome = result('live-browser-read', 'error', 'the check stopped', firstLine(error.message));
  } finally {
    const closed = page ? await page.close().then(() => undefined, error => error.message) : undefined;
    // The fixture quits Safari only after closing the window it created. A setup that failed before it had one left
    // Safari and its Start Page window running (2026-10-19), so the check then quits the Safari it launched itself.
    let cleanup = closed, quitSafari;
    if (opening !== undefined && quitLaunchedSince) {
      const quit = await quitLaunchedSince(SAFARI, opening, { pid: diagnostics?.pid ?? page?.window?.pid, unprovenWindow: diagnostics?.cleanup === 'unproven window left open' }).then(done => { quitSafari = done; }, error => error.message);
      cleanup = quit ? [closed, quit].filter(Boolean).join('; ') : undefined;
    }
    outcome ??= result('live-browser-read', 'fail', 'no result');
    if (quitSafari) outcome = { ...outcome, quitSafari: true };
    if (closed && !cleanup) outcome = { ...outcome, fixtureCleanup: closed };
    if (cleanup) outcome = { ...outcome, cleanup, ...(outcome.status === 'pass' ? { status: 'fail', reason: 'passed, but closing the fixture window or Safari failed' } : {}) };
  }
  return { ...outcome, ...(diagnostics?.menuCancelMethod === 'Escape' ? { escapePosted: true, menuEscapePid: diagnostics.menuEscapePid } : {}), ms: Date.now() - started };
}

// The real app helpers. The running check and quit go through NSRunningApplication (no Apple events), and the quit
// refuses unless the one running process is the one this run launched.
export async function appState(bundle) {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', FIXTURE_SCRIPT, JSON.stringify({ op: 'running', appId: bundle })], { timeout: 15000 });
  return JSON.parse(stdout);
}
export async function launchApp(bundle, { state = appState, run = execute, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  await run('/usr/bin/open', ['-g', '-b', bundle], { timeout: 15000 });
  for (let i = 0; i < 100; i++) {
    const now = await state(bundle);
    if (now.pids?.length === 1) return { pid: now.pids[0] };
    if (now.pids?.length > 1) throw new Error(`${bundle} has ${now.pids.length} processes`);
    await sleep(100);
  }
  throw new Error(`${bundle} did not start`);
}
export async function quitApp(bundle, launched, { state = appState, run = execute, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = 5000 } = {}) {
  const now = await state(bundle);
  if (!now.running) return;
  if (now.pids?.length !== 1 || now.pids[0] !== launched?.pid) throw new Error(`${bundle} is not the one process this run launched; left running`);
  // The script checks the pid (and the launch date, when given) again just before it quits.
  await run('/usr/bin/osascript', ['-l', 'JavaScript', FIXTURE_SCRIPT, JSON.stringify({ op: 'quit', appId: bundle, pid: launched.pid,
    ...(launched.launchedAtMs !== undefined ? { launchedAtMs: launched.launchedAtMs } : {}) })], { timeout: 15000 });
  for (let i = 0; i < waitMs / 100; i++) {
    if (!(await state(bundle)).running) return;
    await sleep(100);
  }
  throw new Error(`${bundle} quit unconfirmed`);
}

// Quits an app that one process of this run launched: the only process for the bundle, launched (by macOS's date) no
// earlier than sinceMs, after a check that found the app not running. Anything else stays running and throws.
// Returns true when it quit something.
export async function quitLaunchedSince(bundle, sinceMs, { pid, unprovenWindow = false, state = appState, run, sleep, waitMs = 25000 } = {}) {
  const now = await state(bundle);
  if (!now.running) return false;
  const launchedAtMs = now.launchDates?.[0];
  if (unprovenWindow || !Number.isInteger(pid) || now.pids?.length !== 1 || now.pids[0] !== pid || !(launchedAtMs >= sinceMs)) {
    throw new Error(`${bundle} is not one process launched by this check (pids ${(now.pids ?? []).join(', ')}); left running`);
  }
  await quitApp(bundle, { pid: now.pids[0], launchedAtMs: sinceMs }, { state, run, sleep, waitMs });
  return true;
}

// AXIsProcessTrusted() without options never prompts.
export async function axTrusted() {
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); String($.AXIsProcessTrusted())"], { timeout: 15000 });
    return stdout.trim() === 'true';
  } catch { return false; }
}

// A fixture page on 127.0.0.1, opened in an owned Safari window by the benchmark's fixture helper (bench/real-fixture.mjs).
export function fixturePage(nonce) {
  const marker = `sleight compat ${nonce}`;
  const body = `Compatibility marker ${nonce}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${body}</h1><p>A local page for sleight's engine compatibility check.</p><button>Compat button</button></body></html>`;
  return { marker, body, html };
}
export async function openSafariPage({ nonce, dir, open, close, onDiagnostics }) {
  const page = fixturePage(nonce);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== `/${nonce}/`) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page.html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${nonce}/`;
  const ctx = { dir, nonce, ownerAway: true, onFixtureDiagnostics: onDiagnostics };
  const stop = () => new Promise(resolve => server.close(() => resolve()));
  let lease;
  try { lease = await open(ctx, { app: 'Safari', bundle: SAFARI, target: url, token: nonce, mode: 'window', fixtureKind: 'web-page' }); }
  catch (error) {
    // A setup failure the helper cleaned up still quits the Safari it launched.
    await close(ctx).catch(() => {});
    error.fixtureDiagnostics ??= ctx.windowLeases?.at(-1)?.diagnostics;
    await stop();
    throw error;
  }
  return { ...page, url, window: lease?.diagnostics?.fixtureWindow, diagnostics: lease?.diagnostics,
    close: async () => { try { await close(ctx); } finally { await stop(); } } };
}
