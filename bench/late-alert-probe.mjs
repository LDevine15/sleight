#!/usr/bin/env node
// AN3: how late do sheets, alerts, new windows and focus changes appear after Return, Tab, Escape or Space?
// The guard's light check (plugins/sleight/lib/light-return.mjs) trusts what it sees 250 ms after the key, so it
// stays off until this measures it. Each scenario sends one key through the engine, behind the relay, and samples
// the same native observer the light check uses (window-identity with focus) every 10 ms for 1500 ms.
//
// sleight-arch runs it only with the owner away:
//   CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/late-alert-probe.mjs --owner-away
// Options: --trials N (default 5), --only textedit,finder,excel, --out <file>. --dry-run runs the plan on fake
// apps and a virtual clock, with no lock, engine or app.
//
// Waits while /tmp/sleight-hold exists, then takes /tmp/sleight-live.lock. Fixtures open with `open -g`; TextEdit
// and Excel must not be running already (the owner's documents). No Apple events to Office, no pointer moves, no
// clicks. Fixture apps quit through NSRunningApplication; an owned Don't Save is answered through System Events.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LIGHT_TIMING } from '../plugins/sleight/lib/light-return.mjs';

export const WINDOW_MS = 1500, INTERVAL_MS = 10, MARK = '[late-alert-key]';
const HOLD = '/tmp/sleight-hold';
const SEED = 'late-alert fixture\n';

export const GROUPS = {
  // TextEdit works on the probe's own saved file: Save As (Option-Shift-Cmd-S) gives the sheet. Never an
  // untitled document, which can autosave into the owner's iCloud TextEdit folder.
  textedit: { bundle: 'com.apple.TextEdit', mustNotRun: true, scenarios: [
    ['textedit-find-open', 'super+f'], ['textedit-find-escape', 'Escape'], ['textedit-save-sheet', 'super+alt+shift+s'],
    ['textedit-replace-prompt', 'Return'], ['textedit-replace-escape', 'Escape'], ['textedit-sheet-escape', 'Escape']] },
  finder: { bundle: 'com.apple.finder', mustNotRun: false, scenarios: [
    ['finder-rename-start', 'Return'], ['finder-rename-taken', 'Return'], ['finder-alert-return', 'Return'],
    ['finder-rename-escape', 'Escape']] },
  excel: { bundle: 'com.microsoft.Excel', mustNotRun: true, scenarios: [
    ['excel-validation-alert', 'Return'], ['excel-alert-escape', 'Escape']] },
};

export class HoldError extends Error {}
export class StopError extends Error {}
class TrialError extends Error {}

export function parseArgs(argv) {
  const options = { trials: 5, groups: Object.keys(GROUPS), ownerAway: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--owner-away') options.ownerAway = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--trials') options.trials = Number(argv[++i]);
    else if (arg === '--only') options.groups = String(argv[++i] ?? '').split(',');
    else if (arg === '--out') options.out = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  assert.ok(Number.isInteger(options.trials) && options.trials >= 1 && options.trials <= 50, '--trials takes 1 to 50');
  for (const group of options.groups) assert.ok(GROUPS[group], `Unknown group ${group}`);
  if (!options.dryRun && !options.ownerAway) throw new Error('Refusing to run live: it shows windows and sends keys. Pass --owner-away (sleight-arch, owner away) or --dry-run.');
  return options;
}

// ---- Analysis -------------------------------------------------------------------------------------------

// What the light check would compare. An unknown or denied observation (an AX timeout) carries no state.
export function signature(observed) {
  if (!observed || !['ok', 'mismatch'].includes(observed.status)) return undefined;
  const focus = observed.focus ?? {};
  return { status: observed.status, matches: observed.matches ?? null, window: observed.window ?? null,
    sheets: focus.sheets ?? null, role: focus.role ?? null, subrole: focus.subrole ?? null, inWindow: focus.inWindow ?? null };
}
export function changeKinds(base, sig) {
  if (!base || !sig) return [];
  const kinds = [];
  if (['status', 'matches', 'window'].some(key => base[key] !== sig[key])) kinds.push('window');
  if (base.sheets !== sig.sheets) kinds.push('sheet');
  if (['role', 'subrole', 'inWindow'].some(key => base[key] !== sig[key])) kinds.push('focus');
  return kinds;
}
const same = (a, b) => !!a && !!b && changeKinds(a, b).length === 0;

// Nearest rank: with 5 values, p95 is the largest.
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
export function stats(values) {
  const known = values.filter(Number.isFinite);
  return known.length ? { n: known.length, min: Math.min(...known), p50: percentile(known, 0.5), p95: percentile(known, 0.95),
    max: Math.max(...known) } : null;
}

