// The resident host's app pipe owner (electron-host.mjs). No default app launcher, IPC listener or product grants.
// Trusted host code supplies launch/ownership/authority; model code never gets this object.
import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { hostReason } from '../electron-host-reasons.mjs';

const methodPattern = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const sessionPattern = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
// What a worker may send through the host. The worker's CDP filter (app mode) is the first fence;
// this is the second and refuses at least as much, so a bug or a bypass there cannot reach the app's
// browser-wide commands. Browser.close would quit the app without the user's click. Foreground,
// activation, cookie and download commands, Target creation and closing, closing or crashing a
// renderer and focus emulation are refused. Every command except Browser.getVersion and the Target
// reads and attaches needs a session the client owns, and an attach needs the parent's admitTarget.
const transportDomains = new Set(['Page', 'Runtime', 'DOM', 'DOMSnapshot', 'CSS', 'Accessibility', 'Input', 'Network', 'Fetch',
  'Log', 'Emulation', 'Inspector', 'Debugger', 'Performance', 'Target', 'Browser']);
const transportTarget = new Set(['getTargets', 'getTargetInfo', 'attachToTarget', 'detachFromTarget', 'setAutoAttach', 'setDiscoverTargets']);
const transportRefused = new Set(['Page.bringToFront', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.getAllCookies',
  'Network.deleteCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.enableDeviceBoundSessions',
  'Network.deleteDeviceBoundSession', 'Page.deleteCookie', 'Page.setDownloadBehavior', 'Target.createTarget', 'Target.closeTarget',
  'Page.close', 'Page.crash', 'Emulation.setFocusEmulationEnabled']);
