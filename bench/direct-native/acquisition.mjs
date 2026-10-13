// Offline NP-6 prototype. No process launcher or engine adapter is installed here.
// The trusted adapter must wrap the existing relay, including effective policy, app
// approval, lease/document/review/flow/clipboard gates and current-turn handling.
const fields = ['sessionId', 'runtimeEpoch', 'appId', 'pid', 'processStart', 'windowId',
  'documentId', 'leaseGeneration', 'policyGeneration'];
const refusalCodes = new Set(['DENIED', 'FORBIDDEN', 'APPROVAL_REQUIRED', 'LEASE_BUSY', 'USER_TAKEOVER', 'TARGET_STALE']);
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => fields.every(key => a?.[key] === b?.[key]);
const valid = b => b && fields.every(key => b[key] !== undefined && b[key] !== null && b[key] !== '') &&
  Number.isSafeInteger(b.pid) && b.pid > 0 && Number.isFinite(b.processStart);
const identity = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const ready = connection => connection && identity(connection.buildKey) && identity(connection.protocolKey) &&
  (identity(connection.runtimeEpoch) || (Number.isSafeInteger(connection.runtimeEpoch) && connection.runtimeEpoch > 0));

// Static text only, keyed by trusted build/protocol identity. Never put instructions,
// observations, approvals, handles or environment values into this shared cache.
export class CapabilityCache {
  #entries = new Map();
  get(build, protocol) { return this.#entries.get(JSON.stringify([build, protocol])); }
  set(build, protocol, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw fail('ENGINE_UNAVAILABLE');
    const key = JSON.stringify([build, protocol]);
    this.#entries.delete(key); this.#entries.set(key, text);
    while (this.#entries.size > 8) this.#entries.delete(this.#entries.keys().next().value);
  }
}

export class NativeAcquisition {
  #sessionId; #launcher; #adapter; #now; #invalidate; #cache;
  #resource; #connection; #record; #generation = 0; #pending; #closed = false; #denied;
  #closing; #stale = false; #capabilitiesSent = false; #warmups = 0; #unusedWarmups = 0; #movedMs = 0;
  constructor({ sessionId, launcher, adapter, now = () => performance.now(), invalidate, cache = new CapabilityCache() }) {
    if (!sessionId || typeof invalidate !== 'function') throw new TypeError('session and reference invalidator required');
    for (const method of ['start', 'connect', 'dispose']) if (typeof launcher?.[method] !== 'function') throw new TypeError(`launcher.${method} required`);
    for (const method of ['acquire', 'binding', 'instructions', 'capabilities', 'execute']) {
      if (typeof adapter?.[method] !== 'function') throw new TypeError(`guarded adapter.${method} required`);
    }
    this.#sessionId = sessionId; this.#launcher = launcher; this.#adapter = adapter;
    this.#now = now; this.#invalidate = invalidate; this.#cache = cache;
  }
  #live(generation) {
    if (generation !== this.#generation) throw fail('TARGET_STALE');
    if (this.#closed) throw fail('ENGINE_UNAVAILABLE');
    if (this.#denied) throw fail(this.#denied);
    if (this.#stale) throw fail('TARGET_STALE');
  }
  #retire(reason) {
    this.#record = undefined;
    if (reason !== 'reset' && reason !== 'DENIED') this.#stale = true;
    this.#invalidate(reason);
  }
  async #phase(receipt, name, fn) {
    const start = this.#now(); receipt.boundaries[name] = { start, end: null };
    try { return await fn(); }
    finally { receipt.boundaries[name].end = this.#now(); receipt.ms[name] = this.#now() - start; }
  }
  #receipt() {
    return { state: this.#connection ? 'runtime-warm' : 'cold', retained: false,
      initialObservationIncluded: false, boundaries: {},
      ms: { launcher: 0, connectionReady: 0, preApprovalBracket: null, publicAcquisition: 0,
        resultDelivery: 0, total: null, policy: null, internalCapture: null, nativeQueue: null },
      cpuSeconds: null, rssBytes: null, effect: 'none' };
  }
  async #ready(receipt, generation) {
    if (this.#connection) {
      if (!ready(this.#connection)) throw fail('ENGINE_UNAVAILABLE');
      return;
    }
    // A failed cleanup retains this exact owned start. Do not overwrite it or
    // reconnect through partially initialized state while its cleanup is unknown.
    if (this.#resource) {
      await this.#phase(receipt, 'cleanup', () => this.#dispose());
      this.#live(generation);
    }
    try {
      const resource = await this.#phase(receipt, 'launcher', () => this.#launcher.start({ sessionId: this.#sessionId }));
      if (resource?.owned !== true) throw fail('ENGINE_UNAVAILABLE');
      this.#resource = resource;
      this.#live(generation);
      if (resource.helperState === 'warm') receipt.state = 'shared-helper-warm';
      const connection = await this.#phase(receipt, 'connectionReady', () => this.#launcher.connect(resource));
      this.#live(generation);
      if (!ready(connection)) throw fail('ENGINE_UNAVAILABLE');
      this.#connection = connection;
    } catch (error) {
      this.#connection = undefined;
      // Keep ownership on a failed disposal. The next attempt must resolve it
      // before starting, and reset/shutdown can retry that same owned resource.
      await this.#dispose().catch(() => {});
      throw error;
    }
  }
  async #dispose() {
    const resource = this.#resource;
    if (!resource) return;
    await this.#launcher.dispose(resource);
    if (this.#resource === resource) this.#resource = undefined;
  }
  #run(fn) {
    if (this.#closing) return Promise.reject(fail('LEASE_BUSY'));
    if (this.#pending) return Promise.reject(fail('LEASE_BUSY'));
    const generation = this.#generation;
    const pending = Promise.resolve().then(() => { this.#live(generation); return fn(generation); });
    this.#pending = pending;
    return pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; });
  }
  async #check(record, generation, context) {
    const checked = await this.#adapter.binding(this.#connection, record.handle, context);
    this.#live(generation);
    if (checked?.allowed !== true) throw fail('DENIED');
    if (!valid(checked.binding) || !same(record.binding, checked.binding)) {
      this.#retire('binding-changed'); throw fail('TARGET_STALE');
    }
  }
  open({ app, turnId, actions = [] } = {}, deliver = async () => {}) {
    if (typeof app !== 'string' || !app || app.length > 512 || typeof turnId !== 'string' || !turnId ||
        !Array.isArray(actions) || actions.length > 16 || typeof deliver !== 'function') return Promise.reject(fail('TARGET_STALE'));
    // Copy compiler-owned input before any await. Grammar and request-size validation
    // remain NP-3's responsibility; this route never interprets or rewrites actions.
    const input = structuredClone(actions);
    return this.#run(async generation => {
      const receipt = this.#receipt(), started = this.#now();
      try {
        await this.#ready(receipt, generation);
        const context = { sessionId: this.#sessionId, turnId };
        if (this.#adapter.preApproval) {
          await this.#phase(receipt, 'preApprovalBracket', () => this.#adapter.preApproval(this.#connection, app, context));
          this.#live(generation);
        }
        let observation = null;
        if (this.#record) {
          if (this.#record.app !== app) { this.#retire('app-changed'); throw fail('TARGET_STALE'); }
          await this.#check(this.#record, generation, context); receipt.retained = true;
        } else {
          const acquired = await this.#phase(receipt, 'publicAcquisition', () => this.#adapter.acquire(this.#connection, app, context));
          this.#live(generation);
          if (!acquired?.handle || !valid(acquired.binding) || acquired.binding.sessionId !== this.#sessionId ||
              acquired.binding.runtimeEpoch !== this.#connection.runtimeEpoch ||
              (acquired.binding.appId !== app && acquired.binding.appName !== app)) {
            this.#retire('acquisition-mismatch'); throw fail('TARGET_STALE');
          }
          this.#record = { app, handle: acquired.handle, binding: { ...acquired.binding } };
          await this.#check(this.#record, generation, context);
          observation = acquired.observation ?? null;
          receipt.initialObservationIncluded = observation !== null;
        }
        const instructions = await this.#adapter.instructions(this.#connection, context);
        this.#live(generation);
        if (typeof instructions !== 'string' || !instructions) throw fail('ENGINE_UNAVAILABLE');
        const { buildKey, protocolKey } = this.#connection;
        let capabilities = null;
        if (!this.#capabilitiesSent) {
          capabilities = this.#cache.get(buildKey, protocolKey);
          if (capabilities === undefined) {
            capabilities = await this.#adapter.capabilities(this.#connection);
            this.#live(generation); this.#cache.set(buildKey, protocolKey, capabilities);
          }
        }
        let actionResult = null;
        if (input.length) {
          // From this point a lost reply means an unknown effect. Only the guarded
          // executor can establish the completed prefix. Never automatically replay.
          receipt.effect = 'unknown';
          actionResult = await this.#adapter.execute(this.#connection, this.#record.handle, input, context);
          this.#live(generation);
          receipt.effect = 'adapter-reported';
        }
        await this.#check(this.#record, generation, context);
        const result = { observation, actionResult, instructions, capabilities };
        await this.#phase(receipt, 'resultDelivery', () => deliver(structuredClone(result)));
        this.#live(generation);
        this.#capabilitiesSent = true; this.#unusedWarmups = 0;
        receipt.ms.total = this.#now() - started;
        return { result, receipt };
      } catch (error) {
        const code = refusalCodes.has(error?.code) ? error.code : 'ENGINE_UNAVAILABLE';
        if (code === 'DENIED') this.#retire(code);
        if (code === 'FORBIDDEN') { this.#denied = code; this.#retire(code); }
        // An uncertain action blocks further dispatch until an explicit reset. That
        // reset invalidates evidence; it never retries the action or resets a service.
        if (receipt.effect === 'unknown') { this.#denied ??= 'ENGINE_UNAVAILABLE'; this.#retire('effect-unknown'); }
        receipt.ms.total = this.#now() - started;
        throw Object.assign(fail(code), { receipt });
      }
    });
  }
  warmup({ independentWorkAuthorized = false } = {}) {
    if (!independentWorkAuthorized) return Promise.reject(fail('APPROVAL_REQUIRED'));
    return this.#run(async generation => {
      const receipt = this.#receipt(), started = this.#now();
      if (!this.#connection) {
        await this.#ready(receipt, generation);
        this.#warmups++; this.#unusedWarmups++; this.#movedMs += this.#now() - started;
      }
      return receipt;
    });
  }
  accounting() {
    return { warmups: this.#warmups, unusedWarmups: this.#unusedWarmups, movedMs: this.#movedMs, elapsedTaskSavingsMs: null };
  }
  reset() {
    if (this.#closing) return this.#closing;
    this.#generation++; this.#retire('reset');
    const pending = this.#pending;
    this.#closing = (async () => {
      try {
        await pending?.catch(() => {});
        this.#connection = undefined; this.#capabilitiesSent = false;
        await this.#dispose();
        this.#stale = false;
        // Reset clears unknown-effect fencing, never replaying the prior action.
        if (this.#denied === 'ENGINE_UNAVAILABLE') this.#denied = undefined;
      } finally { this.#closing = undefined; }
    })();
    return this.#closing;
  }
  async shutdown() {
    if (this.#closed && !this.#resource && !this.#closing) return;
    this.#closed = true;
    await this.reset();
  }
}
