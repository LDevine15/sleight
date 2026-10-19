import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { claim, score } from '../bench/claim-score.mjs';
import { engineMix, summarizeEngines } from '../bench/engine-version.mjs';
import {
  FAMILIES, NAV, README_BLOCKS, cellText, cellsFor, collectJsonAbs, collectRace, collectReleases, collectRunnerStudies, dateRange, lossRule, parseRunnerReport,
  ownerPass, readmeBlocks, render, renderNav, renderNavHtml, renderReadme, scoreClaimDir, scrub, scrubPaths, spliceReadme, taskMatrix, variantOf,
} from '../bench/results-hub.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'docs/results');
const WT = join(homedir(), 'Projects/sleight-wt');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const committed = () => Object.fromEntries(FAMILIES.map(f => [f.id, readJson(join(OUT, 'data', `${f.id}.json`))]));
const page = name => readFileSync(join(OUT, name), 'utf8');

// Every study the committed data holds, with the page its tables are on.
function allStudies(all) {
  return [
    ...all['native-claim'].studies.map(s => ({ s, page: 'native-claim.md' })),
    ...all['app-claim'].studies.map(s => ({ s, page: 'app-claim.md' })),
    ...all['browser-race'].studies.map(s => ({ s, page: 'browser-race.md' })),
    ...all['browser-turbo'].race.studies.map(s => ({ s, page: 'browser-turbo.md' })),
    // Only the headline gate studies get a per-task table on the page; the rest show round totals.
    ...all['browser-turbo'].gates.filter(s => all['browser-turbo'].headline.includes(s.id)).map(s => ({ s, page: 'browser-turbo.md' })),
    ...all['ab-tests'].studies.map(s => ({ s, page: 'ab-tests.md' })),
  ];
}

test('rendering is deterministic and the committed pages match the committed data', () => {
  const all = committed();
  const first = render(all), second = render(committed());
  assert.deepEqual(first, second);
  for (const [name, text] of Object.entries(first)) assert.equal(readFileSync(join(OUT, name), 'utf8'), text, `${name} is stale: run node bench/results-hub.mjs`);
});

test('collecting from docs/benchmarks twice gives the same studies', () => {
  assert.deepEqual(collectRunnerStudies(), collectRunnerStudies());
  assert.deepEqual(collectJsonAbs(), collectJsonAbs());
  assert.deepEqual(collectReleases(), collectReleases());
});

test('every committed cell equals claim-score\'s score() and claim() over the committed runs, and the pages print them', () => {
  const all = committed();
  for (const { s, page: name } of allStudies(all)) {
    const table = score(s.runs.map(r => ({ arm: r.arm, task: r.task, seconds: r.seconds, passed: r.passed })));
    const verdict = claim(table, { tasks: s.tasks, arms: s.arms }, s.me);
    for (const cell of s.cells) {
      const t = table[cell.arm][cell.task];
      assert.equal(cell.runs, t.runs.length, `${s.id} ${cell.arm} ${cell.task} runs`);
      assert.equal(cell.passes, t.passes.length, `${s.id} ${cell.arm} ${cell.task} passes`);
      if (t.expected === null) assert.equal(cell.expected, null);
      // Race runs are stored to the millisecond, so expected time can move in the third decimal.
      else assert.ok(Math.abs(cell.expected - t.expected) < 0.01, `${s.id} ${cell.arm} ${cell.task} expected ${cell.expected} against ${t.expected}`);
    }
    assert.equal(s.verdict.wording, verdict.wording, `${s.id} wording`);
    {
      const text = page(name);
      for (const cell of s.cells) assert.ok(text.includes(`| ${cellText(cell)} |`) || text.includes(` ${cellText(cell)} |`), `${name} prints ${s.id} ${cell.arm} ${cell.task} as ${cellText(cell)}`);
    }
  }
});

