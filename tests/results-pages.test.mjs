import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { render, FAMILIES } from '../bench/results-hub.mjs';
import { chartCaption } from '../bench/results-charts.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const templatePath = new URL('../bench/results-index.html', import.meta.url);
const all = () => Object.fromEntries(FAMILIES.map(f => [f.id, JSON.parse(read(`docs/results/data/${f.id}.json`))]));
const homePath = /\/Users\/[^\s,"'<>\\]/;

test('the privacy scan allows the Users root and rejects home paths', () => {
  for (const text of ['file:///Users/', 'URL: file:///Users/, Value: Users', JSON.stringify({ url: 'file:///Users/' })]) {
    assert.doesNotMatch(text, homePath);
  }
  for (const text of ['/Users/someone', 'file:///Users/someone/', 'file:///Users/someone/Documents/file.txt',
    JSON.stringify({ url: 'file:///Users/someone/Documents/file.txt' })]) {
    assert.match(text, homePath);
  }
});

test('the docs tree served by Pages contains no home paths', () => {
  const docs = new URL('../docs/', import.meta.url);
  const files = readdirSync(docs, { recursive: true }).filter(name => /\.(md|html|json|svg|txt|csv|js|mjs|css)$/i.test(name));
  assert.ok(files.includes('benchmarks/2026-10-04-hover-discovery-2/results.json'));
  for (const name of files) assert.doesNotMatch(readFileSync(new URL(name, docs), 'utf8'), homePath, name);
});

function checkURL(value, { navigation = false } = {}) {
  const url = new URL(value.replaceAll('&amp;', '&'), 'https://land-o-clusters.github.io/sleight/results/');
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:', `unexpected URL scheme: ${value}`);
  const local = url.origin === 'https://land-o-clusters.github.io';
  assert.ok(local || (navigation && url.origin === 'https://github.com'), `third-party URL: ${value}`);
}

// Inspect executable markup, not URLs quoted as benchmark evidence in the inline JSON.
function checkRequests(html) {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => tag.slice(0, tag.indexOf('>') + 1) + '</script>');
  for (const tag of markup.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const name = tag[1].toLowerCase();
    for (const attr of tag[2].matchAll(/\b(src|href|srcset|poster|data|action|formaction|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const key = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? attr[4];
      const urls = key === 'srcset' ? value.split(',').map(part => part.trim().split(/\s+/)[0]) : key === 'ping' ? value.split(/\s+/) : [value];
      for (const url of urls) checkURL(url, { navigation: name === 'a' && key === 'href' });
    }
  }
  for (const match of markup.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi)) checkURL(match[1] ?? match[2]);
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const code = script[1].replace(/const DATA = [\s\S]*?;\n/, '');
    assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Worker|SharedWorker|importScripts)\b|\bimport\s*\(|serviceWorker/);
  }
}

function landing(data) {
  assert.ok(existsSync(templatePath), 'landing template is present');
  const files = render(data), html = files['index.html'];
  checkRequests(html);
  return { html, files };
}
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

test('Pages serves unprocessed files and has a root link to results', () => {
  const marker = new URL('../docs/.nojekyll', import.meta.url);
  assert.ok(existsSync(marker), '.nojekyll is present');
  assert.equal(statSync(marker).size, 0);
  const root = read('docs/index.html');
  assert.match(root, /<html lang="en">/);
  assert.match(root, /<meta name="viewport"/);
  assert.match(root, /href="results\/"/);
  checkRequests(root);
});

test('the committed results pages and source templates load no third-party resources', () => {
  for (const name of ['docs/results/index.html', 'docs/results/explore.html', 'bench/results-explore.html']) checkRequests(read(name));
  if (existsSync(new URL('../docs/results/release-passes.html', import.meta.url))) checkRequests(read('docs/results/release-passes.html'));
});

test('the request guard rejects remote resources and allows only GitHub navigation', () => {
  checkRequests('<a href="https://github.com/Land-o-Clusters/sleight">Source</a><img src="img/overview-light.svg">');
  // Evidence can quote the site a benchmark drove without loading it.
  checkRequests('<script>const DATA = {"evidence":"https://example.com"};\n</script>');
  for (const markup of [
    '<script src="https://cdn.example.com/a.js"></script>',
    '<img src="//tracker.example.com/pixel">',
    '<img srcset="img/local.svg 1x, https://example.com/a.svg 2x">',
    '<link rel="stylesheet" href="https://github.com/fonts.css">',
    '<a href="https://github.com.evil.example/source">Source</a>',
    '<style>@import "https://example.com/font.css";</style>',
    '<style>body { background: url(https://example.com/pixel) }</style>',
    '<script>fetch("/analytics")</script>',
    '<a href="https://github.com" ping="https://example.com/ping">Source</a>',
  ]) assert.throws(() => checkRequests(markup), undefined, markup);
});

test('the landing renders family links and chart captions without scripts or fetched data', () => {
  const data = all(), { html } = landing(data);
  assert.doesNotMatch(html, /http-equiv="refresh"|<script\b|<!--__/);
  assert.match(html, /href="explore.html"/);
  for (const id of ['headline-native', 'overview']) {
    const caption = escape(chartCaption(id, data));
    assert.ok(html.includes(`<figcaption id="${id}-caption">${caption}</figcaption>`));
    assert.ok(html.includes(`alt="${caption}"`));
    assert.ok(html.includes(`img/${id}-light.svg`));
    assert.ok(html.includes(`img/${id}-dark.svg`));
  }
  const table = /<tbody id="families">([\s\S]*?)<\/tbody>/.exec(html)[1];
  assert.equal([...table.matchAll(/<tr>/g)].length, FAMILIES.length);
  for (const family of FAMILIES) {
    assert.ok(table.includes(escape(family.title)), family.title);
    assert.ok(table.includes(`href="https://github.com/Land-o-Clusters/sleight/blob/main/docs/results/${family.page}"`));
    assert.ok(table.includes(`href="data/${family.id}.json"`));
  }
});

test('the landing renders when the browser race has no complete studies', () => {
  const data = all();
  data['browser-race'].studies = [];
  const { html, files } = landing(data);
  assert.match(html, /data\/browser-race\.json/);
  for (const browser of ['safari', 'firefox']) assert.match(files[`img/family-browser-race-${browser}-light.svg`], /No complete set/);
  assert.doesNotMatch(html, /<!--__/);
});

test('the landing escapes benchmark wording in family summaries and chart captions', () => {
  const unsafe = '</script><img src=//x> <!-- $&';
  const data = all();
  const study = data['browser-race'].studies.find(s => s.latest);
  assert.ok(study);
  study.verdict.wording = unsafe;
  data['native-claim'].studies[0].models.sleight = [unsafe];
  const { html } = landing(data);
  assert.doesNotMatch(html, /<script\b|<\/script\s*>|<img src=\/\/x>|<!--/i);
  assert.ok(html.includes(escape(unsafe)), 'the family summary escapes run wording');
  assert.ok(html.includes(escape(chartCaption('headline-native', data))), 'the chart caption is escaped');
});
