import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function realBrowserPlan({ browser, round, home = homedir() }) {
  if (!['chrome', 'helium'].includes(browser)) throw Error('real browser must be chrome or helium');
  if (typeof round !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(round)) throw Error('invalid round identity');
  const profileRoot = join(home, 'Library/Caches/sleight-bench/real-browser', round, 'profile');
  const executable = browser === 'chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/Applications/Helium.app/Contents/MacOS/Helium';
  const marker = `Sleight Gate ${round}`;
  const url = 'data:text/html,' + encodeURIComponent(`<title>${marker}</title><h1>${marker}</h1>`);
  return { browser, executable, profileRoot, marker, command: executable,
    args: ['--user-data-dir=' + profileRoot, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--use-mock-keychain',
      '--password-store=basic', '--new-window', url],
    headless: false, connectionMode: 'product-remote-debugging' };
}

function browserProcesses() {
  const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (!output.trim()) throw Error('BENCH_PROCESS_LIST_UNAVAILABLE');
  return output.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) throw Error('BENCH_PROCESS_LIST_INVALID');
    return { pid: Number(match[1]), executable: match[2] };
  });
}

export async function checkBrowserOwner(plan, { listProcesses = browserProcesses } = {}) {
  const ownerCheck = { executable: plan.executable, checkedAt: new Date().toISOString(), ok: false, otherPids: [] };
  try {
    const processes = await listProcesses();
    if (!Array.isArray(processes) || processes.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
        typeof row.executable !== 'string' || !row.executable)) throw Error('BENCH_PROCESS_LIST_INVALID');
    const canonical = path => existsSync(path) ? realpathSync(path) : path;
    ownerCheck.otherPids = processes.filter(row => canonical(row.executable) === canonical(plan.executable)).map(row => row.pid);
    if (ownerCheck.otherPids.length) throw Error(`Quit ${plan.browser} before starting this round; another process uses the browser executable (PID ${ownerCheck.otherPids.join(', ')}).`);
    ownerCheck.ok = true;
    return ownerCheck;
  } catch (error) { ownerCheck.error = error.message; error.ownerCheck = ownerCheck; throw error; }
}

function ordinaryParents(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) throw Error('BENCH_PROFILE_UNSAFE');
    }
    if (dirname(current) === current) break;
  }
}

// The runner owns this exact child and profile. A failed collection retains the
// profile and live lock so the next round cannot hide an orphaned window.
export async function launchRealBrowser(plan, { spawnBrowser = spawn, listProcesses, timeoutMs = 15000, stopMs = 5000 } = {}) {
  const expected = realBrowserPlan({ browser: plan.browser, round: plan.marker?.slice('Sleight Gate '.length) });
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw Error('BENCH_PROFILE_UNSAFE');
  const ownerCheck = await checkBrowserOwner(plan, { listProcesses });
  try { return { ...await startRealBrowser(plan, { spawnBrowser, timeoutMs, stopMs }), ownerCheck }; }
  catch (error) { error.ownerCheck = ownerCheck; throw error; }
}

async function startRealBrowser(plan, { spawnBrowser, timeoutMs, stopMs }) {
  ordinaryParents(plan.profileRoot);
  mkdirSync(dirname(dirname(plan.profileRoot)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(plan.profileRoot), { mode: 0o700 });
  mkdirSync(plan.profileRoot, { mode: 0o700 });
  let child;
  try { child = spawnBrowser(plan.command, plan.args, { stdio: 'ignore' }); }
  catch (error) { rmSync(dirname(plan.profileRoot), { recursive: true }); throw error; }
  let closed = false, spawnError;
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', () => { closed = true; resolve(); });
  });
  const wait = async ms => {
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (!closed) { child.kill('SIGTERM'); await wait(stopMs); }
    if (!closed) { child.kill('SIGKILL'); await wait(stopMs); }
    if (!closed) throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');
    rmSync(dirname(plan.profileRoot), { recursive: true });
    return { browserClosed: true, profileDeleted: true };
  })();
  const deadline = Date.now() + timeoutMs, file = join(plan.profileRoot, 'DevToolsActivePort');
  try {
    for (;;) {
      if (closed || spawnError || Date.now() > deadline) throw Error('BENCH_BROWSER_START_FAILED');
      if (existsSync(file) && /^\d+\n\/devtools\/browser\/[^\s]+\n?$/.test(readFileSync(file, 'utf8'))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ...plan, pid: child.pid, stop };
  } catch (error) { await stop(); throw error; }
}

