import { spawn } from 'node:child_process';
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
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window', url],
    headless: false, connectionMode: 'product-remote-debugging' };
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
export async function launchRealBrowser(plan, { spawnBrowser = spawn, timeoutMs = 15000, stopMs = 5000 } = {}) {
  const expected = realBrowserPlan({ browser: plan.browser, round: plan.marker?.slice('Sleight Gate '.length) });
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw Error('BENCH_PROFILE_UNSAFE');
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
