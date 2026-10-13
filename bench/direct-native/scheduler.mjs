// Offline admission prototype. No engine connection, pool, lease grant or app access.
// The host adapter must retain the existing broker and every guarded engine gate.
const kinds = ['read', 'mutation', 'barrier'];
const globals = ['clipboard', 'desktop', 'modal'];
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => names.includes(key));
const integer = value => Number.isSafeInteger(value) && value > 0;
const exclusive = job => job.request.kind === 'barrier' || job.request.resources.length > 0;

function validate(request) {
  if (!fields(request, ['session', 'runtime', 'epoch', 'target', 'kind', 'surface', 'resources',
    'timeoutMs', 'readKey', 'scope']) || !text(request.session) || !text(request.runtime) ||
    !integer(request.epoch) || !kinds.includes(request.kind) ||
    !['native', 'browser'].includes(request.surface) || !Array.isArray(request.resources) ||
    request.resources.some(value => !globals.includes(value)) || !integer(request.timeoutMs) ||
    request.timeoutMs > 30000 || !fields(request.target,
      ['pid', 'processStart', 'window', 'document', 'leaseGeneration', 'policyGeneration'])) {
    throw new TypeError('Native scheduler: invalid request.');
  }
  const t = request.target;
  if (!integer(t.pid) || !text(t.processStart) || !text(t.window) || !text(t.document) ||
    !integer(t.leaseGeneration) || !integer(t.policyGeneration) ||
    (request.kind === 'read' && (!text(request.readKey) || !text(request.scope))) ||
    (request.kind !== 'read' && (request.readKey !== undefined || request.scope !== undefined))) {
    throw new TypeError('Native scheduler: invalid target or read scope.');
  }
}

function conflict(a, b) {
  if (exclusive(a) || exclusive(b)) return true;
  if (a.request.runtime === b.request.runtime) return true;
  // Process-wide native state crosses windows and process incarnations. A reused
  // numeric PID cannot bypass a reservation whose old effect is still unknown.
  return a.request.target.pid === b.request.target.pid &&
    (a.request.kind !== 'read' || b.request.kind !== 'read');
}

function readIdentity(r) {
  return JSON.stringify([r.session, r.runtime, r.epoch, r.surface, r.target.pid,
    r.target.processStart, r.target.window, r.target.document, r.target.leaseGeneration,
    r.target.policyGeneration, r.readKey, r.scope, [...r.resources].sort()]);
}

