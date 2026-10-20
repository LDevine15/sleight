// Grok Bot's local shell reaches one relay over a private, same-user Unix socket.
import { spawn, execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { userInfo, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const LIB = dirname(fileURLToPath(import.meta.url));
const TOOLS = new Set(['js', 'js_reset', 'open_file', 'select_window', 'drag']);
const MAX_REQUEST = 1024 * 1024;
const MAX_REPLY = 64 * 1024 * 1024;
const SOCKET_FILE = 'Library/Caches/sleight/shell/session.sock';
export const socketDirectory = () => dirname(join(userInfo().homedir, SOCKET_FILE));

function owned(path, kind, mode) {
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (kind === 'directory' ? !stat.isDirectory() : !stat.isSocket()) ||
      (stat.mode & 0o777) !== mode) throw new Error(`Shell bridge ${kind} must be private and owned by this user: ${path}`);
  return stat;
}

function checkDirectory(directory, create = false) {
  // Check each existing ancestor before mkdir can follow it. Root-owned system ancestors are allowed.
  const uid = process.getuid();
  for (let path = dirname(directory); path !== dirname(path); path = dirname(path)) {
    let stat;
    try { stat = lstatSync(path); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022 && !(stat.mode & 0o1000))) {
      throw new Error(`Shell bridge parent must be an owned directory: ${path}`);
    }
  }
  if (create) {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  owned(directory, 'directory', 0o700);
}

function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(k => !['tool', 'args'].includes(k)) || !TOOLS.has(request.tool) ||
      !request.args || typeof request.args !== 'object' || Array.isArray(request.args) ||
      (request.tool === 'js' && typeof request.args.code !== 'string')) throw new Error('Invalid shell request or tool');
  return request;
}

// Node has no getpeereid API. This small helper receives the actual connected fd at fd 3.
export async function preparePeerCheck({ tools = async () => process.platform !== 'darwin' ||
  (await import('./direct-browser/host.mjs')).appleToolsPresent() } = {}) {
  if (!await tools()) throw new Error('Shell session needs Xcode Command Line Tools; install them before starting a session');
  const directory = mkdtempSync(join(tmpdir(), 'sleight-peer-'));
  const binary = join(directory, 'peer');
  try {
    await promisify(execFile)('/usr/bin/clang', ['-Wall', '-Werror', '-fmodules-cache-path=' + join(directory, 'modules'),
      join(LIB, 'socket-peer.c'), '-o', binary], { timeout: 60000 });
  } catch (err) { rmSync(directory, { recursive: true, force: true }); throw err; }
  return {
    uid: socket => new Promise((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'ignore', socket._handle.fd] });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.once('error', reject);
      child.once('close', code => code === 0 && /^\d+\n$/.test(output)
        ? resolve(Number(output.trim())) : reject(new Error('Unix peer credentials refused')));
    }),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// A fixed MCP client. The shell cannot send initialize, elicitation answers, metadata or turn frames.
export async function createShellRelay({ command = process.execPath, args = [join(LIB, 'launch.mjs'), '--socket-relay'],
  timeoutMs = 300000, env = process.env } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  const pending = new Map();
  let next = 0, closing, ended = false;
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; fail(new Error(`Shell relay exited (${signal ?? code})`)); resolve({ code, signal });
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.method && msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'No host forms on shell route' } });
      else if (!msg.method && pending.has(msg.id)) {
        const reply = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
      }
    } catch (err) { fail(err); }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (ended || closing) return reject(new Error('Shell relay is closed'));
      const id = next++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Shell relay call timed out; read state before retrying input')); }, timeoutMs);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
      try { send({ id, method, params }); } catch (err) { pending.get(id).reject(err); pending.delete(id); }
    });
  }
  const close = () => closing ||= (async () => {
    // EOF enters launch.mjs's shutdown path, which collects the engine before this child exits.
    child.stdin.end();
    const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 10000);
    try { return await closed; } finally { clearTimeout(timer); lines.close(); }
  })();
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Grok Bot', version: '1' } });
    send({ method: 'notifications/initialized' });
    return { call: (name, args) => request('tools/call', { name, arguments: args }), close, closed };
  } catch (err) { await close(); throw err; }
}