test('the claim pages equal claim-score.mjs run on the same results folder', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (arm, task, n, seconds, passed, reason) => ({ arm, task, run: n, seconds, passed, ...(passed ? {} : { reason }), models: ['claude-haiku-5-5'] });
  writeFileSync(join(dir, '2026-10-30T00-00-00-000Z.json'), JSON.stringify({ arms: ['sleight'], model: 'claude-haiku-5-5', effort: 'high', results: [
    run('sleight', 'calculator-click', 1, 7.5, true), run('sleight', 'calculator-click', 2, 6.25, true), run('sleight', 'calculator-click', 3, 9, false, 'display shows 0'),
    run('sleight', 'preview-read', 1, 5, true), run('sleight', 'preview-read', 2, 4.5, true), run('sleight', 'preview-read', 3, 5.5, true),
    run('sleight', 'not-a-claim-task', 1, 1, true),
  ] }));
  writeFileSync(join(dir, '2026-10-30T01-00-00-000Z.json'), JSON.stringify({ arms: ['lcu'], results: [
    run('lcu', 'calculator-click', 1, 8, true), run('lcu', 'calculator-click', 2, 8.5, true), run('lcu', 'calculator-click', 3, 30, true),
    run('lcu', 'preview-read', 1, 4, true), run('lcu', 'preview-read', 2, 4.2, false, 'wrong page count'), run('lcu', 'preview-read', 3, 4.1, true),
  ] }));
  const rules = readJson(join(ROOT, 'bench/claim-exclusions.json'));
  const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir, '--json'], { encoding: 'utf8' }));
  const mine = scoreClaimDir(dir, rules, rules.since);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.table)), cli.table);
  assert.deepEqual(JSON.parse(JSON.stringify(mine.verdict)), cli.claim);
  assert.deepEqual(mine.dropped, cli.dropped);
  assert.deepEqual(mine.warnings, cli.warnings);
  const arms = rules.arms.filter(arm => mine.table[arm]);
  const { cells } = cellsFor(mine.rows, rules.tasks, arms, 'sleight');
  const click = cells.find(c => c.arm === 'sleight' && c.task === 'calculator-click');
  assert.ok(Math.abs(click.expected - cli.table.sleight['calculator-click'].expected) < 1e-9);
  assert.equal(cellText(click), `${(Math.round(cli.table.sleight['calculator-click'].expected * 10) / 10).toFixed(1)} (2/3)`);
});

test('the committed native claim equals the saved claim-score output for its folder', t => {
  const saved = join(WT, 'app-claim/native-score-1018b.json');
  const dir = join(WT, 'app-claim/native-results-1018b');
  if (!existsSync(saved) || !existsSync(dir)) { t.skip('the raw native claim folder is not on this Mac'); return; }
  const study = committed()['native-claim'].studies[0];
  const cli = readJson(saved);
  for (const cell of study.cells) {
    const t2 = cli.table[cell.arm][cell.task];
    assert.equal(cell.passes, t2.passes.length);
    assert.equal(cell.runs, t2.runs.length);
    assert.ok(t2.expected === null ? cell.expected === null : Math.abs(cell.expected - t2.expected) < 0.001, `${cell.arm} ${cell.task}`);
  }
  assert.equal(study.verdict.wording, cli.claim.wording);
  assert.deepEqual(study.verdict.lowest, cli.claim.lowest);
});

test('a race set scores the same as race-score.mjs on the same round folders', t => {
  const raceDir = join(WT, 'race-1017');
  if (!existsSync(raceDir)) { t.skip('the race folder is not on this Mac'); return; }
  const fresh = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'race' });
  for (const study of fresh.studies.filter(s => s.latest)) {
    const dirs = study.rounds.map(r => join(raceDir, r.round));
    const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/fowl/race-score.mjs'), ...dirs, '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    const scored = cli.browsers[study.browser];
    for (const cell of study.cells) {
      const t2 = scored.table[cell.arm][cell.task];
      assert.equal(cell.passes, t2.passes.length, `${study.id} ${cell.arm} ${cell.task}`);
      assert.ok(t2.expected === null ? cell.expected === null : Math.abs(cell.expected - t2.expected) < 0.001, `${study.id} ${cell.arm} ${cell.task}`);
    }
    for (const arm of study.arms) assert.deepEqual(study.verdict.raceFastest[arm], scored.fastest[arm]);
  }
});

