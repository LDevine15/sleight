#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = [
  ['vscode', 'Visual Studio Code', 'com.microsoft.VSCode', 'Electron/CEF', 'workspace'],
  ['cursor', 'Cursor', 'com.todesktop.230313mzl4w4u92', 'Electron/CEF', 'workspace'],
  ['spotify', 'Spotify', 'com.spotify.client', 'Electron/CEF', 'existing'],
  ['word', 'Microsoft Word', 'com.microsoft.Word', 'Office', 'docx'],
  ['excel', 'Microsoft Excel', 'com.microsoft.Excel', 'Office', 'xlsx'],
  ['textedit', 'TextEdit', 'com.apple.TextEdit', 'Apple native', 'txt'],
  ['finder', 'Finder', 'com.apple.finder', 'Apple native', 'folder'],
  ['notes', 'Notes', 'com.apple.Notes', 'Apple native', 'local-container'],
  ['calendar', 'Calendar', 'com.apple.iCal', 'Apple native', 'local-container'],
  ['helium', 'Helium', 'net.imput.helium', 'Chromium', 'browser'],
  ['slack', 'Slack', 'com.tinyspeck.slackmacgap', 'Electron/CEF', 'existing', true],
  ['discord', 'Discord', 'com.hnc.Discord', 'Electron/CEF', 'existing', true],
  ['whatsapp', 'WhatsApp', 'net.whatsapp.WhatsApp', 'Account app', 'existing', true],
  ['notion', 'Notion', 'notion.id', 'Electron/CEF', 'existing', true],
  ['mail', 'Mail', 'com.apple.mail', 'Apple native', 'existing', true],
].map(([id, app, bundle, group, fixture, ownerPresent = false]) =>
  ({ id, app, bundle, class: group, fixture, ownerPresent, readOnly: ownerPresent }));

export function speedPlan({ ids, runs = 10, ownerPresent = false, concurrentApp = 'textedit', dryRun = false } = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw Error('runs must be an integer from 1 to 30');
  if (ids && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)) throw Error('apps must be a nonempty unique list');
  const apps = ids ? ids.map(id => {
    const app = catalog.find(a => a.id === id);
    if (!app) throw Error('unknown app id: ' + id);
    return app;
  }) : catalog.filter(app => !app.ownerPresent || ownerPresent);
  if (apps.some(app => app.ownerPresent) && !ownerPresent) throw Error('account apps require --owner-present');
  if (!apps.some(app => app.id === concurrentApp)) {
    if (concurrentApp === 'textedit' && ids && !ids.includes('textedit')) concurrentApp = apps[0].id;
    else throw Error('concurrent app must be selected');
  }
  return { dryRun, runs, concurrency: 4, concurrentApp, ownerPresent, apps: apps.map(app => ({ ...app, readOnly: ownerPresent || app.readOnly })),
    excluded: catalog.filter(app => !apps.includes(app)).map(app => ({ id: app.id, reason: app.ownerPresent && !ownerPresent ? 'requires --owner-present' : 'not selected' })),
    phases: ['acquire', 'first explicit full read', 'warm full read', 'unique scroll-area action', 'full readback'],
    concurrentPhases: ['acquire', 'first explicit full read', 'warm full read'],
    note: 'Acquisition includes the engine automatic initial read. Concurrent and owner-present samples send no input. Local-container away cells are unqualified and refused before host access. Owner-present reads do not prove local-container membership. A missing unique scroll target is a failed action sample.',
    prerequisites: ['background fixture ownership', 'qualified current local-container identity for away cells (unavailable)', 'local-container receipts for owner-present reads only', 'owner-approved benchmark browser profile receipt', 'workspace apps stopped before opening a fresh folder', 'live lock and hold preflights'] };
}

export function speedScope(plan, task) {
  // AX text and owner-attested IDs do not join the active document to a local container.
  // No supported joining adapter is qualified here. Refuse before acquiring any host/client.
  if (task.fixture === 'local-container' && plan.ownerPresent !== true) throw Error('LOCAL_CONTAINER_UNQUALIFIED');
  return plan.ownerPresent === true ? 'owner-present-read-only' : 'owned-fixture';
}

export async function readMetrics(handle, { marker, requiredText, scrollMarker } = {}) {
  const tree = await handle.getAXState({ disableDiffing: true, emit: false });
  return treeMetrics(tree, { marker, requiredText, scrollMarker });
}

