// Clean-room event-before-input pattern, consulted: Chrome DevTools MCP 1.10.1,
// src/utils/WaitForHelper.ts and FowlBrowser 8b68924 mcp/src/tools.mjs.
// No upstream implementation copied. No DOM-silence or network-idle success claim.
import { eventPulse, fault } from './waits.mjs';

export function validateExpectation(expect) {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) throw fault('INVALID_OPERATION');
  const keys = Object.keys(expect);
  const allowed = {
    state: ['kind', 'field', 'equals'], text: ['kind', 'text', 'present'],
    navigation: ['kind'], dialog: ['kind', 'type'], popup: ['kind'], download: ['kind'],
  }[expect.kind];
  if (!allowed || keys.some(k => !allowed.includes(k))) throw fault('INVALID_OPERATION');
  if (expect.kind === 'state' && (!['checked', 'value', 'selected', 'expanded', 'focused'].includes(expect.field)
    || !['string', 'boolean', 'number'].includes(typeof expect.equals))) throw fault('INVALID_OPERATION');
  if (expect.kind === 'text' && (typeof expect.text !== 'string' || expect.text.length > 2000
    || typeof expect.present !== 'boolean')) throw fault('INVALID_OPERATION');
  if (expect.kind === 'dialog' && !['alert', 'confirm', 'prompt', 'beforeunload'].includes(expect.type)) throw fault('INVALID_OPERATION');
}

export function armEffects(session, frameId) {
  const pulse = eventPulse();
  const events = [];
  let dialog;
  let dialogReady;
  const barrier = new Promise(resolve => { dialogReady = resolve; });
  const listeners = new Map();
  // Popup/download events are wakeups, not attribution proof. BP2-8 owns causal receipts.
  for (const name of ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'DOM.documentUpdated',
    'DOM.attributeModified', 'Runtime.bindingCalled', 'Page.windowOpen', 'Page.downloadWillBegin',
    'Page.downloadProgress', 'Page.javascriptDialogOpening']) {
    const listener = payload => {
      if (name === 'Page.frameNavigated' && payload.frame?.id !== frameId) return;
      if (name === 'Page.navigatedWithinDocument' && payload.frameId !== frameId) return;
      if (name === 'Page.javascriptDialogOpening') dialog = { type:
        ['alert', 'confirm', 'prompt', 'beforeunload'].includes(payload.type) ? payload.type : 'unknown' };
      if (name === 'Page.javascriptDialogOpening') dialogReady(dialog);
      if (events.length < 64) events.push({ name, payload });
      pulse.wake();
    };
    listeners.set(name, listener);
    session.on(name, listener);
  }
  return { events, pulse, barrier, get dialog() { return dialog; },
    stop() { for (const [name, listener] of listeners) session.off(name, listener); } };
}

export async function proveEffect({ deadline, armed, observe, expect, resolved, operation }) {
  let last;
  for (;;) {
    if (armed.dialog) {
      return { phase: 'observed', effect: expect.kind === 'dialog' && armed.dialog.type === expect.type ? 'verified' : 'unknown',
        code: 'DIALOG_OPEN', next: 'browser_act(dialog)',
        observation: { dialog: armed.dialog.type, complete: false } };
    }
    const version = armed.pulse.version;
    try {
      last = await deadline.run(() => observe({ operation, resolved, expect, events: armed.events, deadline }));
      // Only the trusted scoped observer can prove a new document or causally attributed child/download.
      if (last?.matched === true && last.complete === true && Number.isSafeInteger(last.document)
        && (expect.kind === 'navigation' ? last.document !== operation.document : last.document === operation.document)) {
        if (!['native', 'ax', 'causal-event'].includes(last.source)) return {
          phase: 'observed', effect: 'unknown', code: 'STATE_UNVERIFIABLE', next: 'browser_read', observation: projectProof(last),
        };
        return { phase: 'verified', effect: 'verified', observation: projectProof(last) };
      }
      await armed.pulse.wait(deadline, version);
    } catch (error) {
      if (error.code === 'DEADLINE' && last?.complete === true && last.unchanged === true) {
        return { phase: 'observed', effect: 'unchanged', code: 'POSTCONDITION_PENDING',
          next: 'browser_read', observation: projectProof(last) };
      }
      throw error;
    }
  }
}

function projectProof(proof) {
  // Page strings, values, URLs, download names, CDP IDs and getter output never enter this receipt.
  return { complete: proof.complete === true, document: proof.document,
    source: ['native', 'ax', 'page-reported', 'causal-event'].includes(proof.source) ? proof.source : 'unknown',
    ...(proof.protected === true ? { protected: true, matched: proof.matched === true } : {}) };
}
