import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInstalledConfig, acceptedInstalledPackage } from './installed-config.mjs';
import { browserTools, validateToolCall } from './tools.mjs';

const bridges = new WeakSet(), frontends = new WeakSet();
export const isV3Bridge = value => !!value && bridges.has(value);
export const isV3Frontend = value => !!value && frontends.has(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unproved = () => ({ revoked: true, cleanup: [{ resource: 'v3-worker', status: 'retained', code: 'CLEANUP_UNPROVED' }] });
const failure = (unknown = false) => ({ text: unknown ? 'Input outcome is unconfirmed. Read state before retrying; use the engine browser path if needed.'
  : 'Turbo is unavailable for this turn. Use the engine browser path.', isError: !unknown });

export async function createV3Bridge({ startupTimeoutMs = 120000, timeoutMs = 31000 } = {}, dependencies = {}) {
  const config = (dependencies.readConfig ?? readInstalledConfig)();
  if (!config) return null;
  const accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config);
  if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH');
  if (![startupTimeoutMs, timeoutMs].every(n => Number.isInteger(n) && n > 0 && n <= 300000)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:NODE_|DYLD_|LD_)/.test(key)) delete env[key];
  const child = (dependencies.forkWorker ?? fork)(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [],
    { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
  let hello, active = false, lost = false, generation = 0, sequence = 0, ending;
  const pending = new Map(), turns = new Set(); let deliveries = new WeakMap(), resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => lose(), startupTimeoutMs);
  const current = () => { try { return accepted.current() === true; } catch { return false; } };
  function fence() { active = false; generation++; deliveries = new WeakMap(); }
  function lose(code = 'V3_WORKER_UNAVAILABLE') {
    if (lost) return;
    lost = true; fence(); clearTimeout(timer); rejectReady(Error(typeof code === 'string' ? code : 'V3_WORKER_UNAVAILABLE'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('V3_WORKER_UNAVAILABLE')); }
    pending.clear();
    try { if (child.connected) child.disconnect(); child.unref?.(); } catch {}
  }
  child.on('message', frame => {
    if (lost) return;
    if (!hello && frame?.version === 3 && frame.status === 'unavailable') { lose('V3_RUNTIME_UNAVAILABLE'); return; }
    if (!hello && exact(frame, ['version', 'session', 'nonce', 'browser']) && frame.version === 3 && id(frame.session) &&
        /^[a-f0-9]{64}$/.test(frame.nonce) && /^b[A-Za-z0-9_-]{1,63}$/.test(frame.browser)) {
      hello = frame; clearTimeout(timer); resolveReady(); return;
    }
    if (!hello || !exact(frame, ['version', 'id', 'result']) || frame.version !== 3 || !pending.has(frame.id)) { lose(); return; }
    const entry = pending.get(frame.id); pending.delete(frame.id); clearTimeout(entry.timer); entry.resolve(frame.result);
  });
  child.on('error', lose); child.on('exit', lose); child.on('disconnect', lose);
  function rpc(method, params) {
    if (lost || !current() || pending.size >= 32) return Promise.reject(Error('V3_WORKER_UNAVAILABLE'));
    const frame = { version: 3, id: 'q' + (++sequence), method, params };
    if (Buffer.byteLength(JSON.stringify(frame)) > 131072) return Promise.reject(Error('INVALID_ARGUMENT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { lose(); reject(Error('V3_WORKER_UNAVAILABLE')); }, timeoutMs);
      pending.set(frame.id, { resolve, reject, timer });
      try { child.send(frame, error => { if (error) lose(); }); } catch { lose(); }
    });
  }
  await ready;
  if (!current()) { lose(); throw Error('HOST_PACKAGE_MISMATCH'); }
  function endTurn() {
    fence();
    if (!ending) ending = rpc('end', {}).catch(unproved).finally(() => { ending = undefined; });
    return ending;
  }
  const bridge = Object.freeze({ browser: hello.browser,
    bootstrapEnvelope: () => ({ version: 1, session: hello.session, nonce: hello.nonce }),
    tools: () => browserTools(hello.browser),
    async bind(frame) {
      if (!exact(frame, ['version', 'session', 'nonce', 'event', 'turn', 'text']) || frame.version !== 1 ||
          frame.session !== hello.session || frame.nonce !== hello.nonce || frame.event !== 'begin' || !id(frame.turn) ||
          typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536 || turns.has(frame.turn) || lost || !current()) throw Error('TRUSTED_TURN_REQUIRED');
      turns.add(frame.turn); fence(); const epoch = generation;
      const result = await rpc('begin', { turn: frame.turn, text: frame.text });
      if (epoch !== generation || lost || !current()) return false;
      active = result?.available === true; return active;
    },
    async call(input) {
      let request;
      try { request = validateToolCall(input, hello.browser); } catch { return { text: 'Invalid turbo arguments. Use the documented five tool schemas.', isError: true }; }
      if (!active || lost || !current()) return failure();
      const epoch = generation;
      try {
        const reply = await rpc('call', request);
        if (!active || lost || epoch !== generation || !current()) return failure(request.name !== 'browser_read');
        if (!exact(reply, ['resultId', 'result']) || !id(reply.resultId) || !exact(reply.result, ['text', 'isError']) ||
            typeof reply.result.text !== 'string' || typeof reply.result.isError !== 'boolean' || reply.result.text.length > 100000) throw Error();
        const result = reply.result;
        if (!result.isError) deliveries.set(result, { id: reply.resultId, hash: hash(result), epoch });
        return result;
      } catch { lose(); return failure(request.name !== 'browser_read'); }
    },
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || !active || lost || !current() || record.epoch !== generation || record.hash !== hash(result)) return false;
      rpc('delivered', { resultId: record.id, hash: record.hash }).catch(() => {}); return true;
    },
    end: endTurn, endTurn,
    async detach() { const receipt = await endTurn(); lose(); return receipt; },
    async close() { fence(); try { return await rpc('close', {}); } catch { return unproved(); } finally { lose(); } },
  });
  bridges.add(bridge); return bridge;
}
export function createV3Frontend(bridge) {
  if (!isV3Bridge(bridge)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const frontend = Object.freeze({ browser: bridge.browser, tools: bridge.tools, call: bridge.call, delivered: bridge.delivered, end: bridge.endTurn });
  frontends.add(frontend); return frontend;
}

// Only an inherited fork channel reaches this entry. MCP calls carry tool JSON,
// while begin frames carry the relay hook's authenticated user message separately.
export function serveV3Worker({ channel, browser, begin, current = () => true, close = async () => ({ revoked: true, cleanup: [] }) }) {
  const session = 'v3' + randomBytes(16).toString('hex'), nonce = randomBytes(32).toString('hex');
  let runtime, generation = 0, work = Promise.resolve(), queued = 0, ended = false;
  const seen = new Set(), turns = new Set(), results = new Map();
  const send = frame => { if (channel.connected !== false) channel.send(frame); };
  function fence() { generation++; results.clear(); const old = runtime; runtime = undefined; return old?.end() ?? Promise.resolve({ revoked: true, cleanup: [] }); }
  channel.on('disconnect', () => { ended = true; Promise.resolve(fence()).catch(() => {}); });
  channel.on('message', frame => {
    if (ended) return;
    if (!exact(frame, ['version', 'id', 'method', 'params']) || frame.version !== 3 || !id(frame.id) || seen.has(frame.id) ||
        seen.size >= 65536 || Buffer.byteLength(JSON.stringify(frame)) > 131072) { ended = true; Promise.resolve(fence()).catch(() => {}); return; }
    seen.add(frame.id);
    const respond = result => send({ version: 3, id: frame.id, result });
    if (frame.method === 'end' || frame.method === 'close') {
      if (!exact(frame.params, [])) return respond(unproved());
      const stopped = fence();
      Promise.resolve(stopped).then(async receipt => { if (frame.method === 'close') { ended = true; return close(); } return receipt; }).then(respond, () => respond(unproved()));
      return;
    }
    if (frame.method === 'begin') {
      if (!exact(frame.params, ['turn', 'text']) || !id(frame.params.turn) || turns.has(frame.params.turn) ||
          typeof frame.params.text !== 'string' || Buffer.byteLength(frame.params.text) > 65536) return respond({ available: false });
      turns.add(frame.params.turn); const stopped = fence(), epoch = generation;
      work = work.catch(() => {}).then(async () => {
        await stopped;
        if (ended || epoch !== generation || !current()) return { available: false };
        const prepared = await begin(Object.freeze({ source: 'user', session, turn: frame.params.turn, id: frame.params.turn, text: frame.params.text }));
        if (ended || epoch !== generation || !current()) { await prepared?.end(); return { available: false }; }
        runtime = prepared; return { available: !!runtime };
      });
      work.then(respond, () => respond({ available: false })); return;
    }
    if (!['call', 'delivered'].includes(frame.method) || queued >= 32) return respond({ resultId: frame.id, result: failure() });
    const epoch = generation; queued++;
    const operation = work.catch(() => {}).then(async () => {
      if (!runtime || ended || epoch !== generation || !current()) return { resultId: frame.id, result: failure() };
      if (frame.method === 'delivered') {
        if (!exact(frame.params, ['resultId', 'hash'])) return false;
        const record = results.get(frame.params.resultId); results.delete(frame.params.resultId);
        return !!record && record.runtime === runtime && record.hash === frame.params.hash && record.hash === hash(record.result) && runtime.delivered(record.result) === true;
      }
      const request = validateToolCall(frame.params, browser), owner = runtime;
      const result = await owner.call(request);
      if (epoch !== generation || ended || runtime !== owner) return { resultId: frame.id, result: failure(request.name !== 'browser_read') };
      if (results.size >= 128) results.delete(results.keys().next().value);
      results.set(frame.id, { runtime: owner, result, hash: hash(result) });
      return { resultId: frame.id, result };
    });
    work = operation.catch(() => {});
    operation.then(respond, () => respond({ resultId: frame.id, result: failure() })).finally(() => { queued--; });
  });
  return Object.freeze({ ready: () => send({ version: 3, session, nonce, browser }) });
}

async function installedMain() {
  const config = readInstalledConfig();
  if (!config) throw Error('SETTING_OFF');
  const accepted = acceptedInstalledPackage(config);
  if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH');
  // The action/rule interfaces do not yet supply the document-bound payment
  // terms and private upload binding required by the existing host providers.
  // Keep the installed route on v2 until that join is reviewed. Never replace
  // those providers with an always-allow stub or infer permission from tool JSON.
  throw Error('V3_PRIVATE_PROVIDERS_UNAVAILABLE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.send) {
  installedMain().catch(() => { if (process.connected) { process.send({ version: 3, status: 'unavailable' }); process.disconnect(); } });
}