export async function startSocketSession({ directory = socketDirectory(), startRelay = createShellRelay,
  peerUid, idleMs = 600000, signals = process } = {}) {
  checkDirectory(directory, true);
  const socketPath = join(directory, basename(SOCKET_FILE));
  try { lstatSync(socketPath); throw new Error('Shell socket path is occupied; stop its session or inspect the stale socket before removing it'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const peers = new Set();
  let relay, peer, timer, closing, socketStat, busy = false;
  let finish, finishStartup;
  const closed = new Promise(resolve => { finish = resolve; });
  const startupReady = new Promise(resolve => { finishStartup = resolve; });
  const server = createServer({ pauseOnConnect: true }, socket => {
    socket.setEncoding('utf8');
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    void (async () => {
      try {
        if (await peerUid(socket) !== process.getuid()) throw new Error('Unix peer uid refused');
        if (closing) throw new Error('Shell session is closing');
        let input = '', handled = false;
        socket.on('data', chunk => {
          if (handled) { socket.destroy(); return; }
          input += chunk;
          if (Buffer.byteLength(input) > MAX_REQUEST) { socket.destroy(); return; }
          const newline = input.indexOf('\n');
          if (newline < 0) return;
          handled = true;
          void (async () => {
            try {
              if (input.slice(newline + 1).trim()) throw new Error('One shell request per connection');
              const { tool, args } = validate(JSON.parse(input.slice(0, newline)));
              if (!relay || busy || closing) throw new Error('Shell session is starting, busy or closing; read state before retrying input');
              busy = true; clearTimeout(timer); socket.setTimeout(0);
              try { socket.end(JSON.stringify({ result: await relay.call(tool, args) }) + '\n'); }
              finally { busy = false; armIdle(); }
            } catch (err) { socket.end(JSON.stringify({ error: err.message }) + '\n'); }
          })();
        });
        socket.resume();
      } catch { socket.end(JSON.stringify({ error: 'Unix peer credentials refused' }) + '\n'); }
    })();
  });
  function armIdle() { if (!closing) timer = setTimeout(() => { void close(); }, idleMs); }
  const onSignal = () => { void close(); };
  function close() {
    return closing ||= (async () => {
      clearTimeout(timer);
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.removeListener(signal, onSignal);
      for (const socket of peers) socket.destroy();
      let error, stopped = Promise.resolve();
      try {
        await startupReady;
        stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        for (const socket of peers) socket.destroy();
        const result = await relay?.close();
        if (result && (result.code !== 0 || result.signal)) throw new Error('Shell relay did not report a clean engine collection');
      } catch (err) { error = err; }
      finally {
        await stopped;
        if (socketStat) {
          try { const stat = lstatSync(socketPath); if (stat.dev === socketStat.dev && stat.ino === socketStat.ino) unlinkSync(socketPath); }
          catch (err) { if (err.code !== 'ENOENT') error ||= err; }
        }
        try { peer?.close(); } catch (err) { error ||= err; }
        finish({ error });
      }
      return { error };
    })();
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.on(signal, onSignal);
  try {
    if (!peerUid) { peer = await preparePeerCheck(); peerUid = peer.uid; }
    if (closing) throw new Error('Shell session stopped during startup');
    // Bind before starting a relay so two session commands never start two engines.
    // The private parent protects the socket during the brief listen-to-chmod interval.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600); socketStat = owned(socketPath, 'socket', 0o600);
    if (closing) throw new Error('Shell session stopped during startup');
    relay = await startRelay();
    if (closing) throw new Error('Shell session stopped during startup');
    relay.closed?.then(() => { void close(); });
    finishStartup();
    armIdle();
    return { socketPath, close, closed };
  } catch (err) { finishStartup(); await close(); throw err; }
}

export async function callSocket(request, { directory = socketDirectory(), timeoutMs = 310000 } = {}) {
  validate(request); checkDirectory(directory);
  const path = join(directory, basename(SOCKET_FILE));
  owned(path, 'socket', 0o600);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let input = '', settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } socket.destroy(); };
    socket.setTimeout(timeoutMs, () => fail(new Error('Shell call timed out; read state before retrying input')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REPLY) return fail(new Error('Shell reply too large; read state before retrying input'));
      if (!input.includes('\n')) return;
      try {
        const reply = JSON.parse(input);
        if (reply.error) throw new Error(reply.error);
        settled = true; resolve(reply.result); socket.end();
      } catch (err) { fail(err); }
    });
    socket.once('error', fail);
    socket.once('close', () => { if (!settled) fail(new Error('Shell session closed before replying; read state before retrying input')); });
  });
}

export async function printSocketResult(result, { out = text => process.stdout.write(text) } = {}) {
  let directory, count = 0;
  for (const block of result?.content ?? []) {
    if (block.type === 'image') {
      directory ||= mkdtempSync(join(tmpdir(), 'sleight-shell-image-'));
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[block.mimeType] ?? 'bin';
      const path = join(directory, `${++count}.${extension}`);
      writeFileSync(path, Buffer.from(block.data, 'base64'), { mode: 0o600, flag: 'wx' });
      out(path + '\n');
    } else if (block.type === 'text') out(block.text + '\n');
    else out(JSON.stringify(block) + '\n');
  }
  return result?.isError ? 1 : 0;
}

export async function socketCommand([command, ...args], { out = text => process.stdout.write(text) } = {}) {
  if (['open_file', 'select_window', 'drag'].includes(command) && args.length === 1 && args[0] === '--help') {
    const { localToolDefinitions } = await import('./launch.mjs');
    out(JSON.stringify(localToolDefinitions({}).find(tool => tool.name === command), null, 2) + '\n');
    return 0;
  }
  if (command === 'session' && !args.length) {
    const session = await startSocketSession();
    process.stderr.write(`sleight: Grok Bot shell session ready at ${session.socketPath}; idle timeout 10 minutes\n`);
    const { error } = await session.closed;
    if (error) throw error;
    return 0;
  }
  let toolArgs;
  if (command === 'js' && args.length === 1) toolArgs = { code: args[0] };
  else if (command === 'js_reset' && !args.length) toolArgs = {};
  else if (['open_file', 'select_window', 'drag'].includes(command) && args.length === 1) toolArgs = JSON.parse(args[0]);
  else throw new Error("usage: sleight-mcp session | js '<code>' | js_reset | open_file|select_window|drag '<JSON arguments>'");
  return printSocketResult(await callSocket({ tool: command, args: toolArgs }), { out });
}
