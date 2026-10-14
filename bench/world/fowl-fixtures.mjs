import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserHandler, browserKinds, createBrowserFixture } from './browser-fixtures.mjs';
import { browserInstructions } from './tasks.mjs';
import { matrixOptions, roundArguments } from './fowl-options.mjs';
import { runRound } from '../fowl/handoff-runner.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://127.0.0.1:5432';
export const FIXTURE_ARMS = ['sleight', 'fowl+sleight', 'fowlbrowser', 'playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu', 'browser-use', 'sleight-turbo'];
export const NOT_RUN = ['codex-cu', 'devtools'].map(arm => ({ arm, status: 'not run', reason: 'Bridge code is not in the repository (owner decision, 2026-10-14)' }));

export function fixtureTask(fixture, uploadPath, browser) {
  return { name: fixture.kind, browser, budgetSeconds: 300, needsClicks: false, worldFixture: fixture.kind,
    prompt: `In {browser}, open ${ORIGIN}/${fixture.nonce}/. ${browserInstructions[fixture.kind].replace('{uploadPath}', uploadPath)} Use only this fixture and leave its windows open.`,
    result: 'the requested JSON, or confirmation that the fixture form was submitted',
    grade: `${ORIGIN}/${fixture.nonce}/api/log`, site: { log: `${ORIGIN}/${fixture.nonce}/api/log` } };
}

export function fixtureHandler(fixture) {
  const handle = browserHandler(fixture, ORIGIN);
  return (req, res) => {
    if (req.method === 'GET' && req.url === `/${fixture.nonce}/api/log` && req.headers.host === new URL(ORIGIN).host
      && (!req.headers.origin || req.headers.origin === ORIGIN)) {
      return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(fixture));
    }
    return handle(req, res);
  };
}

export { gradeFixture } from './fowl-fixture-grade.mjs';

async function serve(fixture) {
  const handler = fixtureHandler(fixture);
  const server = createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.writeHead(500).end()));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5432, '127.0.0.1', resolve); });
  return () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function runFixtureClaims({ outRoot = '/tmp/fb-rounds', arms = FIXTURE_ARMS, kinds = browserKinds,
  browser = 'chrome', stamp = new Date().toISOString().replace(/[:.]/g, '-'), run = runRound, serve: start = serve, ...input } = {}) {
  const options = matrixOptions(input);
  if (!arms.length || arms.some(arm => !FIXTURE_ARMS.includes(arm))) throw Error('Unknown or excluded fixture arm');
  if (!kinds.length || kinds.some(kind => !browserKinds.includes(kind))) throw Error('Unknown fixture kind');
  if (!['chrome', 'helium'].includes(browser)) throw Error('Unknown browser');
  const rows = [], notRun = NOT_RUN;
  if (!options.dryRun) mkdirSync(outRoot, { recursive: true });
  for (let repetition = 1; repetition <= options.runs; repetition++) for (const arm of arms) for (const kind of kinds) {
    const out = join(outRoot, `fixtures-${stamp}-${repetition}-${arm}-${kind}`);
    const args = roundArguments(options, ['--surface', arm, '--tasks', join(out, 'tasks.json'), '--codex-browsers', 'auto', '--out', join(out, 'round')]);
    const row = { arm, task: kind, run: repetition, browser: options.swap ? (browser === 'chrome' ? 'helium' : 'chrome') : browser,
      out, args, ...(options.dryRun ? { dryRun: true } : {}) };
    rows.push(row);
    if (options.dryRun) continue;
    let close;
    try {
      mkdirSync(out, { recursive: false });
      const fixture = createBrowserFixture(kind, { nonce: randomUUID() });
      const uploadPath = join(out, 'upload.txt');
      if (kind === 'file-upload') writeFileSync(uploadPath, fixture.expected.uploadText, { flag: 'wx' });
      writeFileSync(join(out, 'tasks.json'), JSON.stringify([fixtureTask(fixture, uploadPath, browser)], null, 2), { flag: 'wx' });
      close = await start(fixture);
      row.code = await run({ out: join(out, 'round'), args, arm });
    } catch (error) { row.code = 1; row.error = error.message; }
    finally {
      if (close) try { await close(); row.cleanup = 'server closed'; }
      catch (error) { row.code = 1; row.cleanup = error.message; }
    }
    if (row.code === 130) return { rows, notRun };
  }
  const result = { rows, notRun };
  if (!options.dryRun) writeFileSync(join(outRoot, `fixture-coverage-${stamp}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

export function fixtureOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--dry-run', '--swap'].includes(flag)) result[flag === '--dry-run' ? 'dryRun' : 'swap'] = true;
    else if (['--out', '--arm', '--browser', '--model', '--effort', '--runs'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`${flag} needs a value`);
      result[flag === '--out' ? 'outRoot' : flag === '--arm' ? 'arms' : flag.slice(2)] = flag === '--arm' ? value.split(',') : value;
    } else throw Error(`Unknown fixture option ${flag}`);
  }
  return result;
}

if (import.meta.main) {
  const result = await runFixtureClaims(fixtureOptions(process.argv.slice(2)));
  console.log(JSON.stringify(result));
  process.exitCode = result.rows.some(row => row.code !== undefined && row.code !== 0) ? 1 : 0;
}
