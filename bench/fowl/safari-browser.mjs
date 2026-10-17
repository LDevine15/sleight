import { execFile, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkBrowserOwner } from './real-browser.mjs';

const execute = promisify(execFile), profile = 'sleight benchmark';
export function safariProfileEvidence(window) {
  for (const node of window.toolbar || []) {
    if (!['AXMenuButton', 'AXPopUpButton', 'AXButton'].includes(node.role)) continue;
    for (const [key, attribute] of [['title', 'AXTitle'], ['description', 'AXDescription'], ['value', 'AXValue']]) {
      if (node[key] === profile) return { attribute, value: profile };
    }
  }
  return null;
}

export async function prepareSafariBridge(root, { spawnBrowser = spawn, timeoutMs = 15000, compile = execute } = {}) {
  const executable = join(root, 'gate-helper'), cache = join(root, 'module-cache');
  try {
    await compile('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache,
      fileURLToPath(new URL('./safari-helper.swift', import.meta.url)), '-o', executable], { timeout: 60000 });
  } finally { rmSync(cache, { recursive: true, force: true }); }
  const child = spawnBrowser(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, failure, stderr = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const fail = error => { failure = error; pending?.reject(error); child.stdin.end(); };
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('close', code => fail(Error(`BENCH_SAFARI_HELPER_EXIT ${code}: ${stderr}`)));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const result = JSON.parse(line);
      if (!pending) throw Error('BENCH_SAFARI_HELPER_PROTOCOL');
      if (result.error) pending.reject(Error(result.error)); else pending.resolve(result);
    } catch (error) { fail(error); }
  });
  return {
    async request(op, input = {}) {
      if (failure) throw failure;
      if (pending) throw Error('BENCH_SAFARI_HELPER_BUSY');
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => fail(Error('BENCH_SAFARI_HELPER_TIMEOUT')), timeoutMs + 25000);
          child.stdin.write(JSON.stringify({ op, ...input }) + '\n', error => { if (error) fail(error); });
        });
      } finally { clearTimeout(timer); pending = null; }
    },
    async close() {
      child.stdin.end();
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('BENCH_BROWSER_CLEANUP_UNPROVED')), timeoutMs); })]); }
      finally { clearTimeout(timer); lines.close(); }
    },
  };
}

function windows(snapshot) {
  if (!Array.isArray(snapshot?.windows) || snapshot.windows.some(w => typeof w.id !== 'string' || !w.id) ||
      new Set(snapshot.windows.map(w => w.id)).size !== snapshot.windows.length) throw Error('BENCH_SAFARI_AX_INVALID');
  return snapshot.windows;
}
function tabs(window) {
  if (!Array.isArray(window.tabs) || !window.tabs.length) throw Error('BENCH_SAFARI_TABS_UNOBSERVED');
  const result = {};
  for (const tab of window.tabs) {
    if (typeof tab.id !== 'string' || !tab.id || typeof tab.title !== 'string' ||
        typeof tab.url !== 'string' || !tab.url || result[`safari:${tab.id}`]) throw Error('BENCH_SAFARI_TABS_UNOBSERVED');
    result[`safari:${tab.id}`] = { title: tab.title, url: tab.url };
  }
  return result;
}

