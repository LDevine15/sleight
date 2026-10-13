import { randomUUID } from 'node:crypto';
import { bounded } from './lifecycle.mjs';

// New implementation of the v1/v2 handoff contract. The adapter represents
// existing engine authority; this module neither opens files nor drives apps.
const sameApp = (a, b) => ['bundleId', 'windowId', 'title'].every((key) => a?.[key] === b?.[key] && typeof a?.[key] === 'string');
const copy = (value) => structuredClone(value);

export class NativeHandoff {
  #lifecycle;
  #adapter;
  #timeout;
  #records = new Map();
  constructor(lifecycle, { verifyArtifact = () => false, acquire = () => { throw new Error('NATIVE_AUTHORITY_REQUIRED'); },
    complete = () => { throw new Error('NATIVE_COMPLETION_UNPROVED'); }, revalidate = () => false, timeoutMs = 1500 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('INVALID_DEADLINE');
    this.#lifecycle = lifecycle;
    this.#adapter = { verifyArtifact, acquire, complete, revalidate };
    this.#timeout = timeoutMs;
  }

  async prepare(lease, { artifact, targetApp }, proof) {
    const identity = this.#lifecycle.describe(lease);
    const request = copy({ artifact, targetApp });
    if (!sameApp(targetApp, targetApp) || !artifact?.handle || artifact.origin !== identity.origin ||
      artifact.targetId !== identity.targetId || !['download', 'file-panel', 'protocol'].includes(artifact.kind) ||
      (artifact.kind === 'download' && artifact.state !== 'completed')) throw new Error('ARTIFACT_UNVERIFIED');
    if (!await this.#lifecycle.authorize(proof, { action: 'handoff', identity, ...request })) throw new Error('PERMISSION_REQUIRED');
    if (!await bounded(() => this.#adapter.verifyArtifact(request.artifact, identity), this.#timeout)) throw new Error('ARTIFACT_UNVERIFIED');
    this.#lifecycle.park(lease);
    const id = randomUUID();
    const receipt = { id, session: identity.session, turn: identity.turn, sourceTabLease: identity,
      origin: identity.origin, artifactOrProtocol: request.artifact, targetApp: request.targetApp, status: 'browser-parked' };
    this.#records.set(id, { receipt, lease, running: null, attempted: false, native: null });
    return copy(receipt);
  }

  async run(id) {
    const record = this.#records.get(id);
    if (!record) throw new Error('UNKNOWN_HANDOFF');
    if (record.running) return record.running;
    if (record.attempted) return copy(record.receipt);
    record.attempted = true;
    record.running = this.#run(record);
    return record.running;
  }

  async #run(record) {
    const receipt = record.receipt;
    try {
      // Browser consent/grants are deliberately absent. The native adapter must
      // obtain its own session approval and exact engine app/window guard.
      const acquired = await bounded(() => this.#adapter.acquire({ session: receipt.session, turn: receipt.turn,
        artifactOrProtocol: copy(receipt.artifactOrProtocol), targetApp: copy(receipt.targetApp) }), this.#timeout);
      if (!acquired?.authority || !sameApp(acquired.identity, receipt.targetApp)) throw new Error('NATIVE_IDENTITY_UNPROVED');
      record.native = acquired;
      receipt.status = 'native-acquired';
      const result = await bounded(() => this.#adapter.complete(acquired, copy(receipt)), this.#timeout);
      if (result?.status !== 'completed' || !sameApp(result.identity, receipt.targetApp)) throw new Error('NATIVE_COMPLETION_UNPROVED');
      receipt.status = 'native-completed';
    } catch {
      receipt.status = 'native-unresolved';
      receipt.effect = 'unknown';
      receipt.next = 'inspect exact native state; explicit reconciliation required';
    }
    return copy(receipt);
  }

  async revalidate(id, proof) {
    const record = this.#records.get(id);
    if (!record || record.receipt.status !== 'native-completed') throw new Error('NATIVE_COMPLETION_UNPROVED');
    if (!await this.#lifecycle.authorize(proof, { action: 'handoff-revalidate', receipt: record.receipt })) throw new Error('PERMISSION_REQUIRED');
    const identity = await this.#lifecycle.revalidateParked(record.lease, proof);
    const state = await bounded(() => this.#adapter.revalidate(copy(record.receipt), identity), this.#timeout);
    // Native adapter reads may race a lost socket or lease. Repeat the fence/state
    // check before labeling the browser postcondition proved.
    await this.#lifecycle.revalidateParked(record.lease, proof);
    if (state?.verified !== true) throw new Error('BROWSER_POSTCONDITION_UNPROVED');
    // Resume is a distinct explicit user action with a new lease and state read.
    record.receipt.status = 'browser-revalidated';
    return copy(record.receipt);
  }
}