// Serialized into the engine. Receives text, never a native handle.
function treeMetrics(tree, { marker, requiredText, scrollMarker } = {}) {
  if (typeof tree !== 'string') throw Error('TREE_UNAVAILABLE');
  if (marker && !tree.split('\n')[0].includes(marker) || requiredText && !tree.includes(requiredText)) throw Error('FIXTURE_IDENTITY');
  const numbered = [...tree.matchAll(/^\t*\d+ /gm)].length;
  const dom = [...tree.matchAll(/\bnode_id=/g)].length;
  const scrolls = [...tree.matchAll(/^\t*(\d+) (?:scroll area|scroll view|AXScrollArea)\b/gmi)];
  const targets = scrolls.length ? scrolls : [...tree.matchAll(/^\t*(\d+) (?:text area|text view|outline|list)\b/gmi)];
  if (scrollMarker) {
    const targetIds = new Set(targets.map(row => Number(row[1]))), matches = new Set(), ancestors = [];
    for (const line of tree.split('\n')) {
      const row = /^(\t*)(\d+) (.+)$/.exec(line);
      if (!row) continue;
      const depth = row[1].length, id = Number(row[2]);
      while (ancestors.length && ancestors.at(-1).depth >= depth) ancestors.pop();
      if (row[3].includes(scrollMarker)) {
        const parent = ancestors.findLast(item => targetIds.has(item.id));
        if (parent) matches.add(parent.id);
      }
      ancestors.push({ depth, id });
    }
    return { chars: tree.length, nodes: numbered || dom || null, scrollTarget: matches.size === 1 ? [...matches][0] : null };
  }
  return { chars: tree.length, nodes: numbered || dom || null, scrollTarget: targets.length === 1 ? Number(targets[0][1]) : null };
}