test('a race set leaves sleight inside Codex out of sleight\'s verdict and shows it against Codex on the same model', t => {
  const raceDir = mkdtempSync(join(tmpdir(), 'hub-race-'));
  t.after(() => rmSync(raceDir, { recursive: true, force: true }));
  const ok = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed', error: null, result: { content: [{ type: 'text', text: 'state' }] } } });
  const round = (name, surface, tasks) => {
    const dir = join(raceDir, name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'browser.json'), JSON.stringify({ browser: 'safari' }));
    for (const [task] of tasks) { mkdirSync(join(dir, task)); writeFileSync(join(dir, task, 'events.jsonl'), ok + '\n'); }
    writeFileSync(join(dir, 'results.json'), JSON.stringify(tasks.map(([task, seconds]) => ({ task: { name: task, browser: 'safari' }, surface, wallMs: seconds * 1000,
      site: { lines: [] }, run: { started: Date.parse('2026-10-19T06:00:00Z'), finished: Date.parse('2026-10-19T06:01:00Z'), result: { result: 'RESULT: fixture' } }, outcome: { ok: true, cell: 'ok', problems: [] } }))));
  };
  for (const i of [1, 2, 3]) {
    round(`safari-sleight-r${i}`, 'sleight', [['form-travel', 30], ['mdn', 20]]);
    round(`safari-codex-r${i}`, 'codex', [['form-travel', 50], ['mdn', 40]]);
    round(`safari-codex-sleight-r${i}`, 'codex-sleight', [['form-travel', 25], ['mdn', 45]]);
  }
  const race = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'Safari and Firefox race' });
  const study = race.studies.find(s => s.label === 'sleight');
  assert.deepEqual(study.arms, ['sleight', 'codex']);
  assert.deepEqual(study.hosted, ['codex-sleight']);
  assert.equal(study.verdict.wording, 'fastest');
  assert.deepEqual(study.verdict.fastest, { sleight: ['form-travel', 'mdn'], codex: [] });
  assert.deepEqual(study.verdict.lost, []);
  assert.deepEqual(study.verdict.topUps, []);
  assert.deepEqual(study.cells.filter(c => c.arm === 'codex-sleight').map(c => [c.task, c.expected]), [['form-travel', 25], ['mdn', 45]]);
  const [pair] = study.sameModel;
  assert.deepEqual([pair.hosted, pair.base], ['codex-sleight', 'codex']);
  assert.deepEqual(pair.fastest, { 'codex-sleight': ['form-travel'], codex: ['mdn'] });
  assert.deepEqual(pair.totals, { 'codex-sleight': 70, codex: 90 });
  assert.deepEqual(pair.lost.map(l => [l.task, l.by.map(b => b.arm)]), [['mdn', ['codex']]]);
  assert.equal(pair.wording, 'completed every task, fastest on 1 of 2');
  const md = render({ ...committed(), 'browser-race': race })['browser-race.md'];
  const section = md.slice(md.indexOf('## Safari'));
  const sameAt = section.indexOf('Same model: sleight inside Codex against Codex');
  assert.ok(sameAt > 0, 'the page has a same-model section');
  assert.match(section.slice(0, sameAt), /By the loss rule, sleight didn't lose a task\./);
  assert.match(section.slice(0, sameAt), /\| Task \| sleight \| Codex \|\n/, 'sleight\'s task table has no codex-sleight column');
  assert.ok(!section.slice(0, sameAt).includes('Arm ahead'));
  assert.match(section.slice(sameAt), /\| Task \| sleight inside Codex \| Codex \|/);
  assert.match(section.slice(sameAt), /By the loss rule, sleight inside Codex lost 1 of 2 tasks\./);
  // The same-model section sits outside the folds, under its own heading.
  assert.match(outsideDetails(section), /### Same model: sleight inside Codex against Codex\n[\s\S]*\| Task \| sleight inside Codex \| Codex \|/);
});

test('no generated file holds a home path, the account name or the owner\'s name', () => {
  // A fixed list, plus the full name macOS reports for this account (id -F) so no name is written into the repo. The account
  // name alone isn't used: on CI it is 'runner', a word the pages use.
  const names = [];
  if (process.platform === 'darwin') try { names.push(...execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)); } catch { /* no full name */ }
  const banned = [/\/Users\//, /\/var\/folders\//, ...[...new Set(names.filter(name => name.length >= 3))].map(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))];
  const files = [...readdirSync(OUT).filter(n => !n.startsWith('.')).map(n => join(OUT, n)), ...readdirSync(join(OUT, 'data')).map(n => join(OUT, 'data', n))]
    .filter(path => /\.(md|html|json)$/.test(path));
  assert.ok(files.length >= 14);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\//, file);
    assert.ok(!text.includes(homedir()), file);
    for (const re of banned) assert.doesNotMatch(text, re, file);
  }
  assert.equal(scrubPaths(`${homedir()}/x and /Users/someone/y`), '~/x and ~/y');
  assert.equal(scrubPaths('at /private/var/folders/ab/cd/T/x.json and /var/folders/ab/cd/T/y'), 'at $TMPDIR and $TMPDIR');
  assert.equal(scrubPaths('the runner graded it'), 'the runner graded it', 'rendering scrubs paths only, never words');
  assert.equal(scrub('/Users/someone/z'), '~/z');
});

