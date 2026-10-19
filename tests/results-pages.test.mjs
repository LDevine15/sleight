import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { exploreData, FAMILIES } from '../bench/results-hub.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const templatePath = new URL('../bench/results-index.html', import.meta.url);
const all = () => Object.fromEntries(FAMILIES.map(f => [f.id, JSON.parse(read(`docs/results/data/${f.id}.json`))]));
const captions = { 'headline-native': 'Native claim caption from the chart module.', overview: 'Overview caption from the chart module.' };

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

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.text = ''; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  find(tag) { return [...(this.tag === tag ? [this] : []), ...this.children.flatMap(node => node.find(tag))]; }
}

function landing(data) {
  assert.ok(existsSync(templatePath), 'H3 landing template is present');
  const template = read('bench/results-index.html');
  assert.equal(template.split('/*__DATA__*/null').length, 2, 'one data slot, matching explore.html');
  const html = template.replace('/*__DATA__*/null', () => JSON.stringify(data).replaceAll('<', '\\u003c'));
  checkRequests(html);
  const nodes = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Node('div')]));
  const document = { getElementById: id => nodes[id], createElement: tag => new Node(tag) };
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInNewContext(script, { document });
  return { html, nodes };
}

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

test('the landing consumes exploreData and chart captions without fetching data', () => {
  const data = { ...exploreData(all()), chartCaptions: captions };
  const { html, nodes } = landing(data);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.match(html, /href="explore.html"/);
  for (const [id, caption] of Object.entries(captions)) {
    assert.equal(nodes[`${id}-caption`].textContent, caption);
    assert.equal(nodes[id].attrs.alt, caption);
    assert.match(html, new RegExp(`img/${id}-light\\.svg`));
    assert.match(html, new RegExp(`img/${id}-dark\\.svg`));
  }
  const rows = nodes.families.find('tr');
  assert.equal(rows.length, FAMILIES.length);
  for (const family of data.families) {
    const row = rows.find(row => row.textContent.includes(family.title));
    assert.ok(row, family.title);
    assert.equal(row.find('a')[0].attrs.href, `https://github.com/Land-o-Clusters/sleight/blob/main/docs/results/${family.page}`);
    assert.equal(row.find('a')[1].attrs.href, `data/${family.id}.json`);
    for (const link of row.find('a')) checkURL(link.attrs.href, { navigation: true });
  }
  assert.ok(nodes.families.textContent.includes(data.studies.find(study => study.family === 'native-claim').wording));
});

test('the landing handles H1 stubs and an empty study list', () => {
  const data = { families: [{ id: 'native-claim', title: 'Native claim', page: 'native-claim.md' }], strings: [], studies: [] };
  const { nodes } = landing(data);
  assert.match(nodes.families.textContent, /No studies/);
  assert.equal(nodes['headline-native-caption'].textContent, 'Native claim');
  assert.equal(nodes['overview-caption'].textContent, 'Benchmark overview');
  assert.equal(nodes['headline-native'].attrs.alt, 'Native claim');
});

test('the landing treats benchmark wording and captions as text', () => {
  const unsafe = '<img src="https://example.com/track">';
  const { nodes } = landing({ families: [{ id: 'native-claim', title: 'Native claim', page: 'native-claim.md' }], strings: [],
    studies: [{ family: 'native-claim', wording: unsafe }], chartCaptions: { 'headline-native': unsafe } });
  assert.ok(nodes.families.textContent.includes(unsafe));
  assert.equal(nodes.families.find('img').length, 0);
  assert.equal(nodes['headline-native-caption'].textContent, unsafe);
});