export function validateRealBrowser(browser) {
  const round = browser?.marker?.slice('Sleight Gate '.length);
  const expected = realBrowserPlan({ browser: browser?.browser, round });
  if (browser.profileRoot !== expected.profileRoot || browser.executable !== expected.executable ||
      !Number.isSafeInteger(browser.pid) || browser.pid <= 0) throw Error('BENCH_PROFILE_UNSAFE');
  ordinaryParents(browser.profileRoot);
  const stat = lstatSync(browser.profileRoot);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('BENCH_PROFILE_UNSAFE');
  return browser;
}

// Only the runner's exact private profile supplies this connection, never browser discovery.
export async function realBrowserCommands(browser, { Socket = globalThis.WebSocket, validate = validateRealBrowser, timeoutMs = 5000 } = {}) {
  validate(browser);
  const portFile = readFileSync(join(browser.profileRoot, 'DevToolsActivePort'), 'utf8');
  const match = /^(\d+)\n(\/devtools\/browser\/[^\s]+)\n?$/.exec(portFile);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error('BENCH_BROWSER_ENDPOINT_INVALID');
  const socket = new Socket(`ws://127.0.0.1:${match[1]}${match[2]}`);
  let serial = 0;
  const pending = new Map();
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  socket.addEventListener('message', event => {
    try {
      const frame = JSON.parse(event.data), entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(Error(frame.error.message)); else entry.resolve(frame.result);
    } catch (error) { fail(error); }
  });
  socket.addEventListener('close', () => fail(Error('BENCH_BROWSER_CONNECTION_CLOSED')));
  socket.addEventListener('error', () => fail(Error('BENCH_BROWSER_CONNECTION_ERROR')));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('BENCH_BROWSER_CONNECTION_TIMEOUT')), timeoutMs);
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('BENCH_BROWSER_CONNECTION_ERROR')), { once: true });
      socket.addEventListener('close', () => reject(Error('BENCH_BROWSER_CONNECTION_CLOSED')), { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  finally { clearTimeout(timer); }
  return {
    async send(method, params = {}) {
      if (socket.readyState !== 1) throw Error('BENCH_BROWSER_CONNECTION_CLOSED');
      const id = ++serial;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(Error('BENCH_BROWSER_COMMAND_TIMEOUT')), timeoutMs);
          socket.send(JSON.stringify({ id, method, params }));
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
    async close() {
      if (socket.readyState === 3) return;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('BENCH_BROWSER_DISCONNECT_TIMEOUT')), timeoutMs);
          socket.addEventListener('close', resolve, { once: true }); socket.close();
        });
      } finally { clearTimeout(timer); }
    },
  };
}

const inventory = (browser, targets) => Object.fromEntries(targets.filter(target => target.type === 'page')
  .map(target => [`${browser.browser}:${target.targetId}`, { url: target.url, title: target.title }]));

export async function observeRealBrowser(browser, { connect = realBrowserCommands } = {}) {
  const connection = await connect(browser);
  try { return inventory(browser, (await connection.send('Target.getTargets')).targetInfos); }
  finally { await connection.close(); }
}

export async function resetRealBrowser(browser, { connect = realBrowserCommands, timeoutMs = 5000 } = {}) {
  const connection = await connect(browser);
  try {
    const previous = (await connection.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
    const { targetId } = await connection.send('Target.createTarget', { url: browser.args.at(-1) });
    if (typeof targetId !== 'string' || !targetId || previous.some(target => target.targetId === targetId)) throw Error('BENCH_BROWSER_RESET_FAILED');
    // Create first so closing the last old tab cannot exit the owned browser.
    for (const target of previous) {
      if (!(await connection.send('Target.closeTarget', { targetId: target.targetId })).success) throw Error('BENCH_BROWSER_RESET_FAILED');
    }
    await connection.send('Target.activateTarget', { targetId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const targets = (await connection.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
      if (targets.length === 1 && targets[0].targetId === targetId && targets[0].title === browser.marker) return inventory(browser, targets);
      if (Date.now() >= deadline) throw Error('BENCH_BROWSER_RESET_FAILED');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { await connection.close(); }
}
