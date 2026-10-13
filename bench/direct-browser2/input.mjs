// Prototype internal broker component, not a model-facing CDP API.
// Actionability sequence follows the design's Playwright/Fowl references; implementation is original.
import { createHash } from 'node:crypto';
import { Deadline, fault } from './waits.mjs';
import { armEffects, proveEffect, validateExpectation } from './effects.mjs';

const identityKeys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration',
  'targetId', 'frameId', 'documentEpoch', 'origin'];
const journalState = new WeakMap();
const ops = new Set(['click', 'hover', 'key', 'insertText', 'scroll', 'dialog', 'wait']);
const fields = { click: [], hover: [], key: ['key', 'modifiers'], insertText: ['text'],
  scroll: ['deltaX', 'deltaY'], dialog: ['accept', 'promptText'], wait: [] };
const namedKeys = { Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], Space: ['Space', 32],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40] };

function validate(op) {
  if (!op || !ops.has(op.op)) throw fault('INVALID_OPERATION');
  const common = [...identityKeys, 'operationId', 'sequence', 'ref', 'op', 'expect', 'timeout_ms'];
  if (Object.keys(op).some(k => ![...common, ...fields[op.op]].includes(k))) throw fault('INVALID_OPERATION');
  for (const key of identityKeys) {
    const value = op[key];
    if (!(typeof value === 'string' && value.length > 0 && value.length <= 512)
      && !(Number.isSafeInteger(value) && value >= 0)) throw fault('INVALID_OPERATION');
  }
  for (const key of ['operationId', 'ref']) if (typeof op[key] !== 'string' || !/^[\w:-]{1,128}$/.test(op[key])) throw fault('INVALID_OPERATION');
  if (!Number.isSafeInteger(op.sequence) || op.sequence < 1) throw fault('INVALID_OPERATION');
  validateExpectation(op.expect);
  if (op.op === 'insertText' && (typeof op.text !== 'string' || Buffer.byteLength(op.text) > 64000)) throw fault('INVALID_OPERATION');
  if (op.op === 'key' && (!namedKeys[op.key] || !Number.isInteger(op.modifiers ?? 0) || (op.modifiers ?? 0) < 0
    || (op.modifiers ?? 0) > 15)) throw fault('INVALID_OPERATION');
  if (op.op === 'scroll' && (!Number.isFinite(op.deltaX) || !Number.isFinite(op.deltaY)
    || Math.abs(op.deltaX) > 10000 || Math.abs(op.deltaY) > 10000)) throw fault('INVALID_OPERATION');
  if (op.op === 'dialog' && (typeof op.accept !== 'boolean' || (op.promptText !== undefined
    && (typeof op.promptText !== 'string' || op.promptText.length > 2000)))) throw fault('INVALID_OPERATION');
}

function sameIdentity(a, b) { return identityKeys.every(key => a[key] === b[key]); }
function sameRect(a, b) { return a && b && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 0.25); }
function targetKey(op) { return JSON.stringify([op.browserIncarnation, op.targetId]); }
function operationKey(op) { return JSON.stringify([op.clientSession, op.turn, op.operationId]); }
function digest(op) { return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(op).sort()))).digest('hex'); }
function errorCode(error) {
  // Transport rejections need not be Errors, and a code accessor may itself throw.
  try {
    const allowed = ['INVALID_OPERATION', 'ADAPTER_UNAVAILABLE', 'STALE_REF', 'PERMISSION_REQUIRED',
      'EFFECT_UNKNOWN', 'NOT_VISIBLE', 'DISABLED', 'COVERED', 'READONLY_PICKER', 'NOT_FOCUSED',
      'UNSTABLE', 'FRAME_UNQUALIFIED', 'DEADLINE', 'CANCELLED'];
    const code = error?.code;
    return allowed.includes(code) ? code : 'ADAPTER_FAILURE';
  } catch { return 'ADAPTER_FAILURE'; }
}
function failure(operationId, code, sent = false) {
  return { operationId, code, phase: sent ? 'unknown' : 'prepared', effect: sent ? 'unknown' : 'none',
    next: sent || ['STALE_REF', 'COVERED', 'UNSTABLE'].includes(code) ? 'browser_read' : 'trusted_authority' };
}