// Times are relative to the reference (the key's pressKey returning inside the engine, as the light check
// counts). firstSeenMs is the end of the first sample showing a change, an upper bound; notBeforeMs is the start
// of the last unchanged sample before it, a lower bound.
export function analyzeTrial({ baseline, samples, reference, keyStart }) {
  const rel = t => Math.round(t - reference);
  let first, lastSame, final, previous, unknown = 0;
  const firstByKind = {}, transitions = [];
  for (const sample of samples) {
    const sig = signature(sample.observed);
    if (!sig) { unknown++; continue; }
    final = sig;
    const key = JSON.stringify(sig);
    if (key !== previous) { transitions.push({ startMs: rel(sample.start), endMs: rel(sample.end), ...sig }); previous = key; }
    const kinds = changeKinds(baseline, sig);
    if (!kinds.length) { if (!first) lastSame = sample; continue; }
    first ??= { sample, kinds };
    for (const kind of kinds) firstByKind[kind] ??= rel(sample.end);
  }
  const intervals = samples.slice(1).map((sample, i) => sample.start - samples[i].start);
  return { seen: !!first, firstSeenMs: first ? rel(first.sample.end) : null,
    notBeforeMs: first && lastSame ? rel(lastSame.start) : null, kinds: first?.kinds ?? [], firstByKind,
    beforeKey: !!first && Number.isFinite(keyStart) && first.sample.end < keyStart,
    final: final ?? null, finalKinds: changeKinds(baseline, final), samples: samples.length, unknown,
    sampleMs: percentile(intervals, 0.5), transitions };
}

export function summarize(results, waitMs = LIGHT_TIMING.waitMs) {
  const summary = {};
  for (const result of results) {
    const row = summary[result.scenario] ??= { key: result.key, trials: 0, seen: 0, missed: 0, errors: 0, beforeKey: 0,
      firstSeen: [], notBefore: [], kinds: {}, sampleMs: [] };
    row.trials++;
    if (result.error) { row.errors++; continue; }
    if (!result.seen) { row.missed++; continue; }
    row.seen++;
    if (result.beforeKey) row.beforeKey++;
    row.firstSeen.push(result.firstSeenMs);
    if (Number.isFinite(result.notBeforeMs)) row.notBefore.push(result.notBeforeMs);
    for (const kind of result.kinds) row.kinds[kind] = (row.kinds[kind] ?? 0) + 1;
    if (Number.isFinite(result.sampleMs)) row.sampleMs.push(result.sampleMs);
  }
  for (const row of Object.values(summary)) {
    const firstSeen = row.firstSeen, notBefore = row.notBefore;
    Object.assign(row, { firstSeenMs: stats(firstSeen), notBeforeMs: stats(notBefore),
      // Seen after the light check's wait: possibly late (upper bound past it) or surely late (lower bound past it).
      possiblyLate: firstSeen.filter(ms => ms > waitMs).length, surelyLate: notBefore.filter(ms => ms > waitMs).length,
      sampleMs: percentile(row.sampleMs, 0.5) });
    delete row.firstSeen; delete row.notBefore;
  }
  return summary;
}

// ---- Measuring one key ----------------------------------------------------------------------------------

export const keyCode = key => `{ const started = Date.now(); await app.pressKey(${JSON.stringify(key)}); ` +
  `nodeRepl.write(${JSON.stringify(MARK)} + JSON.stringify({ keyStart: started, keyDone: Date.now() })); }`;
export function keyTimes(text) {
  const match = /\[late-alert-key\](\{[^}\n]*\})/.exec(text ?? '');
  try {
    const times = match && JSON.parse(match[1]);
    return Number.isFinite(times?.keyStart) && Number.isFinite(times?.keyDone) ? times : undefined;
  } catch { return undefined; }
}

