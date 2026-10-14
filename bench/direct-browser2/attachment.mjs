// Broker-only coordinator: one autoAttachRelated policy on the accepted socket.
// Protocol reference: Chrome DevTools Target domain; no root pause-all registration.
export const scopeKeys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn',
  'targetId', 'leaseGeneration', 'frameId', 'documentGeneration', 'operationSequence', 'origin'];

export function validScope(scope) {
  return scope && scopeKeys.every(key => typeof scope[key] === 'string' ? scope[key].length > 0 && scope[key].length < 512 :
    Number.isSafeInteger(scope[key]) && scope[key] > 0) && /^https?:\/\//.test(scope.origin);
}
export function sameScope(a, b) { return scopeKeys.every(key => a?.[key] === b?.[key]); }
export function receipt(scope, phase = 'prepared', effect = 'none', next = null) {
  return { phase, effect, completed: [], untouched: [], next,
    identity: scope ? Object.fromEntries(scopeKeys.filter(key => key !== 'origin').map(key => [key, scope[key]])) : null };
}
export async function bounded(fn, timeoutMs, signal) {
  let timer;
  let abort;
  try {
    if (signal?.aborted) throw Error('CANCELLED');
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('DEADLINE')), timeoutMs);
        abort = () => reject(Error('CANCELLED'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export async function granted(authorize, scope, operation, timeoutMs, args) {
  try { return await bounded(() => authorize(scope, operation, args), timeoutMs) === true; }
  catch { return false; }
}

export class ScopedAttachment {
  constructor({ session, authorize, setup, timeoutMs = 1000, proveOwned = async () => false,
    proveAbsent = async () => false, creatorScope = async () => null, resolveScope = async () => null }) {
    if (!session?.send || !session.on || !session.off || !session.sessionId || typeof authorize !== 'function') throw Error('INVALID_ADAPTER');
    this.session = session;
    this.authorize = authorize;
    this.setup = setup;
    this.timeoutMs = timeoutMs;
    this.proveOwned = proveOwned;
    this.proveAbsent = proveAbsent;
    this.creatorScope = creatorScope;
    this.resolveScope = resolveScope;
    this.roots = new Map();
    this.records = new Map();
    this.pending = new Set();
    this.watches = new Set();
    this.inFlight = new Set();
    this.registrations = new Map();
    this.registrationGeneration = 0;
    this.closed = false;
    this.closing = false;
    // Subscribe before the first registration: existing children can arrive in its response race.
    this.listener = (event, sourceSessionId = session.sessionId) => {
      if (this.closed) return;
      const parent = this.roots.get(event.targetInfo?.openerId) ?? this.records.get(event.targetInfo?.openerId)?.scope ??
        [...this.records.values()].find(record => record.sessionId === sourceSessionId)?.scope ??
        this.roots.get(event.targetInfo?.targetId);
      if (!parent || !event.sessionId || !event.targetInfo?.targetId) return;
      const previous = [...this.records.values()].find(record => record.sessionId === event.sessionId);
      if (previous) return;
      const task = this.accept(event, parent, this.closing || this.records.has(event.targetInfo.targetId)).catch(() => {});
      this.pending.add(task);
      task.finally(() => this.pending.delete(task));
    };
    session.on('Target.attachedToTarget', this.listener);
  }

  watch(scope) {
    const task = this.watchScope(scope);
    this.watches.add(task);
    task.then(() => this.watches.delete(task), () => this.watches.delete(task));
    return task;
  }
  async watchScope(scope) {
    if (this.closed || this.closing || !validScope(scope) || !await granted(this.authorize, scope, 'attach', this.timeoutMs)) throw Error('PERMISSION_REQUIRED');
    if (this.closed || this.closing) return receipt(scope, 'prepared', 'none', 'cleanup-required');
    if (this.roots.has(scope.targetId)) {
      if (!sameScope(this.roots.get(scope.targetId), scope)) throw Error('ATTACHMENT_UNKNOWN');
      return;
    }
    try {
      await bounded(() => {
        if (this.closed || this.closing) throw Error('CANCELLED');
        this.roots.set(scope.targetId, Object.freeze({ ...scope }));
        return this.sendOwned(scope, 'Target.autoAttachRelated', {
          targetId: scope.targetId, waitForDebuggerOnStart: true,
        });
      }, this.timeoutMs);
      if (this.closing || this.closed) return receipt(scope, 'dispatched', 'unknown', 'cleanup-required');
    } catch {
      // Registration could have reached Chrome. Preserve the root and listener for cleanup.
      throw Error('ATTACHMENT_UNKNOWN');
    }
  }

  // Retain the actual command lifetime separately from a client's bounded wait.
  // A deadline is not proof that Chrome declined a registration. Late replies
  // can provide exact removal identifiers, but never trigger more setup.
  sendOwned(scope, method, params, sessionId = this.session.sessionId, hook) {
    if (this.closed || this.closing) throw Error('CANCELLED');
    const record = { scope: Object.freeze({ ...scope }), method, sessionId, pending: true };
    this.inFlight.add(record);
    if (method === 'Target.autoAttachRelated' || (method === 'Target.setAutoAttach' && params.autoAttach)) {
      record.generation = ++this.registrationGeneration;
      this.registrations.set(record.generation, record);
    }
    if (hook) {
      hook.pending++;
      if (method === 'Page.addScriptToEvaluateOnNewDocument') hook.futureDispatched = true;
    }
    let raw;
    try { raw = Promise.resolve(this.session.send(method, params, sessionId)); }
    catch (error) { raw = Promise.reject(error); }
    const settled = () => { record.pending = false; this.inFlight.delete(record); if (hook) hook.pending--; };
    return raw.then(value => {
      if (hook && method === 'Page.addScriptToEvaluateOnNewDocument' && value?.identifier) hook.identifier = value.identifier;
      settled(); return value;
    }, error => { settled(); throw error; });
  }

  async accept(event, parent, releaseOnly = false) {
    const info = event.targetInfo;
    const scope = { ...parent, targetId: info.targetId };
    const record = { scope, sessionId: event.sessionId, state: 'setting-up', receipt: receipt(scope) };
    this.records.set(this.records.has(info.targetId) ? event.sessionId : info.targetId, record);
    if (releaseOnly) {
      record.receipt.next = 'cleanup-required';
      await this.release(record, event.waitingForDebugger === true);
      return;
    }
    const controller = new AbortController();
    const end = Date.now() + this.timeoutMs;
    const remaining = () => Math.max(1, end - Date.now());
    try {
      let origin;
      try { origin = new URL(info.url).origin; } catch {}
      if (!origin || origin === 'null') {
        const creator = await bounded(() => this.creatorScope(info, parent), remaining());
        if (!creator || !sameScope(creator, parent)) { record.receipt.next = 'unattributed'; return; }
        origin = parent.origin;
      }
      // Target events do not supply a document/lease proof. Broker reconciliation must supply it.
      const resolved = await bounded(() => this.resolveScope(info, parent, origin), remaining());
      if (!validScope(resolved) || resolved.targetId !== info.targetId || resolved.origin !== origin ||
        ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn'].some(key => resolved[key] !== parent[key])) {
        record.receipt.next = 'unattributed'; return;
      }
      Object.assign(scope, resolved);
      if (!await granted(this.authorize, scope, 'popup-child', remaining())) {
        record.receipt.next = 'permission-required'; return;
      }
      if (info.type !== 'page') {
        record.receipt.next = info.type === 'iframe' ? 'BACKGROUND_UNAVAILABLE' : 'unsupported-target'; return;
      }
      const send = async (method, params, hook) => {
        if (controller.signal.aborted || Date.now() >= end || this.closed || this.closing) throw Error('CANCELLED');
        if (!await granted(this.authorize, scope, 'popup-setup', remaining())) throw Error('PERMISSION_REQUIRED');
        if (controller.signal.aborted || Date.now() >= end || this.closed || this.closing) throw Error('CANCELLED');
        return bounded(() => {
          if (controller.signal.aborted || Date.now() >= end || this.closed || this.closing) throw Error('CANCELLED');
          return this.sendOwned(scope, method, params, event.sessionId, hook);
        }, Math.max(1, end - Date.now()), controller.signal);
      };
      await bounded(() => this.setup(scope, { send, signal: controller.signal, sessionId: event.sessionId }), remaining());
      // Recursively watches only this authorized child's related targets, never the browser root.
      record.registration = true;
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      record.receipt = receipt(scope, 'observed', 'unknown', 'focus-unqualified');
    } catch {
      record.receipt = receipt(scope, 'dispatched', 'unknown', 'BACKGROUND_UNAVAILABLE');
    } finally {
      controller.abort();
      await this.release(record, event.waitingForDebugger === true);
    }
  }

  async release(record, paused) {
    if (!paused) { record.state = 'running'; return; }
    try {
      await bounded(() => this.session.send('Runtime.runIfWaitingForDebugger', {}, record.sessionId), this.timeoutMs);
      record.state = 'resumed';
    } catch {
      record.state = 'cleanup-unproved';
      record.receipt = receipt(record.scope, 'dispatched', 'unknown', 'cleanup-required');
      try {
        if (await bounded(() => this.proveOwned(record.scope), this.timeoutMs) === true) {
          await bounded(() => this.session.send('Target.closeTarget', { targetId: record.scope.targetId }), this.timeoutMs);
          if (await bounded(() => this.proveAbsent(record.scope), this.timeoutMs) === true) record.state = 'closed';
        }
      } catch { /* Keep exact ownership and unknown cleanup for the broker's handoff. */ }
    }
  }

  async drain() { while (this.pending.size) await Promise.all([...this.pending]); }
  async clearRegistrations(sessionId, method) {
    // Only completions preceding this dispatch are covered by its removal proof.
    // An enable that settles during the clear response needs a later clear.
    await bounded(async () => {
      const covered = [...this.registrations.values()].filter(record =>
        !record.pending && record.sessionId === sessionId && record.method === method);
      await this.session.send('Target.setAutoAttach', {
        autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
      }, sessionId);
      for (const record of covered) this.registrations.delete(record.generation);
    }, this.timeoutMs);
  }
  dispose() {
    this.closing = true;
    if (!this.disposal) this.disposal = this.cleanup().finally(() => { this.disposal = null; });
    return this.disposal;
  }
  async cleanup() {
    if (this.closed) return [];
    this.closing = true;
    await this.drain();
    const cleanup = [];
    let rootsRemoved = false;
    // This coordinator exclusively owns the browser's related registrations. Clearing does not pause.
    if (this.roots.size) {
      try {
        await this.clearRegistrations(this.session.sessionId, 'Target.autoAttachRelated');
        rootsRemoved = true;
      } catch {
        for (const scope of this.roots.values()) cleanup.push(receipt(scope, 'dispatched', 'unknown', 'cleanup-required'));
      }
    }
    for (const record of this.records.values()) {
      if (record.registration) {
        try {
          await this.clearRegistrations(record.sessionId, 'Target.setAutoAttach');
          record.registration = [...this.registrations.values()].some(pending =>
            pending.method === 'Target.setAutoAttach' && pending.sessionId === record.sessionId);
        } catch { cleanup.push(receipt(record.scope, 'dispatched', 'unknown', 'cleanup-required')); }
      }
      if (record.state === 'cleanup-unproved') await this.release(record, true);
      if (record.state === 'cleanup-unproved') cleanup.push(receipt(record.scope, 'dispatched', 'unknown', 'cleanup-required'));
    }
    await this.drain();
    // An earlier dispatch can still register after a successful clear response.
    // Keep its root/listener until a clear dispatched after completion succeeds.
    for (const pending of new Set([...this.inFlight, ...this.registrations.values()])) cleanup.push(receipt(pending.scope, 'dispatched', 'unknown', 'cleanup-required'));
    if (this.pending.size) for (const scope of this.roots.values()) cleanup.push(receipt(scope, 'dispatched', 'unknown', 'cleanup-required'));
    if (rootsRemoved && !this.inFlight.size && !this.registrations.size && !this.pending.size) this.roots.clear();
    if (!this.roots.size && !this.inFlight.size && !this.registrations.size && !this.pending.size && ![...this.records.values()].some(record => record.registration || record.state === 'cleanup-unproved')) {
      this.closed = true;
      this.session.off('Target.attachedToTarget', this.listener);
    }
    return cleanup;
  }
}
