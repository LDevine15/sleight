import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('./results-index.html', import.meta.url), 'utf8');

export function renderResultsIndex(data) {
  const payload = JSON.stringify(data).replaceAll('<', '\\u003c');
  return template.replace('/*__DATA__*/null', () => payload);
}