const sessionless = new Set(['Browser.getVersion', 'Target.getTargets', 'Target.getTargetInfo', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Target.setDiscoverTargets']);
const keysAre = (params, keys) => Object.keys(params).sort().join() === [...keys].sort().join();
const framesOnly = filter => Array.isArray(filter) && filter.length === 2 && keysAre(filter[0], ['type']) && filter[0].type === 'iframe' &&
  keysAre(filter[1], ['exclude']) && filter[1].exclude === true;
// The shape rules on top of the method list. sessionId is the route the command would run on.
export function transportCallAllowed(method, params, sessionId) {
  if (!transportMethodAllowed(method) || !plainObject(params)) return false;
  if (sessionId === undefined && !sessionless.has(method)) return false;
  if (method === 'Target.attachToTarget') return sessionId === undefined && keysAre(params, ['targetId', 'flatten']) && params.flatten === true && sessionPattern(params.targetId);
  if (method === 'Target.setDiscoverTargets') return keysAre(params, ['discover']) && typeof params.discover === 'boolean';
  if (method === 'Target.setAutoAttach') return keysAre(params, ['autoAttach', 'waitForDebuggerOnStart', 'flatten', 'filter']) && typeof params.autoAttach === 'boolean' &&
    typeof params.waitForDebuggerOnStart === 'boolean' && params.flatten === true && framesOnly(params.filter);
  return true;
}
export function transportMethodAllowed(method) {
  if (typeof method !== 'string' || !methodPattern.test(method) || transportRefused.has(method)) return false;
  const [domain, name] = method.split('.');
  if (!transportDomains.has(domain)) return false;
  if (domain === 'Browser') return name === 'getVersion';
  if (domain === 'Target') return transportTarget.has(name);
  return true;
}

export class PipeTransport extends EventEmitter {
  // firstId: the id before the first command's. CDP ids are 32-bit; the pipe keeper's own command uses 2**31 - 2.
  // maxInboundRecords/maxInboundBytes bound the received records waiting behind a reply (see receive).
  constructor({ input, output, maxFrameBytes = 1024 * 1024, maxPending = 256, maxQueuedBytes = 8 * 1024 * 1024, timeoutMs = 5000, firstId = 0,
    maxInboundRecords = 4096, maxInboundBytes = maxQueuedBytes, onCdpFailure, onQueueFailure }) {
    super();
    for (const value of [maxFrameBytes, maxPending, maxQueuedBytes, timeoutMs, maxInboundRecords, maxInboundBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid pipe bound');
    }
    if (maxPending > 256) throw new Error('invalid pipe bound');
    if (!Number.isSafeInteger(firstId) || firstId < 0 || firstId > 2 ** 30) throw new Error('invalid pipe bound');
    Object.assign(this, { input, output, maxFrameBytes, maxPending, maxQueuedBytes, timeoutMs, maxInboundRecords, maxInboundBytes, onCdpFailure, onQueueFailure });
    this.pending = new Map(); this.routes = new Map(); this.writes = new Map(); this.sequence = firstId; this.buffer = Buffer.alloc(0);
    this.failed = false; this.blocked = false; this.queuedBytes = 0; this.drainVersion = 0; this.inFlight = new Set();
    this.inbound = []; this.inboundBytes = 0; this.gate = undefined; this.receiving = false; this.dispatching = false;
    output.on('data', chunk => this.receive(chunk));
    output.on('end', () => this.fail(new Error('pipe EOF')));
    output.on('error', error => this.fail(error));
    input.on('error', error => this.fail(error));
    input.on('drain', () => { this.drainVersion++; this.blocked = false; this.flush(); });
  }

  request(method, params = {}, { signal, sessionId, beforeWrite, owner } = {}) {
    const refused = message => Promise.reject(Object.assign(new Error(message), { dispatched: false }));
    if (this.failed) return refused('pipe unavailable');
    if (this.pending.size >= this.maxPending) { this.queueFailure('count bound'); return refused('pipe queue full'); }
    if (signal?.aborted) return refused('cancelled before dispatch');
    if (typeof method !== 'string' || !method || !plainObject(params)) return refused('invalid pipe command');
    if (sessionId !== undefined && !sessionPattern(sessionId)) return refused('invalid pipe session');
    const id = ++this.sequence;
    let bytes;
    try { bytes = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); }
    catch { return refused('invalid pipe command'); }
    if (bytes.length - 1 > this.maxFrameBytes) return refused('outbound frame too large');
    // Bound retained, unwritten Buffers as well as command count, including the NUL delimiter.
    if (this.queuedBytes + bytes.length > this.maxQueuedBytes) { this.queueFailure('byte bound'); return refused('pipe queue full'); }
    return new Promise((resolve, reject) => {
      let dispatched = false;
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        this.routes.delete(id); this.inFlight.delete(id); this.removeWrite(id);
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error?.cdp === true) {
          try { this.onCdpFailure?.({ method, code: error.code, message: error.message, sessionId }); } catch {}
        }
        if (error) reject(Object.assign(error, { dispatched })); else resolve(value);
      };
      const abort = () => finish(new Error(dispatched ? 'cancelled; effect unknown' : 'cancelled before dispatch'));
      const timedOut = () => {
        if (!dispatched) this.queueFailure('queue timeout');
        finish(new Error(dispatched ? 'pipe timeout; effect unknown' : 'pipe queue timeout'));
      };
      let timer = setTimeout(timedOut, this.timeoutMs);
      this.pending.set(id, finish); this.routes.set(id, sessionId);
      signal?.addEventListener('abort', abort, { once: true });
      this.queuedBytes += bytes.length;
      this.writes.set(id, { finish, owner, bytes: bytes.length, write: () => {
        try { beforeWrite?.(); } catch (error) { finish(error); return; }
        // write(false) accepted this frame. Only later frames wait for drain.
        dispatched = true;
        this.inFlight.add(id);
        clearTimeout(timer); timer = setTimeout(timedOut, this.timeoutMs);
        const drainVersion = this.drainVersion;
        try { this.blocked = !this.input.write(bytes) && drainVersion === this.drainVersion; }
        catch (error) {
          const reason = hostReason('write ' + error?.code);
          this.fail(new Error(reason === 'host failure' ? 'pipe write failed' : reason));
        }
      } });
      this.flush();
    });
  }

  queueFailure(reason) {
    try { this.onQueueFailure?.(reason); } catch {}
  }

  flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // A received record not yet dispatched (a detach, a crash) may revoke the route a queued write uses: it goes first.
      while (!this.failed && !this.blocked && this.writes.size && !this.receiving && !this.inbound.length) {
        const [id, entry] = this.writes.entries().next().value;
        this.removeWrite(id); entry.write();
      }
    } finally { this.flushing = false; }
  }

  removeWrite(id) {
    const entry = this.writes.get(id);
    if (entry) { this.queuedBytes -= entry.bytes; this.writes.delete(id); }
  }

  cancelQueued(reason, matches = () => true) {
    for (const entry of [...this.writes.values()]) if (matches(entry.owner)) entry.finish(new Error(reason));
  }

  // Received records go through one FIFO in wire order. Events dispatch synchronously until a reply is dispatched.
  // A reply only resolves a Promise, and its consumers (transportSend's continuation, the host's .then that
  // forwards it to the worker) run in later microtasks; so after a reply the next record waits for setImmediate,
  // or an event right behind it on the wire would reach the worker first. Playwright installs its Runtime
  // listeners in Page.getFrameTree's .then, so such an event (the MAIN context) was lost. Records from later
  // chunks join the same FIFO, and writes wait while it holds anything (see flush).
  receive(chunk) {
    if (this.failed) return;
    const outer = this.receiving; // a listener's reentrant receive() must not end the outer one's write hold
    this.receiving = true;
    try {
      // Slice before buffering: one oversized chunk cannot allocate an unbounded bank.
      let start = 0;
      while (start < chunk.length && !this.failed) {
        const end = chunk.indexOf(0, start);
        const stop = end < 0 ? chunk.length : end;
        if (this.buffer.length + stop - start > this.maxFrameBytes) return this.fail(new Error('inbound frame too large'));
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, stop)]);
        if (end < 0) return;
        let message;
        try {
          message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer));
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid pipe message');
          // Private NUL transport event -> the v3 session event shape {method, params, sessionId?}.
          if (!Object.hasOwn(message, 'id') && (typeof message.method !== 'string' || !methodPattern.test(message.method) ||
              message.params !== undefined && !plainObject(message.params) ||
              message.sessionId !== undefined && !sessionPattern(message.sessionId))) throw new Error('invalid pipe event');
        } catch (error) { return this.fail(error); }
        const bytes = this.buffer.length + 1;
        this.buffer = Buffer.alloc(0); start = end + 1;
        if (this.inbound.length >= this.maxInboundRecords || this.inboundBytes + bytes > this.maxInboundBytes) {
          this.queueFailure('inbound bound');
          return this.fail(new Error('inbound queue full'));
        }
        this.inbound.push({ message, bytes }); this.inboundBytes += bytes;
        this.dispatchInbound();
      }
    } finally {
      this.receiving = outer;
      this.flush();
    }
  }

  dispatchInbound() {
    if (this.dispatching) return; // a listener's reentrant receive() leaves its records to this loop
    this.dispatching = true;
    try {
      while (!this.failed && this.gate === undefined && this.inbound.length) {
        const { message, bytes } = this.inbound.shift();
        this.inboundBytes -= bytes;
        if (!Object.hasOwn(message, 'id')) {
          // A throwing listener must not turn into a pipe fault.
          try { this.emit('event', Object.freeze({ method: message.method, params: message.params ?? {},
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }) })); } catch { /* listener error */ }
          continue;
        }
        const finish = this.pending.get(message.id);
        // A reply belongs to exactly the route its request used, and carries a result or an error, never both or neither.
        if (finish && (!this.inFlight.has(message.id) || message.sessionId !== this.routes.get(message.id) ||
            Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) return this.fail(new Error('invalid pipe reply'));
        if (!finish) continue; // a late reply to a request already finished (timeout, cancel) changes nothing
        finish(message.error ? Object.assign(new Error(message.error.message || 'CDP error'), { dispatched: true, cdp: true, code: message.error.code }) : null, message.result);
        // Even with nothing queued yet: a stream can emit buffered chunks back to back in one task.
        this.gate = setImmediate(() => { this.gate = undefined; this.dispatchInbound(); this.flush(); });
      }
    } finally { this.dispatching = false; }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true; this.buffer = Buffer.alloc(0);
    // Synchronous: nothing received but not yet dispatched is delivered after a fault.
    if (this.gate !== undefined) clearImmediate(this.gate);
    this.gate = undefined; this.inbound = []; this.inboundBytes = 0;
    for (const finish of [...this.pending.values()]) finish(new Error(error.message));
    // Never destroy/end the last writer on revoke, timeout or malformed input.
    this.emit('fault', error);
  }
}