/**
 * Trusted adapter hooks (never supplied by the model): resolve(op), authorize(op,resolved),
 * fence(op,resolved), inspect(resolved,deadline), observe({operation,resolved,expect,events,deadline}).
 * resolve binds ref to the entire identity, scoped session, isolated executionContextId and backendNodeId.
 * fence returns the CURRENT complete identity. authorize checks exact op/data/destination capability.
 * inspect may be a qualified scoped Playwright actionability adapter. observe gates all fresh content
 * reads and returns bounded private proof, not page approvals. Missing hooks deny all operations.
 * A broker-owned journal may be retained across controller reconnects; unknown entries are never evicted.
 */
export function createInputController(hooks = {}) {
  const journal = hooks.journal ?? new Map();
  if (!journalState.has(journal)) journalState.set(journal, {
    queues: new Map(), blocked: new Set([...journal.values()].filter(x => x.receipt?.effect === 'unknown').map(x => x.target)),
  });
  const { queues, blocked } = journalState.get(journal);
  const required = ['resolve', 'authorize', 'fence', 'observe'];

  async function execute(op, deadline, entry) {
    let sent = false;
    let armed;
    let inputMs = 0;
    let proofMs = 0;
    const start = deadline.now();
    try {
      if (required.some(k => typeof hooks[k] !== 'function')) throw fault('ADAPTER_UNAVAILABLE');
      const resolved = await deadline.run(() => hooks.resolve(op));
      if (!sameIdentity(op, resolved ?? {})) throw fault('STALE_REF');
      const check = async () => {
        const state = await deadline.run(() => hooks.fence(op, resolved));
        if (!sameIdentity(op, state ?? {})) throw fault('STALE_REF');
        if ((await deadline.run(() => hooks.authorize(op, resolved)))?.allowed !== true) throw fault('PERMISSION_REQUIRED');
        const after = await deadline.run(() => hooks.fence(op, resolved));
        if (!sameIdentity(op, after ?? {})) throw fault('STALE_REF');
      };
      await check();
      if (blocked.has(targetKey(op)) && op.op !== 'dialog') throw fault('EFFECT_UNKNOWN');
      const session = resolved.rootSession ?? resolved.session;
      if (!session?.sessionId || !resolved.session?.sessionId || !['send', 'on', 'off'].every(k => typeof resolved.session[k] === 'function')) throw fault('ADAPTER_UNAVAILABLE');
      armed = armEffects(resolved.session, op.frameId);
      let point;
      let frameLocal = false;
      if (!['dialog', 'wait'].includes(op.op)) {
        const inspect = hooks.inspect ?? inspectNode;
        const samples = [];
        for (let i = 0; i < 3; i++) {
          const state = await deadline.run(() => inspect(resolved, deadline));
          if (!state?.connected) throw fault('STALE_REF');
          if (state.visible !== true) throw fault('NOT_VISIBLE');
          if (state.enabled !== true) throw fault('DISABLED');
          if (state.hit !== true) throw fault('COVERED');
          if (op.op === 'insertText' && state.editable !== true) throw fault('READONLY_PICKER');
          if (['insertText', 'key'].includes(op.op) && state.focused !== true) throw fault('NOT_FOCUSED');
          if (!state.rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(state.rect[k]))
            || state.rect.width <= 0 || state.rect.height <= 0) throw fault('NOT_VISIBLE');
          samples.push(state.rect);
          frameLocal ||= state.frameLocal === true;
          await check();
          if (i < 2) await armed.pulse.wait(deadline, armed.pulse.version, 16);
        }
        if (!sameRect(samples[0], samples[1]) || !sameRect(samples[1], samples[2])) throw fault('UNSTABLE');
        const rect = samples[2];
        point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        // OOPIF coordinate conversion and parent hit checks require a qualified scoped adapter.
        if (frameLocal || (resolved.rootSession && resolved.rootSession !== resolved.session)) {
          if (typeof hooks.rootPoint !== 'function') throw fault('FRAME_UNQUALIFIED');
          point = await deadline.run(() => hooks.rootPoint(resolved, point, deadline));
          if (point?.hit !== true || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fault('COVERED');
        }
      }
      const command = async (method, params, route = session) => {
        await check();
        deadline.check();
        const inputStart = deadline.now();
        try {
          await deadline.run(async () => {
            // Deadline.run schedules its callback. Recheck identity inside that
            // callback after authorization, before journal transition and send.
            const current = await deadline.run(() => hooks.fence(op, resolved));
            if (!sameIdentity(op, current ?? {})) throw fault('STALE_REF');
            deadline.check();
            // No await between the final comparison and the actual send.
            // A throw/timeout from send may still mean the input reached Chrome.
            sent = true;
            entry.receipt = failure(op.operationId, 'EFFECT_UNKNOWN', true);
            return Promise.race([
              route.send(method, params),
              armed.barrier.then(() => { throw fault('DIALOG_OPEN'); }),
            ]);
          });
          if (armed.dialog) throw fault('DIALOG_OPEN');
        }
        finally { inputMs += deadline.now() - inputStart; }
      };
      if (op.op === 'click') {
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
      } else if (op.op === 'hover') {
        // Never focus-emulate or bringToFront. A five-second hidden mouseMoved stalls at the shared deadline.
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
      } else if (op.op === 'scroll') {
        await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: op.deltaX, deltaY: op.deltaY });
      } else if (op.op === 'insertText') {
        await command('Input.insertText', { text: op.text }, resolved.session);
      } else if (op.op === 'key') {
        const [code, virtualKey] = namedKeys[op.key];
        const params = { key: op.key === 'Space' ? ' ' : op.key, code, windowsVirtualKeyCode: virtualKey, modifiers: op.modifiers ?? 0 };
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params }, resolved.session);
        await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, resolved.session);
      } else if (op.op === 'dialog') {
        await command('Page.handleJavaScriptDialog', { accept: op.accept,
          ...(op.promptText === undefined ? {} : { promptText: op.promptText }) }, resolved.session);
      }
      const proofStart = deadline.now();
      let proof;
      try { proof = await proveEffect({ deadline, armed, observe: async args => {
        const authorizeCurrent = async () => {
          const current = await deadline.run(() => hooks.fence(op, resolved));
          if (sameIdentity(op, current ?? {})) {
            await check();
          } else if (op.expect.kind === 'navigation' && current
            && identityKeys.filter(k => !['origin', 'documentEpoch'].includes(k)).every(k => current[k] === op[k])
            && current.documentEpoch !== op.documentEpoch && typeof hooks.authorizeObservation === 'function') {
            // New-document reads need their own site gate; the connection is never that authority.
            if ((await deadline.run(() => hooks.authorizeObservation(op, current)))?.allowed !== true) throw fault('PERMISSION_REQUIRED');
          } else throw fault('STALE_REF');
          if (!sameIdentity(current, (await deadline.run(() => hooks.fence(op, resolved))) ?? {})) throw fault('STALE_REF');
          return current;
        };
        const current = await authorizeCurrent();
        const result = await hooks.observe({ ...args, resolved: { ...resolved, ...current } });
        const after = await authorizeCurrent();
        if (!sameIdentity(current, after) || result?.documentEpoch !== after.documentEpoch) throw fault('STALE_REF');
        return result;
      }, expect: op.expect, resolved, operation: op }); }
      finally { proofMs = deadline.now() - proofStart; }
      return { operationId: op.operationId, ...proof,
        timing: { total_ms: deadline.now() - deadline.started, prepare_ms: proofStart - start - inputMs,
          input_ms: inputMs, observation_ms: proofMs } };
    } catch (error) {
      // Raw CDP/page errors can contain private field values; do not echo their messages.
      const code = errorCode(error);
      if (armed?.dialog && sent) return { operationId: op.operationId, code: 'DIALOG_OPEN', phase: 'observed',
        effect: op.expect.kind === 'dialog' && op.expect.type === armed.dialog.type ? 'verified' : 'unknown',
        next: 'browser_act(dialog)', observation: { dialog: armed.dialog.type, complete: false } };
      return failure(op.operationId, sent ? 'EFFECT_UNKNOWN' : code, sent);
    } finally { armed?.stop(); }
  }

  async function runAct(op, { signal } = {}, sharedDeadline) {
    let deadline;
    try {
      validate(op);
      // Snapshot input: caller mutation after admission must not change what the gate sees or sends.
      op = structuredClone(op);
      deadline = sharedDeadline ?? new Deadline(op.timeout_ms ?? (op.expect.kind === 'navigation' ? 10000 : 3000), { signal, now: hooks.now });
    } catch { return failure(op?.operationId, 'INVALID_OPERATION'); }
    const key = operationKey(op);
    const fingerprint = digest(op);
    const prior = journal.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return failure(op.operationId, 'OPERATION_REUSED');
      return structuredClone(prior.pending ? await prior.pending : prior.receipt);
    }
    if (journal.size >= 4096) return failure(op.operationId, 'JOURNAL_FULL');
    const target = targetKey(op);
    const predecessor = queues.get(target) ?? Promise.resolve();
    const entry = { fingerprint, target };
    const pending = (async () => {
      let receipt;
      try { await deadline.run(() => predecessor); receipt = await execute(op, deadline, entry); }
      catch (error) { receipt = entry.receipt ?? failure(op.operationId, errorCode(error)); }
      entry.receipt = receipt;
      if (receipt.effect === 'unknown') blocked.add(target);
      delete entry.pending;
      return receipt;
    })();
    entry.pending = pending;
    journal.set(key, entry);
    // Caller expiry may resolve pending before its active predecessor. The target
    // reservation still waits for both, so later work cannot bypass that predecessor.
    const tail = Promise.allSettled([predecessor, pending]).then(() => {
      if (queues.get(target) === tail) queues.delete(target);
    });
    queues.set(target, tail);
    return structuredClone(await pending);
  }

  async function batch(steps, options) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 16) return { completed: [], stopped: failure(undefined, 'INVALID_OPERATION'), untouched: [] };
    const completed = [];
    let deadline;
    try { deadline = new Deadline(options?.timeout_ms ?? 3000, { signal: options?.signal, now: hooks.now }); }
    catch { return { completed, stopped: failure(undefined, 'INVALID_OPERATION'), untouched: steps.map(s => s.operationId) }; }
    for (let i = 0; i < steps.length; i++) {
      const receipt = await runAct(steps[i], options, deadline);
      if (receipt.effect !== 'verified' || receipt.observation?.dialog) {
        return { completed, stopped: receipt, untouched: steps.slice(i + 1).map(s => s.operationId) };
      }
      completed.push(receipt);
    }
    return { completed, untouched: [] };
  }
  return { act: (op, options) => runAct(op, options), batch };
}