test('runner reports parse into runs, and the owner\'s scoring passes a checkout that stopped', () => {
  const text = [
    '| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    '| form-checkout | sleight-turbo | helium | FAIL, score 0/10 | ok | n/a | ok | n/a | n/a | n/a | 44 s, 44 s net / 240 | 13 calls | in 1 | 0.009 |',
    '| wikipedia | sleight-turbo | chrome | ok | ok | n/a | ok | n/a | n/a | n/a | 6 s, 6 s net / 90 | 1 calls, 2 errors | in 4 | 0.002 |',
    '', 'ROUND NOT CLEAN: 1 problems', '', '- form-checkout · outcome · nothing submitted', '', 'Answers:',
  ].join('\n');
  const { rows, problems } = parseRunnerReport(text);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].ok, rows[0].seconds, rows[0].calls, rows[0].errors], [false, 44, 13, 0]);
  assert.deepEqual([rows[1].ok, rows[1].seconds, rows[1].calls, rows[1].errors], [true, 6, 1, 2]);
  assert.deepEqual(problems['form-checkout'], ['outcome: nothing submitted']);
  assert.deepEqual(variantOf('gate2-20261013-1207-fowlbrowser-swap'), { variant: 'fowlbrowser', session: 'gate2-20261013-1207', order: 'swap' });
  assert.deepEqual(variantOf('1309-sleight-normal'), { variant: 'sleight', session: '1309', order: 'normal' });
  assert.deepEqual(variantOf('candidate-normal'), { variant: 'candidate', session: null, order: 'normal' });
  const gate = committed()['browser-turbo'].gates.find(s => s.id === '2026-10-16-gate-3');
  const turboCheckout = gate.runs.filter(r => r.arm === 'sleight-turbo' && r.task === 'form-checkout');
  assert.equal(turboCheckout.length, 10);
  assert.ok(turboCheckout.every(r => r.passed && !r.runnerOk), 'every turbo checkout stopped before paying, a pass under the owner\'s scoring');
});

test('the owner\'s scoring looks only at the outcome problems of a checkout run', () => {
  const failed = { task: 'form-checkout', ok: false };
  assert.equal(ownerPass(failed, ['outcome: nothing submitted']), true);
  assert.equal(ownerPass(failed, ['outcome: nothing submitted', 'focus: took focus']), true, 'a focus problem is not an outcome problem');
  assert.equal(ownerPass(failed, ['focus: took focus']), false, 'no outcome problem recorded');
  assert.equal(ownerPass(failed, ['outcome: paid without a stated amount']), false);
  assert.equal(ownerPass({ task: 'form-travel', ok: false }, ['outcome: nothing submitted']), false);
  assert.equal(ownerPass({ task: 'wikipedia', ok: true }, []), true);
});

test('the loss rule counts a lower expected time or a faster passing run', () => {
  const table = score([
    { arm: 'sleight', task: 'a', seconds: 10, passed: true }, { arm: 'sleight', task: 'a', seconds: 10, passed: true },
    { arm: 'x', task: 'a', seconds: 8, passed: true }, { arm: 'x', task: 'a', seconds: 40, passed: true },
    { arm: 'sleight', task: 'b', seconds: 5, passed: true }, { arm: 'x', task: 'b', seconds: 6, passed: true },
  ]);
  assert.deepEqual(lossRule(table, ['a', 'b'], ['sleight', 'x'], 'sleight'), [{ task: 'a', by: [{ arm: 'x', lowerExpected: false, fasterRun: true }] }]);
  assert.equal(dateRange('2026-10-18T02-39', '2026-10-18T03-16'), '2026-10-18, 02:39 to 03:16 UTC');
  assert.equal(dateRange('2026-10-17T04-20', '2026-10-18T03-33'), '2026-10-17 to 2026-10-18');
});

// A small stand-in for the DOM, enough for explore.html's script to build its filters, charts and tables.
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.text = ''; this.value = ''; this.hidden = false; this.offsetWidth = 100; this.offsetHeight = 40; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...kids) { this.children = kids; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  count(tag) { return (this.tagName === tag ? 1 : 0) + this.children.reduce((n, c) => n + c.count(tag), 0); }
}