export class NativeScheduler {
  constructor({ runtimes, policy, capacity = 1, maxQueued = 256, maxCoalesced = 8,
    now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (![1, 2].includes(capacity) || !integer(maxQueued) || maxQueued > 256 ||
      !integer(maxCoalesced) || maxCoalesced > 8 || typeof policy !== 'function' ||
      !Array.isArray(runtimes) || !runtimes.length || runtimes.length > 2 ||
      new Set(runtimes.map(r => r.id)).size !== runtimes.length || runtimes.some(r =>
        !text(r.id) || !integer(r.epoch) || !Array.isArray(r.processes) || !r.processes.length ||
        r.processes.some(p => !integer(p.pid) || !text(p.processStart)))) {
      throw new TypeError('Native scheduler: invalid offline configuration (runtime cap 2).');
    }
    this.runtimes = structuredClone(runtimes);
    this.policy = policy;
    this.capacity = capacity;
    this.maxQueued = maxQueued;
    this.maxCoalesced = maxCoalesced;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queue = [];
    this.active = new Map();
    this.revoked = new Set();
    this.cursor = undefined;
    this.sequence = 0;
    this.scheduled = false;
    this.stopped = false;
    this.startedAt = now();
    this.receipts = [];
    this.cleanupReceipts = [];
    this.completed = 0;
    this.failures = 0;
  }

  submit(input, run) {
    validate(input);
    if (typeof run !== 'function') throw new TypeError('Native scheduler: missing fake operation.');
    // Requests are immutable snapshots; a caller cannot change a queued identity.
    const request = structuredClone(input);
    const submittedAt = this.now();
    let resolve;
    const result = new Promise(yes => { resolve = yes; });
    const client = { resolve, submittedAt, deadline: submittedAt + request.timeoutMs, done: false };
    const last = this.queue.at(-1);
    let job;
    if (request.kind === 'read' && last?.request.kind === 'read' && last.clients.length < this.maxCoalesced &&
      readIdentity(request) === readIdentity(last.request)) {
      job = last;
      job.clients.push(client);
    } else {
      job = { id: ++this.sequence, request, run, clients: [client], state: 'queued' };
      const refusal = this.stopped ? 'ENGINE_UNAVAILABLE' : this.revoked.has(request.session) ? 'REVOKED' :
        !this.matchesRuntime(request) ? 'WRONG_INSTANCE' : this.queue.length >= this.maxQueued ? 'QUEUE_FULL' : null;
      if (refusal) this.deliver(job, refusal, 'prepared');
      else this.queue.push(job);
    }
    if (!client.done) {
      client.timer = this.setTimer(() => {
        this.finishClient(job, client, 'WAIT_TIMEOUT',
          ['dispatched', 'unknown'].includes(job.state) ? 'unknown' : 'prepared');
        this.prune(); this.schedule();
      }, request.timeoutMs);
      client.timer?.unref?.();
    }
    this.schedule();
    return { operation: job.id, result, cancel: () => {
      this.finishClient(job, client, 'CANCELLED', job.state === 'dispatched' || job.state === 'unknown' ? 'unknown' : 'prepared');
      this.prune(); this.schedule();
    } };
  }

  matchesRuntime(r) {
    const runtime = this.runtimes.find(candidate => candidate.id === r.runtime && candidate.epoch === r.epoch);
    return !!runtime?.processes.some(p => p.pid === r.target.pid && p.processStart === r.target.processStart);
  }

  finishClient(job, client, code, effect, value) {
    if (client.done) return;
    const deliveredValue = value === undefined ? undefined : structuredClone(value);
    client.done = true;
    if (client.timer !== undefined) this.clearTimer(client.timer);
    const receipt = { operation: job.id, code, effect,
      admissionWaitMs: job.admittedAt === undefined ? null : job.admittedAt - client.submittedAt,
      publicWallMs: this.now() - client.submittedAt, queueMs: null, serviceMs: null };
    // Retained receipts contain only numeric timing/status, never returned content.
    this.receipts.push(receipt);
    if (this.receipts.length > 512) this.receipts.shift();
    client.resolve(value === undefined ? receipt : { ...receipt, value: deliveredValue });
  }

  deliver(job, code, effect, value) {
    for (const client of job.clients) this.finishClient(job, client, code, effect, value);
  }

  prune() {
    this.queue = this.queue.filter(job => job.clients.some(client => !client.done));
    for (const job of this.active.values()) {
      if (job.state === 'admitting' && job.clients.every(client => client.done)) this.active.delete(job.id);
    }
  }

  expire() {
    const now = this.now();
    for (const job of [...this.queue, ...this.active.values()]) {
      for (const client of job.clients) {
        if (client.deadline <= now) this.finishClient(job, client, 'WAIT_TIMEOUT',
          ['dispatched', 'unknown'].includes(job.state) ? 'unknown' : 'prepared');
      }
    }
    this.prune(); this.schedule();
  }

  revoke(session) {
    this.revoked.add(session);
    for (const job of [...this.queue, ...this.active.values()]) {
      if (job.request.session === session) this.deliver(job, 'REVOKED',
        ['dispatched', 'unknown'].includes(job.state) ? 'unknown' : 'prepared');
    }
    this.prune(); this.schedule();
  }

  disconnect(runtime) {
    if (!this.runtimes.some(r => r.id === runtime)) throw new TypeError('Unknown runtime.');
    if (!this.stopped) this.failures++;
    this.stopped = true;
    for (const job of this.queue) this.deliver(job, 'ENGINE_UNAVAILABLE', 'prepared');
    this.queue = [];
    // One helper failure stops the entire cohort, including independent runtimes.
    // An unresolved call still owns its transport and conflicting resources.
    for (const job of this.active.values()) this.deliver(job, 'ENGINE_UNAVAILABLE',
      ['dispatched', 'unknown'].includes(job.state) ? 'unknown' : 'prepared');
  }

  // Trusted adapter only: a terminal cleanup receipt, never a model timeout or
  // an attempted cancellation. The cohort remains stopped after a helper fault.
  confirmCompletion(operation, receipt) {
    const job = this.active.get(operation);
    if (!job || job.state !== 'unknown' || receipt?.collected !== true ||
      !['observed', 'verified'].includes(receipt.effect)) throw new TypeError('Completion is unproved.');
    this.cleanupReceipts.push({ operation, collected: true, effect: receipt.effect });
    if (this.cleanupReceipts.length > 512) this.cleanupReceipts.shift();
    this.active.delete(operation);
    this.schedule();
  }

  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  pump() {
    this.expireWithoutSchedule();
    if (this.stopped) return;
    while (this.active.size < this.capacity) {
      const sessions = [...new Set(this.queue.map(job => job.request.session))];
      const previous = sessions.indexOf(this.cursor);
      const order = previous < 0 ? sessions : [...sessions.slice(previous + 1), ...sessions.slice(0, previous + 1)];
      let chosen;
      for (const session of order) {
        const job = this.queue.find(candidate => candidate.request.session === session);
        if (!job || [...this.active.values()].some(other => conflict(job, other))) continue;
        // A later job cannot continually jump an older conflicting barrier.
        if (this.queue.some(other => other.id < job.id &&
          (exclusive(job) || exclusive(other)) && conflict(job, other))) continue;
        chosen = job; break;
      }
      if (!chosen) return;
      this.queue.splice(this.queue.indexOf(chosen), 1);
      this.cursor = chosen.request.session;
      chosen.state = 'admitting';
      chosen.admittedAt = this.now();
      // Reserve before asynchronous lease/policy checks, so revoke can win.
      this.active.set(chosen.id, chosen);
      void this.execute(chosen);
    }
  }

  expireWithoutSchedule() {
    for (const job of [...this.queue, ...this.active.values()]) {
      for (const client of job.clients) if (client.deadline <= this.now()) this.finishClient(job, client, 'WAIT_TIMEOUT',
        ['dispatched', 'unknown'].includes(job.state) ? 'unknown' : 'prepared');
    }
    this.prune();
  }

  async execute(job) {
    let dispatched = false;
    try {
      // The adapter checks the broker and engine approval, document/review/flow
      // gates. A successful check cannot mint or renew any permission here.
      const permit = await this.policy(structuredClone(job.request));
      this.expireWithoutSchedule();
      if (this.stopped || this.revoked.has(job.request.session) || job.clients.every(c => c.done)) return;
      if (!this.matchesRuntime(job.request)) { this.deliver(job, 'WRONG_INSTANCE', 'prepared'); return; }
      if (permit?.leaseValid !== true) { this.deliver(job, 'LEASE_BUSY', 'prepared'); return; }
      if (permit?.allowed !== true) { this.deliver(job, 'DENIED', 'prepared'); return; }
      job.state = 'dispatched'; dispatched = true;
      const value = await job.run();
      this.expireWithoutSchedule();
      if (!this.stopped && !this.revoked.has(job.request.session)) this.deliver(job, 'OK', 'observed', value);
      this.completed++;
      job.state = 'settled';
    } catch (error) {
      const helperFailure = error?.code === 'CONNECTION_CLOSED' || error?.code === 'HELPER_FAILURE';
      if (!helperFailure) this.failures++;
      if (dispatched && job.request.kind !== 'read') {
        job.state = 'unknown';
        this.deliver(job, 'EFFECT_UNKNOWN', 'unknown');
      } else {
        this.deliver(job, 'ENGINE_UNAVAILABLE', 'prepared');
      }
      if (helperFailure) this.disconnect(job.request.runtime);
    } finally {
      if (job.state !== 'unknown') this.active.delete(job.id);
      this.schedule();
    }
  }

  snapshot() {
    const seconds = (this.now() - this.startedAt) / 1000;
    return { queued: this.queue.length, inFlight: this.active.size, stopped: this.stopped,
      completed: this.completed, failures: this.failures,
      throughputPerSecond: seconds > 0 ? this.completed / seconds : null,
      cpu: null, rss: null, queueMs: null, serviceMs: null,
      receipts: this.receipts.map(receipt => ({ ...receipt })),
      cleanupReceipts: this.cleanupReceipts.map(receipt => ({ ...receipt })) };
  }
}

// Evaluation of evidence only. No launch, approval, runtime creation or restart.
export function stabilityGate({ supportedBuild = false, diagnosticApproved = false,
  cleanControls = false, addressable = false, independentRuntimes = 0, samples = [] } = {}) {
  const failed = !Array.isArray(samples) || samples.some(s => s.failures !== 0 || s.cleanup !== true);
  const controls = supportedBuild === true && diagnosticApproved === true && cleanControls === true &&
    addressable === true && !failed;
  return { experimentCap: 2, qualificationCounts: [1, 4, 13],
    experimentAllowed: controls && [1, 2].includes(independentRuntimes),
    parallelStabilityQualified: controls && [1, 4, 13].every(n =>
      samples.some(s => s.n === n && s.complete === true && s.failures === 0 && s.cleanup === true)),
    parallelSpeedClaimQualified: false,
    productionPoolingEnabled: false };
}
