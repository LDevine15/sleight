import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, observeRealBrowser, checkBrowserOwner } from './real-browser.mjs';
import { REAL_SURFACES, realAgentSetup } from './real-gate-setup.mjs';
import { runCodex, codexConfigServers } from '../codex-arm.mjs';
import { runOwned } from '../preapproved-process.mjs';
import { assertLogin } from '../preflight.mjs';
import { assertWorldCLI } from '../world/native-world.mjs';
import { startHostMonitor, gradeHostMonitor } from './host-monitor.mjs';
import { startGateForms } from './real-gate-sites.mjs';
import { gradeGateTask } from './real-gate-grade.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const codexHome = () => join(homedir(), '.codex-bench');
export function realGatePlan({ args, tasks, repo = repoRoot, mcpRoot, armHome, round, realBrowser, dryRun = true }) {
  if (args.remote || args.gui || args.swap || args.serve || args['keep-tabs']) throw Error('real-browser gate owns its local window, browser order, sites and cleanup; omit remote/gui/swap/serve/keep-tabs');
  if (tasks.some(task => task.surface && task.surface !== args.surface)) throw Error('real-browser gate runs one surface per round');
  const surface = args.surface || 'sleight-turbo';
  if (!REAL_SURFACES.includes(surface)) throw Error(`real-browser surfaces: ${REAL_SURFACES.join(', ')}`);
  round ??= realBrowser?.marker?.slice('Sleight Gate '.length) ?? randomUUID();
  const browser = realBrowser ?? realBrowserPlan({ browser: args['real-browser'], round });
  const out = resolve(args.out || `/tmp/fb-rounds/real-${round}-${surface}`);
  const selected = tasks.filter(task => !task.takeover && (!args.only || args.only.split(',').includes(task.name)));
  if (!selected.length) throw Error('No gate tasks selected');
  if (selected.some(task => !/^[a-zA-Z0-9_-]+$/.test(task.name) || !['chrome', 'helium'].includes(task.browser))) throw Error('Invalid browser task');
  if (new Set(selected.map(task => task.name)).size !== selected.length) throw Error('Duplicate gate task names');
  const arms = selected.map(original => {
    const task = { ...original, browser: browser.browser };
    const dir = join(out, task.name);
    const setup = realAgentSetup({ task, surface, dir, realBrowser: browser, repo, armHome, dryRun,
      model: args.model || 'haiku', effort: args.effort || 'high' });
    return { ...setup, args: surface === 'codex' ? setup.args : [...setup.args, setup.prompt],
      task, surface, dir };
  });
  return { mode: 'real-browser', out, browser, arms, mcpRoot, surface };
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

export async function runGateAgent(plan, { signal, runClaude = runOwned, runNativeCodex = runCodex } = {}) {
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
      const run = await collect(() => runClaude(plan.command, plan.args, { cwd: plan.dir, env: plan.env, signal,
        timeoutMs: (plan.task.budgetSeconds || 600) * 4000 }));
      groupClean = run.groupClean;
      writeFileSync(events, run.stdout); writeFileSync(join(plan.dir, 'stderr.txt'), run.stderr);
      const messages = run.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      result = { exitCode: run.exit.code, result: messages.findLast(event => event.type === 'result'),
        timedOut: run.timedOut, groupClean: run.groupClean,
        toolCalls: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_use').length, 0),
        toolErrors: messages.reduce((count, event) => count + (event.message?.content || []).filter(item => item.type === 'tool_result' && item.is_error).length, 0) };
    }
    const receipt = { ...result, name: plan.task.name, started, finished: Date.now(), agentConfig: plan.metadata };
    writeFileSync(join(plan.dir, 'run.json'), JSON.stringify(receipt, null, 2));
    if (!groupClean) throw Object.assign(Error('BENCH_AGENT_CLEANUP_UNPROVED'), { groupClean: false });
    return receipt;
  } catch (error) {
    if (groupClean === false) error.groupClean = false;
    throw error;
  }
}

