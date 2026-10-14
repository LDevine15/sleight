import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function ciTestFiles(root = process.cwd()) {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  const [command, runner, ...selectors] = script.split(/\s+/);
  if (command !== 'node' || runner !== '--test') throw Error('unsupported CI test command');
  return [...new Set(selectors.flatMap(selector => {
    if (/^--test-concurrency=\d+$/.test(selector)) return [];
    const match = selector.match(/^([\w/-]+)\/\*\.test\.mjs$/);
    if (!match) throw Error('unsupported CI test selector: ' + selector);
    return readdirSync(join(root, match[1])).filter(file => file.endsWith('.test.mjs')).sort()
      .map(file => match[1] + '/' + file);
  }))];
}
