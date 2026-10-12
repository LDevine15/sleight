import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const limit = 1024 * 1024;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const owned = stat => (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
const handshakeEnv = new Set(['NODE_REPL_NODE_PATH', 'NODE_REPL_NODE_MODULE_DIRS', 'NODE_REPL_TRUSTED_CODE_PATHS',
  'NODE_REPL_TRUSTED_SERVICES', 'NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE', 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS',
  'NODE_REPL_VERSION', 'SKY_CUA_SERVICE_PATH', 'SKY_CUA_SERVICE_VERSION', 'BROWSER_USE_AVAILABLE_BACKENDS']);
const valid = entry => entry?.schema === 1 && typeof entry.initialize?.protocolVersion === 'string' &&
  typeof entry.initialize?.serverInfo?.name === 'string' && typeof entry.initialize?.serverInfo?.version === 'string' &&
  entry.initialize.capabilities && typeof entry.initialize.capabilities === 'object' && !Array.isArray(entry.initialize.capabilities) &&
  Array.isArray(entry.tools?.tools) && !entry.tools.nextCursor &&
  entry.tools.tools.every(tool => typeof tool?.name === 'string' && tool.inputSchema?.type === 'object');

// Include development builds that share a version, inherited engine settings, and the
// engine launch path. Only the resulting digest is written, never environment values.
export function startupIdentity(server, pluginRoot, env = process.env) {
  if (!server.version) return;
  try {
    const lib = join(pluginRoot, 'lib');
    const build = createHash('sha256');
    for (const file of readdirSync(lib).filter(file => file.endsWith('.mjs')).sort()) build.update(file + '\0').update(readFileSync(join(lib, file))).update('\0');
    return { engine: [server.version, server.command, server.args],
      sleight: [JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).version, build.digest('hex')],
      runtime: [process.platform, process.arch, process.version], env: {
        ...Object.fromEntries(Object.entries(env).filter(([name]) => (name.startsWith('CUA_') || handshakeEnv.has(name)) &&
          !/(?:SESSION|THREAD|TURN|REQUEST)_ID$|(?:TOKEN|SOCKET|PIPE_PATH|VERIFYING_IDENTITY)$/.test(name))),
        ...server.env,
      } };
  } catch { return; } // Cache setup must not fail an otherwise usable engine.
}