function metrics(reply) {
  if (reply?.isError) throw Error('ENGINE_CALL_FAILED');
  const text = (reply?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const line = text.split('\n').findLast(line => line.startsWith('AM1METRICS:'));
  let value; try { value = JSON.parse(line?.slice(11)); } catch { throw Error('METRICS_UNAVAILABLE'); }
  if (!Number.isInteger(value?.chars) || value.chars < 0 ||
      value.nodes !== null && (!Number.isInteger(value.nodes) || value.nodes < 0) ||
      value.scrollTarget !== null && (!Number.isInteger(value.scrollTarget) || value.scrollTarget < 0)) throw Error('METRICS_INVALID');
  return value;
}
const failures = new Set(['HOLD', 'TREE_UNAVAILABLE', 'FIXTURE_IDENTITY', 'ENGINE_CALL_FAILED', 'METRICS_UNAVAILABLE', 'METRICS_INVALID',
  'NO_UNIQUE_SCROLL_AREA', 'CLEANUP_UNCONFIRMED', 'SESSION_CLEANUP_UNCONFIRMED', 'FOCUS_CHANGED', 'APP_ALREADY_RUNNING',
  'FIXTURE_NOT_OPEN', 'FIXTURE_SETUP_FAILED', 'LOCAL_CONTAINER_RECEIPT_REQUIRED', 'LOCAL_CONTAINER_UNQUALIFIED', 'MACOS_REQUIRED', 'INVALID_OPTIONS',
  'CONFLICTING_OWNER_BOUNDARY', 'OWNER_BOUNDARY_REQUIRED', 'BROWSER_PROFILE_RECEIPT_REQUIRED', 'OUTPUT_OUTSIDE_BENCH_RESULTS', 'OUTPUT_SYMLINK', 'OUTPUT_ALREADY_EXISTS', 'TEMP_CLEANUP_UNCONFIRMED']);
const failureCode = error => failures.has(error?.message) ? error.message : 'READ_FAILED';

export async function runSpeedMap(plan, runtime) {
  const report = { startedUTC: new Date().toISOString(), runs: plan.runs, concurrency: plan.concurrency,
    ownerPresent: plan.ownerPresent, rows: [], cohorts: [], note: plan.note };
  const boundary = () => { if (runtime.held()) throw Error('HOLD'); };
  async function cohort(task, trial, mode) {
    boundary();
    let fixture, scope, preparationStarted = false;
    try {
      scope = speedScope(plan, task);
      preparationStarted = true;
      fixture = await runtime.prepare(task, { trial, mode });
    }
    catch (error) {
      const cleanupConfirmed = !preparationStarted || error.cleanupConfirmed === true;
      report.rows.push({ app: task.id, class: task.class, ownerAccount: plan.ownerPresent || task.ownerPresent,
        scope: scope ?? 'unqualified-local-container', mode, trial, status: 'refused', failure: failureCode(error),
        acquireMs: null, firstReadMs: null, warmReadMs: null, actionMs: null, afterReadMs: null,
        chars: null, nodes: null, cleanupConfirmed });
      await runtime.publish(report);
      if (!cleanupConfirmed) throw Error('CLEANUP_UNCONFIRMED');
      return;
    }
    const count = mode === 'concurrent' ? plan.concurrency : 1, start = runtime.now();
    const rows = await Promise.all(Array.from({ length: count }, async (_, sessionIndex) => {
      let session;
      const row = { app: task.id, class: task.class, ownerAccount: plan.ownerPresent || task.ownerPresent,
        scope, mode, trial, sessionIndex, status: 'failed',
        acquireMs: null, firstReadMs: null, warmReadMs: null, actionMs: null, afterReadMs: null,
        chars: null, nodes: null, cleanupConfirmed: true };
      async function timed(key, code) {
        boundary(); const start = runtime.now();
        const reply = await session.js(code);
        if (reply?.isError) throw Error('ENGINE_CALL_FAILED');
        row[key] = runtime.now() - start;
      }
      try {
        boundary(); session = await runtime.openSession(task, fixture);
        const browser = task.fixture === 'browser';
        const handle = browser ? 'am1Tab' : 'am1App';
        const acquire = browser ? `var am1Choices = (await cua.listBrowsers({emit:false})).filter(b => b.name === ${JSON.stringify(task.app)} && b.id === ${JSON.stringify(fixture.browserId)} && b.profileName === ${JSON.stringify(fixture.profileName)}); if(am1Choices.length !== 1) throw Error('BROWSER_IDENTITY'); var am1Tab = await cua.createBrowserTab(am1Choices[0].id, ${JSON.stringify(fixture.url)}, {visible:false});` :
          `var am1App = await cua.getApp(${JSON.stringify(task.bundle)});`;
        await timed('acquireMs', acquire);
        const read = `var am1Tree = await ${handle}.getAXState({ disableDiffing: true, emit: false }); am1Tree;`;
        async function measuredRead(key) {
          // A bound standalone read follows the native lease rule and lets
          // concurrent read-only sessions avoid taking an action lease.
          await timed(key, read);
          boundary();
          return metrics(await session.js(`nodeRepl.write('AM1METRICS:' + JSON.stringify((${treeMetrics.toString()})(am1Tree, ${JSON.stringify({ marker: fixture.marker, requiredText: fixture.requiredText, scrollMarker: fixture.scrollMarker })})));`));
        }
        const first = await measuredRead('firstReadMs');
        row.chars = first.chars; row.nodes = first.nodes;
        const warm = await measuredRead('warmReadMs');
        if (mode === 'sequential' && !plan.ownerPresent && !task.readOnly) {
          if (!browser && warm.scrollTarget === null) throw Error('NO_UNIQUE_SCROLL_AREA');
          await timed('actionMs', browser ? 'await am1Tab.cua.scroll({x:120,y:200,scrollX:0,scrollY:400});' :
            `await am1App.scroll(${warm.scrollTarget}, 'down', 1);`);
          const after = await measuredRead('afterReadMs');
          row.afterChars = after.chars; row.afterNodes = after.nodes;
        }
        row.status = 'complete';
      } catch (error) { row.failure = failureCode(error); if (!session) row.cleanupConfirmed = error.cleanupConfirmed === true; }
      finally {
        if (session) {
          try { await session.close(); }
          catch { row.cleanupConfirmed = false; row.status = 'failed'; row.failure = 'SESSION_CLEANUP_UNCONFIRMED'; }
        }
      }
      return row;
    }));
    let cleanup;
    try { cleanup = await runtime.closeFixture(fixture); } catch { cleanup = { confirmed: false }; }
    for (const row of rows) {
      row.cleanupConfirmed &&= cleanup?.confirmed === true;
      row.cleanupReasons = cleanup?.reasons ?? [];
      if (cleanup?.focusChanged) { row.status = 'unsafe'; row.failure = 'FOCUS_CHANGED'; }
    }
    report.rows.push(...rows);
    if (mode === 'concurrent') report.cohorts.push({ app: task.id, trial, sessions: count, wallMs: runtime.now() - start });
    report.summary = summarizeSpeedMap(report);
    await runtime.publish(report);
    if (rows.some(row => !row.cleanupConfirmed)) throw Error('CLEANUP_UNCONFIRMED');
    if (cleanup?.focusChanged) throw Error('FOCUS_CHANGED');
  }
  for (const task of plan.apps) for (let trial = 1; trial <= plan.runs; trial++) await cohort(task, trial, 'sequential');
  const concurrent = plan.apps.find(app => app.id === plan.concurrentApp);
  for (let trial = 1; trial <= plan.runs; trial++) await cohort(concurrent, trial, 'concurrent');
  report.summary = summarizeSpeedMap(report); report.finishedUTC = new Date().toISOString();
  await runtime.publish(report); return report;
}

export function summarizeSpeedMap({ rows, cohorts = [] }) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.app + ':' + row.mode;
    if (!groups.has(key)) groups.set(key, { app: row.app, class: row.class, ownerAccount: row.ownerAccount === true, mode: row.mode, rows: [] });
    groups.get(key).rows.push(row);
  }
  const stats = values => {
    values = values.filter(Number.isFinite).sort((a, b) => a - b);
    const n = values.length;
    return { n, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
      p90: n ? values[Math.ceil(n * 0.9) - 1] : null };
  };
  return [...groups.values()].map(group => {
    const completed = group.rows.filter(row => row.status === 'complete' && row.cleanupConfirmed !== false);
    const qualifiedCohorts = group.mode === 'concurrent' ? cohorts.filter(cohort => cohort.app === group.app &&
      group.rows.filter(row => row.trial === cohort.trial).length === cohort.sessions &&
      group.rows.filter(row => row.trial === cohort.trial).every(row => row.status === 'complete' && row.cleanupConfirmed !== false)) : [];
    return { app: group.app, class: group.class, ownerAccount: group.ownerAccount, mode: group.mode,
      scope: [...new Set(group.rows.map(row => row.scope ?? 'unknown'))].join(', '),
      failures: [...new Set(group.rows.filter(row => row.failure).map(row => row.failure))],
      cohortWallMs: stats(qualifiedCohorts.map(cohort => cohort.wallMs)), attempted: group.rows.length, completed: completed.length,
      ...Object.fromEntries(['acquireMs', 'firstReadMs', 'warmReadMs', 'actionMs', 'afterReadMs', 'chars', 'nodes']
        .map(key => [key, stats(completed.map(row => row[key]))])) };
  });
}

