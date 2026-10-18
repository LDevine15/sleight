// The resident host's app pipe owner (electron-host.mjs). No default app launcher, IPC listener or product grants.
// Trusted host code supplies launch/ownership/authority; model code never gets this object.
import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';

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
  constructor({ input, output, maxFrameBytes = 1024 * 1024, maxPending = 64, timeoutMs = 5000, firstId = 0 }) {
    super();
    for (const value of [maxFrameBytes, maxPending, timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid pipe bound');
    }
    if (!Number.isSafeInteger(firstId) || firstId < 0 || firstId > 2 ** 30) throw new Error('invalid pipe bound');
    Object.assign(this, { input, output, maxFrameBytes, maxPending, timeoutMs });
    this.pending = new Map(); this.routes = new Map(); this.sequence = firstId; this.buffer = Buffer.alloc(0);
    this.failed = false; this.blocked = false;
    output.on('data', chunk => this.receive(chunk));
    output.on('end', () => this.fail(new Error('pipe EOF')));
    output.on('error', error => this.fail(error));
    input.on('error', error => this.fail(error));
    input.on('drain', () => { this.blocked = false; });
  }

  request(method, params = {}, { signal, sessionId } = {}) {
    if (this.failed) return Promise.reject(new Error('pipe unavailable'));
    if (this.blocked || this.pending.size >= this.maxPending) return Promise.reject(new Error('pipe queue full'));
    if (signal?.aborted) return Promise.reject(new Error('cancelled before dispatch'));
    if (typeof method !== 'string' || !method || !plainObject(params)) return Promise.reject(new Error('invalid pipe command'));
    if (sessionId !== undefined && !sessionPattern(sessionId)) return Promise.reject(new Error('invalid pipe session'));
    const id = ++this.sequence;
    let bytes;
    try { bytes = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); }
    catch (error) { return Promise.reject(error); }
    if (bytes.length - 1 > this.maxFrameBytes) return Promise.reject(new Error('outbound frame too large'));
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        this.routes.delete(id);
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const unknown = message => Object.assign(new Error(message), { dispatched: true });
      const abort = () => finish(unknown('cancelled; effect unknown'));
      const timer = setTimeout(() => finish(unknown('pipe timeout; effect unknown')), this.timeoutMs);
      this.pending.set(id, finish); this.routes.set(id, sessionId);
      signal?.addEventListener('abort', abort, { once: true });
      try { this.blocked = !this.input.write(bytes); }
      catch (error) { finish(error); this.fail(error); }
    });
  }

  receive(chunk) {
    if (this.failed) return;
    // Slice before buffering: one oversized chunk cannot allocate an unbounded bank.
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const stop = end < 0 ? chunk.length : end;
      if (this.buffer.length + stop - start > this.maxFrameBytes) return this.fail(new Error('inbound frame too large'));
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, stop)]);
      if (end < 0) return;
      try {
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid pipe message');
        if (Object.hasOwn(message, 'id')) {
          const finish = this.pending.get(message.id);
          // A reply belongs to exactly the route its request used, and carries a result or an error, never both or neither.
          if (finish && (message.sessionId !== this.routes.get(message.id) ||
              Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw new Error('invalid pipe reply');
          finish?.(message.error ? Object.assign(new Error(message.error.message || 'CDP error'), { dispatched: true, cdp: true, code: message.error.code }) : null, message.result);
        } else {
          // Private NUL transport event -> the v3 session event shape {method, params, sessionId?}.
          if (typeof message.method !== 'string' || !methodPattern.test(message.method) ||
              message.params !== undefined && !plainObject(message.params) ||
              message.sessionId !== undefined && !sessionPattern(message.sessionId)) throw new Error('invalid pipe event');
          // A throwing listener must not turn into a pipe fault.
          try { this.emit('event', Object.freeze({ method: message.method, params: message.params ?? {},
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }) })); } catch { /* listener error */ }
        }
      } catch (error) { return this.fail(error); }
      this.buffer = Buffer.alloc(0); start = end + 1;
    }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true; this.buffer = Buffer.alloc(0);
    for (const finish of [...this.pending.values()]) finish(Object.assign(new Error(error.message), { dispatched: true }));
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
    maxRoutes = 4096, maxTransportQueue = 256 }) {
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
      this.pipe.on('fault', error => this.park(error.message));
      this.pipe.on('event', frame => this.routeEvent(frame));
      this.child.events.on('exit', code => { this.exitCode = code; this.park('child exited'); });
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
    this.pipe.on('fault', error => this.park(error.message));
    this.pipe.on('event', frame => this.routeEvent(frame));
    child.events.on('exit', code => { this.exitCode = code; this.park('child exited'); });
    this.state = 'parked'; this.epoch++; this.parkedBy = { reason: 'host restarted', resumable: true };
    return this.receipt({ phase: 'unknown', event: 'adopted', identity: this.identity });
  }

  // This is a host-only in-process channel. The resident host's authenticated channels map each
  // verified remote client to one of these objects; possession of the object alone is not what
  // authenticates a worker, and it is never serialized.
  connect(session) {
    if (this.state !== 'ready' || typeof session !== 'string' || !session) throw new Error('broker not ready');
    if (this.clients.size >= 64) throw new Error('client queue full');
    const client = Object.freeze({ session, nonce: randomUUID(), epoch: this.epoch });
    this.clients.add(client); return client;
  }

  // Releasing a client drops its routes at once and detaches its top-level sessions in the app
  // afterwards (best effort), so a lost worker cannot leave a page paused behind its attachment.
  detach(client) {
    if (!this.clients.delete(client)) return;
    const owned = [...this.routes].filter(([, route]) => route.client === client);
    for (const [name] of owned) this.routes.delete(name);
    if (this.state !== 'ready') return;
    for (const [name, route] of owned) {
      if (!route.top) continue;
      this.pipe.request('Target.detachFromTarget', { sessionId: name }).catch(error => {
        this.receipt({ phase: 'unknown', event: 'client-detach-failed', reason: error.message });
      });
    }
  }

  // park() stops every command and keeps the app's pipe open. Unless the cause is resumable,
  // only a deliberate user action (Quit, or reconciliation after the app exits) leaves the state.
  park(reason, { resumable = false } = {}) {
    if (this.state === 'collected') return;
    const first = this.state !== 'parked';
    this.state = 'parked'; this.epoch++; this.clients.clear(); this.routes.clear();
    this.parkedBy = { reason, resumable: resumable && (this.parkedBy ? this.parkedBy.resumable : true) };
    this.verifiedAt = -Infinity;
    this.receipt({ phase: 'unknown', event: 'parked', reason });
    if (first) this.emit('parked', { reason, resumable: this.parkedBy.resumable, epoch: this.epoch });
  }

  // Revocation and disconnect park a healthy connection so a later authorized worker can resume it.
  revoke(reason) { this.park(reason, { resumable: true }); }

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

  routeEvent(frame) {
    const params = frame.params;
    if (frame.sessionId === undefined) {
      // Browser-level events that name a session belong to that session's owner alone. A session no
      // client owns (or one whose params carry no usable id) reaches nobody.
      if (['Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.receivedMessageFromTarget'].includes(frame.method)) {
        const named = sessionPattern(params.sessionId) ? this.routes.get(params.sessionId) : undefined;
        if (named) this.emit('routed', named.client, frame);
        if (named && frame.method === 'Target.detachedFromTarget') this.routes.delete(params.sessionId);
        return;
      }
      // A target's lifecycle (created, changed, destroyed, crashed) goes only to the clients attached to it, so one
      // session never learns another's windows or URLs. Clients find targets they hold nothing on with Target.getTargets.
      if (frame.method.startsWith('Target.')) {
        const targetId = params.targetInfo?.targetId ?? params.targetId;
        if (!sessionPattern(targetId)) return;
        const owners = new Set([...this.routes.values()].filter(route => route.top && route.targetId === targetId).map(route => route.client));
        for (const client of owners) this.emit('routed', client, frame);
        return;
      }
      this.emit('routed', undefined, frame); return;
    }
    const route = this.routes.get(frame.sessionId);
    if (!route) return; // A session that no client owns has no listener.
    if (frame.method === 'Target.attachedToTarget' && sessionPattern(params.sessionId)) {
      if (this.routes.size >= this.maxRoutes) { this.park('route bank full'); return; }
      if (!this.routes.has(params.sessionId)) this.routes.set(params.sessionId, { client: route.client, top: false });
    }
    this.emit('routed', route.client, frame);
    if (frame.method === 'Target.detachedFromTarget' && sessionPattern(params.sessionId)) this.routes.delete(params.sessionId);
  }

  // The v3 path. Playwright's traffic arrives here through an authenticated channel. Semantic
  // authority (this click, that fill, payments) is decided in the worker by v3-context and the
  // shared rules before any command exists, so this method grants no operation. It checks
  // transport access only: the client, the epoch, the app incarnation, the method class and
  // the session ownership, and it repeats those checks after every await.
  async transportSend(client, { method, params = {}, sessionId } = {}, { signal } = {}) {
    if (this.state !== 'ready') throw new Error('broker parked');
    if (!this.clients.has(client) || client.epoch !== this.epoch) throw new Error('unauthenticated client');
    if (!transportCallAllowed(method, params, sessionId)) throw new Error('CDP_COMMAND_REFUSED');
    if (sessionId !== undefined && (!sessionPattern(sessionId) || this.routes.get(sessionId)?.client !== client)) throw new Error('CDP_SESSION_NOT_OWNED');
    this.ownsParamSessions(client, params);
    if (this.queued >= this.maxTransportQueue) throw new Error('authorization queue full');
    const epoch = this.epoch;
    this.queued++;
    try {
      await this.fresh();
    } catch (error) {
      this.park(error.message); throw error;
    } finally { this.queued--; }
    if (epoch !== this.epoch || this.state !== 'ready') throw new Error('broker parked during preparation');
    if (!this.clients.has(client)) throw new Error('client detached during preparation');
    if (sessionId !== undefined && this.routes.get(sessionId)?.client !== client) throw new Error('CDP_SESSION_NOT_OWNED');
    this.ownsParamSessions(client, params);
    if (method === 'Target.attachToTarget') {
      await this.admitted(params.targetId);
      if (epoch !== this.epoch || this.state !== 'ready' || !this.clients.has(client)) throw new Error('broker parked during preparation');
    }
    if (signal?.aborted) throw new Error('cancelled before dispatch');
    try {
      const result = await this.pipe.request(method, params, { signal, sessionId });
      if (epoch !== this.epoch) throw Object.assign(new Error('authority changed in flight; effect unknown'), { dispatched: true });
      if (method === 'Target.attachToTarget' && sessionPattern(result?.sessionId)) {
        if (this.routes.size >= this.maxRoutes || this.routes.has(result.sessionId)) { this.park('route bank full'); throw new Error('CDP_SESSION_NOT_OWNED'); }
        this.routes.set(result.sessionId, { client, top: sessionId === undefined, targetId: params.targetId });
      } else if (method === 'Target.detachFromTarget' && sessionPattern(params.sessionId) && this.routes.get(params.sessionId)?.client === client) {
        this.routes.delete(params.sessionId);
      }
      return result;
    } catch (error) {
      // A command the app answered with an error is an ordinary failure. Anything else leaves
      // the effect unknown, so the connection parks (resumable: the pipe itself may be healthy).
      if (error.cdp !== true && epoch === this.epoch) this.park(error.message, { resumable: !this.pipe.failed });
      throw error;
    }
  }

  // The target's own info from the app, judged by the parent's callback, before any attach is written.
  async admitted(targetId) {
    if (typeof this.admitTarget !== 'function') throw new Error('CDP_TARGET_NOT_OWNED');
    let info;
    try { info = (await this.pipe.request('Target.getTargetInfo', { targetId })).targetInfo; }
    catch (error) { if (error.cdp === true) throw new Error('CDP_TARGET_NOT_OWNED'); throw error; }
    let admitted = false;
    try { admitted = plainObject(info) && info.targetId === targetId && await this.admitTarget(Object.freeze({ ...info })) === true; } catch { admitted = false; }
    if (!admitted) throw new Error('CDP_TARGET_NOT_OWNED');
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
    if (this.preparing >= 64) throw new Error('authorization queue full');
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
      const result = await this.pipe.request(command.method, command.params, { signal, sessionId: command.sessionId });
      if (epoch !== this.epoch) return this.receipt({ ...receipt, phase: 'unknown', reason: 'authority changed in flight' });
      return this.receipt({ ...receipt, phase: 'observed', result });
    } catch (error) {
      this.park(error.message);
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
    this.park('user quit');
    try {
      const observed = await this.inspect();
      if (observed.parent && !same(observed.parent, this.identity)) throw new Error('PID reused');
      // Host callback must use the app's own Quit, never a signal or title-only target.
      if (observed.parent) await this.child.requestQuit(this.identity);
    } catch (error) { return this.receipt({ cleanup: 'retained', reason: error.message }); }
    return this.collect();
  }

  async collect() {
    if (this.state === 'collected') return this.receipt({ cleanup: 'removed', exitCode: this.exitCode });
    this.park('collection');
    try {
      const observed = await this.inspect();
      if (observed.parent || observed.descendants.length) throw new Error('processes remain');
      // Census must explicitly account for the union, not only current children
      // (orphaned descendants no longer appear under the exited parent).
      if (this.descendants.size && await this.child.confirmAbsent?.([...this.descendants.values()]) !== true) {
        throw new Error('observed descendant absence unproved');
      }
      await this.ownership.remove(this.owned);
      this.pipe?.fail(new Error('owned app collected'));
      this.child.input.end();
      this.child.output.destroy();
      this.state = 'collected';
      return this.receipt({ cleanup: 'removed', exitCode: this.exitCode });
    } catch (error) { return this.receipt({ cleanup: 'retained', reason: error.message }); }
  }
}