test('explore.html runs, fills its filters, draws charts per task and switches family', () => {
  const html = page('explore.html');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode(id)]));
  const document = { documentElement: new FakeNode('html'), getElementById: id => nodes[id], createElement: tag => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag), createTextNode: text => Object.assign(new FakeNode('#text'), { text }) };
  const localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  vm.runInNewContext(script, { document, localStorage, window: { innerWidth: 390 }, console });
  assert.ok(nodes['f-family'].children.length >= FAMILIES.length);
  assert.equal(nodes.charts.children.length, 9, 'one chart per native claim task');
  assert.equal(nodes.charts.count('circle'), 2 * committed()['native-claim'].studies[0].runs.length, 'a dot and a hit area per run');
  assert.ok(nodes.cells.count('tr') > 9 * 6);
  nodes['f-family'].listeners.change[0]({ target: { value: 'browser-race' } });
  assert.ok(nodes['f-study'].children.length >= 2);
  nodes['f-study'].listeners.change[0]({ target: { value: nodes['f-study'].children[1].attrs.value } });
  assert.ok(nodes.charts.children.length >= 12, 'one chart per race task');
  const cellRows = () => nodes.cells.children[1].children.length;
  const all = cellRows();
  nodes['f-result'].listeners.change[0]({ target: { value: 'fail' } });
  assert.ok(cellRows() < all, 'the result filter narrows the cell table to cells with a failed run');
  nodes['f-result'].listeners.change[0]({ target: { value: '' } });
  nodes.theme.listeners.click[0]();
  assert.equal(document.documentElement.attrs['data-theme'], 'light');
});

test('pages name each arm\'s engine version with its UTC dates once the data carries them, and flag engine arms on different versions', () => {
  const all = committed(), before = render(all);
  const study = all['browser-race'].studies.find(s => s.latest);
  const run = (version, day) => ({ version, provenance: 'inferred', startedAt: `${day}T10:00:00.000Z`, endedAt: `${day}T11:00:00.000Z`, dated: 'recorded' });
  const rows = [{ arm: 'sleight', engine: run('26.1013.40934', '2026-10-19') }, { arm: 'codex', engine: run('26.1007.71326', '2026-10-18') },
    { arm: 'lcu', engine: run('26.1007.71326', '2026-10-18') }];
  const engines = summarizeEngines(rows);
  Object.assign(study, { engines, engineMix: engineMix(engines) });
  const page = render(all)['browser-race.md'];
  assert.match(page, /\| ChatGPT engine and UTC dates \| Build \|/);
  assert.match(page, /\| sleight \| [^\n]*\| engine 26\.1013\.40934 \(1 inferred\), 2026-10-19 \|/);
  assert.match(page, /\| LCU \| [^\n]*\| not used, 2026-10-18 \|/);
  assert.match(page, /The arms that use the engine ran on different engine versions: sleight on 26\.1013\.40934, codex on 26\.1007\.71326\./);
  // Data collected before engine versions were tracked renders exactly as before.
  for (const name of ['native-claim.md', 'app-claim.md', 'browser-turbo.md', 'release-passes.md']) assert.equal(render(all)[name], before[name]);
});

test('claim rows and claim-score carry the engine and date inferred from the pass stamp and the file\'s last save', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-claim-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '2026-10-18T02-39-00-000Z.json');
  writeFileSync(file, JSON.stringify({ arms: ['sleight'], results: [{ arm: 'sleight', task: 'calculator-click', run: 1, seconds: 7, passed: true }] }));
  utimesSync(file, new Date('2026-10-18T03:00:00Z'), new Date('2026-10-18T03:00:00Z'));
  const rules = readJson(join(ROOT, 'bench/claim-exclusions.json'));
  const [row] = scoreClaimDir(dir, { ...rules, since: '2026-10-18' }, '2026-10-18').rows;
  assert.deepEqual(row.engine, { version: '26.1007.71326', provenance: 'inferred', startedAt: '2026-10-18T02:39:00.000Z', endedAt: '2026-10-18T03:00:00.000Z', dated: 'inferred' });
  const cli = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir, '--json'], { encoding: 'utf8' }));
  assert.deepEqual([cli.engines.sleight.versions['26.1007.71326'].runs, cli.engines.sleight.versions['26.1007.71326'].first], [1, '2026-10-18T02:39:00.000Z']);
  assert.match(execFileSync(process.execPath, [join(ROOT, 'bench/claim-score.mjs'), '--results', dir], { encoding: 'utf8' }),
    /sleight +engine 26\.1007\.71326 \(1 inferred\), 2026-10-18 \(dates inferred\)/);
});

