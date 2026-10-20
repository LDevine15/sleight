// Grok Bot's local shell reaches one relay over a private, same-user Unix socket.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFile } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { userInfo, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { environment } from './direct-browser/host.mjs';

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
  if (request?.op === 'status' && Object.keys(request).length === 1) return request;
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
      join(LIB, 'socket-peer.c'), '-o', binary], { timeout: 60000, env: environment() });
  } catch (err) { rmSync(directory, { recursive: true, force: true }); throw err; }
  return {
    uid: socket => new Promise((resolve, reject) => {
      const child = spawn(binary, [], { env: {}, stdio: ['ignore', 'pipe', 'ignore', socket._handle.fd] });
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
  timeoutMs = 300000, termMs = 10000, killMs = 5000, env = process.env, signal } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  const pending = new Map();
  let next = 0, closing, ended = false;
  const fail = error => {
    // A broken protocol or pipe cannot prove that the engine stopped input. Close before releasing callers.
    if (!ended) void close();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
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
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const result = new Promise((resolve, reject) => {
      if (ended || closing) { complete(); return reject(new Error('Shell relay is closed')); }
      const id = next++;
      // A timeout ends the caller's wait, but only an engine reply or exit ends its input ownership.
      const timer = setTimeout(() => { reject(new Error('Shell relay call timed out; engine still busy until it replies; read state before retrying input')); }, timeoutMs);
      pending.set(id, { resolve: value => { clearTimeout(timer); complete(); resolve(value); },
        reject: err => { clearTimeout(timer); complete(); reject(err); } });
      try { send({ id, method, params }); } catch (err) { pending.get(id).reject(err); pending.delete(id); }
    });
    return Object.assign(result, { completed });
  }
  const close = () => closing ||= (async () => {
    // EOF enters launch.mjs's shutdown path, which collects the engine before this child exits.
    child.stdin.end();
    const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, termMs);
    const force = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, termMs + killMs);
    try { return await closed; } finally { clearTimeout(timer); clearTimeout(force); lines.close(); signal?.removeEventListener('abort', abort); }
  })();
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Grok Bot', version: '1' } });
    send({ method: 'notifications/initialized' });
    return { call: (name, args) => request('tools/call', { name, arguments: args }), close, closed };
  } catch (err) { await close(); throw err; }
}

// Serialize startup, including stale socket recovery, without holding a lock during calls.
export async function startSocketSession(options = {}) {
  const directory = options.directory ?? socketDirectory();
  checkDirectory(directory, true);
  const lock = join(directory, 'starting');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (err) { if (err.code === 'EEXIST') throw new Error('Shell session is starting; inspect its startup lock if it does not finish'); throw err; }
  try { return await startSocketSessionLocked({ ...options, directory }); }
  finally { rmSync(lock, { recursive: true }); }
}