const same = (a, b) => a && b && a.pid === b.pid && a.birth === b.birth;
const identityValid = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.birth === 'string' && value.birth.length > 0;

export class ElectronBroker extends EventEmitter {
  // admitTarget(targetInfo) is the trusted parent's answer to "does this target belong to the opted-in app?"
  // (electron-targets.mjs's classification). Without it no target can be attached.
  constructor({ ownership, launch, authorizeLaunch, authorize, admitTarget, transport = {}, identityMaxAgeMs = 1000, now = () => performance.now(),
    maxRoutes = 4096, maxTransportQueue = 256, diagnostic }) {
    super();
    for (const value of [identityMaxAgeMs, maxRoutes, maxTransportQueue]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid broker bound');
    }
    Object.assign(this, { ownership, launch, authorizeLaunch, authorize, admitTarget, transportOptions: transport, identityMaxAgeMs, now, maxRoutes, maxTransportQueue });
    this.state = 'new'; this.instance = randomUUID(); this.epoch = 0;
    this.clients = new Set(); this.grants = new Set(); this.descendants = new Map(); this.receipts = [];
    this.preparing = 0; this.queued = 0; this.parkedBy = undefined; this.verifiedAt = -Infinity; this.verifying = undefined;
    // sessionId -> { client, top }. Flat CDP session ids are capabilities, so a client may only
    // send on sessions its own attach created (or that an owned session auto-attached).
    this.routes = new Map();
    // Physical root attachments outlive their input authority until native evidence proves collection.
    this.attachments = new Map(); this.collectingAttachments = new WeakMap();
    this.pendingAttaches = new Set();
    this.diagnostic = diagnostic;
    if (diagnostic) this.transportOptions = { ...transport, onQueueFailure: reason => this.queueFailure(reason), onCdpFailure: row => {
      const type = this.routes.get(row.sessionId)?.targetType ?? (row.sessionId === undefined ? 'browser' : 'unknown');
      const kind = ['page', 'iframe', 'webview'].includes(type) ? type : /worker/.test(type) ? 'worker' : 'unknown';
      diagnostic({ method: row.method, code: row.code, message: row.message, sessionKind: kind,
        targetType: type, frameType: type === 'page' ? 'top' : type === 'iframe' || type === 'webview' ? type : 'none' });
    } };
  }

  queueFailure(reason) {
    try { this.diagnostic?.({ method: 'queue', message: reason, code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }); } catch {}
  }

  receipt(fields) {
    const value = { broker: this.instance, epoch: this.epoch, ...fields };
    this.receipts.push(value);
    if (this.receipts.length > 128) this.receipts.shift();
    return value;
  }

  status() {
    return Object.freeze({ state: this.state, epoch: this.epoch, instance: this.instance, identity: this.identity,
      clients: this.clients.size, routes: this.routes.size, parked: this.parkedBy ? { ...this.parkedBy } : undefined });
  }

  async start(spec) {
    if (this.state !== 'new') throw new Error('retained ownership prevents another launch');
    const preparedSpec = structuredClone(spec);
    this.state = 'authorizing';
    try {
      if (!this.authorizeLaunch || await this.authorizeLaunch(structuredClone(preparedSpec), this.instance) !== true) {
        this.state = 'new'; throw new Error('launch authority required');
      }
      if (this.state !== 'authorizing') throw new Error('launch interrupted during approval');
      this.state = 'launching';
      this.owned = await this.ownership.reserve({ broker: this.instance, spec: structuredClone(preparedSpec) });
      if (this.state !== 'launching') throw new Error('launch interrupted before spawn');
      this.child = await this.launch(structuredClone(preparedSpec), this.owned);
      if (!identityValid(this.child?.identity)) throw new Error('launch PID incarnation missing');
      this.identity = Object.freeze({ ...this.child.identity });
      await this.ownership.record(this.owned, this.identity);
      this.pipe = new PipeTransport({ ...this.transportOptions, input: this.child.input, output: this.child.output });
      this.pipe.on('fault', error => this.park(error.message, { expected: this.expectedExit === true && ['pipe EOF', 'owned app collected'].includes(error.message) }));
      this.pipe.on('event', frame => this.routeEvent(frame));
      this.child.events.on('exit', code => { this.exitCode = code; this.park('child exited', { expected: this.expectedExit === true }); });
      const observed = await this.inspect();
      if (!same(observed.parent, this.identity)) throw new Error('launch PID changed or single-instance forwarding');
      if (this.state !== 'launching') throw new Error('launch interrupted before handshake');
      await this.pipe.request('Browser.getVersion');
      if (this.state !== 'launching') throw new Error('launch interrupted');
      this.state = 'ready'; this.verifiedAt = this.now();
      return this.receipt({ phase: 'verified', event: 'handshake', identity: this.identity });
    } catch (error) {
      if (this.state !== 'new') this.state = 'retained';
      this.receipt({ phase: 'unknown', event: 'launch-failed', reason: error.message });
      throw error;
    }
  }