// The named profile is owner-created and persistent. Only this launch's windows
// and temporary helper bank belong to the round; no Safari data files are read.
export async function launchSafari(plan, { spawnBrowser, listProcesses, timeoutMs, quitMs, ownerCheck,
  safariBridge = prepareSafariBridge }) {
  const root = dirname(plan.profileRoot);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  let bridge, launchAttempted = false, collected = false, stopped, windowId;
  const browser = { ...plan, ownerCheck, collections: [] };
  const census = async () => {
    try { browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid: browser.pid }); }
    catch (error) { browser.ownerCheck = error.ownerCheck; throw error; }
  };
  const snapshot = async () => windows(await bridge.request('snapshot'));
  const ownedWindow = list => {
    const window = list.find(w => w.id === windowId);
    const evidence = window && safariProfileEvidence(window);
    if (!evidence) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
    browser.profileEvidence = evidence;
    return window;
  };
  const reset = async () => {
    await census();
    const before = await snapshot(), previous = new Set(before.map(w => w.id));
    if (windowId && (before.length !== 1 || before[0].id !== windowId)) throw Error('BENCH_SAFARI_EXTRA_WINDOWS');
    if (windowId) ownedWindow(before);
    const menu = await bridge.request('new-profile');
    if (menu.menuEscapePosted !== true) throw Error('BENCH_SAFARI_MENU_ESCAPE_UNPROVED');
    const deadline = Date.now() + timeoutMs;
    let fresh;
    for (;;) {
      const added = (await snapshot()).filter(w => !previous.has(w.id));
      if (added.length > 1) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
      if (added.length === 1 && safariProfileEvidence(added[0])) { fresh = added[0]; break; }
      if (Date.now() >= deadline) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    windowId = fresh.id; browser.profileWindow = windowId;
    browser.profileEvidence = safariProfileEvidence(fresh);
    await census();
    // Only initial restored windows, or the previous verified profile window,
    // may close here. Later unexpected windows stop reset before any mutation.
    for (const window of before) await bridge.request('close-window', { window: window.id });
    await bridge.request('navigate', { window: windowId, url: plan.markerUrl });
    for (;;) {
      const list = await snapshot(), current = ownedWindow(list);
      const inventory = tabs(current), values = Object.values(inventory);
      if (list.length === 1 && values.length === 1 && values[0].title === plan.marker && values[0].url === plan.markerUrl) {
        await census(); return inventory;
      }
      if (Date.now() >= deadline) throw Error('BENCH_SAFARI_MARKER_UNPROVED');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  browser.reset = reset;
  browser.observe = async () => {
    try {
      await census();
      const list = await snapshot();
      if (list.length !== 1) throw Error('BENCH_SAFARI_EXTRA_WINDOWS');
      return { observed: true, source: 'AX-tab-bar', profileEvidence: browser.profileEvidence, tabs: tabs(ownedWindow(list)),
        unavailableGraders: ['completed downloads', 'device viewport'] };
    } catch (error) {
      return { observed: false, tabs: {}, reason: error.message, ...(error.ownerCheck ? { ownerCheck: error.ownerCheck } : {}),
        unavailableGraders: ['retention', 'handoff', 'completed downloads', 'device viewport'] };
    }
  };
  browser.stop = async () => {
    if (stopped) return stopped;
    if (!collected && launchAttempted) {
      const receipt = { pid: browser.pid, requestedAt: new Date().toISOString() }; browser.collections.push(receipt);
      try {
        const result = await bridge.request('quit', { quitMs });
        if (result.browserClosed !== true) throw Error('normal quit unproved');
        receipt.browserClosed = true; collected = true;
      } catch (error) { receipt.error = error.message; throw Error('BENCH_BROWSER_CLEANUP_UNPROVED', { cause: error }); }
    }
    try { await bridge?.close(); } catch (error) { throw Error('BENCH_BROWSER_CLEANUP_UNPROVED', { cause: error }); }
    rmSync(root, { recursive: true });
    return stopped = { browserClosed: true, profileDeleted: false, harnessDeleted: true };
  };
  try {
    bridge = await safariBridge(root, { spawnBrowser, timeoutMs });
    await census();
    launchAttempted = true;
    const launched = await bridge.request('launch');
    if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0 || launched.executable !== plan.executable ||
        !Number.isFinite(launched.launchDate)) throw Error('BENCH_SAFARI_LAUNCH_UNPROVED');
    Object.assign(browser, launched);
    await reset(); return browser;
  } catch (error) {
    try { await browser.stop(); } catch (cleanup) { error = cleanup; }
    const { stop, reset, observe, ...receipt } = browser;
    error.browserReceipt = receipt;
    throw error;
  }
}
