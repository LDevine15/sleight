import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { claim, score } from '../bench/claim-score.mjs';
import {
  FAMILIES, cellText, cellsFor, collectJsonAbs, collectRace, collectReleases, collectRunnerStudies, dateRange, lossRule, parseRunnerReport,
  render, scoreClaimDir, scrub, variantOf,
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

test('no generated file holds a home path, the account name or the owner\'s name', () => {
  const names = [userInfo().username];
  try { names.push(...execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)); } catch { /* not macOS */ }
  const banned = [...new Set(names.filter(name => name.length >= 3))].map(name => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const files = [...readdirSync(OUT).filter(n => !n.startsWith('.')).map(n => join(OUT, n)), ...readdirSync(join(OUT, 'data')).map(n => join(OUT, 'data', n))]
    .filter(path => /\.(md|html|json)$/.test(path));
  assert.ok(files.length >= 14);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\//, file);
    assert.ok(!text.includes(homedir()), file);
    for (const re of banned) assert.doesNotMatch(text, re, file);
  }
  assert.equal(scrub(`${homedir()}/x and /Users/someone/y`), '~/x and ~/y');
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
  nodes.theme.listeners.click[0]();
  assert.equal(document.documentElement.attrs['data-theme'], 'light');
});