// The generated Markdown pages: the hub landing and one per family.
const GENERATED = ['README.md', ...FAMILIES.map(f => f.page)];

// Text outside every <details> fold, nested folds included.
function outsideDetails(text) {
  let depth = 0, out = '';
  for (const part of text.split(/(<details>|<\/details>)/)) {
    if (part === '<details>') depth += 1;
    else if (part === '</details>') depth -= 1;
    else if (!depth) out += part;
    assert.ok(depth >= 0, 'a </details> without its <details>');
  }
  assert.equal(depth, 0, 'every <details> is closed');
  return out;
}
const firstTable = text => { const lines = text.split('\n'), at = lines.findIndex(l => l.startsWith('| ')); let end = at; while (lines[end]?.startsWith('| ')) end += 1; return lines.slice(at, end).join('\n'); };

test('each generated page starts and ends with the nav line, and the current page is the one item without a link', () => {
  const files = render(committed());
  for (const name of GENERATED) {
    const nav = renderNav(name), text = files[name];
    assert.ok(text.startsWith(nav + '\n\n# '), `${name} starts with the nav line and then its title`);
    assert.ok(text.endsWith('\n' + nav + '\n'), `${name} ends with the nav line`);
    assert.equal(page(name), text);
  }
  assert.match(renderNav('native-claim.md'), /^\[Benchmarks\]\(README\.md\) · Native · \[Apps\]\(app-claim\.md\)/);
  assert.match(renderNav('README.md'), /^Benchmarks · \[Native\]\(native-claim\.md\)/);
  for (const { page: target } of NAV.filter(n => n.page.endsWith('.md'))) assert.ok(existsSync(join(OUT, target)), `the nav links ${target}, which exists`);
  const html = renderNavHtml('explore.html');
  assert.match(html, /<span aria-current="page">Interactive<\/span>/);
  for (const [, host] of html.matchAll(/href="https:\/\/([^/"]+)/g)) assert.ok(['github.com', 'land-o-clusters.github.io'].includes(host), host);
  assert.match(page('explore.html'), /<nav class="pages" aria-label="Benchmark pages">/);
});