export async function admitRealGate(plan) {
  if (existsSync('/Library/Application Support/ClaudeCode/CLAUDE.md')) throw Error('Managed Claude policy cannot be excluded');
  if (existsSync(plan.out)) throw Error('Gate output already exists');
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
    const printable = { ...plan, arms: plan.arms.map(({ env, ...arm }) => ({ ...arm,
      environment: { ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) } })) };
    (runtime.print || console.log)(JSON.stringify(printable, null, 2)); return printable;
  }
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
      if (error.ownerCheck) writeFileSync(join(plan.out, 'browser.json'), JSON.stringify({ ...plan.browser, ownerCheck: error.ownerCheck }, null, 2));
      throw error;
    });
    const { stop, ...identity } = browser;
    plan = realGatePlan({ args, tasks, repo, mcpRoot, realBrowser: identity, dryRun: false });
    writeFileSync(join(plan.out, 'browser.json'), JSON.stringify(identity, null, 2));
    if (plan.surface === 'sleight-turbo') { monitor = await (runtime.startMonitor || startHostMonitor)(join(plan.out, 'monitor.jsonl')); await monitor.ready?.(); }
    for (const arm of plan.arms) {
      if (controller.signal.aborted) throw Error('Gate interrupted');
      const ownerCheck = await (runtime.checkOwner || checkBrowserOwner)(browser, { ownedPid: browser.pid }).catch(error => {
        if (error.ownerCheck) writeFileSync(join(plan.out, 'browser.json'), JSON.stringify({ ...identity, ownerCheck: error.ownerCheck }, null, 2));
        throw error;
      });
      writeFileSync(join(plan.out, 'browser.json'), JSON.stringify({ ...identity, ownerCheck }, null, 2));
      const start = await (runtime.resetBrowser || resetRealBrowser)(browser);
      const startKeys = new Set(Object.keys(start));
      if (controller.signal.aborted) throw Error('Gate interrupted');
      const run = await (runtime.runAgent || runGateAgent)(arm, { signal: controller.signal }).catch(error => {
        if (error.groupClean === false || error.collectionError) cleanupProven = false;
        throw error;
      });
      if (!run.groupClean) { cleanupProven = false; throw Error('BENCH_AGENT_CLEANUP_UNPROVED'); }
      const after = await (runtime.observeBrowser || observeRealBrowser)(browser);
      run.afterExit = after;
      run.tabs = new Set(Object.keys(after));
      const grade = await getJson(arm.task.grade);
      const site = await getJson(arm.task.name === 'form-checkout' ? 'http://127.0.0.1:5413/gate-log/p04' : arm.task.site?.log);
      const outcome = gradeGateTask({ task: arm.task, run, grade, site, runner, after, startKeys });
      const row = { task: arm.task, surface: arm.surface, status: 'ran', wallMs: run.finished - run.started, toolCalls: run.toolCalls, toolErrors: run.toolErrors,
        run: { ...run, tabs: [...run.tabs] }, start, agentConfig: arm.metadata, grade, site, outcome };
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
    if (cleanupProven) try { if (browser) writeFileSync(join(plan.out, 'cleanup.json'), JSON.stringify(await browser.stop())); }
    catch { cleanupProven = false; }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort);
    if (cleanupProven) rmdirSync(lockPath);
    else console.error(`Cleanup unproved; retained ${lockPath} and ${plan.browser.profileRoot}`);
  }
  for (const row of rows) row.focusGrade = row.surface === 'sleight-turbo' ? gradeHostMonitor(monitor?.log || [], row.run, rows.map(row => row.run))
    : { ok: null, cell: 'not measured', events: [], problems: [] };
  writeFileSync(join(plan.out, 'results.json'), JSON.stringify(rows, null, 2));
  const lines = ['| task | arm | outcome | focus | ms | calls | errors |', '|---|---|---|---|---:|---:|---:|',
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
