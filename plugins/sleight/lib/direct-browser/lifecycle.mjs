import { randomUUID, timingSafeEqual } from 'node:crypto';

// Lifecycle ideas: FowlBrowser 8b689249ba4e33d2626487aad930605c62e2c6a7
// mcp/src/turns.mjs and takeover.mjs (MIT). New implementation, no copied code.
// Adapters below are trusted host dependencies,
// never frontend callbacks. BP2-1/2 supply policy, identity and durable storage.
const operations = new Set(['open', 'read', 'click', 'key', 'select', 'scroll', 'drag', 'hover', 'wait', 'dialog', 'fill']);
const identityKeys = ['incarnation', 'brokerEpoch', 'endpoint', 'session', 'turn', 'targetId',
  'targetGeneration', 'leaseGeneration', 'frame', 'document', 'origin'];
const observedKeys = identityKeys.filter((key) => !['turn', 'leaseGeneration'].includes(key));
const copy = (value) => structuredClone(value);
const same = (a, b, keys = identityKeys) => keys.every((key) => a?.[key] === b?.[key]);
const secretEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const freeze = (value) => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

export async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(work()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DEADLINE_EXCEEDED')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export class Lifecycle {
  #verifyAuthority;
  #verifyConnection;
  #observe;
  #send;
  #timeout;
  #closeConnection;
  #saveJournal;
  #cdp;
  #browser;
  #connection = 'disconnected';
  #fence = 0;
  #refEpoch = 0;
  #records = new Map();
  #leases = new WeakMap();
  #tokens = new WeakMap();
  #operations = new Map();
  #turns = new Map();
  #intents = new WeakMap();
  #listeners = [];
  #disconnectPending = false;

  constructor({ verifyAuthority = () => false, verifyConnection = () => false,
    observeTarget = () => { throw new Error('IDENTITY_UNAVAILABLE'); },
    dispatch = () => { throw new Error('DISPATCH_UNAVAILABLE'); }, closeConnection = () => false,
    saveJournal = () => false, recovery, timeoutMs = 1500 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('INVALID_DEADLINE');
    this.#verifyAuthority = verifyAuthority;
    this.#verifyConnection = verifyConnection;
    this.#observe = observeTarget;
    this.#send = dispatch;
    this.#timeout = timeoutMs;
    this.#closeConnection = closeConnection;
    this.#saveJournal = saveJournal;
    if (recovery) this.#restore(recovery);
  }

  get state() { return { connection: this.#connection, needsBrowserConsent: !['connected', 'paused'].includes(this.#connection),
    refEpoch: this.#refEpoch, fence: this.#fence, browser: copy(this.#browser) }; }
  // Ownership journal contains identity/status only, never input values or page data.
  get records() { return [...this.#records.values()].map((r) => ({ ...copy(r.identity), status: r.status,
    owned: r.owned, ephemeral: r.ephemeral, kept: r.kept, cleanup: copy(r.cleanup) })); }

  journal() { return { version: 1, records: this.records, operations: [...this.#operations.values()].map((o) => copy(o.receipt)) }; }
  #persist() { try { return this.#saveJournal(this.journal()) === true; } catch { return false; } }
  #restore(journal) {
    if (journal.version !== 1 || !Array.isArray(journal.records) || !Array.isArray(journal.operations)) throw new Error('INVALID_JOURNAL');
    for (const saved of journal.records) {
      const identity = Object.fromEntries(identityKeys.map((key) => [key, saved[key]]));
      if (!identityKeys.every((key) => identity[key] !== undefined)) throw new Error('INVALID_JOURNAL');
      const key = JSON.stringify([identity.incarnation, identity.targetId]);
      if (this.#records.has(key)) throw new Error('INVALID_JOURNAL');
      this.#records.set(key, { key, identity: freeze(identity), owned: saved.owned === true, ephemeral: saved.ephemeral === true,
        kept: saved.kept === true, status: 'parked', generation: 1, cleanup: copy(saved.cleanup) });
    }
    for (const saved of journal.operations) {
      const key = JSON.stringify([saved.session, saved.turn, saved.operation]);
      const sent = saved.phase !== 'prepared';
      const receipt = copy(saved);
      if (!['verified', 'observed'].includes(saved.phase) || saved.effect === 'unknown') {
        receipt.effect = sent ? 'unknown' : 'none';
        receipt.code = sent ? 'EFFECT_UNKNOWN' : 'LEASE_LOST';
        receipt.next = 'read fresh state before explicit resume';
      }
      this.#operations.set(key, { receipt, done: true });
    }
  }

  retainedReceipt(session, turn, operation) {
    const receipt = this.#operations.get(JSON.stringify([session, turn, operation]))?.receipt;
    return receipt ? copy(receipt) : null;
  }

  async authorize(proof, context) {
    try { return await bounded(() => this.#verifyAuthority(proof, freeze(copy(context))), this.#timeout) === true; }
    catch { return false; }
  }

  async connect(cdp, browser, proof) {
    if (this.#disconnectPending) throw new Error('DISCONNECT_UNCONFIRMED');
    if (['connected', 'paused'].includes(this.#connection)) throw new Error('CONNECTION_ALREADY_PRESENT');
    if (!browser?.incarnation || !browser?.brokerEpoch || !browser?.endpoint ||
      !['send', 'on', 'off'].every((name) => typeof cdp?.[name] === 'function') || !cdp.sessionId) throw new Error('INVALID_CONNECTION');
    const fence = this.#fence;
    const accepted = await bounded(() => this.#verifyConnection(proof, freeze(copy(browser)), cdp.sessionId), this.#timeout).catch(() => false);
    if (accepted !== true || fence !== this.#fence) throw new Error('CONNECTION_APPROVAL_REQUIRED');
    // A concurrent approval may have installed its socket while this one waited.
    if (['connected', 'paused'].includes(this.#connection)) throw new Error('CONNECTION_ALREADY_PRESENT');
    this.#unlisten();
    this.#browser = freeze(copy(browser));
    this.#cdp = cdp;
    this.#connection = 'connected';
    const lost = () => { if (this.#cdp === cdp) this.loseConnection('socket-loss'); };
    for (const name of ['disconnected', 'close']) { cdp.on(name, lost); this.#listeners.push([cdp, name, lost]); }
    const targetLost = ({ targetId }) => {
      for (const record of this.#records.values()) {
        if (record.identity.targetId === targetId && !record.closing) this.#cancelRecord(record, 'LEASE_LOST');
      }
      this.#refEpoch++;
      this.#persist();
    };
    for (const name of ['Target.targetDestroyed', 'Target.detachedFromTarget']) {
      cdp.on(name, targetLost); this.#listeners.push([cdp, name, targetLost]);
    }
  }

  #unlisten() { for (const [cdp, name, fn] of this.#listeners) cdp.off(name, fn); this.#listeners = []; }

  #cancelRecord(record, code) {
    record.generation++;
    record.status = 'parked';
    for (const operation of this.#operations.values()) {
      if (operation.record !== record || operation.done) continue;
      const sent = operation.receipt.phase !== 'prepared';
      operation.done = true;
      operation.controller?.abort();
      operation.receipt = { ...operation.receipt, phase: sent ? 'dispatched' : 'prepared',
        effect: sent ? 'unknown' : 'none', code: sent ? 'EFFECT_UNKNOWN' : code, next: 'read fresh state before explicit resume' };
    }
  }

  loseConnection(reason) {
    this.#fence++;
    this.#refEpoch++;
    this.#connection = 'disconnected';
    this.#unlisten();
    for (const record of this.#records.values()) this.#cancelRecord(record, 'LEASE_LOST');
    for (const turn of this.#turns.values()) turn.valid = false;
    this.#persist();
    // Keep journal and receipts. Replacing the socket cannot restore old handles.
    return { reason, ...this.state };
  }

  async disconnect() {
    const cdp = this.#cdp;
    this.#disconnectPending = true;
    this.loseConnection('native-disconnect');
    const closed = await bounded(() => this.#closeConnection(cdp), this.#timeout).catch(() => false);
    if (closed === true) this.#disconnectPending = false;
    return { connectionClosed: closed === true, code: closed === true ? 'DISCONNECTED' : 'DISCONNECT_UNCONFIRMED' };
  }

  pause(reason, session) {
    this.#refEpoch++;
    if (!session) { this.#fence++; if (this.#connection === 'connected') this.#connection = 'paused'; }
    for (const record of this.#records.values()) {
      if (!session || record.identity.session === session) this.#cancelRecord(record, 'USER_TAKEOVER');
    }
    this.#persist();
    return { reason, connection: this.#connection };
  }

  frontendLost(session, frontend) {
    const turn = this.#turns.get(session);
    if (!turn || turn.frontend !== frontend) return false;
    turn.valid = false;
    this.pause('frontend-death', session);
    return true;
  }

  beginTurn(session, turn, frontend) {
    if (![session, turn, frontend].every((s) => typeof s === 'string' && s.length > 0 && s.length < 256) ||
      this.#connection !== 'connected') throw new Error('INVALID_TURN');
    const old = this.#turns.get(session);
    if (old?.valid && old.turn === turn && old.frontend === frontend) return copy(old.hook);
    if (old) { old.valid = false; this.pause('new-turn', session); }
    const hook = { version: 1, session, turn, brokerEpoch: this.#browser.brokerEpoch,
      channelGeneration: frontend, nonce: randomUUID() };
    this.#turns.set(session, { session, turn, frontend, hook, valid: true, ending: false, cleanup: null });
    return copy(hook);
  }

  #validIdentity(identity) {
    if (!identityKeys.every((k) => identity?.[k] !== undefined && identity[k] !== null && identity[k] !== '') ||
      !same(identity, this.#browser, ['incarnation', 'brokerEpoch', 'endpoint'])) throw new Error('IDENTITY_MISMATCH');
    const turn = this.#turns.get(identity.session);
    if (!turn?.valid || turn.ending || turn.turn !== identity.turn) throw new Error('STALE_TURN');
  }

  track(identity, { owned = false, ephemeral = false } = {}) {
    this.#validIdentity(identity);
    const key = JSON.stringify([identity.incarnation, identity.targetId]);
    if (this.#records.has(key)) throw new Error('TARGET_ALREADY_TRACKED');
    const record = { key, identity: freeze(copy(identity)), owned, ephemeral, kept: false,
      status: 'active', generation: 0, cleanup: null };
    this.#records.set(key, record);
    if (!this.#persist()) { record.status = 'parked'; throw new Error('JOURNAL_UNAVAILABLE'); }
    return this.#lease(record);
  }

  #lease(record) {
    const lease = Object.freeze({});
    this.#leases.set(lease, { record, generation: record.generation });
    return lease;
  }

  #active(lease) {
    const bound = this.#leases.get(lease);
    const record = bound?.record;
    const turn = record && this.#turns.get(record.identity.session);
    if (!record || record.generation !== bound.generation || record.status !== 'active' ||
      this.#records.get(record.key) !== record || this.#connection !== 'connected' || !turn?.valid || turn.ending ||
      turn.turn !== record.identity.turn || !same(record.identity, this.#browser, ['incarnation', 'brokerEpoch', 'endpoint'])) throw new Error('LEASE_LOST');
    return record;
  }

  describe(lease) {
    const record = this.#leases.get(lease)?.record;
    if (!record) throw new Error('LEASE_LOST');
    return copy(record.identity);
  }

  keep(lease) { this.#active(lease).kept = true; this.#persist(); }
  park(lease, reason = 'native-handoff') {
    const record = this.#active(lease);
    record.kept = true;
    this.#cancelRecord(record, 'LEASE_LOST');
    this.#persist();
    return { reason, identity: copy(record.identity) };
  }

  async revalidateParked(lease, proof) {
    const record = this.#leases.get(lease)?.record;
    if (!record || record.status !== 'parked' || this.#records.get(record.key) !== record ||
      this.#connection !== 'connected' || !same(record.identity, this.#browser,
        ['incarnation', 'brokerEpoch', 'endpoint'])) throw new Error('LEASE_LOST');
    const fence = this.#fence;
    const generation = record.generation;
    if (!await this.authorize(proof, { action: 'handoff-read', identity: record.identity })) throw new Error('PERMISSION_REQUIRED');
    const fresh = await bounded(() => this.#observe(record.identity.targetId), this.#timeout);
    if (fence !== this.#fence || generation !== record.generation || !same(fresh, record.identity,
      ['incarnation', 'brokerEpoch', 'endpoint', 'session', 'targetId', 'targetGeneration', 'origin'])) throw new Error('IDENTITY_MISMATCH');
    return copy(fresh);
  }

  async resume(lease, proof) {
    const record = this.#leases.get(lease)?.record;
    if (!record || this.#records.get(record.key) !== record || record.status !== 'parked' ||
      !['connected', 'paused'].includes(this.#connection)) throw new Error('LEASE_LOST');
    const fence = this.#fence;
    const generation = record.generation;
    const identity = record.identity;
    if (!await this.authorize(proof, { action: 'resume', identity })) throw new Error('PERMISSION_REQUIRED');
    const fresh = await bounded(() => this.#observe(identity.targetId), this.#timeout);
    if (fence !== this.#fence || record.generation !== generation || !same(fresh, this.#browser,
      ['incarnation', 'brokerEpoch', 'endpoint']) || !same(fresh, identity,
      ['incarnation', 'session', 'targetId', 'targetGeneration', 'origin'])) throw new Error('IDENTITY_MISMATCH');
    const turn = this.#turns.get(identity.session);
    if (!turn?.valid || turn.ending) throw new Error('STALE_TURN');
    record.identity = freeze({ ...copy(fresh), turn: turn.turn, leaseGeneration: identity.leaseGeneration + 1 });
    record.generation++;
    record.status = 'active';
    this.#connection = 'connected';
    if (!this.#persist()) { this.#cancelRecord(record, 'LEASE_LOST'); throw new Error('JOURNAL_UNAVAILABLE'); }
    return this.#lease(record);
  }

  prepare(lease, input) {
    const record = this.#active(lease);
    if (!operations.has(input.op)) throw new Error('UNSUPPORTED_OPERATION');
    if (typeof input.operation !== 'string' || !input.operation || input.operation.length > 256 ||
      !Number.isInteger(input.count ?? 1) || (input.count ?? 1) < 1 || (input.count ?? 1) > 16) throw new Error('INVALID_OPERATION');
    const request = freeze(copy({ ...input, count: input.count ?? 1, identity: record.identity }));
    const key = JSON.stringify([record.identity.session, record.identity.turn, input.operation]);
    const old = this.#operations.get(key);
    if (old) {
      if (!old.request || JSON.stringify(old.request) !== JSON.stringify(request)) throw new Error('OPERATION_ID_REUSED');
      return old.token;
    }
    const token = Object.freeze({});
    const entry = { token, key, request, record, generation: record.generation, fence: this.#fence, done: false,
      running: null, receipt: { session: record.identity.session, turn: record.identity.turn, operation: input.operation,
        phase: 'prepared', effect: 'none', completed: [], notAttempted: Array.from({ length: request.count }, (_, i) => i) } };
    this.#operations.set(key, entry);
    this.#tokens.set(token, entry);
    return token;
  }

  receipt(token) {
    const entry = this.#tokens.get(token);
    if (!entry) throw new Error('UNKNOWN_OPERATION');
    return copy(entry.receipt);
  }

  async dispatch(token, proof) {
    const entry = this.#tokens.get(token);
    if (!entry) throw new Error('UNKNOWN_OPERATION');
    if (entry.done) return this.receipt(token);
    if (entry.running) return entry.running;
    entry.running = this.#dispatch(entry, proof);
    return entry.running;
  }

  #current(entry) {
    const turn = this.#turns.get(entry.record.identity.session);
    return !entry.done && entry.fence === this.#fence && entry.generation === entry.record.generation &&
      entry.record.status === 'active' && this.#connection === 'connected' && turn?.valid && !turn.ending;
  }

  async #dispatch(entry, proof) {
    let code = 'LEASE_LOST';
    try {
      if (!this.#current(entry)) return this.#finish(entry, code);
      if (!await this.authorize(proof, { action: 'dispatch', ...entry.request })) return this.#finish(entry, 'PERMISSION_REQUIRED');
      const fresh = await bounded(() => this.#observe(entry.request.identity.targetId), this.#timeout);
      if (!same(fresh, entry.request.identity, observedKeys)) return this.#finish(entry, 'STALE_REF');
      if (!this.#current(entry)) return this.#finish(entry, code);
      // Observation may outlive an operation grant even when the lease is intact.
      if (!await this.authorize(proof, { action: 'dispatch', ...entry.request })) return this.#finish(entry, 'PERMISSION_REQUIRED');
      if (!this.#current(entry)) return this.#finish(entry, code);
      // No await between the last fence and host dispatcher invocation.
      entry.receipt.phase = 'dispatched';
      entry.receipt.effect = 'unknown';
      entry.receipt.notAttempted = [];
      // Persist possible dispatch before input. Saver must synchronously commit,
      // returning true only on durable success, and must never be model supplied.
      if (!this.#persist()) {
        entry.receipt.phase = 'prepared'; entry.receipt.effect = 'none';
        entry.receipt.notAttempted = Array.from({ length: entry.request.count }, (_, i) => i);
        return this.#finish(entry, 'JOURNAL_UNAVAILABLE');
      }
      if (!this.#current(entry)) return this.receipt(entry.token);
      entry.controller = new AbortController();
      const result = await bounded(() => this.#send(entry.request, { signal: entry.controller.signal,
        deadline: Date.now() + this.#timeout }), this.#timeout);
      if (!this.#current(entry)) return this.receipt(entry.token);
      // Only a sequential prefix is creditable. Unknown adapter shapes stay unknown.
      const prefix = result?.completed;
      if (!Array.isArray(prefix) || !prefix.every((n, i) => n === i && n < entry.request.count) ||
        !['observed', 'verified', 'dispatched'].includes(result.phase) ||
        !['observed', 'verified', 'unknown', 'unchanged'].includes(result.effect)) return this.#finish(entry, 'EFFECT_UNKNOWN');
      entry.receipt = { ...entry.receipt, phase: result.phase, effect: result.effect, completed: [...prefix],
        notAttempted: result.effect === 'unknown' ? [] : Array.from({ length: entry.request.count - prefix.length }, (_, i) => i + prefix.length) };
      entry.done = true;
      this.#persist();
      return this.receipt(entry.token);
    } catch { return this.#finish(entry, entry.receipt.phase === 'prepared' ? 'STATE_UNAVAILABLE' : 'EFFECT_UNKNOWN'); }
    finally { entry.controller?.abort(); }
  }

  #finish(entry, code) {
    if (!entry.done) {
      entry.receipt.code = code;
      entry.receipt.next = code === 'PERMISSION_REQUIRED' ? 'trusted action approval' : 'read fresh state';
      entry.done = true;
      this.#persist();
    }
    return this.receipt(entry.token);
  }

  creationIntent(session, turn) {
    const live = this.#turns.get(session);
    if (!live?.valid || live.ending || live.turn !== turn || this.#connection !== 'connected') throw new Error('STALE_TURN');
    const intent = Object.freeze({});
    this.#intents.set(intent, { session, turn, browser: copy(this.#browser), fence: this.#fence, used: false });
    return intent;
  }

  commitCreation(intent, identity) {
    const plan = this.#intents.get(intent);
    if (!plan || plan.used || identity.session !== plan.session || identity.turn !== plan.turn ||
      !identityKeys.every((k) => identity?.[k] !== undefined && identity[k] !== null && identity[k] !== '') ||
      !same(identity, plan.browser, ['incarnation', 'brokerEpoch', 'endpoint'])) throw new Error('INVALID_CREATION_INTENT');
    plan.used = true;
    const live = this.#turns.get(plan.session);
    if (live?.valid && !live.ending && live.turn === plan.turn && plan.fence === this.#fence) {
      return { lease: this.track(identity, { owned: true, ephemeral: true }), status: 'owned' };
    }
    const key = JSON.stringify([identity.incarnation, identity.targetId]);
    if (this.#records.has(key)) throw new Error('TARGET_ALREADY_TRACKED');
    this.#records.set(key, { key, identity: freeze(copy(identity)), owned: true, ephemeral: true, kept: false,
      generation: 1, status: 'cleanup-required', cleanup: { status: 'retained', code: 'LATE_CREATION' } });
    this.#persist();
    return { lease: null, status: 'cleanup-required' };
  }

  async endTurn(hook) {
    const turn = this.#turns.get(hook?.session);
    if (!turn?.valid || !same(hook, turn.hook, ['version', 'session', 'turn', 'brokerEpoch', 'channelGeneration']) ||
      Object.keys(hook).length !== Object.keys(turn.hook).length || !secretEqual(hook.nonce, turn.hook.nonce)) throw new Error('STALE_HOOK');
    if (turn.cleanup) return turn.cleanup;
    turn.ending = true;
    const records = [...this.#records.values()].filter((r) => r.identity.session === turn.session && r.identity.turn === turn.turn);
    for (const record of records) {
      // Fence queued work, but preserve whether this tab was already parked.
      if (record.status === 'active') { this.#cancelRecord(record, 'TURN_ENDED'); record.status = 'ending'; }
    }
    turn.cleanup = Promise.all(records.map((r) => this.#cleanup(r)));
    return turn.cleanup;
  }

  async #cleanup(record) {
    const identity = record.identity;
    const receipt = { ...copy(identity), status: 'retained', phase: 'prepared', effect: 'none', closeRequested: false, absenceVerified: false };
    const finish = (changes) => { Object.assign(receipt, changes); record.cleanup = copy(receipt); this.#persist(); return receipt; };
    if (record.status === 'parked') return finish({ status: 'parked', code: 'PARKED_LEASE' });
    if (!record.owned || record.kept || !record.ephemeral) {
      record.status = 'released';
      return finish({ status: 'released', code: 'USER_OR_KEPT_TARGET' });
    }
    if ([...this.#operations.values()].some((o) => o.record === record && o.receipt.effect === 'unknown')) {
      record.status = 'parked';
      return finish({ status: 'parked', code: 'EFFECT_UNKNOWN' });
    }
    const fence = this.#fence;
    const generation = record.generation;
    const current = () => fence === this.#fence && generation === record.generation && record.status !== 'parked' &&
      this.#connection === 'connected' && this.#records.get(record.key) === record &&
      same(identity, this.#browser, ['incarnation', 'brokerEpoch', 'endpoint']);
    try {
      if (!current()) return finish({ code: 'LEASE_LOST' });
      const fresh = await bounded(() => this.#observe(identity.targetId), this.#timeout);
      if (!current()) return finish({ code: 'LEASE_LOST' });
      if (fresh !== null && !same(fresh, identity, observedKeys)) return finish({ code: 'IDENTITY_MISMATCH' });
      if (fresh !== null) {
        record.closing = true;
        receipt.closeRequested = true;
        receipt.phase = 'dispatched';
        receipt.effect = 'unknown';
        record.cleanup = copy(receipt);
        if (!this.#persist()) return finish({ closeRequested: false, phase: 'prepared', effect: 'none', code: 'JOURNAL_UNAVAILABLE' });
        if (!current()) return finish({ closeRequested: false, phase: 'prepared', effect: 'none', code: 'LEASE_LOST' });
        const result = await bounded(() => this.#cdp.send('Target.closeTarget', { targetId: identity.targetId }), this.#timeout);
        if (!current()) return finish({ code: 'EFFECT_UNKNOWN' });
        if (result?.success !== true) return finish({ code: 'CLOSE_DENIED', effect: 'none' });
      }
      const inventory = await bounded(() => this.#cdp.send('Target.getTargets'), this.#timeout);
      if (!current() || !Array.isArray(inventory?.targetInfos)) return finish({ code: 'ABSENCE_UNPROVED' });
      if (inventory.targetInfos.some((t) => t.targetId === identity.targetId)) return finish({ code: 'TARGET_STILL_PRESENT' });
      this.#records.delete(record.key);
      record.status = 'closed';
      return finish({ status: fresh === null ? 'already-gone' : 'closed', phase: 'verified', effect: 'verified', absenceVerified: true });
    } catch { return finish({ code: receipt.closeRequested ? 'EFFECT_UNKNOWN' : 'IDENTITY_UNAVAILABLE' }); }
    finally { record.closing = false; }
  }
}