export async function measure(io, { scenario, key, window }, { windowMs = WINDOW_MS, intervalMs = INTERVAL_MS } = {}) {
  const sample = async () => {
    const start = io.now();
    let observed;
    try { observed = await io.observe({ ...window, focus: true }); } catch (error) { observed = { status: 'unknown', error: error.message }; }
    return { start, end: io.now(), observed };
  };
  // Three consecutive equal observations before the key, within 20 tries.
  const base = [];
  for (let i = 0; i < 20 && base.length < 3; i++) {
    const next = await sample(), sig = signature(next.observed);
    if (!sig || (base.length && !same(signature(base.at(-1).observed), sig))) base.length = 0;
    if (sig) base.push(next);
    await io.sleep(intervalMs);
  }
  if (base.length < 3) return { scenario, key, error: 'Baseline unstable; no key sent', baseline: base.map(s => s.observed) };
  const baseline = signature(base.at(-1).observed), samples = [];
  const submitted = io.now();
  let reference, referenceKind, result, callError, returned, done = false;
  const call = io.engine(keyCode(key)).then(value => { result = value; }, error => { callError = error; }).finally(() => {
    returned = io.now();
    const times = result && keyTimes(result.text);
    [reference, referenceKind] = times ? [times.keyDone, 'key-returned']
      : Number.isFinite(result?.approvalAt) ? [result.approvalAt, 'approval'] : [returned, 'call-returned'];
    result = result && { ...result, times };
    done = true;
  });
  while (!done || (!callError && io.now() < reference + windowMs)) {
    if (io.now() - submitted > 90000) break;
    const next = await sample();
    samples.push(next);
    const wait = intervalMs - (next.end - next.start);
    if (wait > 0) await io.sleep(wait);
  }
  await call;
  if (callError) throw callError;
  const analysis = analyzeTrial({ baseline, samples, reference, keyStart: result.times?.keyStart });
  return { scenario, key, referenceKind, baseline, submittedMs: Math.round(submitted - reference),
    returnedMs: Math.round(returned - reference), keyStartMs: result.times ? Math.round(result.times.keyStart - reference) : null,
    engineError: result.isError ? result.errorText ?? true : undefined, ...analysis };
}

// ---- Scenario plans -------------------------------------------------------------------------------------

const TRIALS = {
  async textedit(t) {
    await t.measure('textedit-find-open');
    await t.measure('textedit-find-escape');
    // The engine's name for Option isn't confirmed: a rejected key name gets one retry with "option".
    const save = await t.measure('textedit-save-sheet', { tryKey: true });
    if (save.rejected) await t.measure('textedit-save-sheet', { key: 'super+option+shift+s' });
    if (!((await t.gate()).sheets >= 1)) throw new TrialError('Save As sheet absent; nothing typed');
    // The save panel goes to the bank folder (cmd+shift+G) and takes a name that exists there.
    await t.input('await app.pressKey("super+shift+g")', { sheet: true });
    await t.input(`await app.typeText(${JSON.stringify(t.fixture.bank)})`, { sheet: true });
    await t.input('await app.pressKey("Return")', { sheet: true });
    await t.input('await app.setValue({ id: "saveAsNameTextField" }, "taken")', { sheet: true });
    const read = await t.input('await app.getAXState({ disableDiffing: true })', { sheet: true });
    if (!read.text.includes(basename(t.fixture.bank)) || !read.text.includes('taken')) {
      throw new TrialError('Save panel location or name unconfirmed; no Return sent');
    }
    await t.measure('textedit-replace-prompt');
    await t.measure('textedit-replace-escape', { dialog: true });
    await t.measure('textedit-sheet-escape', { dialog: true });
  },
  async finder(t) {
    await t.input('await app.pressKey("a")'); // type-select alpha.txt
    const start = await t.measure('finder-rename-start');
    if (start.final?.role !== 'AXTextField') throw new TrialError('Rename field not seen; nothing typed');
    await t.input('await app.typeText("taken")');
    await t.measure('finder-rename-taken');
    await t.measure('finder-alert-return', { dialog: true });
    await t.measure('finder-rename-escape', { dialog: true });
  },
  // A1 accepts only 1 to 10. On 2026-10-17 typeText("abc") left Excel's focus on the window itself (AXWindow) in
  // 5 of 5 trials and no alert came, so the value goes in as key presses, and the readouts record what A1 held.
  async excel(t) {
    await t.input('await app.pressKey("9"); await app.pressKey("9")');
    await t.readout('after-typing');
    await t.measure('excel-validation-alert');
    await t.readout('after-return');
    await t.measure('excel-alert-escape', { dialog: true });
    await t.input('await app.pressKey("Escape")', { dialog: true });
    await t.readout('after-trial');
  },
};

// Put the fixture back between trials: Escape (and Finder's alert OK) through the engine, then the files.
async function settle(t, group) {
  for (let i = 0; i < 4; i++) {
    const state = await t.gate({ dialog: true, check: false });
    if (!state.sheets && !state.dialogs && i > 0) break;
    const key = group === 'finder' && state.dialogs ? 'Return' : 'Escape';
    await t.input(`await app.pressKey(${JSON.stringify(key)})`, { dialog: true, cleanup: true });
  }
  const state = await t.gate({ dialog: true, check: false });
  if (state.sheets || state.dialogs) throw new StopError(`${group} fixture still shows a sheet or alert after cleanup`);
  return t.io.checkFiles(group, t.fixture);
}