  // A restarted host takes over an app it did not launch, through the pipe keeper (electron-host.mjs). Nothing is sent
  // here: the connection waits parked, and resume() checks the process and does a new handshake. Its command ids start
  // far from the dead host's, so a late reply to one of those is never taken for one of these.
  adopt(child, owned) {
    if (this.state !== 'new') throw new Error('retained ownership prevents another launch');
    if (!identityValid(child?.identity)) throw new Error('launch PID incarnation missing');
    this.owned = owned; this.child = child; this.identity = Object.freeze({ ...child.identity });
    this.pipe = new PipeTransport({ ...this.transportOptions, input: child.input, output: child.output, firstId: randomInt(1 << 20, 1 << 30) });
    this.pipe.on('fault', error => this.park(error.message, { expected: this.expectedExit === true && ['pipe EOF', 'owned app collected'].includes(error.message) }));
    this.pipe.on('event', frame => this.routeEvent(frame));
    child.events.on('exit', code => { this.exitCode = code; this.park('child exited', { expected: this.expectedExit === true }); });
    this.state = 'parked'; this.epoch++; this.parkedBy = { reason: 'host restarted', resumable: true };
    return this.receipt({ phase: 'unknown', event: 'adopted', identity: this.identity });
  }

  // This is a host-only in-process channel. The resident host's authenticated channels map each
  // verified remote client to one of these objects; possession of the object alone is not what
  // authenticates a worker, and it is never serialized.
  connect(session) {
    if (this.state !== 'ready' || typeof session !== 'string' || !session) throw new Error('broker not ready');
    if (this.clients.size >= 64) { this.queueFailure('count bound'); throw new Error('client queue full'); }
    const client = Object.freeze({ session, nonce: randomUUID(), epoch: this.epoch });
    this.clients.add(client); return client;
  }

  // Releasing a client drops its routes at once and detaches its top-level sessions in the app
  // afterwards (best effort), so a lost worker cannot leave a page paused behind its attachment.
  detach(client) {
    if (this.clients.delete(client)) this.pipe?.cancelQueued('client detached during preparation', owner => owner === client);
    const owned = [...this.routes].filter(([, route]) => route.client === client);
    for (const [name] of owned) this.routes.delete(name);
    if (this.state !== 'ready') return;
    for (const [name, attachment] of this.attachments) {
      if (attachment.client !== client) continue;
      this.collectAttachment(name, attachment).then(collected => {
        if (!collected) this.receipt({ phase: 'unknown', event: 'client-detach-failed', reason: 'physical detach unconfirmed' });
      });
    }
  }

  // park() stops every command and keeps the app's pipe open. Unless the cause is resumable,
  // only a deliberate user action (Quit, or reconciliation after the app exits) leaves the state.
  park(reason, { resumable = false, expected = false } = {}) {
    if (this.state === 'collected') return;
    const first = this.state !== 'parked';
    this.state = 'parked'; this.epoch++; this.clients.clear(); this.routes.clear();
    this.parkedBy = { reason, resumable: resumable && (this.parkedBy ? this.parkedBy.resumable : true) };
    this.pipe?.cancelQueued('broker parked during preparation');
    this.verifiedAt = -Infinity;
    this.receipt({ phase: 'unknown', event: 'parked', reason });
    try { this.diagnostic?.({ method: 'park', message: hostReason(reason), code: null, sessionKind: 'host', ...(expected === true ? { expected: true } : {}) }); } catch {}
    if (first) this.emit('parked', { reason, resumable: this.parkedBy.resumable, epoch: this.epoch });
  }

  // Revocation and disconnect park a healthy connection so a later authorized worker can resume it.
  revoke(reason, { expected = false } = {}) {
    // A repeated revoke of the same parked grant adds no authority change. In particular,
    // a qualification disconnect also triggers the local consent store's revoke hook.
    if (this.state === 'parked' && this.parkedBy?.reason === reason && this.parkedBy.resumable) return;
    this.park(reason, { resumable: true, expected });
  }

  // Resume is never automatic: the host calls it after fresh authority. It needs a live pipe with
  // nothing in flight, the same app incarnation, and a new handshake.
  async resume(authority) {
    if (this.state !== 'parked' || !this.parkedBy?.resumable) throw new Error('not resumable');
    if (typeof authority !== 'function' || await authority({ identity: this.identity, instance: this.instance }) !== true) throw new Error('resume authority required');
    if (this.state !== 'parked' || !this.parkedBy?.resumable) throw new Error('not resumable');
    if (this.pipe.failed || this.pipe.pending.size || this.pipe.blocked) throw new Error('pipe not quiescent');
    const epoch = this.epoch;
    this.state = 'resuming';
    try {
      const observed = await this.inspect();
      if (!same(observed.parent, this.identity)) throw new Error('app identity changed');
      await this.pipe.request('Browser.getVersion');
      if (this.state !== 'resuming' || epoch !== this.epoch) throw new Error('resume interrupted');
    } catch (error) {
      // A park during the resume (a revoke, a fault) already set the state and its reason: keep them.
      if (epoch !== this.epoch) throw new Error('resume interrupted: ' + (this.parkedBy?.reason ?? 'parked'));
      this.state = 'parked'; this.parkedBy = { reason: error.message, resumable: false };
      throw error;
    }
    this.state = 'ready'; this.parkedBy = undefined; this.verifiedAt = this.now();
    return this.receipt({ phase: 'verified', event: 'resumed', identity: this.identity });
  }

