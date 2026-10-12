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

const page = `<!doctype html><title>speed</title><input id=f aria-label="Name"><button id=b onclick="this.textContent=+this.textContent+1">0</button>
${Array.from({ length: 60 }, (_, i) => `<p>Row ${i} <a href="#${i}">link ${i}</a></p>`).join('')}`;
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

console.log('arm      browser call                               n  min median p90 (ms)');
await js(`let b = await cua.getBrowser({ extensionInstanceId: '${IDS[browser]}' })`);
await timeIt('createBrowserTab', `let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'speed' }); await t.close?.()`, 3);
const open = await js(`let t = await cua.createBrowserTab(b.browserId, '${url}', { sessionName: 'speed' })`);
const idx = (re) => Number(new RegExp(`(\\d+) ${re}`).exec(open.text)?.[1]);
const field = idx('text field'); const button = idx('button');
await timeIt('getAXState (full)', `await t.getAXState({ disableDiffing: true })`);
await timeIt('getAXState (diff)', `await t.getAXState()`);
await timeIt('click (no read)', `await t.click(${button}); 1`);
await timeIt('click + read', `await t.click(${button}); await t.getAXState()`);
await timeIt('typeText (no read)', `await t.typeText(${field}, 'abc'); 1`);
await timeIt('evaluate', `await t.playwright.evaluate(() => document.title)`);
await js(`await t.close?.(); 1`).catch(() => {});
await client.close(); site.close();
