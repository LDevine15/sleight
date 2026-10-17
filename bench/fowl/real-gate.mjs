import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, observeRealBrowser, checkBrowserOwner, browserVersion, profileSourceProblems, watchNavigations } from './real-browser.mjs';
import { REAL_SURFACES, realAgentSetup, withClaudeManifest } from './real-gate-setup.mjs';
import { benchmarkProfile } from '../world/arms/chrome.mjs';
import { executableProblem } from '../../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { runCodex, codexConfigServers } from '../codex-arm.mjs';
import { runOwned } from '../preapproved-process.mjs';
import { assertLogin } from '../preflight.mjs';
import { assertWorldCLI } from '../world/native-world.mjs';
import { startHostMonitor, gradeHostMonitor } from './host-monitor.mjs';
import { startGateForms } from './real-gate-sites.mjs';
import { gradeGateTask, browserEvidence } from './real-gate-grade.mjs';
import { taskSupport } from './support.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const codexHome = () => join(homedir(), '.codex-bench');
export function realGatePlan({ args, tasks, repo = repoRoot, mcpRoot, armHome, round, realBrowser, dryRun = true }) {
  if (args.remote || args.gui || args.swap || args.serve || args['keep-tabs']) throw Error('real-browser gate owns its local window, browser order, sites and cleanup; omit remote/gui/swap/serve/keep-tabs');
  if (tasks.some(task => task.surface && task.surface !== args.surface)) throw Error('real-browser gate runs one surface per round');
  const surface = args.surface || (['firefox', 'safari'].includes(args['real-browser']) ? 'sleight' : 'sleight-turbo');
  if (!REAL_SURFACES.includes(surface)) throw Error(`real-browser surfaces: ${REAL_SURFACES.join(', ')}`);
  round ??= realBrowser?.marker?.slice('Sleight Gate '.length) ?? randomUUID();
  // Chrome's extension arms need the benchmark profile; every other arm can ask for it so all arms share one setup.
  const profile = args['real-profile'] ?? (['fowlbrowser', 'claude-in-chrome'].includes(surface) && args['real-browser'] === 'chrome' ? 'benchmark' : 'fresh');
  const browser = realBrowser ?? realBrowserPlan({ browser: args['real-browser'], round, profile, surface });
  const out = resolve(args.out || `/tmp/fb-rounds/real-${round}-${surface}`);
  const candidates = tasks.filter(task => !args.only || args.only.split(',').includes(task.name));
  if (!candidates.length) throw Error('No gate tasks selected');
  if (['firefox', 'safari'].includes(browser.browser) && surface === 'sleight-turbo') throw Error('Firefox/Safari have no turbo surface; use sleight');
  if (!['firefox', 'safari'].includes(browser.browser) && surface === 'sleight') throw Error('Chrome/Helium use sleight-turbo');
  const unsupported = candidates.flatMap(task => {
    const reason = task.takeover ? 'Takeover requires the separate user-takeover test protocol'
      : taskSupport(task, surface, { realBrowser: browser.browser });
    return reason ? [{ task, status: 'not-supported', reason }] : [];
  });
  const selected = candidates.filter(task => !unsupported.some(row => row.task === task));
  if (selected.some(task => !/^[a-zA-Z0-9_-]+$/.test(task.name) || !['chrome', 'helium', 'firefox', 'safari'].includes(task.browser))) throw Error('Invalid browser task');
  if (new Set(selected.map(task => task.name)).size !== selected.length) throw Error('Duplicate gate task names');
  const arms = selected.map(original => {
    const task = { ...original, browser: browser.browser };
    const dir = join(out, task.name);
    // After launch the pin is the device ID read from the round's own profile copy.
    const deviceFile = browser.claudeDeviceFile ?? args['chrome-device-file'];
    const chromeFiles = { ...(deviceFile ? { deviceFile } : {}),
      ...(args['chrome-local-state'] ? { localState: args['chrome-local-state'] } : {}) };
    const setup = realAgentSetup({ task, surface, dir, realBrowser: browser, repo, armHome, dryRun, mcpRoot, chromeFiles,
      model: args.model || 'haiku', effort: args.effort || 'high' });
    return { ...setup, args: surface === 'codex' ? setup.args : [...setup.args, setup.prompt],
      task, surface, dir };
  });
  return { mode: 'real-browser', out, browser, arms, unsupported, mcpRoot, surface };
}

