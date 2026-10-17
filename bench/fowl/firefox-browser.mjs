import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserProcesses, checkBrowserOwner, matchesBrowserProcess } from './real-browser.mjs';

const execute = promisify(execFile), limit = 16 * 1024 * 1024;
const invalid = () => Error('BENCH_FIREFOX_SESSIONSTORE_INVALID');
export function decodeMozLz4(bytes) {
  if (bytes.length < 13 || !bytes.subarray(0, 8).equals(Buffer.from('mozLz40\0'))) throw invalid();
  const size = bytes.readUInt32LE(8);
  if (!size || size > limit || bytes.length > limit) throw invalid();
  const out = Buffer.alloc(size); let source = 12, dest = 0;
  const length = initial => {
    let value = initial;
    if (initial === 15) {
      let next;
      do { if (source >= bytes.length) throw invalid(); next = bytes[source++]; value += next; } while (next === 255);
    }
    return value;
  };
  while (source < bytes.length) {
    const token = bytes[source++], literals = length(token >>> 4);
    if (source + literals > bytes.length || dest + literals > size) throw invalid();
    bytes.copy(out, dest, source, source + literals); source += literals; dest += literals;
    if (source === bytes.length) break;
    if (source + 2 > bytes.length) throw invalid();
    const offset = bytes.readUInt16LE(source); source += 2;
    const count = length(token & 15) + 4;
    if (!offset || offset > dest || dest + count > size) throw invalid();
    for (let i = 0; i < count; i++) { out[dest] = out[dest - offset]; dest++; }
  }
  if (dest !== size) throw invalid();
  try { return JSON.parse(out.toString('utf8')); } catch { throw invalid(); }
}

export function firefoxTabs(state) {
  if (!Array.isArray(state?.windows)) throw invalid();
  const tabs = {};
  for (const [w, window] of state.windows.entries()) {
    if (!Array.isArray(window.tabs)) throw invalid();
    for (const [t, tab] of window.tabs.entries()) {
      if (!Number.isSafeInteger(tab.index) || tab.index < 1 || !Array.isArray(tab.entries)) throw invalid();
      const entry = tab.entries[tab.index - 1];
      if (typeof entry?.url !== 'string' || !entry.url) throw invalid();
      tabs[`firefox:${w + 1}:${t + 1}`] = { url: entry.url, title: entry.title || '', initialUrl: tab.entries[0]?.url };
    }
  }
  return tabs;
}

function readInventory(profile, notBefore = 0, recovery = false) {
  // A clean quit moves recovery to sessionstore.jsonlz4. Never read previous or
  // backup sessions, which could falsely certify a page from an earlier task.
  const sources = [join(profile, 'sessionstore.jsonlz4')];
  if (recovery) sources.push(join(profile, 'sessionstore-backups/recovery.jsonlz4'));
  const source = sources.find(existsSync);
  if (!source) throw Error('BENCH_FIREFOX_SESSIONSTORE_MISSING');
  for (let path = dirname(source); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    if (path === profile) break;
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw invalid();
  if (stat.mtimeMs < notBefore) throw Error('BENCH_FIREFOX_SESSIONSTORE_STALE');
  return { tabs: firefoxTabs(decodeMozLz4(readFileSync(source))), source };
}

const prefs = {
  'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0,
  'browser.startup.homepage_override.mstone': 'ignore', 'startup.homepage_welcome_url': '',
  'startup.homepage_welcome_url.additional': '', 'browser.aboutwelcome.enabled': false,
  'browser.shell.checkDefaultBrowser': false, 'browser.sessionstore.resume_from_crash': false,
  'browser.sessionstore.resume_session_once': false, 'browser.sessionstore.interval': 250,
  'browser.warnOnQuit': false, 'browser.tabs.warnOnClose': false, 'browser.tabs.warnOnCloseOtherTabs': false,
  'toolkit.telemetry.enabled': false, 'toolkit.telemetry.unified': false,
  'datareporting.healthreport.uploadEnabled': false, 'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'app.update.auto': false, 'app.update.staging.enabled': false, 'app.update.background.scheduling.enabled': false,
  'app.update.interval': 2147483647, 'extensions.update.enabled': false,
  'extensions.systemAddon.update.enabled': false,
  'app.normandy.enabled': false, 'app.shield.optoutstudies.enabled': false,
};

export function firefoxProfileMetadata(home = homedir()) {
  return Object.fromEntries(['Library/Application Support/Firefox', 'Library/Caches/Mozilla'].map(relative => {
    const root = join(home, relative);
    try {
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('unsafe metadata root');
      return [root, readdirSync(root).sort().map(name => ({ name, mtimeMs: lstatSync(join(root, name)).mtimeMs }))];
    } catch (error) { return [root, { error: error.code || error.message }]; }
  }));
}

export function requestFirefoxQuit(executable, browser) {
  return execute(executable, [String(browser.pid), browser.executable, String(process.pid)], { timeout: 5000 });
}

async function quitHelper(root) {
  const executable = join(root, 'quit-firefox'), cache = join(root, 'module-cache');
  try {
    await execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache,
      fileURLToPath(new URL('./firefox-quit.swift', import.meta.url)), '-o', executable], { timeout: 60000 });
  } finally { rmSync(cache, { recursive: true, force: true }); }
  return browser => requestFirefoxQuit(executable, browser);
}

