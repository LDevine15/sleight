import { execFile, spawn } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkBrowserOwner } from './real-browser.mjs';
// /Applications/Safari.app links into the Safari cryptex, and the helper reports the resolved path (adcebef9).
const sameExecutable = (a, b) => { try { return typeof a === 'string' && realpathSync(a) === realpathSync(b); } catch { return false; } };

const execute = promisify(execFile), profile = 'sleight benchmark';
// Safari 26 names the toolbar profile button only in its identifier ("TabGroupPickerButton?Profile=sleight%20benchmark&Icon=..."),
// with an empty title, description and value (2026-10-18).
export function identifierProfile(identifier) {
  const match = /^TabGroupPickerButton\?(.*)$/.exec(typeof identifier === 'string' ? identifier : '');
  if (!match) return null;
  const pairs = match[1].split('&').filter(pair => pair === 'Profile' || pair.startsWith('Profile='));
  if (pairs.length !== 1 || !pairs[0].startsWith('Profile=')) return null;
  try { return decodeURIComponent(pairs[0].slice('Profile='.length)); } catch { return null; }
}
export function safariProfileEvidence(window) {
  if (window.profileEvidence) {
    const evidence = window.profileEvidence;
    if (String(evidence.identifier ?? '').startsWith('TabGroupPickerButton?') && identifierProfile(evidence.identifier) !== profile) return null;
    if (evidence.value === profile && typeof evidence.element === 'string' && evidence.element &&
        ['AXMenuButton', 'AXPopUpButton', 'AXButton'].includes(evidence.role) &&
        ['AXTitle', 'AXDescription', 'AXValue', 'AXIdentifier'].includes(evidence.attribute)) return evidence;
    return null;
  }
  const matches = [];
  for (const node of window.toolbar || []) {
    if (!node.id || !['AXMenuButton', 'AXPopUpButton', 'AXButton'].includes(node.role)) continue;
    if (String(node.identifier ?? '').startsWith('TabGroupPickerButton?') &&
        (identifierProfile(node.identifier) !== profile || [node.title, node.description, node.value].some(label => label && label !== profile))) return null;
    const attribute = [['title', 'AXTitle'], ['description', 'AXDescription'], ['value', 'AXValue']].find(([key]) => node[key] === profile)?.[1] ||
      (identifierProfile(node.identifier) === profile ? 'AXIdentifier' : null);
    if (attribute) matches.push({ element: node.id, role: node.role,
      ...(node.identifier ? { identifier: node.identifier } : {}), attribute, value: profile });
  }
  const preferred = matches.filter(node => /profile/i.test(node.identifier || ''));
  const candidates = preferred.length ? preferred : matches;
  return candidates.length === 1 ? candidates[0] : null;
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
// What the census may say about a window that is not the round's: its AX shape, never a title, URL or content.
function windowShape(window) {
  const shape = { profileEvidence: Boolean(safariProfileEvidence(window)) };
  for (const key of ['role', 'subrole', 'frame', 'minimized', 'focused', 'childRoles']) if (Object.hasOwn(window, key)) shape[key] = window[key];
  return shape;
}
// known: titles of pages this harness loaded itself. Safari exposes only the selected tab's URL (through the address field), so an
// unselected tab still showing the harness's marker page gets the marker URL; any other unselected tab leaves the inventory unobserved.
function tabs(window, known = {}) {
  if (!Array.isArray(window.tabs) || !window.tabs.length) throw Error('BENCH_SAFARI_TABS_UNOBSERVED');
  const result = {};
  for (const tab of window.tabs) {
    const url = tab.url === '' && Object.hasOwn(known, tab.title) ? known[tab.title] : tab.url;
    if (typeof tab.id !== 'string' || !tab.id || typeof tab.title !== 'string' ||
        typeof url !== 'string' || !url || result[`safari:${tab.id}`]) throw Error('BENCH_SAFARI_TABS_UNOBSERVED');
    result[`safari:${tab.id}`] = { title: tab.title, url };
  }
  return result;
}


// The named profile is owner-created and persistent. Each task gets its own Safari: launched here with its own pid, a verified
// profile window, and quit (by that pid) before the next task, so no window, popup or sheet carries over between tasks. Launch
// and quit happen inside reset() and stop(), outside the agent's timed span (real-gate.mjs times only runGateAgent).
export async function launchSafari(plan, { spawnBrowser, listProcesses, timeoutMs, quitMs, ownerCheck,
  safariBridge = prepareSafariBridge, restoreWait = ms => new Promise(resolve => setTimeout(resolve, ms)), settleMs = 10000 }) {
  const root = dirname(plan.profileRoot);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  let bridge, running = false, stopped, windowId, fresh = null;
  const browser = { ...plan, ownerCheck, collections: [], launches: [] };
  const census = async (...given) => {
    const ownedPid = given.length ? given[0] : browser.pid;
    try { browser.ownerCheck = await checkBrowserOwner(plan, { listProcesses, ownedPid }); }
    catch (error) { browser.ownerCheck = error.ownerCheck; throw error; }
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  // After a quit, the previous Safari's WebKit services can outlive it for a moment; a launch waits until none is left.
  const censusClear = async () => {
    const deadline = Date.now() + settleMs;
    for (;;) {
      try { return await census(undefined); }
      catch (error) { if (!error.ownerCheck || !browser.pid || Date.now() >= deadline) throw error; await pause(250); }
    }
  };
  const snapshot = async () => windows(await bridge.request('snapshot'));
  const ownedWindow = list => {
    const window = list.find(w => w.id === windowId);
    const evidence = window && safariProfileEvidence(window);
    if (!evidence) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
    browser.profileEvidence = evidence;
    return window;
  };
  // Opens the benchmark profile window in a Safari this harness just launched and loads the marker page.
  const openWindow = async () => {
    await census();
    await restoreWait(2000);
    await census();
    let before = await snapshot();
    // Safari opens a Start Page window of its own at launch (in whichever profile was used last). It belongs to the process
    // this harness launched and holds no navigation, so the helper may close it; any other window stops the round.
    if (before.some(window => window.startPage !== true && !safariProfileEvidence(window))) throw Error('BENCH_SAFARI_RESTORED_WINDOWS: Safari restored windows from another profile; close your Safari windows or turn off window restore, then retry');
    if (before.some(window => window.startPage !== true)) throw Error('BENCH_SAFARI_EXTRA_WINDOWS');
    if (before.length) {
      for (const window of before) await bridge.request('close-launch-window', { window: window.id });
      const closing = Date.now() + timeoutMs;
      for (;;) {
        before = await snapshot();
        if (!before.length) break;
        if (Date.now() >= closing) throw Error('BENCH_SAFARI_LAUNCH_WINDOW_UNCLOSED');
        await pause(25);
      }
    }
    const previous = new Set(before.map(w => w.id));
    const menu = await bridge.request('new-profile');
    if (menu.menuEscapePosted !== true || menu.menuCleared !== true || ![1, 2].includes(menu.menuEscapes)) throw Error('BENCH_SAFARI_MENU_ESCAPE_UNPROVED');
    const deadline = Date.now() + timeoutMs;
    let created;
    for (;;) {
      const added = (await snapshot()).filter(w => !previous.has(w.id));
      if (added.length > 1) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
      if (added.length === 1 && safariProfileEvidence(added[0])) { created = added[0]; break; }
      if (Date.now() >= deadline) throw Error('BENCH_SAFARI_PROFILE_WINDOW_UNPROVED');
      await pause(25);
    }
    windowId = created.id; browser.profileWindow = windowId;
    browser.profileEvidence = safariProfileEvidence(created);
    await census();
    await bridge.request('navigate', { window: windowId, url: plan.markerUrl });
    for (;;) {
      const list = await snapshot(), current = ownedWindow(list);
      const inventory = tabs(current), values = Object.values(inventory);
      if (list.length === 1 && values.length === 1 && values[0].title === plan.marker && values[0].url === plan.markerUrl) {
        await census(); return inventory;
      }
      if (Date.now() >= deadline) throw Error('BENCH_SAFARI_MARKER_UNPROVED');
      await pause(25);
    }
  };
  // Quits the Safari launched here (the helper checks pid, executable and launch date, answers its own unsubmitted-form
  // alert and force-terminates only that process if it ignores the quit).
  const quitCurrent = async () => {
    const receipt = { pid: browser.pid, requestedAt: new Date().toISOString() }, began = Date.now(); browser.collections.push(receipt);
    try {
      const result = await bridge.request('quit', { quitMs });
      if (result.browserClosed !== true) throw Error('normal quit unproved');
      receipt.browserClosed = true; receipt.quitMs = Date.now() - began; running = false; windowId = undefined;
      if (result.unsubmittedFormQuitConfirmed === true) receipt.unsubmittedFormQuitConfirmed = true;
      if (result.forceTerminated === true) receipt.forceTerminated = true;
    } catch (error) { receipt.error = error.message; throw Error('BENCH_BROWSER_CLEANUP_UNPROVED', { cause: error }); }
  };
  const startSafari = async () => {
    await censusClear();
    // Set before the request: a launch whose reply never arrives still has to be collected.
    running = true;
    const requestedAt = Date.now(), launched = await bridge.request('launch');
    // A process that predates this request is not ours; its windows are never touched.
    if (!Number.isSafeInteger(launched.pid) || launched.pid <= 0 || !sameExecutable(launched.executable, plan.executable) ||
        !Number.isFinite(launched.launchDate) || launched.launchDate * 1000 < requestedAt - 1000) throw Error('BENCH_SAFARI_LAUNCH_UNPROVED');
    Object.assign(browser, launched);
    browser.launches.push({ pid: launched.pid, launchDate: launched.launchDate, launchMs: Date.now() - requestedAt });
    return await openWindow();
  };
  // The first task uses the Safari launched with the browser; every later task gets a fresh one.
  browser.reset = async () => {
    if (fresh) { const inventory = fresh; fresh = null; return inventory; }
    if (running) await quitCurrent();
    const began = Date.now(), inventory = await startSafari();
    browser.launches.at(-1).readyMs = Date.now() - began;
    return inventory;
  };
  browser.observe = async () => {
    let auxiliaryWindows = [];
    try {
      await census();
      const list = await snapshot();
      // A window with no profile evidence and a non-standard subrole (a floating panel or system dialog, never a document window)
      // holds no tabs of the round; it is recorded and skipped. A profile window or an unproven standard window still counts.
      const auxiliary = list.filter(w => !safariProfileEvidence(w) && typeof w.subrole === 'string' && w.subrole && w.subrole !== 'AXStandardWindow');
      auxiliaryWindows = auxiliary.map(windowShape);
      const counted = list.filter(w => !auxiliary.includes(w));
      if (counted.length !== 1) {
        throw Object.assign(Error('BENCH_SAFARI_EXTRA_WINDOWS'), { extraWindows: counted.filter(w => w.id !== windowId).map(windowShape) });
      }
      return { observed: true, source: 'AX-tab-bar', profileEvidence: browser.profileEvidence, tabs: tabs(ownedWindow(counted), { [plan.marker]: plan.markerUrl }),
        ...(auxiliaryWindows.length ? { auxiliaryWindows } : {}), unavailableGraders: ['completed downloads', 'device viewport'] };
    } catch (error) {
      return { observed: false, tabs: {}, reason: error.message, ...(error.ownerCheck ? { ownerCheck: error.ownerCheck } : {}),
        ...(error.extraWindows ? { extraWindows: error.extraWindows } : {}), ...(auxiliaryWindows.length ? { auxiliaryWindows } : {}),
        unavailableGraders: ['retention', 'handoff', 'completed downloads', 'device viewport'] };
    }
  };
  browser.stop = async () => {
    if (stopped) return stopped;
    if (running) await quitCurrent();
    try { await bridge?.close(); } catch (error) { throw Error('BENCH_BROWSER_CLEANUP_UNPROVED', { cause: error }); }
    rmSync(root, { recursive: true });
    return stopped = { browserClosed: true, profileDeleted: false, harnessDeleted: true };
  };
  try {
    bridge = await safariBridge(root, { spawnBrowser, timeoutMs });
    const began = Date.now();
    fresh = await startSafari();
    browser.launches.at(-1).readyMs = Date.now() - began;
    return browser;
  } catch (error) {
    try { await browser.stop(); } catch (cleanup) { error = cleanup; }
    const { stop, reset, observe, ...receipt } = browser;
    error.browserReceipt = receipt;
    throw error;
  }
}
