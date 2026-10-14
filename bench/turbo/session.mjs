// This arm measures production turbo's tools and modules, not the installed path.
// Bench-only enable and fixture trust enter through existing private factories.
// No installed configuration, native control event or engine process is used.
import { randomBytes } from 'node:crypto';
import { createAuthority, createTransportAuthority, revokeAuthoritySession } from '../../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../../plugins/sleight/lib/direct-browser/broker.mjs';
import { createRootTargets } from '../../plugins/sleight/lib/direct-browser/root-targets.mjs';
import { createTransportOwner } from '../../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import { createSemanticAdapter, formInspectors } from '../../plugins/sleight/lib/direct-browser/forms.mjs';
import { fixedReadInspectors } from '../../plugins/sleight/lib/direct-browser/reads.mjs';
import { createFrontend } from '../../plugins/sleight/lib/direct-browser/surface.mjs';
import { validateHostRequest } from '../../plugins/sleight/lib/direct-browser/request-schema.mjs';
import { bounded } from '../../plugins/sleight/lib/direct-browser/lifecycle.mjs';
import { fixturePolicy } from './setup.mjs';
import { taskPayment } from './payment.mjs';

export async function createModuleSession({ raw, origins, taskMessage, readPayment = async () => null } = {}) {
  const permits = fixturePolicy(origins);
  if (typeof taskMessage !== 'string' || Buffer.byteLength(taskMessage) > 65536) throw Error('Runner task message required');
  const session = 's' + randomBytes(16).toString('hex'), incarnation = 'b' + randomBytes(16).toString('hex');
  const turn = 'benchturn', uid = process.getuid?.() ?? 1000, secret = randomBytes(32).toString('hex');
  const event = Object.freeze({ text: taskMessage });
  let roots, adapter, live = true, broker, frontend, closing, pageTerms, requested;
  const binding = () => live ? { session, turn, browserIncarnation: incarnation, brokerEpoch: broker.status().epoch } : null;
  const wire = Object.freeze({ sessionId: raw.sessionId, on: raw.on.bind(raw), off: raw.off.bind(raw),
    async send(method, params, route) {
      if (['Page.bringToFront', 'Target.activateTarget'].includes(method) ||
          ['Target.createTarget', 'Page.navigate'].includes(method) && !permits(params.url) &&
          !(method === 'Target.createTarget' && params.url === 'about:blank' && params.background === true)) throw Error('FIXTURE_COMMAND_DENIED');
      const fence = roots?.captureObservation(route);
      const value = await raw.send(method, params, route); roots?.observeNodes(route, method, value, fence); return value;
    } });
  roots = createRootTargets({ session: wire, current: binding });
  const owner = createTransportOwner({ session: wire, checkLease: roots.checkLease,
    helpers: { ...formInspectors(), ...fixedReadInspectors }, nodeBinding: roots.nodeBinding,
    dialogBinding: (id, lease) => adapter.dialogBinding(id, lease) });
  adapter = createSemanticAdapter({ owner, rootTargets: roots, leaseFor: roots.leaseFor, current: roots.current,
    paymentTerms(state) {
      if (!requested || !pageTerms) return undefined;
      if (state.dialog) {
        const amounts = [...state.dialog.matchAll(/\$([\d,]+\.\d{2})/g)].map(match => match[1].replaceAll(',', ''));
        // Only the same simple payment dialog is covered. Different language,
        // amount, payee or plan needs a new person decision, absent in this arm.
        if (amounts.length !== 1 || amounts[0] !== pageTerms.amount ||
            !/^pay\s+\$[\d,.]+\s+now\?$/i.test(state.dialog.trim())) return undefined;
      }
      return { page: pageTerms, method: requested.method };
    } });
  const authority = createAuthority({ current: adapter.currentScope, classify: adapter.classify, checkTarget: adapter.checkTarget,
    authenticate: value => live && value === event, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }) });
  adapter.bindAuthority(authority);
  const revoke = id => { revokeAuthoritySession(authority, id); owner.revokeSession(id); roots.revokeSession(id); return true; };
  broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: incarnation, connect: async () => wire,
    verifyConnection: () => live, disconnect: () => true, currentTurn: () => live ? turn : null,
    validateRequest: validateHostRequest, prepare: adapter.prepare, authorize: adapter.authorize,
    dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch,
    transportAuthority: createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation }), endSession: revoke, redact: value => value });
  const close = () => closing ??= bounded(async () => {
    live = false; revoke(session);
    const first = await adapter.cleanupSession(session), targets = await roots.close(), remote = await owner.close();
    const stopped = await broker.shutdown();
    return { revoked: stopped === true, cleanup: [...first.cleanup, ...targets.cleanup, ...remote.cleanup] };
  }, 30000);
  try {
    await broker.connect({ userInitiated: true });
    frontend = await createFrontend({ proof: event, verifyOptIn: value => live && value === event, packageCurrent: () => live,
      status: () => broker.status().state, client: broker.attach({ version: 1, uid, secret, session, incarnation }),
      redact: value => value, endSession: close, selectedBrowser: 'bbench',
      ownership: { session, turn, brokerEpoch: broker.status().epoch },
      onDelivered(value) {
        if (value.name !== 'browser_read') return false;
        try { return adapter.delivered(roots.leaseFor(value.tab, binding()), value.observation.observation); } catch { return false; }
      }, onUnknown(value) { try { roots.retainTarget(roots.leaseFor(value.tab, binding()).target); } catch {} } });
    return Object.freeze({ tools: frontend.tools, delivered: frontend.delivered, close: () => frontend.end(),
      async call(input) {
        // Only a runner-supplied user message can register payment intent. The
        // fixed evidence read supplies page terms separately, never permissions.
        const evidence = /^\s*(?:buy|purchase|pay\s+for)\b/i.test(event.text)
          ? await readPayment(input.arguments?.tab) : null;
        pageTerms = evidence?.page; const payment = taskPayment(event.text, pageTerms);
        if (payment && permits(evidence.url) && (!requested || JSON.stringify(requested) === JSON.stringify(payment))) {
          requested = payment;
          authority.user(event, 'request', { session, consequence: 'payment', origin: new URL(evidence.url).origin, terms: payment });
        } else { pageTerms = undefined; }
        return frontend.call(input);
      } });
  } catch (error) { await close(); throw error; }
}