test('each family page with a race or claim opens with the task matrix of its newest set as its first table', () => {
  const all = committed();
  const newest = (studies, browser) => studies.find(s => s.browser === browser && s.latest);
  const expected = {
    'native-claim.md': all['native-claim'].studies[0], 'app-claim.md': all['app-claim'].studies[0],
    'browser-turbo.md': newest(all['browser-turbo'].race.studies, 'chrome'), 'browser-race.md': newest(all['browser-race'].studies, 'safari'),
  };
  for (const [name, study] of Object.entries(expected)) assert.equal(firstTable(page(name)), taskMatrix(study), `${name}'s first table is ${study.id}'s task matrix`);
  // Only the newest set per browser shows outside the folds.
  for (const [name, studies] of [['browser-turbo.md', all['browser-turbo'].race.studies], ['browser-race.md', all['browser-race'].studies]]) {
    const visible = outsideDetails(page(name));
    for (const study of studies) assert.equal(visible.includes(`## ${study.title}`), study.latest, `${name}: ${study.id} is ${study.latest ? 'visible' : 'folded'}`);
  }
  assert.match(page('browser-turbo.md'), /^# Chrome and Helium: turbo against FowlBrowser$/m);
  assert.match(page('browser-race.md'), /^# Safari and Firefox: the engine path against Codex, LCU, Cua and Peekaboo$/m);
  assert.match(page('ab-tests.md'), /^# Experiments$/m);
  assert.ok(page('browser-turbo.md').includes('<details><summary>Gate rounds on FowlBrowser\'s runner, before production turbo</summary>'));
});

test('the method bullets appear on the pages only inside <details>', () => {
  const method = [
    'Expected time is the mean seconds per attempt divided by the pass rate (`bench/claim-score.mjs`)',
    'The rules come from [LAWS](../status/LAWS.md). Each arm gets 3 runs per task',
    '`bench/fowl/race-score.mjs` grades every saved run again',
    'FowlBrowser\'s head-to-head runner, pinned with sleight\'s patch',
    'Release passes run sleight alone on the benchmark\'s default suite',
    'Studies saved as JSON',
  ];
  let seen = 0;
  for (const name of GENERATED) {
    const text = page(name), visible = outsideDetails(text);
    for (const bullet of method) {
      assert.ok(!visible.includes(bullet), `${name} shows "${bullet.slice(0, 40)}" outside a fold`);
      if (text.includes(bullet)) seen += 1;
    }
  }
  assert.ok(seen >= 10, `the method is still on the pages, folded (${seen} bullets found)`);
});

test('release-passes.html is gone, and no generated page links it', () => {
  const files = render(committed());
  assert.ok(!('release-passes.html' in files));
  assert.ok(!existsSync(join(OUT, 'release-passes.html')), 'docs/results/release-passes.html is deleted');
  for (const [name, text] of Object.entries(files)) assert.ok(!text.includes('release-passes.html'), `${name} links release-passes.html`);
});

test('spliceReadme fills only the marked blocks and refuses broken markers', () => {
  const shells = 'intro 1\n<!-- hub:claim -->\n<!-- /hub:claim -->\nhand-typed 2\n<!-- hub:headline --><!-- /hub:headline -->\n<!-- hub:benchmarks -->\nstale 3\n<!-- /hub:benchmarks -->\nend\n';
  const filled = spliceReadme(shells, { claim: 'A', headline: 'B', benchmarks: 'C\n\nD' });
  assert.equal(filled, 'intro 1\n<!-- hub:claim -->\nA\n<!-- /hub:claim -->\nhand-typed 2\n<!-- hub:headline -->\nB\n<!-- /hub:headline -->\n<!-- hub:benchmarks -->\nC\n\nD\n<!-- /hub:benchmarks -->\nend\n');
  assert.equal(spliceReadme(filled, { claim: 'A', headline: 'B', benchmarks: 'C\n\nD' }), filled, 'a second splice changes nothing');
  assert.equal(spliceReadme('no markers here\n', { claim: 'A' }), 'no markers here\n', 'a README without the markers is left alone');
  assert.equal(spliceReadme(shells, { headline: '' }).includes('<!-- hub:headline -->\n<!-- /hub:headline -->'), true, 'an empty block leaves an empty shell');
  assert.throws(() => spliceReadme('<!-- hub:claim --><!-- /hub:claim --><!-- hub:claim --><!-- /hub:claim -->', { claim: 'A' }), /more than once/);
  assert.throws(() => spliceReadme('<!-- hub:claim -->', { claim: 'A' }), /without the other/);
  assert.throws(() => spliceReadme('<!-- /hub:claim --><!-- hub:claim -->', { claim: 'A' }), /before the opening/);
  assert.deepEqual(Object.keys(readmeBlocks(committed())), README_BLOCKS);
});

test('the README\'s generated blocks match the data, and every number in the claim block comes from it', () => {
  const all = committed();
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.equal(renderReadme(all, readme), readme, 'README.md hub blocks are stale: run node bench/results-hub.mjs');
  for (const name of README_BLOCKS) {
    const opens = readme.split(`<!-- hub:${name} -->`).length - 1;
    assert.ok(opens <= 1, `hub:${name} appears at most once`);
  }
  const { claim, benchmarks } = readmeBlocks(all);
  const study = all['native-claim'].studies[0];
  assert.match(claim, new RegExp(`"${study.verdict.wording}": the lowest expected time on ${study.verdict.lowest.length} of ${study.tasks.length} `));
  assert.ok(claim.includes(`${(Math.round(study.verdict.totals.sleight * 10) / 10).toFixed(1)} s`));
  assert.ok(claim.includes(`over ${study.runs.length} runs dated ${study.date}`));
  assert.ok(claim.includes('The hub lists each run, failures included, with the method and the model each arm ran.'));
  for (const fam of FAMILIES) assert.ok(benchmarks.includes(`](docs/results/${fam.page})`), `the benchmarks block links ${fam.page}`);
  // The hub landing's table and the README's lines are the same text.
  const landing = page('README.md');
  for (const line of benchmarks.split('\n').filter(l => l.startsWith('- '))) {
    const text = line.replace(/^- \[[^\]]+\]\([^)]+\): /, '').replace(/\.$/, '');
    assert.ok(landing.includes(text), `the landing holds "${text.slice(0, 50)}"`);
  }
});

