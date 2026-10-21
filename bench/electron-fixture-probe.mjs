// A fixed diagnostic subset of the live qualification. Omitted required cells keep it unqualified.
// Uses the ordinary runner's consent watcher, ownership lock, cancellation and cleanup.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELLS } from './electron-qualification.mjs';
import { main, parseRunnerArgs } from './electron-live-runner.mjs';

export function observeCell(cell, fixtureName) {
  return { ...cell, async run(c) {
    const observations = {};
    const capture = async () => {
      try { return await c.driver.fixtureObservation({ tab: c.tab(), fixtureName }); }
      catch { return { ok: false, code: 'ELECTRON_FIXTURE_OBSERVATION_FAILED' }; }
    };
    const observed = { ...c, async act(tab, steps, ...rest) {
      if (steps.some(step => step.do === 'press' && step.key === 'Meta+Shift+V')) observations.beforePreview = await capture();
      return c.act(tab, steps, ...rest);
    } };
    let result, failure;
    try { result = await cell.run(observed); } catch (error) { failure = error; }
    observations.after = await capture();
    if (failure) {
      failure.detail = { ...failure.detail, fixtureObservation: observations };
      throw failure;
    }
    return { ...result, detail: { ...result?.detail, fixtureObservation: observations } };
  } };
}

const ids = new Set(['consent-card', 'connect', 'list', 'read', 'click', 'key', 'webview', 'new-window', 'quit']);
export const FIXTURE_PROBE_CELLS = Object.freeze(CELLS.filter(cell => ids.has(cell.id)).map(cell =>
  cell.id === 'key' ? observeCell(cell, 'a-scratch.txt') : cell.id === 'webview' ? observeCell(cell, 'a-notes.md') : cell));

export function probeArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { if (!argv[++i] || argv[i].startsWith('--')) throw Error('INVALID_OPTIONS'); }
    else if (!['--owner-away', '--dry-run'].includes(argv[i])) throw Error('INVALID_OPTIONS');
  }
  const args = [...argv, '--phases', 'qualify'];
  parseRunnerArgs(args);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(probeArgs(process.argv.slice(2)), { qualificationCells: FIXTURE_PROBE_CELLS }).then(code => { process.exitCode = code; },
    () => { console.error('ELECTRON_FIXTURE_PROBE_FAILED'); process.exitCode = 1; });
}
