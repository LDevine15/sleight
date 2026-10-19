import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeLabel } from './direct-browser/consent-ui.mjs';

// sleight's own payment card for the engine-path payment gate (payment-gate.mjs): the consent host's operation sheet, the one
// turbo's payment confirmations use (direct-browser/consent-ui.mjs and host.mjs). LAWS: trusted confirmations use sleight's own
// window, outside the page. Only the person's click in that window answers it: the host's reply carries the channel's nonce and
// only an event the channel authenticates counts, so neither the page nor a tool can answer it.
//
// ask({ session, site, shown, control }) resolves 'once' (Allow once), 'cancel' (Cancel, closed or timed out) or undefined when
// no card can be shown (no helper build, no window server, the host lost). open() gives the channel or undefined; tests pass one.
export function createPaymentCard({ open = openConsentHost, now = Date.now, timeoutMs = 120000 } = {}) {
  let channel;
  // A host that exits or never starts leaves no channel, and the next payment opens one again.
  // A lost host is also closed, so a late answer doesn't leave one running beside the next (review F15).
  const forget = () => { const old = channel; channel = undefined; old?.then(ui => ui?.close?.(), () => {}); };
  const connect = async () => channel ??= Promise.resolve().then(() => open({ onLoss: forget })).then(value => value ?? forget(), forget);
  // One open card per payment: asking again for the same site, figure and control while it is open waits on that card (review N7).
  const asking = new Map();
  return {
    ask(card) {
      const key = JSON.stringify([card.site, card.shown, card.control]);
      if (!asking.has(key)) asking.set(key, show(card).finally(() => asking.delete(key)));
      return asking.get(key);
    },
    async close() { const ui = await channel?.catch(() => undefined); channel = undefined; ui?.close?.(); },
  };
  async function show({ session, site, shown, control }) {
    const ui = await connect();
    if (!ui) return;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve('cancel'), timeoutMs);
      timer.unref?.();
      const done = choice => { clearTimeout(timer); resolve(choice); };
      try {
        ui.present('payment-' + randomUUID(),
          { view: { clientSession: escapeLabel(session), origin: escapeLabel(site || 'this page') },
            operation: { site: site || 'this page', amount: shown ?? 'no amount shown', button: control } },
          ['once', 'cancel'], event => { if (ui.authenticate(event) === true) done(event.choice === 'once' ? 'once' : 'cancel'); },
          { deadline: now() + timeoutMs });
      } catch { clearTimeout(timer); resolve(undefined); }
    });
  }
}

// The consent host, built from this plugin's own helper sources (the same build turbo uses, cached by their hashes). A build
// that isn't ready in time leaves no card for this payment and keeps going for the next one.
async function openConsentHost({ onLoss, buildWaitMs = 20000 } = {}) {
  if (process.platform !== 'darwin') return;
  const host = await import('./direct-browser/host.mjs');
  const native = fileURLToPath(new URL('./direct-browser/native/', import.meta.url));
  const files = ['consent-host.swift', 'peer-host.c'].map(name => {
    const bytes = readFileSync(native + name);
    return { path: 'native/' + name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  const build = host.prepareNativeHelpers({ inventory: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files } });
  const built = await Promise.race([build, new Promise(resolve => setTimeout(resolve, buildWaitMs).unref?.())]);
  if (built?.status !== 'ready') return;
  return host.createNativeUi(built.receipt, onLoss);
}
