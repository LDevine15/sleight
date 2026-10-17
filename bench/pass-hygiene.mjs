import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

const processKey = item => `${item.pid}:${Math.round(item.start * 1000)}:${item.bundle}`;
const windowKey = item => `${processKey(item)}:${item.id}`;
const identity = ({ pid, start, bundle }) => ({ pid, start, bundle });
const valid = item => Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isFinite(item.start) && item.start > 0 && typeof item.bundle === 'string' && item.bundle.length > 0;

// Include off-screen baseline windows too: changing Spaces never transfers ownership.
export function planWindows(before, after, launched = []) {
  const oldWindows = new Set(before.windows.map(windowKey)), oldApps = new Set(before.apps.map(processKey));
  const owned = new Set(launched.filter(valid).map(processKey)), quits = new Set();
  const plan = [];
  for (const window of after.windows) {
    if (!valid(window) || !Number.isSafeInteger(window.id) || oldWindows.has(windowKey(window))) continue;
    const key = processKey(window);
    if (owned.has(key) && !oldApps.has(key) && !before.windows.some(old => processKey(old) === key)) {
      if (!quits.has(key)) { plan.push({ ...identity(window), action: 'quit' }); quits.add(key); }
    } else plan.push({ ...window, action: 'close' });
  }
  for (const app of after.apps.filter(valid)) {
    const key = processKey(app);
    if (owned.has(key) && !oldApps.has(key) && !quits.has(key) && !before.windows.some(old => processKey(old) === key)) {
      plan.push({ ...identity(app), action: 'quit' }); quits.add(key);
    }
  }
  return plan;
}

export async function finishWindows(before, { snapshot, act, launched = [], daemons = [], dryRun = false,
  blocked = false, beforeAction = async () => {}, log = console.log } = {}) {
  const result = { planned: [], leftWindows: [], errors: [] };
  for (const daemon of daemons) {
    log(`${dryRun ? 'would stop' : 'stop'} owned daemon ${daemon.name ?? ''}`);
    if (!dryRun) try { await daemon.stop(); } catch (error) { result.errors.push(error.message); }
  }
  const current = await snapshot();
  result.planned = planWindows(before, current, launched);
  const stoppedApps = new Set();
  for (const item of result.planned) {
    log(`${dryRun ? 'would ' : blocked ? 'kept: ' : ''}${item.action} ${JSON.stringify(item)}`);
    if (blocked || dryRun || stoppedApps.has(processKey(item))) continue;
    try { await beforeAction(); }
    catch (error) { blocked = true; result.errors.push(error.message); continue; }
    try { await act(item); }
    catch (error) {
      result.errors.push(error.message);
      // A close may have produced a Save sheet: never attempt the app's other windows after it.
      stoppedApps.add(processKey(item));
    }
  }
  const after = dryRun ? current : await snapshot();
  result.leftWindows = planWindows(before, after).map(({ action, ...window }) => window);
  for (const item of result.planned.filter(item => item.action === 'quit')) {
    if (after.apps.some(app => processKey(app) === processKey(item)) && !result.leftWindows.some(window => processKey(window) === processKey(item))) {
      result.leftWindows.push({ ...identity(item), reason: 'still running after Quit' });
    }
  }
  for (const item of result.leftWindows) log(`leftWindows ${JSON.stringify(item)}`);
  return result;
}

// Compile and invoke only inside the runner's live lock, never on import or a planning dry run.
export async function beginPassHygiene({ cacheDir, run = runOwned, signal } = {}) {
  const source = fileURLToPath(new URL('./pass-hygiene.swift', import.meta.url));
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  mkdirSync(cacheDir, { recursive: true });
  const binary = join(cacheDir, `pass-hygiene-${hash}`);
  const checked = async (command, args, options) => {
    const result = await run(command, args, options);
    if (result.groupClean !== true) throw Object.assign(new Error('Pass hygiene process group cleanup unconfirmed'), { uncollected: true });
    if (result.exit?.code !== 0 || result.timedOut || result.cancelled || result.spawnError) {
      throw new Error(`Pass hygiene helper failed: ${result.stderr?.trim() || result.spawnError || result.exit?.code}`);
    }
    return result.stdout;
  };
  if (!existsSync(binary)) {
    const bank = mkdtempSync(join(cacheDir, 'pass-hygiene-build-')), output = join(bank, 'helper');
    const modules = join(cacheDir, 'swift-module-cache'); mkdirSync(modules, { recursive: true });
    let uncollected = false;
    try {
      await checked('/usr/bin/xcrun', ['swiftc', '-module-cache-path', modules, source, '-o', output], { timeoutMs: 180000, signal });
      renameSync(output, binary);
    } catch (error) { uncollected = error.uncollected === true; throw error; }
    finally { if (!uncollected) rmSync(bank, { recursive: true, force: true }); }
  }
  const call = async request => JSON.parse(await checked(binary, [JSON.stringify(request)], { timeoutMs: 10000 }));
  const snapshot = async () => {
    const value = await call({ action: 'snapshot' });
    if (!value || !Array.isArray(value.apps) || !Array.isArray(value.windows) || !value.apps.every(valid) ||
      !value.windows.every(window => valid(window) && Number.isSafeInteger(window.id) && window.id > 0 &&
        value.apps.some(app => processKey(app) === processKey(window)))) {
      throw new Error('Pass hygiene snapshot unavailable or incomplete');
    }
    return value;
  };
  const before = await snapshot();
  return { finish: options => finishWindows(before, { ...options, snapshot, act: call }) };
}