  // A secondary read session is never an authority source. Native child records pin the exact parent record,
  // so a detached/recreated session with the same spelling cannot revive a former chain.
  routeCurrent(name, record, client, authority = false) {
    const seen = new Set();
    while (record) {
      if (seen.has(record) || seen.size >= 128 || this.routes.get(name) !== record || record.client !== client ||
          record.epoch !== this.epoch || !this.clients.has(client) || client.epoch !== this.epoch) return false;
      seen.add(record);
      if (record.provenance === 'direct') return record.targetType === 'page' && record.top === true;
      if (record.provenance === 'secondary') {
        if (authority) return false;
        return this.sourceCurrent({ session: record.sourceSession, route: record.source }, client);
      } else if (record.provenance === 'auto') {
        if (authority && (record.targetType !== 'iframe' || !sessionPattern(record.targetId))) return false;
        name = record.parentSession; record = record.parent;
      } else return false;
    }
    return false;
  }

  attachmentSource(targetId, client) {
    const candidates = [...this.routes].filter(([, route]) => route.client === client && route.targetId === targetId && route.provenance === 'auto');
    if (!candidates.length) return undefined;
    if (candidates.length !== 1) throw Error('CDP_TARGET_NOT_OWNED');
    const [session, route] = candidates[0];
    if (!this.sourceCurrent({ session, route }, client)) throw Error('CDP_TARGET_NOT_OWNED');
    return Object.freeze({ session, route });
  }

  sourceCurrent(source, client) {
    if (source.route?.targetType !== 'iframe' || !this.routeCurrent(source.session, source.route, client, true)) return false;
    const matches = [...this.routes].filter(([, route]) => route.client === client && route.targetId === source.route.targetId && route.provenance === 'auto');
    return matches.length === 1 && matches[0][0] === source.session && matches[0][1] === source.route;
  }

  observeSession(name) {
    for (const attempt of this.pendingAttaches) {
      if (attempt.known.has(name)) continue;
      if (attempt.known.size >= this.maxRoutes * 2) attempt.uncertain = true;
      else attempt.known.add(name);
    }
  }

  routeDescends(record, ancestor) {
    const seen = new Set();
    while (record && !seen.has(record) && seen.size < 128) {
      if (record === ancestor) return true;
      seen.add(record); record = record.parent ?? record.source;
    }
    return false;
  }

