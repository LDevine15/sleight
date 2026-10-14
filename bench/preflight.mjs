// Read-only benchmark admission. These checks never load an MCP server or call a model.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { LEDGER_FILE } from './api-auth.mjs';

export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const commandLine = parts => parts.map(quote).join(' ');
function canonical(path) {
  let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  return resolve(realpathSync(parent), relative(parent, resolve(path)));
}

export function assertLogin({ command, env, cwd }, { run = execFileSync, home = homedir() } = {}) {
  const config = env?.CLAUDE_CONFIG_DIR;
  if (!config || !isAbsolute(config) || canonical(config) === canonical(join(home, '.claude'))) {
    throw new Error('Login preflight requires an isolated CLAUDE_CONFIG_DIR; refusing the owner config');
  }
  // auth status prints account metadata. Capture and discard it, including stderr on failure.
  const clean = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TERM']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  Object.assign(clean, { CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' });
  let status;
  try { status = JSON.parse(run(command, ['auth', 'status', '--json'], {
    env: clean, ...(cwd && existsSync(cwd) ? { cwd } : {}), timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })); } catch { /* A failed or malformed status never admits an arm. */ }
  if (status?.loggedIn === true && status.authMethod === 'claude.ai') return;
  const assignments = ['HOME', 'PATH', 'TMPDIR'].filter(key => clean[key] !== undefined).map(key => `${key}=${clean[key]}`);
  throw new Error(`Not logged in to the arm's isolated Claude account (${config}).\nFix: env -i ${commandLine([...assignments,
    `CLAUDE_CONFIG_DIR=${config}`, command, 'auth', 'login'])}`);
}

export function assertSpend({ file = LEDGER_FILE, capUsd = 200, now = new Date() } = {}) {
  let ledger;
  try { ledger = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return 0; }
  const valid = ledger && typeof ledger.month === 'string' && /^\d{4}-\d{2}$/.test(ledger.month) &&
    Number.isFinite(ledger.usd) && ledger.usd >= 0;
  const spent = valid && ledger.month === now.toISOString().slice(0, 7) ? ledger.usd : 0;
  if (!valid || ledger.unpriced || spent >= capUsd) {
    const reason = ledger?.unpriced ? 'an unpriced benchmark round needs reconciliation' : !valid
      ? 'the benchmark API spend ledger is unreadable or malformed' : `benchmark API spend is $${spent.toFixed(2)}, at the $${capUsd} admission cap`;
    // The owner must reconcile the retained raw tokens or wait for the next month. Never clear a marker automatically.
    throw new Error(`${reason}. Review the ledger against the raw round tokens before editing it.\nFix: ${commandLine(['nano', file])}`);
  }
  return spent;
}

export async function probeSocket(path, { token, connect = netConnect, timeoutMs = 5000 } = {}) {
  const socket = connect(path);
  let timer;
  try {
    await new Promise((done, fail) => {
      let buffer = Buffer.alloc(0);
      timer = setTimeout(() => fail(new Error('extension socket timed out')), timeoutMs);
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('extension socket closed before a reply')));
      const send = value => {
        const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
        header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
      };
      socket.once('connect', () => {
        if (token === undefined) return done(); // Engine transport only; its protocol and identity stay with the engine.
        send({ method: 'host.auth', params: { token } });
        send({ id: 1, method: 'tabs.listAll', params: {} });
      });
      socket.on('data', chunk => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > 8 * 1024 * 1024) throw new Error('extension response exceeds preflight limit');
          while (buffer.length >= 4) {
            const size = buffer.readUInt32LE(0);
            if (size > 8 * 1024 * 1024) throw new Error('extension frame exceeds preflight limit');
            if (buffer.length < 4 + size) break;
            const reply = JSON.parse(buffer.subarray(4, 4 + size)); buffer = buffer.subarray(4 + size);
            if (reply.id === 1) {
              if (reply.error || !Array.isArray(reply.result)) throw new Error('extension read failed');
              done();
            }
          }
        } catch (error) { fail(error); }
      });
    });
  } finally { clearTimeout(timer); socket.destroy(); }
}

export async function assertFowlSocket(browser, { home = homedir(), probe = probeSocket } = {}) {
  const dir = join(home, '.fowlbrowser');
  try {
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    if (!token) throw new Error('missing host token');
    await probe(join(dir, `${browser}.sock`), { token });
  } catch {
    const app = browser === 'helium' ? 'Helium' : 'Google Chrome';
    throw new Error(`FowlBrowser extension is unavailable in ${browser}. Reload its extension in this browser (owner action).\nFix: ${commandLine(['open', '-a', app, 'chrome://extensions/'])}`);
  }
}

export async function assertEngineSockets({ dir = '/tmp/codex-browser-use', probe = probeSocket, list = readdirSync } = {}) {
  let names;
  try { names = list(dir).filter(name => /^[a-zA-Z0-9-]+\.sock$/.test(name)); } catch { names = []; }
  const results = await Promise.allSettled(names.map(name => probe(join(dir, name))));
  if (results.some(result => result.status === 'fulfilled')) return;
  throw new Error('No reachable engine browser extension socket. Reload the extension in the selected benchmark browser (owner action).\n' +
    `Fix: ${commandLine(['open', 'chrome://extensions/'])}`);
}
