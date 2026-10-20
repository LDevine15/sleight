import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeLabel } from './direct-browser/consent-ui.mjs';

// AppKit renders plain text. Escape directional controls and bound every untrusted visible field in UTF-8 bytes.
function cardText(value) {
  const text = String(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
  return Buffer.byteLength(text) <= 2048 ? text
    : Buffer.from(text).subarray(0, 2020).toString('utf8').replace(/\uFFFD$/, '') + '\n[request truncated]';
}

// sleight's own payment card for the engine-path payment gate (payment-gate.mjs): the consent host's operation sheet, the one
// turbo's payment confirmations use (direct-browser/consent-ui.mjs and host.mjs). LAWS: trusted confirmations use sleight's own
// window, outside the page. Only the person's click in that window answers it: the host's reply carries the channel's nonce and
// only an event the channel authenticates counts, so neither the page nor a tool can answer it.
//
// ask({ session, site, shown, control }) resolves 'once' (Allow once), 'cancel' (Cancel, closed or timed out) or undefined when
// no card can be shown (no helper build, no window server, the host lost). open() gives the channel or undefined; tests pass one.
export function createPaymentCard({ open = openConsentHost, now = Date.now, timeoutMs = 120000, presentation,
  onStatus, clock = { setTimeout, clearTimeout } } = {}) {
  let channel;
  // A host that exits or never starts leaves no channel, and the next payment opens one again.
  // A lost host is also closed, so a late answer doesn't leave one running beside the next (review F15).
  const forget = () => { const old = channel; channel = undefined; old?.then(ui => ui?.close?.(), () => {}); };
  const connect = async () => channel ??= Promise.resolve().then(() => open({ onLoss: forget })).then(value => value ?? forget(), forget);
  // This layer has no trusted logical request identity. Every ask gets a separate decision, even with equal terms.
  // The relay joins repeated pending engine request IDs; the socket bridge joins retries of its active call.
  return {
    ask: show,
    async close() { const ui = await channel?.catch(() => undefined); channel = undefined; ui?.close?.(); },
  };
  async function show({ session, site, shown, control, request, scoped, app, presentation: cardPresentation }) {
    const ui = await connect();
    if (!ui) return;
    return new Promise(resolve => {
      const id = 'payment-' + randomUUID(), deadline = now() + timeoutMs;
      let settled = false;
      // These observations grant nothing. The channel still authenticates every answer.
      const status = state => { try { onStatus?.({ id, state, app: app || site || 'this Mac', deadline }); } catch {} };
      const done = (choice, state = 'answered') => {
        if (settled) return;
        settled = true; clock.clearTimeout(timer); status(state); resolve(choice);
      };
      const timer = clock.setTimeout(() => done('cancel', 'unanswered'), timeoutMs);
      timer.unref?.();
      try {
        const scope = scoped ? 'Allow for this Grok Bot session only' : 'Allow this action once';
        // Bound untrusted engine text by UTF-8 bytes, with an explicit truncation marker.
        const bounded = request === undefined ? undefined : cardText(request);
        // Shell engine-payment stops use the same styled surface as shell elicitations.
        const styled = cardPresentation ?? (presentation && { style: 'ask', host: session || 'Grok Bot', kind: 'action',
          icon: presentation.icon, question: `Allow this payment at ${site || 'this page'}?`,
          detail: `Amount: ${shown ?? 'no amount shown'}\nControl: ${control ?? 'not named'}\nAllow this payment once.` });
        ui.present(id,
          { view: { clientSession: escapeLabel(session), origin: escapeLabel(site || 'this page'), ...(request === undefined ? {} : { scope }) },
            ...(styled ? { presentation: { ...styled, question: cardText(styled.question), detail: cardText(styled.detail) } } : {}),
            operation: request === undefined ? { site: site || 'this page', amount: shown ?? 'no amount shown', button: control }
              : { request: bounded, scope } },
          ['once', 'cancel'], event => { if (ui.authenticate(event) === true) done(event.choice === 'once' ? 'once' : 'cancel'); },
          { deadline });
        if (!settled) status('waiting');
      } catch { done(undefined, 'unavailable'); }
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
