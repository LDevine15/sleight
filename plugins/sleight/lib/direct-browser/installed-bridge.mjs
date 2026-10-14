import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readInstalledConfig, acceptedInstalledPackage } from './installed-config.mjs';
import { immutableJSON } from './ipc.mjs';
import { validateCall } from './schemas.mjs';
import { compactTools } from './surface.mjs';
import { browserError, BrowserFailure } from './errors.mjs';

const bridges = new WeakSet();
export const isInstalledBridge = value => !!value && bridges.has(value);
const workerPath = fileURLToPath(new URL('./installed-worker.mjs', import.meta.url));
const limit = 131072;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const unproved = () => ({ revoked: false, cleanup: [{ resource: 'installed-worker', status: 'retained', code: 'CLEANUP_UNPROVED' }] });
const unavailableCodes = new Set(['SETTING_OFF', 'HOST_PACKAGE_MISMATCH', 'INSTALLED_CONFIG_UNSAFE', 'NATIVE_HELPERS_UNAVAILABLE',
  'HOST_BUILD_BUSY', 'HOST_CACHE_UNSAFE', 'HOST_SOURCE_MISMATCH', 'SELECTED_PATH_UNSAFE', 'SELECTED_PROCESS_UNPROVED',
  'SELECTED_ENDPOINT_UNPROVED', 'SELECTED_LISTENER_UNPROVED', 'DISTRIBUTION_ACCEPTANCE_REQUIRED', 'INSTALLED_WORKER_UNAVAILABLE']);
const failure = (code, request, unknown = false, completed = 0) => ({ error: browserError(new BrowserFailure(code,
  { phase: 'policy', effect: unknown && request?.name !== 'browser_read' ? 'unknown' : 'none' }),
  { tab: request?.arguments?.tab, completed }) });

