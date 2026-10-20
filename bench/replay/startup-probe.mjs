#!/usr/bin/env node
// Offline launch diagnostic. It sends initialize and tools/list, then closes stdin.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveServer } from '../../plugins/sleight/lib/launch.mjs';
import { replayServers } from './run.mjs';
import { createReplayRecorder } from './evidence.mjs';

export async function startupProbe(dir) {
  mkdirSync(dir, { mode: 0o700 });
  const record = createReplayRecorder(dir), server = 'plugin:sleight:computer';
  const worktree = fileURLToPath(new URL('../..', import.meta.url));
  const spec = replayServers(null, worktree)[server];
  const host = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  const env = { ...host, ...spec.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'lane-claude-')),
    DISABLE_AUTOUPDATER: '1', SLEIGHT_HAND: '0', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: dir };
  const engine = resolveServer(env);
  const summary = { launcherNode: process.execPath, nodeVersion: process.version, worktree,
    engine: { command: engine.command, runtimeExists: existsSync(engine.command ?? ''), args: engine.args,
      configPath: engine.configPath, error: engine.error }, initialized: false, listed: false };
  const child = spawn(spec.command, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    record({ event: 'engine-close', server, code, signal });
    Object.assign(summary, { code, signal, collected: true }); resolve();
  }));
  const send = msg => {
    record({ server, direction: 'submitted', msg });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  };
  const input = createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => record({ event: 'stderr', server, text: chunk.toString() }));
  child.once('error', error => { summary.spawnError = error.message; });
  child.stdin.on('error', error => { summary.stdinError = error.message; });
  input.on('line', line => {
    try {
      const msg = JSON.parse(line);
      record({ server, direction: 'received', msg });
      if (msg.id === 0 && msg.result) {
        summary.initialized = true;
        send({ method: 'notifications/initialized' });
        send({ id: 1, method: 'tools/list', params: {} });
      } else if (msg.id === 1 && msg.result) {
        summary.listed = true;
        summary.tools = msg.result.tools?.map(tool => tool.name);
        child.stdin.end();
      } else if (msg.id !== undefined && msg.method) {
        summary.unexpectedRequest = msg.method;
        child.stdin.end();
      }
    } catch (error) { summary.protocolError = error.message; child.stdin.end(); }
  });
  const stop = () => { child.stdin.end(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  const timer = setTimeout(() => { summary.timedOut = true; child.stdin.end(); }, 15000);
  const gentle = setTimeout(() => child.kill('SIGTERM'), 20000);
  const force = setTimeout(() => child.kill('SIGKILL'), 28000);
  try {
    send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'sr2e-offline-startup', version: '1' } } });
    await closed;
  } finally {
    clearTimeout(timer); clearTimeout(gentle); clearTimeout(force); input.close();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
    writeFileSync(join(dir, 'startup.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  }
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') throw Error('Expected --out NEW_DIRECTORY');
  const summary = await startupProbe(resolve(process.argv[3]));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.initialized || !summary.listed || summary.code !== 0) process.exitCode = 1;
}
