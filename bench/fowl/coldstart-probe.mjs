#!/usr/bin/env node
// Where a session's first browser call spends its time. In the 15:23 round sleight's first call took 4.8 s (median of
// 26) against 244 ms for later calls. A fresh server per trial; the steps run as separate calls so each is timed:
// an empty call (the engine's REPL starting), getBrowser, createBrowserTab on a local page, a read. The site prompt is
// answered at once and its wait is reported apart. No model.
// Usage: node bench/fowl/coldstart-probe.mjs --arm raw|sleight [--browser helium|chrome] [--trials 3] [--open create|new]
// --open new opens the tab with `b.tabs.new()` and `goto` instead of `cua.createBrowserTab`.
// --empty-only skips the local site and every browser call. It permits --concurrency 6;
// --prepare-ms 2500 gives REPL setup the same lead time as a model's first message.
// Hold /tmp/sleight-live.lock while it runs.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coldstartSteps, coldstartMode } from './coldstart-steps.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const arm = args.arm || 'sleight'; const trials = Number(args.trials || 3);
const { emptyOnly, concurrency, prepareMs } = coldstartMode(args, process.argv.slice(2));
const IDS = { chrome: '7a356c11-c3ba-4fd3-88ff-2f891496ba7e', helium: '2f6fb307-288b-46d7-9fc2-5262c30ea852' };
const browser = args.browser || 'helium';
const open = args.open || 'create';
const sdk = createRequire(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/'));
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js');

const site = emptyOnly ? undefined : createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>cold</title><h1>Cold start</h1><button>One</button>'); });
if (site) await new Promise((r) => site.listen(0, '127.0.0.1', r));
const url = site ? `http://127.0.0.1:${site.address().port}/` : undefined;
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
let command; let cargs; let env;
if (arm === 'raw') {
  const dir = join(homedir(), '.codex/plugins/cache/openai-bundled/unified-computer-use');
  const v = readdirSync(dir).sort().at(-1);
  const s = JSON.parse(readFileSync(join(dir, v, '.mcp.json'), 'utf8')).mcpServers.cua_repl;
  command = s.command; cargs = s.args; env = { ...clean, ...s.env, CUA_REPL_ENABLED_SURFACES: 'browser' };
} else {
  command = join(dirname(fileURLToPath(import.meta.url)), '../..', 'plugins/sleight/bin/sleight-mcp'); cargs = []; env = { ...clean, SLEIGHT_SURFACES: 'browser,computer' };
}

const rows = [];
async function trial(i) {
  let promptMs = 0;
  const client = new Client({ name: 'coldstart', version: '0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const t = performance.now(); const ok = /^Allow Browser use to access http:\/\/127\.0\.0\.1(:\d+)?\?$/.test(req.params.message ?? '');
    promptMs += performance.now() - t; return { action: ok ? 'accept' : 'decline', content: {} };
  });
  const t0 = performance.now();
  try {
  await client.connect(new StdioClientTransport({ command, args: cargs, env, stderr: 'ignore' }));
  const connect = performance.now() - t0;
  const META = JSON.stringify({ session_id: crypto.randomUUID(), turn_id: crypto.randomUUID() });
  const js = async (code) => {
    const t = performance.now();
    const r = await client.callTool({ name: 'js', arguments: { code, title: 'cold' }, ...(arm === 'raw' ? { _meta: { 'x-codex-turn-metadata': META } } : {}) }, undefined, { timeout: 90000 });
    const chars = (r.content || []).reduce((n, c) => n + (c.text || '').length, 0);
    return { ms: Math.round(performance.now() - t), chars, error: !!r.isError };
  };
  if (prepareMs) await new Promise(resolve => setTimeout(resolve, prepareMs));
  const row = { connect: Math.round(connect), ...await coldstartSteps(js, { emptyOnly, browserId: IDS[browser], open, url }) };
  row.prompt = Math.round(promptMs);
  if (!emptyOnly) await js('await t.close?.(); 1').catch(() => {});
  rows.push(row);
  console.log(emptyOnly ? `${arm} empty-only trial ${i + 1}: connect ${row.connect} ms | prepare ${prepareMs} ms | empty ${row.empty.ms} ms (${row.empty.chars} chars)${row.empty.error ? ' ERROR' : ''}` :
    `${arm} ${browser} ${open} trial ${i + 1}: connect ${row.connect} ms | empty ${row.empty.ms} ms (${row.empty.chars} chars) | getBrowser ${row.getBrowser.ms} ms (${row.getBrowser.chars}) | open ${row.createTab.ms} ms${row.createTab.error ? ' ERROR' : ''} (${row.createTab.chars}) | first read ${row.read.ms} ms (${row.read.chars}) | second read ${row.second.ms} ms | prompt handler ${row.prompt} ms`);
  } finally { await client.close(); }
}
try {
  for (let i = 0; i < trials; i += concurrency) {
    const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, trials - i) }, (_, n) => trial(i + n)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
} finally { site?.close(); }
