import { checkBrowserFixture } from './browser-fixtures.mjs';

export function gradeFixture({ task, site, answer }) {
  if (!task.worldFixture) return { ok: true, cell: 'n/a', problems: [] };
  let result;
  try {
    if (site?.kind !== task.worldFixture || !Array.isArray(site.views) || !site.expected) throw Error('invalid fixture snapshot');
    const text = String(answer ?? '');
    const line = text.split('\n').filter(line => /^RESULT:/.test(line)).at(-1);
    result = checkBrowserFixture(site, line ? line.slice(7).trim() : text);
  } catch { result = 'WORLD_FIXTURE_UNAVAILABLE'; }
  const problems = result === true ? [] : [result];
  return { ok: problems.length === 0, cell: problems.length ? `FAIL: ${result}` : 'ok', problems };
}