async function startSocketSessionLocked({ directory = socketDirectory(), startRelay = createShellRelay,
  peerUid, idleMs = 600000, requestTimeoutMs = 10000, signals = process } = {}) {
  checkDirectory(directory, true);
  const socketPath = join(directory, basename(SOCKET_FILE));
  // Darwin's sockaddr_un.sun_path has 104 bytes including the terminating NUL.
  if (Buffer.byteLength(socketPath) >= 104) throw new Error('Shell socket path must fit in 103 UTF-8 bytes (macOS sun_path is 104 bytes); use a shorter home/cache path');
  try {
    const before = owned(socketPath, 'socket', 0o600);
    try {
      await callSocket({ op: 'status' }, { directory, timeoutMs: 2000 });
      throw new Error('Shell socket path is occupied by a live session');
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
      const after = owned(socketPath, 'socket', 0o600);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Shell socket changed during startup');
      unlinkSync(socketPath);
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  // A previous session may have crashed. Prune only its private image folders under this cache.
  for (const name of readdirSync(directory).filter(name => /^images-[A-Za-z0-9]+$/.test(name))) {
    const path = join(directory, name);
    owned(path, 'directory', 0o700);
    rmSync(path, { recursive: true });
  }
  const images = mkdtempSync(join(directory, 'images-'));
  const sessionId = randomUUID();
  const peers = new Set();
  const startupAbort = new AbortController();
  let relay, peer, timer, closing, socketStat, busy = false;
  let finish, finishStartup;
  const closed = new Promise(resolve => { finish = resolve; });
  const startupReady = new Promise(resolve => { finishStartup = resolve; });
  const server = createServer({ pauseOnConnect: true }, socket => {
    if (closing || peers.size >= 8) { socket.destroy(); return; }
    socket.setEncoding('utf8');
    peers.add(socket);
    socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), requestTimeoutMs);
    socket.once('close', () => { clearTimeout(deadline); peers.delete(socket); });
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
          clearTimeout(deadline);
          void (async () => {
            try {
              if (input.slice(newline + 1).trim()) throw new Error('One shell request per connection');
              const request = validate(JSON.parse(input.slice(0, newline)));
              if (request.op === 'status') {
                socket.end(JSON.stringify({ result: { ready: !!relay && !closing, sessionId } }) + '\n');
                return;
              }
              const { tool, args } = request;
              if (!relay || busy || closing) throw new Error('Shell session is starting, busy or closing; read state before retrying input');
              busy = true; clearTimeout(timer); socket.setTimeout(0);
              try {
                const call = relay.call(tool, args);
                try {
                  const result = await call;
                  const content = [];
                  for (const block of result?.content ?? []) {
                    if (block.type !== 'image') content.push(block);
                    else await printSocketResult({ content: [block] }, { directory: images,
                      out: text => content.push({ type: 'text', text: text.trimEnd() }) });
                  }
                  socket.end(JSON.stringify({ result: { ...result, content } }) + '\n');
                } catch (err) { socket.end(JSON.stringify({ error: err.message }) + '\n'); }
                finally { await call.completed; }
              }
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
      startupAbort.abort();
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
        try { rmSync(images, { recursive: true, force: true }); } catch (err) { error ||= err; }
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.removeListener(signal, onSignal);
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
    socketStat = lstatSync(socketPath);
    chmodSync(socketPath, 0o600); owned(socketPath, 'socket', 0o600);
    if (closing) throw new Error('Shell session stopped during startup');
    relay = await startRelay({ signal: startupAbort.signal });
    if (closing) throw new Error('Shell session stopped during startup');
    relay.closed?.then(() => { void close(); });
    finishStartup();
    armIdle();
    return { socketPath, close, closed };
  } catch (err) { finishStartup(); await close(); throw err; }
}

export async function callSocket(request, { directory = socketDirectory(), timeoutMs = 310000 } = {}) {
  validate(request);
  const path = join(directory, basename(SOCKET_FILE));
  try { checkDirectory(directory); owned(path, 'socket', 0o600); }
  catch (err) {
    if (err.code === 'ENOENT') err.message = 'No shell session is listening; run sleight-mcp session (sleight-mcp js also starts one on demand)';
    throw err;
  }
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

export async function printSocketResult(result, { out = text => process.stdout.write(text), directory } = {}) {
  for (const block of result?.content ?? []) {
    if (block.type === 'image') {
      if (!directory) {
        const cache = socketDirectory();
        checkDirectory(cache, true);
        directory = mkdtempSync(join(cache, 'images-'));
      }
      owned(directory, 'directory', 0o700);
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[block.mimeType] ?? 'bin';
      const path = join(directory, `${randomUUID()}.${extension}`);
      writeFileSync(path, Buffer.from(block.data, 'base64'), { mode: 0o600, flag: 'wx' });
      out(path + '\n');
    } else if (block.type === 'text') out(block.text + '\n');
    else out(JSON.stringify(block) + '\n');
  }
  return result?.isError ? 1 : 0;
}

export async function socketCommand([command, ...args], options = {}) {
  const { out = text => process.stdout.write(text) } = options;
  if (command === 'session' && args.length === 1 && args[0] === '--install-agent') {
    out(launchAgentInstructions(options));
    return 0;
  }
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
  else throw new Error("usage: sleight-mcp session [--install-agent] | js '<code>' | js_reset | open_file|select_window|drag '<JSON arguments>'");
  await ensureSocketSession(options);
  return printSocketResult(await callSocket({ tool: command, args: toolArgs }, options), { out });
}

// Child becomes a process-group leader. Its session owns idle shutdown and relay collection.
export async function spawnDetachedSession({ command = process.execPath,
  args = [join(LIB, 'launch.mjs'), 'session'], spawnChild = spawn } = {}) {
  const child = spawnChild(command, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

function rememberSession(directory, sessionId, notice) {
  const path = join(directory, 'last-session');
  let previous, fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 128) {
      throw new Error('Shell session marker must be a private owned file');
    }
    previous = readFileSync(fd, 'utf8');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  finally { if (fd !== undefined) closeSync(fd); }
  if (previous === sessionId) return;
  const staging = mkdtempSync(join(directory, 'marker-'));
  try {
    writeFileSync(join(staging, 'id'), sessionId, { flag: 'wx', mode: 0o600 });
    renameSync(join(staging, 'id'), path);
  } finally { rmSync(staging, { recursive: true }); }
  notice(`sleight: shell session ${previous ? 'restarted' : 'started'}; JavaScript handles and session approvals are reset. Read the first call's engine docs.\n`);
}

export async function ensureSocketSession({ directory = socketDirectory(), spawnSession = spawnDetachedSession,
  notice = text => process.stderr.write(text), startupMs = 90000 } = {}) {
  checkDirectory(directory, true);
  const deadline = Date.now() + startupMs;
  let started = false;
  do {
    try {
      const status = await callSocket({ op: 'status' }, { directory, timeoutMs: Math.min(2000, Math.max(1, deadline - Date.now())) });
      if (status.ready) { rememberSession(directory, status.sessionId, notice); return; }
    } catch (err) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) throw err;
      if (!started) { started = true; await spawnSession(); }
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('Shell session did not become ready within 90 seconds; inspect sleight-mcp session before retrying input');
}

export function launchAgentInstructions({ executable = join(LIB, '../bin/sleight-mcp') } = {}) {
  const xml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  return `Owner step: save this plist yourself as ~/Library/LaunchAgents/com.sleight.shell.plist, then run the command below.
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.sleight.shell</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>session</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sleight.shell.plist"
sleight has not written or loaded this plist. The session still exits after ten idle minutes.
`;
}
