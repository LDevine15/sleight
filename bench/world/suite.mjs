import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const suite = JSON.parse(readFileSync(new URL('./suite.json', import.meta.url)));
const readTasks = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));

// Catalog resolution has no setup side effects. The named runner owns fixtures and grading.
export async function resolveTask(id) {
  const row = [...suite.browser, ...suite.native, ...suite.handoff, ...suite.heldOut ?? []].find(t => t.id === id);
  if (!row) throw new Error(`unknown world task ${id}`);
  let tasks;
  if (row.source === 'fowlbrowser') tasks = readTasks('./tasks/fowlbrowser.json');
  else if (row.source === 'handoff') tasks = readTasks('../fowl/handoff.json');
  else if (row.source === 'default') tasks = (await import('../tasks.mjs')).tasks;
  else if (row.source === 'real') tasks = (await import('../tasks-real.mjs')).realTasks;
  else if (row.source === 'battery') tasks = (await import('../battery/tasks.mjs')).tasks;
  else if (row.source === 'world') tasks = (await import('../tasks.mjs')).getTasks('world');
  const task = tasks?.find(t => (t.id ?? t.name) === row.task);
  if (!task) throw new Error(`missing source task ${id}`);
  return task;
}

export function planSuite({ claimOnly = false } = {}) {
  return ['browser', 'native', 'handoff'].flatMap(group => suite[group].filter(row => !claimOnly || row.claim).map(row => ({ ...row, group, live: false })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--dry-run') || process.argv.slice(2).some(arg => !['--dry-run', '--claim'].includes(arg))) throw new Error('use --dry-run; live runs belong to sleight-arch');
  console.log(JSON.stringify(planSuite({ claimOnly: process.argv.includes('--claim') }), null, 2));
}