export async function runProbe(options, io) {
  const report = { started: new Date(io.now()).toISOString(), dryRun: options.dryRun, trials: options.trials,
    groups: options.groups, windowMs: WINDOW_MS, intervalMs: INTERVAL_MS, lightWaitMs: LIGHT_TIMING.waitMs,
    results: [], trialErrors: [], skipped: [], cleanup: [], readouts: [], keyAttempts: [] };
  const save = () => io.persist(report);
  const pre = await io.preflight(options.groups.map(group => GROUPS[group].bundle));
  report.preflight = { running: pre.running };
  let stopped;
  for (const group of options.groups) {
    if (stopped) { report.skipped.push({ group, reason: `run stopped: ${stopped}` }); continue; }
    const plan = GROUPS[group];
    if (plan.mustNotRun && pre.running[plan.bundle] > 0) {
      report.skipped.push({ group, reason: `${plan.bundle} was already running (the owner's documents); nothing opened` });
      continue;
    }
    await io.waitHold();
    let fixture, clientOpen = false;
    try {
      fixture = await io.launch(group, pre);
      if (fixture.skip) { report.skipped.push({ group, reason: fixture.skip }); continue; }
      await io.openClient(group);
      clientOpen = true;
      const opened = await io.engine(`var app = await cua.getApp(${JSON.stringify(plan.bundle)})`);
      if (opened.isError || !io.targetsFixture(group, fixture, opened.text)) {
        report.skipped.push({ group, reason: 'The engine did not target the fixture window; no key sent' });
        continue;
      }
      for (let trial = 1; trial <= options.trials; trial++) {
        const t = trialContext({ io, group, fixture, pre, report, trial, save });
        try { await TRIALS[group](t); }
        catch (error) {
          report.trialErrors.push({ group, trial, error: error.message });
          if (error instanceof HoldError || error instanceof StopError) { stopped = error instanceof StopError ? error.message : undefined; break; }
        } finally {
          try { const files = await settle(t, group); if (files && !files.unchanged) report.trialErrors.push({ group, trial, files }); }
          catch (error) { stopped = `cleanup: ${error.message}`; report.trialErrors.push({ group, trial, cleanup: error.message }); }
          await save();
        }
        if (stopped) break;
      }
    } catch (error) {
      report.trialErrors.push({ group, error: error.message });
      if (error instanceof StopError) stopped = error.message;
    } finally {
      if (clientOpen) await io.closeClient().catch(error => report.trialErrors.push({ group, closeClient: error.message }));
      if (fixture && !fixture.skip) {
        const result = await io.cleanup(group, fixture).catch(error => ({ ok: false, error: error.message }));
        report.cleanup.push({ group, ...result });
        if (!result.ok) stopped = `fixture cleanup unconfirmed (${group})`;
      }
      await save();
    }
  }
  report.cleanupConfirmed = report.cleanup.every(entry => entry.ok);
  report.stopped = stopped;
  report.summary = summarize(report.results);
  report.finished = new Date(io.now()).toISOString();
  await save();
  return report;
}

function trialContext({ io, group, fixture, pre, report, trial, save }) {
  const keys = Object.fromEntries(GROUPS[group].scenarios);
  // Before any input: no hold, the owner's front app and pointer unchanged, and the fixture window focused
  // (or, where an alert is expected, an alert of the fixture app).
  const gate = async ({ dialog = false, sheet = false, check = true } = {}) => {
    if (check) io.free();
    const state = await io.state(group, fixture);
    if (!state.running) throw new StopError(`${group} fixture app is no longer running`);
    if (state.front !== pre.front) throw new StopError('The front app changed; stopping all input');
    if (Math.abs(state.pointer.x - pre.pointer.x) > 0.5 || Math.abs(state.pointer.y - pre.pointer.y) > 0.5) {
      throw new StopError('The pointer moved; stopping all input');
    }
    const mine = state.windows ?? [];
    if (mine.length !== 1) throw new TrialError(`Expected one fixture window, found ${mine.length}; no input sent`);
    const [window] = mine;
    const focusOk = window.focused || (dialog && state.focusedOther && state.dialogs > 0);
    if (!focusOk) throw new TrialError('The fixture window is not the app\'s focused window; no input sent');
    if (sheet && !(window.sheets >= 1)) throw new TrialError('The save sheet is gone; no input sent');
    return { window: { appId: GROUPS[group].bundle, title: window.title, url: window.url ?? null }, sheets: window.sheets,
      dialogs: state.dialogs };
  };
  return {
    io, fixture, gate,
    async input(code, options = {}) {
      await gate({ ...options, check: !options.cleanup });
      const result = await io.engine(code);
      if (result.isError && !options.cleanup) throw new TrialError(`Engine call failed: ${result.errorText ?? 'error'}`);
      return result;
    },
    // What the engine's tree says about the cell (A1/A2 lines, the tab's used range), plus alert windows.
    async readout(phase) {
      const state = await gate({ dialog: true });
      const read = await io.engine('await app.getAXState({ disableDiffing: true })');
      const lines = read.text.split('\n').filter(line => /\bA[12]\b|Used range|Blank sheet|formula bar|edit mode/i.test(line))
        .slice(0, 8).map(line => line.trim().slice(0, 200));
      report.readouts.push({ group, trial, phase, dialogs: state.dialogs, sheets: state.sheets, readError: read.isError || undefined, lines });
    },
    async measure(scenario, options = {}) {
      const { window } = await gate(options);
      const result = await measure(io, { scenario, key: options.key ?? keys[scenario], window }, io.timing);
      // A key name the engine rejects (no change seen) is a key-name probe, not a trial.
      if (options.tryKey && result.engineError && !result.seen) {
        report.keyAttempts.push({ group, trial, scenario, key: result.key, engineError: result.engineError });
        return { ...result, rejected: true };
      }
      report.results.push({ group, trial, ...result });
      await save();
      if (result.error) throw new TrialError(`${scenario}: ${result.error}`);
      return result;
    },
  };
}

