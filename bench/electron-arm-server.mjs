#!/usr/bin/env node
// The Claude Code arm's MCP server for the live runner (electron-live-runner.mjs, phase arm). It serves the five production
// turbo tools (tools.mjs schemas and validation, through bench/turbo/v3-protocol.mjs) and runs each call in one forked
// electron-qualification-worker.mjs: the installed worker's app path (connectAppHost, selectAppConnection, createAppTurn,
// createAppTurnRuntime) over the run's benchmark instance on its temporary profile. It stands in for the relay and bridge
// only, because the installed relay reads the owner's opt-in file and opens the owner's own VS Code profile.
// SLEIGHT_EQ_ARM_CONFIG names a 0600 file in the run's state folder with the registry, folders, session and host secret.
// The model has no shell or file tools in this arm, so it never reads that file.
import { fork } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createProtocol } from './turbo/v3-protocol.mjs';

const WORKER = fileURLToPath(new URL('./electron-qualification-worker.mjs', import.meta.url));
const KEYS = ['allowlist', 'appSecret', 'bundleId', 'cardLog', 'name', 'python', 'qualificationDiagnosticPath', 'registryPath', 'session', 'stateDir', 'tempRoot', 'workspace'];

export function readArmConfig(path, { stat = lstatSync, read = readFileSync, uid = process.getuid() } = {}) {
  const s = stat(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== uid) throw Error('ARM_CONFIG_UNSAFE');
  const config = JSON.parse(read(path, 'utf8'));
  if (!config || Object.keys(config).some(key => !KEYS.includes(key)) || !['bundleId', 'session', 'registryPath', 'stateDir', 'tempRoot', 'appSecret']
    .every(key => typeof config[key] === 'string' && config[key])) throw Error('ARM_CONFIG_INVALID');
  return config;
}

export function forkWorker({ forkProcess = fork, env = process.env } = {}) {
  const child = forkProcess(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    env: { ...env, SLEIGHT_TURBO_UNQUALIFIED: '1' } });
  const pending = new Map();
  let sequence = 0, lost;
  child.on('message', msg => { const entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); entry(msg); } });
  child.on('exit', () => { lost = true; for (const entry of pending.values()) entry({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); pending.clear(); });
  return {
    send: (op, extra = {}) => new Promise(done => {
      if (lost) return done({ ok: false, error: 'V3_WORKER_UNAVAILABLE' });
      const id = ++sequence; pending.set(id, done);
      try { child.send({ id, op, ...extra }); } catch { pending.delete(id); done({ ok: false, error: 'V3_WORKER_UNAVAILABLE' }); }
    }),
    kill: () => { if (!lost) child.kill('SIGKILL'); },
  };
}

/** One arm session: the first call starts the worker's turn (the debugger card, the launch), later calls reuse it. */
export async function createArmSession({ config, text, worker = forkWorker() }) {
  const reply = await worker.send('start', { ...config, text });
  if (!reply.ok) {
    worker.kill();
    throw Object.assign(Error(/[A-Z][A-Z_]{5,}/.exec(String(reply.error))?.[0] ?? 'ARM_START_FAILED'), { stage: reply.stage ?? 'app-start' });
  }
  return {
    identity: reply.identity,
    async call(request) {
      const r = await worker.send('call', { request });
      return r.ok ? { text: String(r.result?.text ?? ''), isError: r.result?.isError === true } : { text: 'Turbo is unavailable for this turn.', isError: true };
    },
    delivered() {}, // the worker marks every delivered result itself
    async close() { await worker.send('end'); worker.kill(); return { revoked: true, cleanup: [] }; },
  };
}

async function main() {
  const config = readArmConfig(process.env.SLEIGHT_EQ_ARM_CONFIG ?? '');
  const protocol = createProtocol({ start: () => createArmSession({ config, text: process.env.SLEIGHT_EQ_ARM_TASK ?? 'Electron arm task.' }),
    onStartupFailure: row => appendFileSync(join(config.stateDir, 'startup.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 }) });
  const lines = createInterface({ input: process.stdin });
  let stopping;
  const stop = () => stopping ??= protocol.close().catch(() => {}).finally(() => { lines.close(); process.stdin.destroy(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  lines.on('line', line => {
    try { void protocol.message(JSON.parse(line)).catch(() => stop()); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
  });
  lines.once('close', stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