export function createStartupCache({ identity, directory = join(homedir(), 'Library/Caches/sleight/handshakes') } = {}) {
  if (!identity) return;
  function safeDirectory() {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || !owned(stat)) throw new Error('unsafe handshake cache directory');
  }
  function read(file) {
    safeDirectory();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat) || stat.size > limit) return;
      const buffer = Buffer.alloc(limit + 1);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      if (size > limit) return;
      const entry = JSON.parse(buffer.toString('utf8', 0, size));
      if (valid(entry)) return entry;
    } finally { closeSync(fd); }
  }
  function write(file, entry) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const data = JSON.stringify(entry);
      if (!valid(entry) || Buffer.byteLength(data) > limit) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 }); safeDirectory();
      writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
      const files = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
        try {
          const stat = lstatSync(join(directory, name));
          return stat.isFile() && owned(stat) ? [{ name, time: stat.mtimeMs }] : [];
        } catch { return []; }
      }).sort((a, b) => (b.name === basename(file)) - (a.name === basename(file)) ||
        b.time - a.time || a.name.localeCompare(b.name));
      for (const old of files.slice(8)) rmSync(join(directory, old.name), { force: true });
    } catch { /* An unavailable cache keeps the existing handshake path. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Unwritable cache. */ } }
  }
  return {
    bind({ context, send, forward }) {
      let file, cached, initializeId, initialized = false, notified = false, started = false, failed = false, cancelled = false;
      let initializeResult, initializedTimer;
      let firstList = true, failureMessage;
      const lists = new Map(), queue = [];
      const fail = (message, invalidate = true) => {
        failed = true;
        clearTimeout(initializedTimer);
        failureMessage = message;
        try { if (invalidate && file) rmSync(file, { force: true }); } catch { /* Unwritable cache. */ }
        for (const msg of queue.splice(0)) if (msg.id !== undefined && !lists.get(msg.id)?.cached) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message } });
        }
      };
      function flush() {
        if (!initialized || failed) return;
        // Send the initialized notification and list before admitting tool calls.
        for (let index = 0; index < queue.length;) {
          const msg = queue[index];
          if (msg.method === 'tools/call' || (msg.method === 'notifications/cancelled' &&
            queue.some(call => call.method === 'tools/call' && call.id === msg.params?.requestId))) { index++; continue; }
          if (msg.method === 'notifications/initialized') { notified = true; clearTimeout(initializedTimer); }
          queue.splice(index, 1); forward(msg);
        }
        if (notified && ![...lists.values()].some(list => list.cached)) {
          for (const msg of queue.splice(0)) forward(msg);
        }
      }
      return {
        initialize(msg) {
          if (started || msg.id === undefined) return;
          started = true; initializeId = msg.id;
          const key = createHash('sha256').update(canonical([identity, context, msg.params])).digest('hex');
          file = join(directory, key + '.json');
          try { cached = read(file); } catch { /* Cold or invalid cache. */ }
          if (cached) send({ jsonrpc: '2.0', id: msg.id, result: structuredClone(cached.initialize) });
        },
        request(msg) {
          if (!started || cancelled || !['tools/list', 'tools/call', 'notifications/initialized', 'ping', 'notifications/cancelled'].includes(msg.method)) return false;
          if (failed) {
            if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603,
              message: failureMessage } });
            return true;
          }
          if (msg.method === 'notifications/initialized' && notified) return true;
          if (msg.method === 'tools/list' && msg.id !== undefined) {
            const cacheable = firstList && Object.keys(msg.params ?? {}).length === 0;
            firstList = false;
            lists.set(msg.id, { cacheable, cached: cacheable && !!cached });
            if (cacheable && cached) send({ jsonrpc: '2.0', id: msg.id, result: structuredClone(cached.tools) });
          }
          queue.push(msg); flush(); return true;
        },
        reply(msg) {
          if (msg.method !== undefined || !started) return false;
          if (failed) return (msg.id === initializeId && !!cached) || !!lists.get(msg.id)?.cached;
          if (initializeId !== undefined && msg.id === initializeId) {
            initializeId = undefined;
            if (msg.error || !msg.result || (cached && canonical(msg.result) !== canonical(cached.initialize))) {
              fail(msg.error?.message ?? 'Engine handshake changed or failed; reconnect sleight.'); return !!cached;
            }
            initializeResult = structuredClone(msg.result); initialized = true; flush();
            if (!notified) {
              initializedTimer = setTimeout(() => {
                notified = true;
                forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
                flush();
              }, 2000);
              initializedTimer.unref?.();
            }
            return !!cached;
          }
          const list = lists.get(msg.id);
          if (!list) return false;
          lists.delete(msg.id);
          if (list.cached && (msg.error || canonical(msg.result) !== canonical(cached.tools))) {
            fail(msg.error?.message ?? 'Engine tools changed; reconnect sleight.'); return true;
          }
          if (list.cacheable && !msg.error && initializeResult) write(file, {
            schema: 1, initialize: initializeResult, tools: msg.result,
          });
          flush(); return list.cached;
        },
        cancel() {
          cancelled = true;
          for (let index = 0; index < queue.length;) {
            if (queue[index].method === 'notifications/initialized') forward(queue.splice(index, 1)[0]);
            else index++;
          }
          fail('Startup was stopped before the call ran; reconnect sleight.', false);
        },
        close() { fail('Engine connection closed before startup completed; reconnect sleight.', false); },
      };
    },
  };
}
