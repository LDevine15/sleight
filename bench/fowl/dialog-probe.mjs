#!/usr/bin/env node
// Per-call speed of Codex's browser extension, raw (ChatGPT's cua_repl) and through sleight, on the same
// local page, to compare with FowlBrowser's mcp/test/bench.mjs. No model: an MCP client sends fixed code.
// Usage: node bench/fowl/ext-speed.mjs --arm raw|sleight [--browser helium|chrome] [--runs 10]
// Hold /tmp/sleight-live.lock while it runs. It accepts the engine's site prompt for 127.0.0.1 only.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const arm = args.arm || 'sleight'; const runs = Number(args.runs || 10);
const IDS = { chrome: '7a356c11-c3ba-4fd3-88ff-2f891496ba7e', helium: '2f6fb307-288b-46d7-9fc2-5262c30ea852' };
const browser = args.browser || 'helium';
const sdk = createRequire(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/'));
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js');

const page = `<!doctype html><title>dialog</title><button id=pay onclick="document.title = confirm('Pay $1 now?') ? 'paid' : 'cancelled'">Pay now</button>`;
const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
let command; let cargs; let env;
if (arm === 'raw') {
  const dir = join(homedir(), '.codex/plugins/cache/openai-bundled/unified-computer-use');
  const { readdirSync } = await import('node:fs');
  const v = readdirSync(dir).sort().at(-1);
  const s = JSON.parse(readFileSync(join(dir, v, '.mcp.json'), 'utf8')).mcpServers.cua_repl;
  command = s.command; cargs = s.args; env = { ...clean, ...s.env, CUA_REPL_ENABLED_SURFACES: 'browser' };
} else {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
  command = join(repo, 'plugins/sleight/bin/sleight-mcp'); cargs = []; env = { ...clean, SLEIGHT_SURFACES: 'browser,computer' };
}
const client = new Client({ name: 'ext-speed', version: '0' }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  const ok = /^Allow Browser use to access http:\/\/127\.0\.0\.1(:\d+)?\?$/.test(req.params.message ?? '');
  return { action: ok ? 'accept' : 'decline', content: {} };
});
await client.connect(new StdioClientTransport({ command, args: cargs, env, stderr: 'ignore' }));

// The raw engine wants the session and turn ids Codex sends (sleight adds them itself).
const META = JSON.stringify({ session_id: crypto.randomUUID(), turn_id: crypto.randomUUID() });
const js = async (code) => {
  const t = performance.now();
  const r = await client.callTool({ name: 'js', arguments: { code, title: 'speed' }, ...(arm === 'raw' ? { _meta: { 'x-codex-turn-metadata': META } } : {}) }, undefined, { timeout: 60000 });
  const ms = performance.now() - t;
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error((r.content || []).map((c) => c.type + ": " + (c.text || "").slice(0, 300)).filter((x) => !/## Computer Use|# Computer Use Confirmations/.test(x)).join("\n"));
  return { ms, text };
};
const stats = (l) => { const s = [...l].sort((a, b) => a - b); return `${s[0].toFixed(0)}  ${s[Math.floor(s.length / 2)].toFixed(0)}  ${s[Math.min(s.length - 1, Math.floor(s.length * .9))].toFixed(0)}`; };
const timeIt = async (label, code, n = runs) => { const l = []; for (let i = 0; i < n; i++) l.push((await js(code)).ms); console.log(`${arm.padEnd(8)} ${browser.padEnd(7)} ${label.padEnd(34)} ${n}  ${stats(l)}`); };

const way = args.way || 'accept';
await js(`let b = await cua.getBrowser({ extensionInstanceId: '${IDS[browser]}' })`);
const open = await js(`let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'dialog' })`);
const pay = Number(/(\d+) button Pay now/.exec(open.text)?.[1]);
const step = async (label, code) => { try { const r = await js(code); console.log(way, browser, label, Math.round(r.ms) + ' ms', r.text.slice(0, 160).replace(/\n/g, ' ')); } catch (e) { console.log(way, browser, label, 'ERROR', String(e.message).slice(0, 200).replace(/\n/g, ' ')); } };
if (way === 'preempt') await step('preempt', 'await t.playwright.evaluate(() => { window.confirm = () => true; }); nodeRepl.write("set")');
await step('click', `await t.click(${pay}); 1`);
if (way === 'accept') await step('answer', 'const d = await t.getJsDialog(); await d.accept(); nodeRepl.write("accepted")');
if (way === 'preempt') { /* placeholder */ }
if (way === 'ax') await step('answer', 'nodeRepl.write(JSON.stringify(await t.ax.get("state")).slice(0, 600))');
await step('read title', 'nodeRepl.write(String(await t.title()))');
await step('read tree', 'await t.getAXState({ disableDiffing: true })');
await js('await t.close?.(); 1').catch(() => {});
await client.close(); site.close();