// Only the ordinary fixed launcher calls this. The second argument permits
// owned stream fixtures; no dependency, executable, descriptor or config path
// is accepted from MCP, project settings, prompt text or browser data.
export async function createInstalledBridge({ startupTimeoutMs = 120000, timeoutMs = 31000 } = {}, dependencies = {}) {
  if (![startupTimeoutMs, timeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 300000)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const config = (dependencies.readConfig ?? readInstalledConfig)();
  if (!config) return null;
  const accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config);
  if (accepted.current() !== true) throw Error('HOST_PACKAGE_MISMATCH');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:NODE_|DYLD_|LD_)/.test(key)) delete env[key];
  const child = (dependencies.spawnWorker ?? spawn)(process.execPath, [workerPath],
    { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const write = child.stdio?.[3], read = child.stdio?.[4];
  if (typeof write?.write !== 'function' || typeof read?.on !== 'function') throw Error('TRUSTED_ROUTE_REQUIRED');
  let hello, browser, buffer = '', sequence = 0, generation = 0, active = false, closed = false, lost = false, ending, closing;
  let deliveries = new WeakMap();
  const pending = new Map(), turns = new Set();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startupTimer = setTimeout(() => lose(), startupTimeoutMs);
  function lose(code = 'INSTALLED_WORKER_UNAVAILABLE') {
    if (lost) return;
    lost = true; active = false; generation++; deliveries = new WeakMap();
    clearTimeout(startupTimer); readyReject(Error(unavailableCodes.has(code) ? code : 'INSTALLED_WORKER_UNAVAILABLE'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('INSTALLED_WORKER_UNAVAILABLE')); }
    pending.clear();
    // Release only our own pipe handles. EOF makes the fixed worker fence its
    // client and retain the browser/native cleanup channel; no process signal
    // or child exit is used as target-cleanup evidence.
    try { write.end(); read.destroy(); child.unref?.(); } catch {}
  }
  const current = () => { try { return accepted.current() === true; } catch { return false; } };
  read.on('data', chunk => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > limit) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        if (!hello && exact(frame, ['version', 'session', 'nonce']) && frame.version === 1 &&
            identifier(frame.session) && /^[a-f0-9]{64}$/.test(frame.nonce)) { hello = frame; continue; }
        if (hello && !browser && exact(frame, ['version', 'ready', 'browser']) && frame.version === 1 &&
            frame.ready === true && /^b[A-Za-z0-9_-]{1,63}$/.test(frame.browser)) {
          browser = frame.browser; clearTimeout(startupTimer); readyResolve(); continue;
        }
        if (exact(frame, ['version', 'status', 'code']) && frame.version === 1 && frame.status === 'unavailable') { lose(frame.code); return; }
        if (!hello || !browser || frame.version !== 1 || !identifier(frame.id) ||
            !exact(frame, ['version', 'id', Object.hasOwn(frame, 'result') ? 'result' : 'error'])) throw Error();
        const entry = pending.get(frame.id); if (!entry) throw Error();
        pending.delete(frame.id); clearTimeout(entry.timer);
        if (Object.hasOwn(frame, 'error')) entry.reject(Error('INVALID_WORKER_REQUEST'));
        else entry.resolve(frame.result);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  child.on('error', lose); child.on('close', lose);
  function rpc(method, params) {
    if (lost || !hello || pending.size >= 32) return Promise.reject(Error('INSTALLED_WORKER_UNAVAILABLE'));
    const id = 'q' + (++sequence);
    const frame = immutableJSON({ ...hello, id, method, params }), bytes = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(bytes) > limit || write.writableLength > limit) return Promise.reject(Error('INVALID_WORKER_REQUEST'));
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { lose(); reject(Error('INSTALLED_WORKER_UNAVAILABLE')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write.write(bytes); } catch { lose(); }
    });
    return promise.then(result => ({ id, result }));
  }
  await ready;
  if (!current()) { lose(); throw Error('HOST_PACKAGE_MISMATCH'); }
  const fence = () => { active = false; generation++; deliveries = new WeakMap(); };
  function endTurn() {
    fence();
    if (ending) return ending;
    if (lost) return Promise.resolve(unproved());
    ending = rpc('end', {}).then(({ result }) => result).catch(unproved).finally(() => { ending = undefined; });
    return ending;
  }
  const bridge = Object.freeze({
    get browser() { return browser; },
    bootstrapEnvelope: () => hello,
    tools() {
      const tools = compactTools();
      tools[0].inputSchema.properties.browser = { type: 'string', const: browser };
      return tools;
    },
    async bind(input) {
      let frame; try { frame = immutableJSON(input); } catch { throw Error('TRUSTED_TURN_REQUIRED'); }
      if (!exact(frame, ['version', 'session', 'nonce', 'event', 'turn', 'text']) || frame.version !== 1 ||
          frame.session !== hello.session || !equal(frame.nonce, hello.nonce) || frame.event !== 'begin' ||
          !identifier(frame.turn) || typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536 ||
          turns.has(frame.turn) || closed || lost || !current()) throw Error('TRUSTED_TURN_REQUIRED');
      turns.add(frame.turn); fence(); const epoch = generation;
      const { result } = await rpc('begin', { turn: frame.turn, text: frame.text });
      if (epoch !== generation || closed || lost || !current()) return false;
      active = result?.available === true && result.browser === browser;
      return active;
    },
    async call(input) {
      let request; try { request = validateCall(input); } catch { return failure('INVALID_ARGUMENT'); }
      if (!active || closed || lost) return failure('LEASE_LOST', request);
      if (!current()) return failure('VERSION_MISMATCH', request);
      const epoch = generation;
      try {
        const { id, result } = await rpc('call', request);
        if (!active || closed || lost || epoch !== generation || !current()) {
          const total = request.name === 'browser_fill' ? request.arguments.fields.length : request.arguments.steps?.length ?? 1;
          const completed = result?.completed ?? result?.error?.completed ?? 0;
          return failure(!current() ? 'VERSION_MISMATCH' : 'LEASE_LOST', request, true,
            Number.isInteger(completed) && completed >= 0 && completed <= total ? completed : 0);
        }
        // Preserve this exact mutable result identity for the host's subsequent
        // actual output-delivery boundary. Clones or modified content cannot ack.
        const output = JSON.parse(JSON.stringify(result));
        if (request.name === 'browser_read' && !output.error && output.observation && output.observation.omitted !== true)
          deliveries.set(output, { id, hash: digest(output), epoch });
        return output;
      } catch { return failure('LEASE_LOST', request, true); }
    },
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || !active || closed || lost || record.epoch !== generation || !current()) return false;
      try { if (record.hash !== digest(result)) return false; } catch { return false; }
      // FIFO writes place this authenticated exact-result acknowledgment before
      // subsequent call frames. Confirmation remains private and asynchronous.
      rpc('delivered', { resultId: record.id, hash: record.hash }).catch(() => {});
      return false;
    },
    end: endTurn, endTurn,
    async detach() {
      fence(); closed = true;
      if (lost) return unproved();
      try {
        const { result } = await rpc('detach', {});
        write.end(); read.destroy(); child.unref?.(); return result;
      } catch { return unproved(); }
    },
    close() {
      fence(); closed = true;
      if (closing) return closing;
      if (lost) return Promise.resolve(unproved());
      closing = rpc('close', {}).then(({ result }) => result).catch(unproved).finally(() => { closing = undefined; });
      return closing;
    },
  });
  bridges.add(bridge); return bridge;
}