// Fixed isolated-world projection. Never exposed as arbitrary evaluate. Scrolling uses CDP DOM,
// while input stays trusted CDP Input. Standard native accessors avoid custom MAIN getters.
function nodeState() {
  const el = this;
  const rect = Element.prototype.getBoundingClientRect.call(el);
  const style = getComputedStyle(el);
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  let hit = document.elementFromPoint(point.x, point.y);
  while (hit?.shadowRoot?.elementFromPoint) {
    const deeper = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  let contained = hit;
  while (contained && contained !== el) contained = contained.parentNode ?? contained.getRootNode()?.host;
  const editable = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    ? !el.readOnly && !el.disabled : el.isContentEditable;
  return { connected: el.isConnected, visible: rect.width > 0 && rect.height > 0
    && style.visibility !== 'hidden' && style.display !== 'none',
  enabled: !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true', editable,
  focused: document.activeElement === el || el.getRootNode().activeElement === el,
  hit: contained === el, frameLocal: window.top !== window,
  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
}

export async function inspectNode(resolved, deadline) {
  const { session, backendNodeId, executionContextId } = resolved;
  if (!Number.isSafeInteger(backendNodeId) || !Number.isSafeInteger(executionContextId)) throw fault('ADAPTER_UNAVAILABLE');
  await deadline.run(() => session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }));
  const node = await deadline.run(() => session.send('DOM.resolveNode', { backendNodeId, executionContextId }));
  if (!node.object?.objectId) throw fault('STALE_REF');
  try {
    const reply = await deadline.run(() => session.send('Runtime.callFunctionOn', {
      objectId: node.object.objectId, functionDeclaration: nodeState.toString(), returnByValue: true,
    }));
    if (reply.exceptionDetails) throw fault('STATE_UNVERIFIABLE');
    return reply.result?.value;
  } finally {
    // Releasing an internal remote object is safe even when the action deadline expired.
    session.send('Runtime.releaseObject', { objectId: node.object.objectId }).catch(() => {});
  }
}