  invalidateRoutes(names) {
    const removed = new Set();
    for (const name of names) { const record = this.routes.get(name); if (record) { removed.add(record); this.routes.delete(name); } }
    // Each pass removes at least one bounded route; identity links cannot accidentally select a replacement record.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, record] of this.routes) if (removed.has(record.parent) || removed.has(record.source)) {
        removed.add(record); this.routes.delete(name); changed = true;
      }
    }
  }

  routeEvent(frame) {
    const params = frame.params;
    if (frame.sessionId === undefined) {
      // Browser-level events that name a session belong to that session's owner alone. A session no
      // client owns (or one whose params carry no usable id) reaches nobody.
      if (['Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.receivedMessageFromTarget'].includes(frame.method)) {
        const named = sessionPattern(params.sessionId) ? this.routes.get(params.sessionId) ?? this.attachments.get(params.sessionId)?.record : undefined;
        if (!named || frame.method === 'Target.detachedFromTarget' && (!named.top ||
            params.targetId !== undefined && params.targetId !== named.targetId)) return;
        if (frame.method === 'Target.detachedFromTarget') { this.invalidateRoutes([params.sessionId]); this.attachments.delete(params.sessionId); }
        this.emit('routed', named.client, frame);
        return;
      }
      // A target's lifecycle (created, changed, destroyed, crashed) goes only to the clients attached to it, so one
      // session never learns another's windows or URLs. Clients find targets they hold nothing on with Target.getTargets.
      if (frame.method.startsWith('Target.')) {
        const targetId = params.targetInfo?.targetId ?? params.targetId;
        if (!sessionPattern(targetId)) return;
        const matching = [...this.routes].filter(([, route]) => route.targetId === targetId);
        const owners = new Set(matching.map(([, route]) => route.client));
        if (frame.method === 'Target.targetDestroyed' || frame.method === 'Target.targetCrashed') {
          this.invalidateRoutes(matching.map(([name]) => name));
          for (const [name, attachment] of this.attachments) if (attachment.record.targetId === targetId) {
            owners.add(attachment.client);
            if (frame.method === 'Target.targetDestroyed') this.attachments.delete(name);
          }
        }
        else if (frame.method === 'Target.targetInfoChanged' && typeof params.targetInfo?.type === 'string')
          this.invalidateRoutes(matching.filter(([, route]) => route.targetType !== params.targetInfo.type).map(([name]) => name));
        for (const client of owners) this.emit('routed', client, frame);
        return;
      }
      this.emit('routed', undefined, frame); return;
    }
    const route = this.routes.get(frame.sessionId);
    if (!route) return; // A session that no client owns has no listener.
    if (frame.method === 'Target.attachedToTarget' && sessionPattern(params.sessionId)) {
      this.observeSession(params.sessionId);
      if (this.attachments.has(params.sessionId) && this.routes.get(params.sessionId) !== this.attachments.get(params.sessionId).record) return;
      if (this.routes.size >= this.maxRoutes) { this.park('route bank full'); return; }
      const previous = this.routes.get(params.sessionId);
      if (previous) {
        if (previous.client !== route.client || previous.provenance !== 'auto' || previous.parent !== route || previous.parentSession !== frame.sessionId) return;
        if (previous.targetId !== params.targetInfo?.targetId || previous.targetType !== params.targetInfo?.type)
          this.invalidateRoutes([params.sessionId]);
        return;
      }
      this.routes.set(params.sessionId, Object.freeze({ client: route.client, top: false, targetId: params.targetInfo?.targetId,
        targetType: params.targetInfo?.type, epoch: this.epoch, provenance: 'auto', parentSession: frame.sessionId, parent: route }));
    } else if (frame.method === 'Target.detachedFromTarget') {
      const named = this.routes.get(params.sessionId);
      if (!named || named.parent !== route || named.parentSession !== frame.sessionId ||
          params.targetId !== undefined && params.targetId !== named.targetId) return;
      this.invalidateRoutes([params.sessionId]);
    } else if (frame.method === 'Target.targetDestroyed' || frame.method === 'Target.targetCrashed' || frame.method === 'Target.targetInfoChanged') {
      const targetId = params.targetInfo?.targetId ?? params.targetId;
      if (!sessionPattern(targetId)) return;
      const matching = [...this.routes].filter(([, record]) => record.client === route.client && record.targetId === targetId && this.routeDescends(record, route));
      const physical = [...this.attachments].filter(([, attachment]) => attachment.client === route.client &&
        attachment.record.targetId === targetId && this.routeDescends(attachment.record, route));
      if (!matching.length && !physical.length) return;
      if (frame.method !== 'Target.targetInfoChanged') this.invalidateRoutes(matching.map(([name]) => name));
      else if (typeof params.targetInfo?.type === 'string')
        this.invalidateRoutes(matching.filter(([, record]) => record.targetType !== params.targetInfo.type).map(([name]) => name));
      if (frame.method === 'Target.targetDestroyed') for (const [name] of physical) this.attachments.delete(name);
    }
    this.emit('routed', route.client, frame);
  }

  // The v3 path. Playwright's traffic arrives here through an authenticated channel. Semantic
  // authority (this click, that fill, payments) is decided in the worker by v3-context and the
  // shared rules before any command exists, so this method grants no operation. It checks
  // transport access only: the client, the epoch, the app incarnation, the method class and
  // the session ownership, and it repeats those checks after every await.
  async transportSend(client, { method, params = {}, sessionId } = {}, { signal, beforeWrite } = {}) {
    if (this.state !== 'ready') throw new Error('broker parked');
    if (!this.clients.has(client) || client.epoch !== this.epoch) throw new Error('unauthenticated client');
    if (!transportCallAllowed(method, params, sessionId)) throw new Error('CDP_COMMAND_REFUSED');
    const isAttach = method === 'Target.attachToTarget';
    if (isAttach) params = Object.freeze({ targetId: params.targetId, flatten: params.flatten });
    if (sessionId !== undefined && (!sessionPattern(sessionId) || this.routes.get(sessionId)?.client !== client)) throw new Error('CDP_SESSION_NOT_OWNED');
    this.ownsParamSessions(client, params);
    const source = isAttach ? this.attachmentSource(params.targetId, client) : undefined;
    const routeRecord = this.routes.get(sessionId), paramRecords = new Map();
    for (const key of ['sessionId', 'targetSessionId']) if (Object.hasOwn(params, key))
      paramRecords.set(key, { name: params[key], record: this.routes.get(params[key]) });
    if (this.queued >= this.maxTransportQueue) { this.queueFailure('authorization queue'); throw new Error('authorization queue full'); }
    const epoch = this.epoch;
    const assertCurrent = (afterReply = false) => {
      if (epoch !== this.epoch || this.state !== 'ready') throw Error('broker parked during preparation');
      if (!this.clients.has(client)) throw Error('client detached during preparation');
      const expectedDetach = name => afterReply && method === 'Target.detachFromTarget' && params.sessionId === name && !this.routes.has(name) &&
        (!this.attachments.has(name) || this.attachments.get(name).record === paramRecords.get('sessionId')?.record);
      if (sessionId !== undefined && !expectedDetach(sessionId) && !this.routeCurrent(sessionId, routeRecord, client)) throw Error('CDP_SESSION_NOT_OWNED');
      for (const [key, { name, record }] of paramRecords) if (params[key] !== name ||
          !expectedDetach(name) && !this.routeCurrent(name, record, client)) throw Error('CDP_SESSION_NOT_OWNED');
      if (source && !this.sourceCurrent(source, client)) throw Error('CDP_TARGET_NOT_OWNED');
    };
    assertCurrent();
    this.queued++;
    try {
      await this.fresh();
    } catch (error) {
      this.park(error.message); throw error;
    } finally { this.queued--; }
    assertCurrent();
    let attachedInfo;
    if (isAttach) {
      attachedInfo = await this.admitted(params.targetId, client, source, assertCurrent);
      assertCurrent();
    }
    if (signal?.aborted) throw new Error('cancelled before dispatch');
    const pipe = this.pipe;
    if (isAttach && this.attachments.size + [...this.pendingAttaches].filter(value => value.reserved).length >= this.maxRoutes) throw Error('CDP_SESSION_NOT_OWNED');
    const attempt = isAttach ? { pipe, known: new Set([...this.routes.keys(), ...this.attachments.keys()]), uncertain: false, reserved: true,
      record: Object.freeze({ client, top: true, targetId: params.targetId, targetType: attachedInfo.type, epoch, provenance: 'unpublished' }) } : undefined;
    if (attempt) this.pendingAttaches.add(attempt);
    try {
      const result = await pipe.request(method, params, { signal, sessionId, owner: client, beforeWrite: () => {
        assertCurrent();
        beforeWrite?.();
        assertCurrent();
      } });
      if (isAttach) {
        try {
          assertCurrent();
          if (!sessionPattern(result?.sessionId) || attempt.uncertain || attempt.known.has(result.sessionId) ||
              this.routes.size >= this.maxRoutes || this.routes.has(result.sessionId) || this.attachments.has(result.sessionId)) throw Error('CDP_SESSION_NOT_OWNED');
        } catch (error) {
          await this.collectUnpublishedAttach(result?.sessionId, client, attempt);
          throw error;
        }
        this.routes.set(result.sessionId, Object.freeze({ client, top: sessionId === undefined, targetId: params.targetId,
          targetType: attachedInfo.type, epoch, provenance: source ? 'secondary' : 'direct',
          ...(source ? { sourceSession: source.session, source: source.route } : {}) }));
        attempt.reserved = false;
        this.attachments.set(result.sessionId, Object.freeze({ client, pipe, record: this.routes.get(result.sessionId) }));
        this.observeSession(result.sessionId);
      } else {
        if (epoch !== this.epoch) throw Object.assign(new Error('authority changed in flight; effect unknown'), { dispatched: true });
        try { assertCurrent(true); }
        catch { throw Object.assign(Error('authority changed in flight; effect unknown'), { dispatched: true }); }
        if (method === 'Target.detachFromTarget' && sessionPattern(params.sessionId)) { this.invalidateRoutes([params.sessionId]); this.attachments.delete(params.sessionId); }
      }
      return result;
    } catch (error) {
      // An unanswered attach may have created an unnameable physical session. Only app collection can retire that risk,
      // including when another revoke already changed the epoch. Ordinary input keeps its existing resume behavior.
      if (error.dispatched === true && error.cdp !== true && (epoch === this.epoch || isAttach))
        this.park(error.message, { resumable: !isAttach && !this.pipe.failed });
      throw error;
    } finally { if (attempt) this.pendingAttaches.delete(attempt); }
  }

  // The target's own info from the app, judged by the parent's callback, before any attach is written.
  async admitted(targetId, client, source, assertCurrent = () => {}) {
    if (typeof this.admitTarget !== 'function') throw new Error('CDP_TARGET_NOT_OWNED');
    let info;
    try { info = (await this.pipe.request('Target.getTargetInfo', { targetId }, { owner: client, beforeWrite: assertCurrent })).targetInfo; }
    catch (error) { if (error.cdp === true) throw new Error('CDP_TARGET_NOT_OWNED'); throw error; }
    assertCurrent();
    if (source) {
      if (!plainObject(info) || info.targetId !== targetId || info.type !== 'iframe') throw Error('CDP_TARGET_NOT_OWNED');
      return Object.freeze({ ...info });
    }
    let admitted = false;
    try { admitted = plainObject(info) && info.targetId === targetId && await this.admitTarget(Object.freeze({ ...info })) === true; } catch { admitted = false; }
    assertCurrent();
    if (!admitted) throw new Error('CDP_TARGET_NOT_OWNED');
    return Object.freeze({ ...info });
  }

  async collectUnpublishedAttach(name, client, attempt) {
    // A fresh native reply names exactly the new physical session. A collision is not proof: never detach it.
    if (sessionPattern(name) && !attempt.uncertain && !attempt.known.has(name) && !this.routes.has(name) && !this.attachments.has(name) &&
        this.pipe === attempt.pipe && !attempt.pipe.failed) {
      const attachment = Object.freeze({ client, pipe: attempt.pipe, record: attempt.record });
      attempt.reserved = false; this.attachments.set(name, attachment);
      if (await this.collectAttachment(name, attachment)) return;
    }
    this.park('attachment cleanup unconfirmed');
  }

  collectAttachment(name, attachment) {
    const pending = this.collectingAttachments.get(attachment);
    if (pending) return pending;
    const collect = (async () => {
      try {
        await attachment.pipe.request('Target.detachFromTarget', { sessionId: name }, { owner: attachment.client, beforeWrite: () => {
          if (this.state !== 'ready' || this.pipe !== attachment.pipe || attachment.pipe.failed || this.attachments.get(name) !== attachment ||
              this.routes.has(name) && this.routes.get(name) !== attachment.record) throw Error('CDP_SESSION_NOT_OWNED');
        } });
        if (this.attachments.get(name) === attachment) this.attachments.delete(name);
        else if (this.attachments.has(name)) return false;
        if (this.routes.get(name) === attachment.record) this.invalidateRoutes([name]);
        return true;
      } catch { return !this.attachments.has(name); }
    })().finally(() => this.collectingAttachments.delete(attachment));
    this.collectingAttachments.set(attachment, collect);
    return collect;
  }

  // A flat session id inside params (Target.detachFromTarget, sendMessageToTarget, ...) is a capability
  // just like the route id. Every method that names one must name a session this client owns; the
  // check runs before any pipe write, and again after the awaited identity check.
  ownsParamSessions(client, params) {
    for (const key of ['sessionId', 'targetSessionId']) {
      if (!Object.hasOwn(params, key)) continue;
      if (!sessionPattern(params[key]) || this.routes.get(params[key])?.client !== client) throw new Error('CDP_SESSION_NOT_OWNED');
    }
  }

  // The app's PID incarnation, rechecked at most every identityMaxAgeMs for transport traffic.
  async fresh() {
    if (this.now() - this.verifiedAt < this.identityMaxAgeMs) return;
    this.verifying ??= (async () => {
      const observed = await this.inspect();
      if (!same(observed.parent, this.identity)) throw new Error('app identity changed');
      this.verifiedAt = this.now();
    })().finally(() => { this.verifying = undefined; });
    await this.verifying;
  }

  async dispatch(client, operation, { signal } = {}) {
    if (this.state !== 'ready') throw new Error('broker parked');
    if (!this.clients.has(client) || client.epoch !== this.epoch) throw new Error('unauthenticated client');
    const epoch = this.epoch;
    if (!this.authorize) throw new Error('operation authority required');
    if (this.preparing >= 64) { this.queueFailure('authorization queue'); throw new Error('authorization queue full'); }
    // The trusted authority binds exact args, session/turn, profile/build,
    // target/frame/document epochs and expiry, then returns the prepared CDP.
    // No raw model CDP or evaluate enters here without that boundary.
    const snapshot = structuredClone(operation);
    let command;
    this.preparing++;
    try {
      const observed = await this.inspect();
      if (!same(observed.parent, this.identity)) throw new Error('app identity changed');
      command = await this.authorize(snapshot, Object.freeze({
        session: client.session, instance: this.instance, identity: this.identity, epoch,
      }));
      const current = await this.inspect();
      if (!same(current.parent, this.identity)) throw new Error('app identity changed during authorization');
    } catch (error) {
      this.park(error.message); throw error;
    } finally { this.preparing--; }
    if (epoch !== this.epoch || this.state !== 'ready') throw new Error('broker parked during authorization');
    if (!this.clients.has(client)) throw new Error('client detached during authorization');
    if (signal?.aborted) throw new Error('cancelled before dispatch');
    if (!command || typeof command.grantId !== 'string' || !command.grantId || typeof command.method !== 'string') {
      throw new Error('operation authority refused');
    }
    if (this.grants.has(command.grantId)) throw new Error('replayed grant');
    if (this.grants.size >= 10000) { this.park('grant bank full'); throw new Error('grant bank full'); }
    this.grants.add(command.grantId);
    const receipt = { grantId: command.grantId, dispatched: true };
    try {
      const result = await this.pipe.request(command.method, command.params, { signal, sessionId: command.sessionId, owner: client, beforeWrite: () => {
        if (epoch !== this.epoch || this.state !== 'ready') throw new Error('broker parked during authorization');
        if (!this.clients.has(client)) throw new Error('client detached during authorization');
      } });
      if (epoch !== this.epoch) return this.receipt({ ...receipt, phase: 'unknown', reason: 'authority changed in flight' });
      return this.receipt({ ...receipt, phase: 'observed', result });
    } catch (error) {
      if (error.dispatched === true && epoch === this.epoch) this.park(error.message);
      return this.receipt({ ...receipt, dispatched: error.dispatched === true, phase: 'unknown', reason: error.message });
    }
  }

  async inspect() {
    const observed = await this.child.inspect(this.identity);
    if (observed?.complete !== true || !Array.isArray(observed.descendants)
      || !Object.hasOwn(observed, 'parent') || (observed.parent !== null && !identityValid(observed.parent))) {
      throw new Error('incomplete process census');
    }
    const fresh = [];
    for (const child of observed.descendants) {
      if (!identityValid(child)) throw new Error('descendant incarnation missing');
      const key = `${child.pid}:${child.birth}`;
      if (!this.descendants.has(key)) fresh.push({ pid: child.pid, birth: child.birth });
      this.descendants.set(key, { ...child });
    }
    // The durable journal learns every incarnation before the next command can rely on it.
    if (fresh.length && typeof this.ownership.observe === 'function') await this.ownership.observe(this.owned, fresh);
    return observed;
  }

  async quit(consent) {
    if (typeof consent !== 'function' || await consent({ identity: this.identity, owned: this.owned }) !== true) {
      throw new Error('exact-instance quit consent required');
    }
    this.park('user quit', { expected: true });
    try {
      const observed = await this.inspect();
      if (observed.parent && !same(observed.parent, this.identity)) throw new Error('PID reused');
      // Host callback must use the app's own Quit, never a signal or title-only target.
      if (observed.parent) { this.expectedExit = true; await this.child.requestQuit(this.identity); }
      return await this.collect();
    } catch (error) { return this.receipt({ cleanup: 'retained', reason: error.message }); }
    finally { this.expectedExit = false; }
  }

  async collect() {
    if (this.state === 'collected') return this.receipt({ cleanup: 'removed', exitCode: this.exitCode });
    this.park('collection', { expected: true });
    try {
      const observed = await this.inspect();
      if (observed.parent || observed.descendants.length) throw new Error('processes remain');
      // Census must explicitly account for the union, not only current children
      // (orphaned descendants no longer appear under the exited parent).
      if (this.descendants.size && await this.child.confirmAbsent?.([...this.descendants.values()]) !== true) {
        throw new Error('observed descendant absence unproved');
      }
      await this.ownership.remove(this.owned);
      this.expectedExit = true;
      this.pipe?.fail(new Error('owned app collected'));
      this.child.input.end();
      this.child.output.destroy();
      this.attachments.clear();
      this.state = 'collected';
      return this.receipt({ cleanup: 'removed', exitCode: this.exitCode });
    } catch (error) { return this.receipt({ cleanup: 'retained', reason: error.message }); }
  }
}
