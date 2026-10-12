#!/usr/bin/env node
// Where `tab.drag` presses and drops, against where Claude aims it. The page is an HTML5 drag-and-drop list like
// FowlBrowser's settings form, and it logs the client point of every mousedown, dragstart and drop, so each trial
// prints the offset between the aimed point (a getBoundingClientRect center) and the real one. No model.
// Usage: node bench/fowl/drag-probe.mjs [--browser helium|chrome] [--trials 4] [--scroll 0] [--finish none|click|drag]
// --finish sends one more pointer action at the target after the drag: a click, or a zero-length drag.
// Hold /tmp/sleight-live.lock while it runs. It accepts the engine's site prompt for 127.0.0.1 only.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const IDS = { chrome: '7a356c11-c3ba-4fd3-88ff-2f891496ba7e', helium: '2f6fb307-288b-46d7-9fc2-5262c30ea852' };
const browser = args.browser || 'helium';
const trials = Number(args.trials || 4);
const scroll = Number(args.scroll || 0);
const finish = args.finish || 'none';
// --aim edge: drop 3 px inside the target's edge nearest the source, so the step before it (the engine moves in 8 equal
// steps) also lands inside the target and the page sees a dragover before the release.
const aim = args.aim || 'center';
const FINISH = { none: '', click: 'await t.click([to[1], to[2]]);', drag: 'await t.drag([to[1], to[2]], [to[1], to[2]]);' }[finish];
const sdk = createRequire(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/'));
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js');

const page = `<!doctype html><title>drag</title>
<style>body{margin:0;font:16px sans-serif} #pad{height:${200 + scroll}px} li{height:40px;margin:10px 0;background:#eee;list-style:none}</style>
<div id=pad></div><ol id=prio></ol><pre id=log></pre><div style="height:1200px"></div>
<script>
const prio = ['Billing', 'Security', 'Product updates', 'Mentions', 'Reminders'];
const log = (s) => { document.getElementById('log').textContent += s + '\\n'; };
let dragged = null;
document.addEventListener('mousedown', (e) => log('down ' + e.clientX + ',' + e.clientY + ' ' + (e.target.closest('li')?.dataset.item ?? e.target.tagName)), true);
document.addEventListener('mouseup', (e) => log('up ' + e.clientX + ',' + e.clientY), true);
function render() {
  const ol = document.getElementById('prio'); ol.innerHTML = '';
  for (const p of prio) {
    const li = document.createElement('li'); li.draggable = true; li.dataset.item = p; li.textContent = p;
    li.addEventListener('dragstart', (e) => { dragged = p; e.dataTransfer.setData('text/plain', p); log('dragstart ' + e.clientX + ',' + e.clientY + ' ' + p); });
    li.addEventListener('dragenter', (e) => log('dragenter ' + e.clientX + ',' + e.clientY + ' ' + p));
    li.addEventListener('dragover', (e) => { e.preventDefault(); if (window.lastOver !== p) log('dragover ' + e.clientX + ',' + e.clientY + ' ' + p); window.lastOver = p; });
    li.addEventListener('dragend', (e) => log('dragend ' + e.clientX + ',' + e.clientY + ' ' + e.dataTransfer.dropEffect));
    li.addEventListener('drop', (e) => {
      e.preventDefault(); log('drop ' + e.clientX + ',' + e.clientY + ' on ' + p);
      const from = prio.indexOf(dragged); const to = prio.indexOf(p);
      if (from >= 0 && from !== to) prio.splice(to, 0, prio.splice(from, 1)[0]);
      render();
    });
    ol.append(li);
  }
}
render();
</script>`;
const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const client = new Client({ name: 'drag-probe', version: '0' }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  const ok = /^Allow Browser use to access http:\/\/127\.0\.0\.1(:\d+)?\?$/.test(req.params.message ?? '');
  return { action: ok ? 'accept' : 'decline', content: {} };
});
await client.connect(new StdioClientTransport({
  command: join(repo, 'plugins/sleight/bin/sleight-mcp'), args: [], env: { ...clean, SLEIGHT_SURFACES: 'browser,computer' }, stderr: 'ignore',
}));
const js = async (code) => {
  const r = await client.callTool({ name: 'js', arguments: { code, title: 'drag probe' } }, undefined, { timeout: 60000 });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(text.split('\n## Computer Use')[0].slice(0, 400));
  return text;
};
const out = (text) => /<<(.*)>>/s.exec(text)?.[1] ?? text.slice(0, 300);

await js(`let b = await cua.getBrowser({ extensionInstanceId: '${IDS[browser]}' })`);
await js(`let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'drag probe' }); 1`);
await js(`if (${scroll}) await t.playwright.evaluate((y) => scrollTo(0, y), ${scroll}); 1`);
const env = out(await js(`nodeRepl.write('<<' + JSON.stringify(await t.playwright.evaluate(() => [scrollY, innerWidth, innerHeight, devicePixelRatio])) + '>>')`));
console.log(`${browser} scroll ${scroll} finish ${finish} aim ${aim}: [scrollY, innerWidth, innerHeight, dpr] = ${env}`);
if (args.inspect) console.log('tab:', out(await js(`const own = (o) => o ? [...new Set([...Object.keys(o), ...Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {})])].join(' ') : 'none'; nodeRepl.write('<<' + own(t) + ' | cua: ' + own(t.cua) + ' | dev: ' + own(t.dev) + ' | ax: ' + own(t.ax) + ' | caps: ' + JSON.stringify(await t.capabilities.list()) + '>>')`)));
// Each trial drags the last item onto the first, from rect centers, as the skill tells Claude to.
for (let i = 0; i < trials; i++) {
  const r = out(await js(`
    const rects = await t.playwright.evaluate(() => [...document.querySelectorAll('#prio li')].map((l) => { const r = l.getBoundingClientRect(); return [l.dataset.item, Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), Math.round(r.top), Math.round(r.bottom)]; }));
    const from = rects.at(-1), to = [...rects[0]];
    if ('${aim}' === 'edge') to[2] = from[2] < to[2] ? to[4] - 3 : to[3] + 3;
    await t.drag([from[1], from[2]], [to[1], to[2]]);
    ${FINISH}
    const after = await t.playwright.evaluate(() => [[...document.querySelectorAll('#prio li')].map((l) => l.dataset.item).join(', '), document.getElementById('log').textContent]);
    nodeRepl.write('<<' + JSON.stringify({ aimed: { from, to }, order: after[0], log: after[1].trim().split('\\n').slice(-8) }) + '>>');`));
  console.log(`trial ${i + 1}: ${r}`);
}
await js('await t.close?.(); 1').catch(() => {});
await client.close(); site.close();
