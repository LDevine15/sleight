#!/usr/bin/env node
// Static engine compatibility check: did a new ChatGPT release change what sleight depends on? It runs anywhere Node
// runs (Linux included) because it only reads the engine's files.
//
//   node bench/compat-static.mjs --app /Applications/ChatGPT.app [--report FILE]
//   node bench/compat-static.mjs --feed [--state DIR] [--force] [--keep-docs] [--report FILE]
//
// --feed polls ChatGPT's update feed and does nothing more until the version changes. Then it downloads the release,
// checks its Sparkle signature, unpacks it, and checks the contract. --state (default ~/.local/state/sleight-compat)
// keeps last.json and results.jsonl, which hold versions, dates and check names only. --keep-docs also keeps the
// engine's API docs per version in <state>/docs and diffs them there; use it only on a private machine, since those docs
// are OpenAI's text. Output and the report never contain engine text. Exit 0 on pass or no change, 1 on a failed
// check, 2 when the check couldn't run (feed or download), which retries on the next run.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyzeBundle, engineDocs, findApp } from './compat/static.mjs';
import { FEED_URL, download, fetchText, latestItem, parseAppcast, unpack, verifySignature } from './compat/feed.mjs';

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verdictOf(steps) {
  if (steps.some(step => step.status === 'error')) return 'error';
  return steps.some(step => step.status === 'fail') ? 'fail' : 'pass';
}

// The sleight commit whose contract was checked.
export function sleightCommit(root = ROOT) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

export function summary(report) {
  const head = `static compat ${report.appVersion ?? '?'} (engine ${report.engineVersion ?? '?'}): ${report.verdict.toUpperCase()}`;
  return [head, ...report.steps.map(step => `  ${step.status.padEnd(5)} ${step.id}${step.reason ? `: ${step.reason}` : ''}`)].join('\n');
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
};

export function checkApp(app, { now = () => new Date() } = {}) {
  const analysis = analyzeBundle(app);
  return { checkedAt: now().toISOString(), source: 'static', appVersion: analysis.appVersion, engineVersion: analysis.engineVersion,
    sleight: sleightCommit(), verdict: verdictOf(analysis.results), steps: analysis.results, fingerprint: analysis.fingerprint };
}

// Line counts only: the diff itself stays in the state folder.
async function keepDocs(state, version, app, run = execute) {
  const dir = join(state, 'docs');
  const previous = existsSync(join(dir, 'latest')) ? readFileSync(join(dir, 'latest'), 'utf8').trim() : undefined;
  mkdirSync(join(dir, version), { recursive: true });
  for (const [name, text] of Object.entries(engineDocs(app))) writeFileSync(join(dir, version, name), text, { mode: 0o600 });
  writeFileSync(join(dir, 'latest'), version + '\n');
  if (!previous || previous === version || !existsSync(join(dir, previous))) return { docsBaseline: previous ?? null };
  const diff = await run('diff', ['-ru', join(dir, previous), join(dir, version)], { maxBuffer: 64 << 20 }).then(r => r.stdout, error => {
    if (error.code === 1) return error.stdout;
    throw error;
  });
  writeFileSync(join(dir, `${version}.diff`), diff, { mode: 0o600 });
  return { docsBaseline: previous, docsChangedLines: diff.split('\n').filter(line => /^[+-](?![+-])/.test(line)).length };
}

export async function runFeed({ state, force = false, keep = false, feedUrl = FEED_URL, fetchImpl = fetch, now = () => new Date(),
  unpackImpl = unpack, verifyImpl = verifySignature, downloadImpl = download, log = console.log } = {}) {
  mkdirSync(state, { recursive: true });
  const lastPath = join(state, 'last.json');
  const last = existsSync(lastPath) ? JSON.parse(readFileSync(lastPath, 'utf8')) : undefined;
  let item;
  try { item = latestItem(parseAppcast(await fetchText(feedUrl, { fetchImpl }))); }
  catch (error) { log(`static compat: could not read the update feed (${error.message})`); return { exit: 2 }; }
  if (!item) { log('static compat: the update feed lists no release'); return { exit: 2 }; }
  if (last?.version === item.version && last?.build === item.build && !force) {
    log(`static compat: ChatGPT ${item.version} unchanged since ${last.checkedAt} (${last.verdict})`);
    return { exit: 0, unchanged: true };
  }
  const temp = mkdtempSync(join(tmpdir(), 'sleight-compat-'));
  let report;
  try {
    const archive = join(temp, 'release');
    try { await downloadImpl(item.url, archive, { fetchImpl }); }
    catch (error) { log(`static compat: download of ChatGPT ${item.version} failed (${error.message}); retrying next run`); return { exit: 2 }; }
    const base = { checkedAt: now().toISOString(), source: 'static', appVersion: item.version, build: item.build };
    if (!verifyImpl(archive, item.edSignature)) {
      report = { ...base, verdict: 'error', steps: [{ id: 'signature', status: 'error', reason: "the download's Sparkle signature doesn't match ChatGPT's pinned key" }] };
    } else {
      const out = join(temp, 'unpacked');
      mkdirSync(out);
      let app;
      try { await unpackImpl(archive, out); app = findApp(out); }
      catch (error) { report = { ...base, verdict: 'error', steps: [{ id: 'unpack', status: 'error', reason: error.message.split('\n')[0] }] }; }
      if (!report && !app) report = { ...base, verdict: 'error', steps: [{ id: 'unpack', status: 'error', reason: 'no ChatGPT.app with the engine in the download' }] };
      if (!report) {
        report = { ...checkApp(app, { now }), build: item.build };
        if (report.appVersion !== item.version) report.steps.push({ id: 'feed-version', status: 'warn', reason: `the feed says ${item.version}, the app says ${report.appVersion}` });
        report.fingerprintChanged = last?.fingerprint ? last.fingerprint !== report.fingerprint : null;
        if (keep) Object.assign(report, await keepDocs(state, report.appVersion ?? item.version, app));
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  appendFileSync(join(state, 'results.jsonl'), JSON.stringify(report) + '\n');
  writeJson(lastPath, { version: item.version, build: item.build, checkedAt: report.checkedAt, verdict: report.verdict, fingerprint: report.fingerprint });
  log(summary(report));
  return { exit: report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2, report };
}

function option(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const reportPath = option(argv, 'report');
  if (argv.includes('--app')) {
    const app = option(argv, 'app');
    if (!app) { console.error('usage: compat-static.mjs --app <ChatGPT.app>'); return 2; }
    const report = checkApp(resolve(app));
    if (reportPath) writeJson(resolve(reportPath), report);
    console.log(summary(report));
    return report.verdict === 'pass' ? 0 : 1;
  }
  if (argv.includes('--feed')) {
    const state = resolve(option(argv, 'state') ?? join(homedir(), '.local', 'state', 'sleight-compat'));
    const { exit, report } = await runFeed({ state, force: argv.includes('--force'), keep: argv.includes('--keep-docs'), feedUrl: option(argv, 'feed') ?? FEED_URL });
    if (reportPath && report) writeJson(resolve(reportPath), report);
    return exit;
  }
  console.error('usage: compat-static.mjs --app <ChatGPT.app> | --feed [URL] [--state DIR] [--force] [--keep-docs] [--report FILE]');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