async function freePort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
export async function startGateSites(mcpRoot) {
  for (const port of [5413, 5414, 5420, 5421]) await freePort(port);
  const shop = await import(pathToFileURL(join(mcpRoot, 'test/demo/server.mjs')));
  const a = await startGateForms(join(mcpRoot, 'test/forms'));
  let b;
  try { b = shop.startServer(); } catch (error) { await a.close(); throw error; }
  return { close: async () => { await Promise.all([a.close(), b.close()]); } };
}
const getJson = async url => {
  if (!url) return null;
  try { const res = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!res.ok) throw Error(`HTTP ${res.status}`); return await res.json(); }
  catch (error) { return { error: error.message }; }
};

export async function runGateAgent(plan, { signal, runClaude = runOwned, runNativeCodex = runCodex, guardChrome = withClaudeManifest } = {}) {
  mkdirSync(plan.dir, { mode: 0o700 });
  let result;
  const collect = async operation => {
    try { return await operation(); }
    catch (thrown) {
      const error = thrown instanceof Error ? thrown : Error(String(thrown), { cause: thrown });
      error.collectionError = true; throw error;
    }
  };
  const started = Date.now(), events = join(plan.dir, 'events.jsonl');
  writeFileSync(events, '');
  let groupClean;
  try {
    if (plan.surface === 'codex') {
      const run = await collect(() => runNativeCodex(plan.prompt, { cwd: plan.dir, model: 'gpt-6-luna', effort: 'high', home: codexHome(),
        signal, timeoutMs: (plan.task.budgetSeconds || 600) * 4000,
        onEvent: event => appendFileSync(events, JSON.stringify({ t: Date.now(), ...event }) + '\n') }));
      groupClean = run.groupClean;
      result = { exitCode: run.code, result: run.out, timedOut: run.timedOut, groupClean: run.groupClean,
        forbidden: run.forbidden, toolCalls: run.toolCalls, engineMs: run.engineMs };
      if (run.forbidden.length) result.result = { ...run.out, is_error: true };
      writeFileSync(join(plan.dir, 'stderr.txt'), run.stderr);
    } else {
      writeFileSync(join(plan.dir, 'mcp.json'), JSON.stringify(plan.mcpConfig, null, 2), { mode: 0o600 });
      writeFileSync(join(plan.dir, 'settings.json'), JSON.stringify(plan.settingsOverrides, null, 2), { mode: 0o600 });
      const agent = () => runClaude(plan.command, plan.args, { cwd: plan.dir, env: plan.env, signal,
        timeoutMs: (plan.task.budgetSeconds || 600) * 4000 });
      const run = await collect(() => plan.surface === 'claude-in-chrome' ? guardChrome(plan, agent) : agent());
      groupClean = run.groupClean;
      writeFileSync(events, run.stdout); writeFileSync(join(plan.dir, 'stderr.txt'), run.stderr);
      const messages = run.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      result = { exitCode: run.exit.code, result: messages.findLast(event => event.type === 'result'),
        timedOut: run.timedOut, groupClean: run.groupClean,
        toolCalls: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_use').length, 0),
        toolErrors: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_result' && item.is_error).length, 0) };
    }
    // Graders require a successful browser call (and for lookups a visit), so an answer from memory fails.
    const evidence = browserEvidence(readFileSync(events, 'utf8'));
    const receipt = { ...result, evidence, name: plan.task.name, started, finished: Date.now(), agentConfig: plan.metadata };
    writeFileSync(join(plan.dir, 'run.json'), JSON.stringify(receipt, null, 2));
    if (!groupClean) throw Object.assign(Error('BENCH_AGENT_CLEANUP_UNPROVED'), { groupClean: false });
    return receipt;
  } catch (error) {
    if (groupClean === false) error.groupClean = false;
    throw error;
  }
}

// What would stop a live round before it starts, read without launching anything.
export function gatePreflight(plan, { executable = executableProblem } = {}) {
  const problems = profileSourceProblems(plan.browser);
  // The product refuses a browser binary others can write (selected-connection.mjs). Chrome ships mode 775 on this
  // Mac, so a turbo round there would answer from memory (live smoke 2026-10-17: every call "Turbo bench unavailable").
  const reason = plan.surface === 'sleight-turbo' && executable(plan.browser.executable);
  if (reason) problems.push(`Turbo refuses ${plan.browser.executable} (${reason}); the owner can run: chmod go-w "${plan.browser.executable}"`);
  return problems;
}

export async function admitRealGate(plan) {
  if (existsSync('/Library/Application Support/ClaudeCode/CLAUDE.md')) throw Error('Managed Claude policy cannot be excluded');
  if (existsSync(plan.out)) throw Error('Gate output already exists');
  const problems = gatePreflight(plan);
  if (problems.length) throw Error(problems.join('; '));
  const setups = plan.arms;
  if (plan.surface === 'codex') {
    if (codexConfigServers(codexHome()).length !== 1 || !existsSync(join(codexHome(), 'auth.json'))) throw Error('Codex benchmark home needs its isolated engine server and login');
  } else {
    assertWorldCLI(setups[0].command);
    assertLogin({ command: setups[0].command, env: setups[0].env });
  }
}

// Dry planning happens before admission, locks, sites, observers, helpers or browsers.
// Runtime injection is only for offline lifecycle tests, never CLI/environment input.
export async function runRealGate({ args, repo = repoRoot, mcpRoot, runner, tasks,
  runtime = {} }) {
  tasks ??= JSON.parse(readFileSync(resolve(mcpRoot, args.tasks || 'tools/agents/codex-h2h.json'), 'utf8'));
  let plan = realGatePlan({ args, tasks, repo, mcpRoot });
  if (args['dry-run']) {
    // Read-only previews of what launch records: the app version and the benchmark profile's folder.
    let profileFolder;
    if (plan.browser.profileMode === 'benchmark-copy') {
      try { profileFolder = benchmarkProfile(join(plan.browser.profileSource.userDataDir, 'Local State')); } catch (error) { profileFolder = { error: error.message }; }
    }
    const printable = { ...plan, browser: { ...plan.browser, version: (runtime.readVersion || browserVersion)(plan.browser.executable) ?? plan.browser.version ?? null,
      ...(profileFolder ? { profileFolder } : {}), preflight: (runtime.preflight || gatePreflight)(plan) },
      arms: plan.arms.map(({ env, ...arm }) => ({ ...arm,
      environment: { ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
        ...Object.fromEntries(['SLEIGHT_TURBO', 'FOWL_GATE_WINDOW'].filter(key => env[key] !== undefined).map(key => [key, env[key]])) } })) };
    (runtime.print || console.log)(JSON.stringify(printable, null, 2)); return printable;
  }
  if (!plan.arms.length) throw Error('No runnable gate tasks: ' + plan.unsupported.map(row => row.reason).join('; '));
  // The live copy always reads Chrome's own profile list, so a substitute list would pin a different folder.
  if (args['chrome-local-state']) throw Error('--chrome-local-state is for dry runs only');
  await (runtime.admit || admitRealGate)(plan);
  const lockPath = runtime.lockPath || '/tmp/sleight-live.lock';
  if (existsSync('/tmp/sleight-hold')) throw Error('Benchmark hold is active');
  mkdirSync(lockPath);
  const controller = new AbortController(), abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, abort);
  let browser, sites, monitor, cleanupProven = true;
  const rows = [];
  try {
    mkdirSync(plan.out, { recursive: true, mode: 0o700 });
    // Resolve pinned native receipts before the first browser launch.
    realGatePlan({ args, tasks, repo, mcpRoot, realBrowser: plan.browser, dryRun: false });
    sites = await (runtime.startSites || startGateSites)(mcpRoot);
    browser = await (runtime.launchBrowser || launchRealBrowser)(plan.browser).catch(error => {
      if (error.message === 'BENCH_BROWSER_CLEANUP_UNPROVED') cleanupProven = false;
      if (error.browserReceipt || error.ownerCheck) writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(error.browserReceipt || { ...plan.browser, ownerCheck: error.ownerCheck }, null, 2));
      throw error;
    });
    const identity = () => { const { stop, reset, observe, ...value } = browser; return value; };
    plan = realGatePlan({ args, tasks, repo, mcpRoot, realBrowser: identity(), dryRun: false });
    writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
    writeFileSync(join(plan.out, 'unsupported.json'), JSON.stringify(plan.unsupported, null, 2));
    if (plan.surface === 'sleight-turbo') { monitor = await (runtime.startMonitor || startHostMonitor)(join(plan.out, 'monitor.jsonl')); await monitor.ready?.(); }
    // Claude in Chrome reaches Anthropic's browser bridge about 6 s after launch (smoke 2026-10-17: launch 20:17:53,
    // connected 20:17:59). Starting sooner costs the first task a failed select_browser that other arms never pay.
    if (plan.surface === 'claude-in-chrome') await (runtime.settle || (ms => new Promise(resolve => setTimeout(resolve, ms))))(10000);
    for (let arm of plan.arms) {
      if (controller.signal.aborted) throw Error('Gate interrupted');
      const census = async () => {
        const ownerCheck = await (runtime.checkOwner || checkBrowserOwner)(browser, { ownedPid: browser.pid }).catch(error => {
          if (error.ownerCheck) {
            browser.ownerCheck = error.ownerCheck;
            writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
          }
          throw error;
        });
        browser.ownerCheck = ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify({ ...identity(), ownerCheck }, null, 2));
      };
      if (browser.browser !== 'firefox') await census();
      const start = await (runtime.resetBrowser || resetRealBrowser)(browser).catch(error => {
        if (error.ownerCheck) browser.ownerCheck = error.ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
        throw error;
      });
      if (browser.browser === 'firefox') await census();
      const startKeys = new Set(Object.keys(start));
      if (browser.browser === 'firefox') {
        arm = realGatePlan({ args, tasks: [arm.task], repo, mcpRoot, realBrowser: identity(), dryRun: false }).arms[0];
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
      }
      if (controller.signal.aborted) throw Error('Gate interrupted');
      // Chrome and Helium report every page URL while the agent runs; the lookup graders need that visit.
      let watch = null, navigation;
      if (!['firefox', 'safari'].includes(browser.browser)) {
        try { watch = await (runtime.watchBrowser || watchNavigations)(browser); }
        catch (error) { navigation = { observed: false, reason: error.message }; }
      }
      const run = await (runtime.runAgent || runGateAgent)(arm, { signal: controller.signal }).catch(error => {
        if (error.groupClean === false || error.collectionError) cleanupProven = false;
        throw error;
      }).finally(async () => {
        if (!watch) return;
        navigation = { observed: true, urls: watch.urls() };
        await watch.close().catch(() => {});
      });
      if (!run.groupClean) { cleanupProven = false; throw Error('BENCH_AGENT_CLEANUP_UNPROVED'); }
      const snapshot = await (runtime.observeBrowser || observeRealBrowser)(browser);
      const observation = ['firefox', 'safari'].includes(browser.browser) ? snapshot : { observed: true, tabs: snapshot };
      const after = observation.tabs;
      if (browser.browser === 'firefox') {
        // Positions can move or be reused; the first history entry identifies the start tab.
        startKeys.clear();
        for (const [key, tab] of Object.entries(after)) if (tab.initialUrl === browser.args.at(-1) || tab.url === browser.args.at(-1)) startKeys.add(key);
        if (observation.ownerCheck) browser.ownerCheck = observation.ownerCheck;
        writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity(), null, 2));
      }
      run.afterExit = after;
      run.tabs = new Set(Object.keys(after));
      const grade = await getJson(arm.task.grade);
      const site = await getJson(arm.task.name === 'form-checkout' ? 'http://127.0.0.1:5413/gate-log/p04' : arm.task.site?.log);
      const evidence = run.evidence;
      // A failed navigation log on Chrome or Helium proves no visit; only Firefox and Safari fall back to tool text.
      const visits = navigation ? (navigation.observed ? navigation.urls : []) : null;
      const outcome = gradeGateTask({ task: arm.task, run, grade, site, runner, after, startKeys,
        observed: observation.observed, observationReason: observation.reason, ownerCheck: observation.ownerCheck, evidence, visits });
      const row = { task: arm.task, surface: arm.surface, status: 'ran', wallMs: run.finished - run.started, toolCalls: run.toolCalls, toolErrors: run.toolErrors,
        successfulBrowserCalls: evidence?.successfulCalls ?? null, run: { ...run, tabs: [...run.tabs] }, start, observation, navigation: navigation ?? null,
        agentConfig: arm.metadata, grade, site, outcome };
      rows.push(row);
      writeFileSync(join(arm.dir, 'run.json'), JSON.stringify(row, null, 2));
      writeFileSync(join(plan.out, 'results.json'), JSON.stringify(rows, null, 2));
    }
  } catch (error) {
    if (existsSync(plan.out)) writeFileSync(join(plan.out, 'failure.json'), JSON.stringify({ error: error.message, completed: rows.length }));
    throw error;
  } finally {
    try { await monitor?.stop(); } catch { cleanupProven = false; }
    try { await sites?.close(); } catch { cleanupProven = false; }
    // A leaked agent may still drive this window. Retain both profile and lock.
    if (cleanupProven) try {
      if (browser) {
        try { writeFileSync(join(plan.out, 'cleanup.json'), JSON.stringify(await browser.stop())); }
        finally {
          const { stop, reset, observe, ...receipt } = browser;
          writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(receipt, null, 2));
        }
      }
    }
    catch { cleanupProven = false; }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort);
    if (cleanupProven) rmdirSync(lockPath);
    else console.error(`Cleanup unproved; retained ${lockPath} and ${plan.browser.profileRoot}`);
  }
  for (const row of rows) row.focusGrade = row.surface === 'sleight-turbo' ? gradeHostMonitor(monitor?.log || [], row.run, rows.map(row => row.run))
    : { ok: null, cell: 'not measured', events: [], problems: [] };
  writeFileSync(join(plan.out, 'results.json'), JSON.stringify(rows, null, 2));
  const used = browser ? (({ stop, reset, observe, ...value }) => value)(browser) : plan.browser;
  const profileText = used.profileMode === 'benchmark-copy' ? `a copy of Chrome's "sleight benchmark" (${used.profileFolder ?? 'folder unknown'})`
    : `fresh at ${used.profileRoot}`;
  const lines = [`Browser: ${used.browser} ${used.version ?? '(version unknown)'}, profile ${profileText}` +
    `${used.loadedExtensions?.length ? `, loaded ${used.loadedExtensions.join(', ')}` : ''}.`, '',
    '| task | arm | outcome | focus | ms | calls | errors |', '|---|---|---|---|---:|---:|---:|',
    ...rows.map(row => `| ${row.task.name} | ${row.surface} | ${row.outcome.cell} | ${row.focusGrade.cell} | ${row.wallMs} | ${row.toolCalls ?? 'unknown'} | ${row.toolErrors ?? 'unknown'} |`)];
  writeFileSync(join(plan.out, 'report.md'), lines.join('\n') + '\n');
  if (!cleanupProven || rows.some(row => !row.outcome.ok || row.focusGrade.ok === false)) process.exitCode = 1;
  return rows;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const values = process.argv.slice(2), args = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i].slice(2);
    args[key] = ['dry-run', 'world'].includes(key) ? true : values[++i];
  }
  if (!args['dry-run']) throw Error('Use bench/fowl/rounds.sh for live rounds');
  await runRealGate({ args, mcpRoot: join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser') });
}