// ---- Fixtures -------------------------------------------------------------------------------------------

const xmlns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const relsXml = body => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const relXml = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
// A workbook whose A1 accepts only whole numbers 1 to 10, with a stop-style error alert.
export function validationWorkbook() {
  return {
    '_rels/.rels': relsXml(relXml('rId1', 'officeDocument', 'xl/workbook.xml')),
    'xl/workbook.xml': `<workbook ${xmlns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relsXml(relXml('rId1', 'worksheet', 'worksheets/sheet1.xml')),
    'xl/worksheets/sheet1.xml': `<worksheet ${xmlns}><sheetData/><dataValidations count="1"><dataValidation type="whole" errorStyle="stop" operator="between" allowBlank="1" showErrorMessage="1" sqref="A1"><formula1>1</formula1><formula2>10</formula2></dataValidation></dataValidations></worksheet>`,
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  };
}

export function probeApprovalMessage(message) {
  return /^Allow Computer Use to use "(?:TextEdit|com\.apple\.TextEdit|Finder|com\.apple\.finder|Microsoft Excel|Excel|com\.microsoft\.Excel)"\?$/.test(message ?? '');
}

async function liveIO({ bank, report: output }) {
  const run = promisify(execFile);
  const [{ resolveServer }, { windowFromText }, { probeClient }, { benchmarkDecision }, { createAppHealthHelper }, { zip }] = await Promise.all([
    import('../plugins/sleight/lib/launch.mjs'), import('../plugins/sleight/lib/document-scope.mjs'), import('./double-keys-client.mjs'),
    import('./approve.mjs'), import('../plugins/sleight/lib/read-failure.mjs'), import('./battery/documents.mjs')]);
  const server = resolveServer();
  assert.ok(!server.error, server.error);
  const health = createAppHealthHelper();
  const approvals = [];
  const nonce = basename(bank).slice(-6);
  const scrub = text => String(text).replaceAll(homedir(), '~').replaceAll(userInfo().username, 'owner');
  let client, cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const host = async (op, extra = {}) => {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./late-alert-host.js', import.meta.url)),
      JSON.stringify({ op, bank, ...extra })], { timeout: 45000, maxBuffer: 1024 * 1024 });
    const reply = JSON.parse(stdout);
    if (!reply.ok && !['quit'].includes(op)) throw new Error(`host ${op}: ${reply.error}`);
    return reply;
  };
  const holdExists = () => access(HOLD).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  let hold = false;
  const watch = setInterval(() => { holdExists().then(value => { hold = value; }, () => { hold = true; }); }, 500);
  watch.unref();
  const approve = params => {
    if (params?._meta?.tool_name === 'press_key') approvals.push(Date.now());
    if (!probeApprovalMessage(params?.message)) return { action: 'decline' };
    const answer = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message: params.message,
      requested_schema: params.requestedSchema }, { BENCH_SUITE: 'real' })?.hookSpecificOutput;
    return answer?.action === 'accept' ? { action: 'accept', content: answer.content ?? {} } : { action: 'decline' };
  };
  const record = entry => {
    const msg = entry.msg;
    if (msg?.method === 'elicitation/create' && msg.params?._meta?.tool_name === 'press_key') approvals.push(Date.now());
    if (['lease-fault', 'engine-close'].includes(entry.event)) output.events = [...(output.events ?? []), scrub(JSON.stringify(entry))].slice(-20);
  };
  const waitFor = async (label, check, ms) => {
    for (const deadline = Date.now() + ms; ;) {
      let value;
      try { value = await check(); } catch (error) { if (Date.now() >= deadline) throw error; }
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`${label} unconfirmed after ${ms / 1000} s`);
      await sleep(250);
    }
  };
  const bind = async (bundle, started) => waitFor(`${bundle} launch`, async () => {
    const bound = await host('bind', { bundle, started });
    return bound.pid ? { pid: bound.pid, birth: bound.birth } : undefined;
  }, 30000);
  const ownedFocused = (group, fixture, ms) => waitFor(`${group} fixture window`, async () => {
    const state = await host('state', { ...fixture });
    return state.windows?.length === 1 && state.windows[0].focused ? state : undefined;
  }, ms);
  const fixtureRequest = fixture => ({ bundle: fixture.bundle, pid: fixture.pid, birth: fixture.birth, title: fixture.title,
    stem: fixture.stem, front: fixture.front });
  return {
    now: Date.now, sleep: ms => sleep(ms), timing: undefined,
    free() {
      if (cancelled) throw new StopError('Interrupted');
      if (hold) throw new HoldError('Timed window began (/tmp/sleight-hold); stopping input');
    },
    async waitHold() { while (await holdExists()) { if (cancelled) throw new StopError('Interrupted'); await sleep(30000); } hold = false; },
    persist: async report => writeFile(join(bank, 'report.json'), scrub(JSON.stringify(report, null, 2)) + '\n'),
    preflight: bundles => host('preflight', { bundles }),
    observe: window => health.windowIdentity(window),
    async launch(group, pre) {
      output.launched = true;
      const started = Date.now();
      if (group === 'textedit') {
        // The probe's own saved file, never an untitled document. On 2026-10-17 a bare launch with the
        // launch arguments still showed an untitled panel (AXDialog) and an "Untitled 6" window.
        for (const name of ['taken.txt', 'taken.rtf']) await writeFile(join(bank, name), SEED);
        const path = join(bank, `doc-${nonce}.txt`);
        await writeFile(path, SEED);
        await run('/usr/bin/open', ['-g', '-a', 'TextEdit', path, '--args', '-ApplePersistenceIgnoreState', 'YES',
          '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO'], { timeout: 10000 });
        const fixture = { bundle: 'com.apple.TextEdit', ...(await bind('com.apple.TextEdit', started)), stem: `doc-${nonce}`, path, front: pre.front };
        fixture.windowTitle = (await ownedFocused(group, fixtureRequest(fixture), 20000)).windows[0].title;
        return fixture;
      }
      if (group === 'finder') {
        const folder = join(bank, `rename-${nonce}`);
        await mkdir(folder);
        for (const name of ['alpha.txt', 'taken.txt']) await writeFile(join(folder, name), SEED);
        const { pid } = await host('finder-pid');
        const fixture = { bundle: 'com.apple.finder', pid, title: basename(folder), folder, front: pre.front };
        const before = await host('state', fixtureRequest(fixture));
        if (before.dialogs) return { skip: 'Finder already showed a dialog; nothing opened' };
        await run('/usr/bin/open', ['-g', folder], { timeout: 10000 });
        await ownedFocused(group, fixtureRequest(fixture), 15000);
        return fixture;
      }
      const path = join(bank, `late-alert-${nonce}.xlsx`);
      await writeFile(path, zip(validationWorkbook()));
      await run('/usr/bin/open', ['-g', '-b', 'com.microsoft.Excel', path], { timeout: 10000 });
      const fixture = { bundle: 'com.microsoft.Excel', ...(await bind('com.microsoft.Excel', started)), stem: `late-alert-${nonce}`, path, front: pre.front };
      try { fixture.windowTitle = (await ownedFocused(group, fixtureRequest(fixture), 60000)).windows[0].title; }
      catch (error) { fixture.launchProblem = error.message; }
      return fixture;
    },
    state: (group, fixture) => host('state', fixtureRequest(fixture)),
    async openClient(group) {
      client = await probeClient(server, { relay: true, relayOptions: { changeReview: false }, approve, record,
        timeoutMs: 60000, label: `late-alert-${group}` });
    },
    async closeClient() { const closing = client; client = undefined; await closing?.close(); },
    async engine(code) {
      const submitted = Date.now();
      const result = await client.call('js', { code });
      const returned = Date.now();
      const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (/input lease.*(?:stopped|changed)|document scope.*stopped|outcome unconfirmed/i.test(text)) {
        throw new StopError(`The relay stopped the call: ${scrub(text).slice(0, 300)}`);
      }
      const approvalAt = approvals.filter(t => t >= submitted && t <= returned).at(-1);
      return { text, isError: !!result.isError, errorText: result.isError ? scrub(text).slice(0, 300) : undefined, approvalAt };
    },
    targetsFixture(group, fixture, text) {
      const window = windowFromText(text);
      if (group === 'finder') return window?.title === fixture.title;
      if (!window?.url) return !!fixture.windowTitle && window?.title === fixture.windowTitle;
      try { return decodeURIComponent(new URL(window.url).pathname).replace(/^\/private/, '') === fixture.path.replace(/^\/private/, ''); }
      catch { return false; }
    },
    async checkFiles(group, fixture) {
      if (group === 'textedit') {
        const contents = await Promise.all(['taken.txt', 'taken.rtf', basename(fixture.path)].map(name => readFile(join(bank, name), 'utf8').catch(() => null)));
        return { unchanged: contents.every(text => text === SEED), replaced: contents.map(text => text !== SEED) };
      }
      if (group === 'finder') {
        const names = (await readdir(fixture.folder)).filter(name => !name.startsWith('.')).sort();
        if (names.join() === 'alpha.txt,taken.txt') return { unchanged: true };
        // A rename that went through: put the probe's own file back.
        const stray = names.filter(name => !['alpha.txt', 'taken.txt'].includes(name));
        if (!names.includes('alpha.txt') && stray.length === 1) await rename(join(fixture.folder, stray[0]), join(fixture.folder, 'alpha.txt'));
        return { unchanged: false, names: names.map(name => name.replace(nonce, '<nonce>')), restored: stray.length === 1 };
      }
      return { unchanged: true };
    },
    async cleanup(group, fixture) {
      if (group === 'finder') {
        await host('finder-dismiss', { ...fixtureRequest(fixture), text: 'taken.txt' }).catch(() => {});
        return host('finder-close', fixtureRequest(fixture));
      }
      return host('quit', { ...fixtureRequest(fixture), closeOwn: group === 'textedit' });
    },
    async close() { clearInterval(watch); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await health.close(); },
  };
}

// ---- Dry run: fake apps on a virtual clock ----------------------------------------------------------------

export function virtualClock(start = Date.UTC(2026, 9, 17)) {
  let t = start;
  const timers = [];
  const fire = () => { timers.sort((a, b) => a.at - b.at); while (timers.length && timers[0].at <= t) timers.shift().resolve(); };
  return { now: () => t, sleep: ms => { t += Math.max(0, ms); fire(); return Promise.resolve(); }, after: ms => new Promise(resolve => timers.push({ at: t + ms, resolve })) };
}

// The fake shows each key's effect after a fixed simulated delay. Its numbers are plumbing, not measurements.
export function fakeIO({ delays = {}, rejectKeys = [] } = {}) {
  const clock = virtualClock();
  const world = { group: undefined, stack: [], pending: undefined };
  const apply = () => { if (world.pending && clock.now() >= world.pending.at) { world.stack = world.pending.stack; world.pending = undefined; } };
  const next = (stack, key) => {
    const top = stack.at(-1), g = world.group;
    if (key === 'Escape') return top ? stack.slice(0, -1) : stack;
    if (g === 'textedit' && key === 'super+f') return [...stack, 'find'];
    if (g === 'textedit' && /^super\+(?:alt|option)\+shift\+s$/.test(key)) return [...stack, 'sheet'];
    if (key === 'Return') {
      if (g === 'textedit' && top === 'sheet') return [...stack, 'alert'];
      if (g === 'finder') return top === 'alert' ? stack.slice(0, -1) : top === 'rename' ? [...stack, 'alert'] : [...stack, 'rename'];
      if (g === 'excel') return [...stack, 'alert'];
    }
    return stack;
  };
  const view = () => {
    apply();
    const top = world.stack.at(-1), separate = top === 'alert' && world.group !== 'textedit';
    const sheets = world.stack.filter(item => item === 'sheet' || (item === 'alert' && world.group === 'textedit')).length;
    return { top, separate, sheets };
  };
  const bank = '/private/tmp/sleight-late-alert-DRYRUN';
  let counter = 0;
  return {
    now: clock.now, sleep: clock.sleep, timing: undefined, free() {}, async waitHold() {}, async persist() {},
    preflight: async bundles => ({ ok: true, front: 1, pointer: { x: 10, y: 10 }, running: Object.fromEntries(bundles.map(b => [b, 0])) }),
    async observe() {
      await clock.sleep(4);
      const { top, separate, sheets } = view();
      if (separate) return { status: 'mismatch', error: 'Focused window differs' };
      const role = ['find', 'rename', 'sheet'].includes(top) ? 'AXTextField' : top === 'alert' ? 'AXButton'
        : { textedit: 'AXTextArea', finder: 'AXOutline', excel: 'AXLayoutArea' }[world.group];
      return { status: 'ok', matches: 1, window: 1, focus: { sheets, role, subrole: null, inWindow: true } };
    },
    async launch(group) {
      world.group = group; world.stack = []; world.pending = undefined;
      return { bundle: GROUPS[group].bundle, pid: 2, bank, title: { textedit: 'doc.txt', finder: 'rename', excel: 'late-alert.xlsx' }[group], path: `${bank}/doc.txt` };
    },
    async state(group, fixture) {
      const { separate, sheets } = view();
      return { ok: true, running: true, front: 1, pointer: { x: 10, y: 10 }, dialogs: separate ? 1 : 0, focusedOther: separate,
        windows: [{ title: fixture.title, url: null, focused: !separate, sheets, edited: false }] };
    },
    async openClient() {}, async closeClient() {},
    async engine(code) {
      if (/getApp/.test(code)) return { text: `Window: "${world.group}", App: fake.`, isError: false };
      if (/getAXState/.test(code)) return { text: `Where: ${basename(bank)}\nName: taken`, isError: false };
      const key = /pressKey\("([^"]+)"\)/.exec(code)?.[1];
      if (!code.includes(MARK)) {
        // Setup and cleanup keys: Escape closes the top layer, Return answers an alert, anything else changes nothing here.
        apply();
        if (key === 'Escape' || (key === 'Return' && world.stack.at(-1) === 'alert')) world.stack = world.stack.slice(0, -1);
        return { text: '', isError: false };
      }
      apply();
      if (rejectKeys.includes(key)) { await clock.after(200); return { text: 'unknown key name', isError: true, errorText: 'unknown key name' }; }
      const scenario = GROUPS[world.group].scenarios.find(([, k]) => k === key)?.[0];
      const delay = delays[key] ?? 40 + ((counter++ * 97) % 360);
      const keyStart = clock.now() + 300, keyDone = keyStart + 15;
      world.pending = { at: keyDone + delay, stack: next(world.stack, key), scenario };
      await clock.after(800);
      return { text: `${MARK}${JSON.stringify({ keyStart, keyDone })}`, isError: false };
    },
    targetsFixture: () => true,
    checkFiles: async () => ({ unchanged: true }),
    cleanup: async () => ({ ok: true, exited: true }),
    async close() {},
  };
}

// ---- Main -----------------------------------------------------------------------------------------------

export function plan(options) {
  return options.groups.map(group => ({ group, bundle: GROUPS[group].bundle, scenarios: GROUPS[group].scenarios.map(([name, key]) => ({ name, key })) }));
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.dryRun) {
    const io = fakeIO();
    const report = await runProbe(options, io);
    console.log(JSON.stringify({ dryRun: true, plan: plan(options), summary: report.summary, skipped: report.skipped,
      trialErrors: report.trialErrors, note: 'Simulated delays on a virtual clock; not a measurement.' }, null, 2));
    return;
  }
  assert.equal(process.platform, 'darwin', 'Requires macOS');
  assert.ok(process.env.CLAUDE_CONFIG_DIR?.startsWith('/tmp/lane-claude-'), 'Supply a throwaway CLAUDE_CONFIG_DIR');
  const { acquireLiveLock } = await import('./live-lock.mjs');
  const holdExists = () => access(HOLD).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  while (await holdExists()) await sleep(30000);
  const release = await acquireLiveLock();
  const bank = await mkdtemp('/private/tmp/sleight-late-alert-');
  const report = {};
  let io, result;
  try {
    io = await liveIO({ bank, report });
    result = await runProbe(options, io);
    Object.assign(result, report.events ? { events: report.events } : {});
    await io.persist(result);
    if (options.out) await writeFile(options.out, JSON.stringify(result, null, 2).replaceAll(homedir(), '~') + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    await io?.close();
    // A fixture that may still be open keeps the lock, so no other live run starts on top of it.
    if (result?.cleanupConfirmed || !report.launched) await release();
    else console.error('Fixture cleanup unconfirmed; /tmp/sleight-live.lock kept. See the report.');
    console.log(JSON.stringify({ report: join(bank, 'report.json').replaceAll(homedir(), '~'), stopped: result?.stopped,
      cleanupConfirmed: result?.cleanupConfirmed, skipped: result?.skipped, summary: result?.summary }, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
