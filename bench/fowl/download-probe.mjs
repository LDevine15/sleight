#!/usr/bin/env node
// Does `locator.downloadMedia()` return on a PDF link with `download` and an attachment header, raw (ChatGPT's
// cua_repl) and through sleight? The hand-off invoice runs hung on it until the engine reset its kernel (3 of 3,
// 2026-10-12). Each way runs in its own tab; the downloaded files are removed afterwards. No model.
// Usage: node bench/fowl/download-probe.mjs --arm raw|sleight [--browser chrome|helium] [--click-first 1]
// --click-first clicks the link with tab.click before downloadMedia, as the hand-off runs did.
// Hold /tmp/sleight-live.lock while it runs. It accepts the engine's site and download prompts for 127.0.0.1 only.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const arm = args.arm || 'sleight';
const IDS = { chrome: '7a356c11-c3ba-4fd3-88ff-2f891496ba7e', helium: '2f6fb307-288b-46d7-9fc2-5262c30ea852' };
const browser = args.browser || 'chrome';
const sdk = createRequire(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/'));
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js');

const stem = 'probe-' + randomUUID();
const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const site = createServer((req, res) => {
  if (req.url.startsWith('/file')) {
    const n = req.url.slice(5, 6) || '0';
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${stem}-${n}.pdf"` });
    return res.end(pdf);
  }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>download</title><a id=a href="/file1" download>Download PDF</a> <a id=b href="/file2" download>Second</a>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
let command; let cargs; let env;
if (arm === 'raw') {
  const dir = join(homedir(), '.codex/plugins/cache/openai-bundled/unified-computer-use');
  const v = readdirSync(dir).sort().at(-1);
  const s = JSON.parse(readFileSync(join(dir, v, '.mcp.json'), 'utf8')).mcpServers.cua_repl;
  command = s.command; cargs = s.args; env = { ...clean, ...s.env, CUA_REPL_ENABLED_SURFACES: 'browser' };
} else {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
  command = join(repo, 'plugins/sleight/bin/sleight-mcp'); cargs = []; env = { ...clean, SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_HAND: '0' };
}
const prompts = [];
const client = new Client({ name: 'download-probe', version: '0' }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  const message = req.params.message ?? '';
  const ok = /^Allow (?:Browser use to access|download from) http:\/\/127\.0\.0\.1(:\d+)?[^\s?]*\?$/.test(message);
  prompts.push(`${ok ? 'accept' : 'decline'}: ${message}`);
  return { action: ok ? 'accept' : 'decline', content: {} };
});
await client.connect(new StdioClientTransport({ command, args: cargs, env, stderr: 'ignore' }));
const META = JSON.stringify({ session_id: crypto.randomUUID(), turn_id: crypto.randomUUID() });
const js = async (code) => {
  const t = performance.now();
  const r = await client.callTool({ name: 'js', arguments: { code, title: 'download probe' }, ...(arm === 'raw' ? { _meta: { 'x-codex-turn-metadata': META } } : {}) }, undefined, { timeout: 90000 });
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  return { ms: Math.round(performance.now() - t), error: !!r.isError, text: (/<<(.*)>>/s.exec(text)?.[1] ?? text.split('\n## Computer Use')[0]).slice(0, 240).replace(/\n/g, ' ') };
};
const step = async (label, code) => { const r = await js(code); console.log(`${arm} ${browser} ${label}: ${r.ms} ms ${r.error ? 'ERROR ' : ''}${r.text}`); };

await js(`let b = await cua.getBrowser({ extensionInstanceId: '${IDS[browser]}' })`);
await js(`let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'download probe' }); 1`);
if (args['click-first']) await step('tab.click on the link', `const tree = await t.getAXState(); const n = Number(/(\\d+) link (?:Description: )?Download PDF/.exec(String(tree))?.[1]); await t.click(n); nodeRepl.write('<<clicked ' + n + '>>')`);
await step('downloadMedia', `const p = await t.playwright.locator('#a').downloadMedia({ timeoutMs: 20000 }); nodeRepl.write('<<' + String(p) + '>>')`);
await step('waitForEvent+click', `let t2 = await cua.getTab(t.id, { browser: b.browserId }).catch(() => null) ?? await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'download probe' }); const d = t2.playwright.waitForEvent('download', { timeoutMs: 20000 }); await t2.playwright.locator('#b').click({}); nodeRepl.write('<<' + String(await (await d).path({})) + '>>')`);
console.log('prompts:', prompts.join(' | ') || 'none');
await js('await t.close?.(); 1').catch(() => {});
await client.close(); site.close();
for (const name of readdirSync(join(homedir(), 'Downloads'))) if (name.startsWith(stem)) rmSync(join(homedir(), 'Downloads', name));