export function speedMarkdown(report) {
  const rounded = value => Number(value.toFixed(2));
  const cell = value => value.n ? `${rounded(value.median)} / ${rounded(value.p90)} (n=${value.n})` : 'not measured';
  const rows = [...(report.summary ?? summarizeSpeedMap(report))].sort((a, b) => a.class.localeCompare(b.class) || a.app.localeCompare(b.app));
  const table = selected => '| Class | App | Mode | Scope | Failure | Complete | Acquire | First read | Warm read | Action | Readback | Characters | Nodes | Cohort lifecycle |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' + selected.map(row =>
      `| ${row.class} | ${row.app} | ${row.mode} | ${row.scope ?? 'unknown'} | ${(row.failures ?? []).join(', ') || 'none'} | ${row.completed}/${row.attempted} | ` +
      ['acquireMs', 'firstReadMs', 'warmReadMs', 'actionMs', 'afterReadMs', 'chars', 'nodes', 'cohortWallMs'].map(key => cell(row[key])).join(' | ') + ' |').join('\n') + '\n';
  const account = rows.filter(row => row.ownerAccount), background = rows.filter(row => !row.ownerAccount);
  return '# App-class speed map\n\nTimes in ms, median / p90 (nearest rank). Counts describe the first explicit full read. ' +
    'Only complete trials contribute to these summaries. Cohort lifecycle includes session startup, reads and cleanup.\n\n' +
    (background.length ? table(background) : '') +
    (account.length ? '\n## Owner-present reads\n\nTiming and tree counts only. Local-container membership is unproved.\n\n' + table(account) : '');
}

export async function main(argv = process.argv.slice(2)) {
  const values = {}, flags = new Set(['--dry-run', '--owner-present', '--owner-away']);
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) { values[argv[i].slice(2)] = true; continue; }
    if (!['--runs', '--apps', '--concurrent-app', '--receipts', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('INVALID_OPTIONS');
    values[argv[i].slice(2)] = argv[++i];
  }
  if (values['owner-away'] && values['owner-present']) throw Error('CONFLICTING_OWNER_BOUNDARY');
  const plan = speedPlan({ ids: values.apps?.split(','), runs: values.runs === undefined ? 10 : Number(values.runs),
    ownerPresent: Boolean(values['owner-present']), concurrentApp: values['concurrent-app'] ?? 'textedit', dryRun: Boolean(values['dry-run']) });
  if (plan.dryRun) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  if (!values['owner-away'] && !values['owner-present']) throw Error('OWNER_BOUNDARY_REQUIRED');
  const { liveSpeedRuntime } = await import('./app-speed-map-live.mjs');
  const runtime = await liveSpeedRuntime(plan, values);
  try { const report = await runSpeedMap(plan, runtime); return report.rows.every(row => row.status === 'complete') ? 0 : 1; }
  finally { await runtime.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(failureCode(error)); process.exitCode = 1; });
}