// This lifecycle owns every child, the empty-profile seed, and its quit helper.
// Reset never reads an owner profile and never reuses a task's browsing state.
export async function launchFirefox(plan, { spawnBrowser, listProcesses, timeoutMs, stopMs, quitMs, quitBrowser, ownerCheck, profileMetadata = firefoxProfileMetadata }) {
  const root = dirname(plan.profileRoot);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  let current, stopping;
  const browser = { ...plan, get pid() { return current && !current.closed ? current.child.pid : undefined; }, ownerCheck, collections: [], profileAudit: {},
    reset: async () => {
      await collect();
      await start();
      return current.start;
    },
    observe: async () => {
      let refusal;
      try { browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid: browser.pid }); }
      catch (error) { browser.ownerCheck = error.ownerCheck; refusal = error; }
      const graceful = await collect();
      const unobserved = reason => ({ observed: false, tabs: {}, reason,
        unavailableGraders: ['tab retention', 'handoff', 'downloads'] });
      if (refusal) return { ...unobserved(refusal.message), ownerCheck: refusal.ownerCheck };
      if (!graceful) return unobserved('Firefox graceful quit not proven; forced or unexpected exit');
      try { return { observed: true, ...readInventory(plan.profileRoot, current.quitAt), unavailableGraders: ['downloads'] }; }
      catch (error) { return unobserved(error.message); }
    },
    stop: () => stopping ??= (async () => {
      await collect(); rmSync(root, { recursive: true });
      return { browserClosed: true, profileDeleted: true };
    })(),
  };
  const wait = async ms => {
    let timer;
    try { await Promise.race([current.exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  const auditAfter = () => {
    browser.profileAudit.after = profileMetadata();
    browser.profileAudit.changed = JSON.stringify(browser.profileAudit.before) !== JSON.stringify(browser.profileAudit.after);
  };
  const collect = async () => {
    if (!current) return false;
    if (current.restartUnproved) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    if (current.closed) { auditAfter(); return current.graceful; }
    let requested = false;
    current.quitAt = Date.now();
    const receipt = { pid: current.child.pid, quit: {} }; browser.collections.push(receipt);
    try {
      try {
        const result = await quitBrowser(browser); requested = true;
        receipt.quit = { exitCode: 0, stderr: result?.stderr || '' };
      } catch (error) { receipt.quit = { exitCode: error.code ?? null, stderr: error.stderr || '', error: error.message }; }
      await wait(Math.max(0, quitMs - (Date.now() - current.quitAt)));
      receipt.quit.durationMs = Date.now() - current.quitAt;
      if (current.closed) { current.graceful = requested && current.code === 0 && !current.signal; return current.graceful; }
      current.child.kill('SIGTERM'); await wait(stopMs);
      if (!current.closed) { current.child.kill('SIGKILL'); await wait(stopMs); }
      if (!current.closed) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
      return false;
    } finally {
      receipt.collectionMs = Date.now() - current.quitAt;
      auditAfter(); receipt.profileAudit = browser.profileAudit;
    }
  };
  const start = async () => {
    rmSync(plan.profileRoot, { recursive: true, force: true }); mkdirSync(plan.profileRoot, { mode: 0o700 });
    const fresh = { ...prefs, 'app.update.lastUpdateTime.background-update-timer': Math.floor(Date.now() / 1000) };
    writeFileSync(join(plan.profileRoot, 'user.js'), Object.entries(fresh).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n', { mode: 0o600 });
    browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses });
    browser.profileAudit = { before: profileMetadata() };
    const child = spawnBrowser(plan.command, plan.args, { stdio: 'ignore', env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' } });
    const state = current = { child, closed: false, graceful: false };
    state.exited = new Promise(resolve => {
      child.once('error', error => { state.error = error; });
      child.once('close', (code, signal) => { state.closed = true; state.code = code; state.signal = signal; resolve(); });
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (state.closed || state.error || Date.now() >= deadline) {
        if (state.closed && state.code === 0 && !state.signal) await collectRestart();
        throw Error('BENCH_BROWSER_START_FAILED');
      }
      try {
        const { tabs } = readInventory(plan.profileRoot, 0, true), values = Object.values(tabs);
        if (values.length === 1 && values[0].title === plan.marker && values[0].url === plan.args.at(-1)) state.start = tabs;
      } catch {}
      if (state.start) {
        browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid: child.pid });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const collectRestart = async () => {
    current.restartUnproved = true;
    const census = listProcesses || browserProcesses, rows = await census();
    const runner = rows.find(row => row.pid === process.pid);
    if (!runner || !Number.isSafeInteger(runner.pgid) || runner.pgid <= 0) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    const replacements = rows.filter(row => row.pid !== current.child.pid && row.ppid === process.pid &&
      row.pgid === runner.pgid && matchesBrowserProcess(plan, row));
    for (const row of replacements) {
      const receipt = { pid: row.pid, restarted: true, quit: {} }, started = Date.now(); browser.collections.push(receipt);
      try {
        const result = await quitBrowser({ ...plan, pid: row.pid });
        receipt.quit = { exitCode: 0, stderr: result?.stderr || '' };
      } catch (error) { receipt.quit = { exitCode: error.code ?? null, stderr: error.stderr || '', error: error.message }; }
      const deadline = started + quitMs;
      try {
        while ((await census()).some(candidate => candidate.pid === row.pid)) {
          if (Date.now() >= deadline) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
          await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        }
      } finally {
        receipt.quit.durationMs = Date.now() - started;
        auditAfter(); receipt.profileAudit = browser.profileAudit;
      }
    }
    current.restartUnproved = false;
    auditAfter();
  };
  try { quitBrowser ??= await quitHelper(root); await start(); return browser; }
  catch (error) {
    // An unproved restart may still own the profile; never erase its evidence.
    if (error.message !== 'BENCH_BROWSER_CLEANUP_UNPROVED') {
      try { await browser.stop(); } catch (cleanup) { error = cleanup; }
    }
    error.browserReceipt = { ...plan, ownerCheck: error.ownerCheck || browser.ownerCheck,
      collections: browser.collections, profileAudit: browser.profileAudit };
    throw error;
  }
}
