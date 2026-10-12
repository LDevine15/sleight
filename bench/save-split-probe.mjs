#!/usr/bin/env node
// Live check for the save split (A7R): `setValue` then Cmd+S in one call, on a temp plain-text TextEdit document opened in
// the background. Passes when the file on disk holds the new text, the relay trace shows the call split at the save, and
// the read after it answers (the hang this fixes made every later read fail with -10005). No model.
// Usage: node bench/save-split-probe.mjs [--trials 3]
// Hold /tmp/sleight-live.lock while it runs. Quits TextEdit afterwards only if this probe started it.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const trials = Number(args.trials || 3);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = createRequire(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/'));
const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
const { ElicitRequestSchema } = sdk('@modelcontextprotocol/sdk/types.js');
const running = () => { try { execFileSync('/usr/bin/pgrep', ['-x', 'TextEdit']); return true; } catch { return false; } };
if (running()) { console.log('TextEdit is already running; the probe only runs when it can quit TextEdit afterwards.'); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'sleight-save-split-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))), SLEIGHT_SURFACES: 'computer', SLEIGHT_TRACE: '1' };
const traceDir = join(homedir(), 'Library/Logs/sleight');
let passed = 0;
try {
  for (let i = 1; i <= trials; i++) {
    const file = join(dir, `save-split-${i}.txt`);
    writeFileSync(file, 'before\n');
    execFileSync('/usr/bin/open', ['-g', '-a', 'TextEdit', file]);
    await new Promise((r) => setTimeout(r, 1500));
    const client = new Client({ name: 'save-split', version: '0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => ({ action: /^Allow Computer Use to use "TextEdit"\?$/.test(req.params.message ?? '') ? 'accept' : 'decline', content: {} }));
    const started = Date.now();
    await client.connect(new StdioClientTransport({ command: join(repo, 'plugins/sleight/bin/sleight-mcp'), args: [], env, stderr: 'ignore' }));
    const js = async (code) => {
      const r = await client.callTool({ name: 'js', arguments: { code, title: 'save split' } }, undefined, { timeout: 90000 });
      return { error: !!r.isError, text: (r.content || []).map((c) => c.text || '').join('\n') };
    };
    const acquire = await js(`let a = await cua.getApp('TextEdit');`);
    const n = Number(/(\d+) text (?:area|entry area)/i.exec(acquire.text)?.[1]);
    const text = `after ${i} ${Date.now()}`;
    const t0 = performance.now();
    const save = await js(`await a.setValue(${n}, ${JSON.stringify(text)});\nawait a.pressKey("cmd+s");`);
    const saveMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const read = await js('await a.getAXState()');
    const readMs = Math.round(performance.now() - t1);
    await client.close();
    await new Promise((r) => setTimeout(r, 500));
    const onDisk = readFileSync(file, 'utf8').trim();
    const trace = readdirSync(traceDir).filter((f) => f.startsWith('trace-')).map((f) => [f, statSync(join(traceDir, f)).mtimeMs]).filter(([, m]) => m >= started).sort((x, y) => y[1] - x[1])[0]?.[0];
    const calls = trace ? readFileSync(join(traceDir, trace), 'utf8').split('\n').filter((l) => l.includes('"direction":"to-server"') && l.includes('tools/call')).length : -1;
    const ok = onDisk === text && !save.error && !read.error;
    if (ok) passed++;
    console.log(`trial ${i}: element ${n}, save ${saveMs} ms${save.error ? ' ERROR' : ''}, read after ${readMs} ms${read.error ? ' ERROR' : ''}, engine calls ${calls} (a split save is 3 or more), file ${onDisk === text ? 'saved' : `NOT saved (${JSON.stringify(onDisk)})`}${save.error ? `\n  ${save.text.slice(-700)}` : ''}`);
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to quit saving no']);
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  if (running()) execFileSync('/usr/bin/osascript', ['-e', 'tell application "TextEdit" to quit saving no']);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed}/${trials} saved with the read after answering`);
