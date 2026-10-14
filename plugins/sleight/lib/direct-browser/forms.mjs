import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadPlaywrightCore } from './worlds.mjs';
import { authorityKeys, sameAuthority } from './protected-proof.mjs';
import { Deadline, eventPulse } from './waits.mjs';
import { canonical, isAuthority } from './authority.mjs';
import { BrowserReads } from './reads.mjs';
import { isTransportOwner } from './transport-owner.mjs';

// Original strategies informed by reviewed BP2-7 forms and Playwright 1.64.0.
// The admitted upstream injected module is unchanged and remains node-scoped.
function formState(expected) {
  const el = this;
  if (!(el instanceof Element)) return { connected: false };
  const get = name => Element.prototype.getAttribute.call(el, name);
  const rect = Element.prototype.getBoundingClientRect.call(el), style = getComputedStyle(el);
  const read = (type, name, object = el) => Object.getOwnPropertyDescriptor(type.prototype, name)?.get?.call(object);
  const state = { connected: el.isConnected, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    enabled: !el.matches(':disabled') && get('aria-disabled') !== 'true', readonly: false,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, tag: el.localName, role: get('role') ?? '',
    frameLocal: window.top !== window };
  state.scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')?.get?.call(el) ?? 0;
  state.scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')?.get?.call(el) ?? 0;
  state.hovered = Element.prototype.matches.call(el, ':hover');
  state.focused = document.activeElement === el || el.getRootNode().activeElement === el;
  state.form = !!el.closest('form');
  if (el instanceof HTMLInputElement) {
    const type = read(HTMLInputElement, 'type');
    state.kind = ['checkbox', 'radio', 'date', 'number', 'range', 'file'].includes(type) ? type : ['submit', 'button', 'reset'].includes(type) ? 'button' : 'text';
    state.readonly = read(HTMLInputElement, 'readOnly');
    const labels = Array.from(read(HTMLInputElement, 'labels') ?? []).map(label => label.textContent).join(' ');
    state.protected = type === 'password' || /(?:password|secret|otp|token|one[-_ ]?time[-_ ]?code|cc[-_ ]?(?:number|csc)|card(?: ?number)?|cvv|cvc)/i.test([get('name'), get('id'), get('autocomplete'), labels].join(' '));
    const value = read(HTMLInputElement, 'value');
    if (state.protected) state.matched = value === expected;
    else state.value = ['checkbox', 'radio'].includes(type) ? read(HTMLInputElement, 'checked') : value;
    if (type === 'file') {
      const files = read(HTMLInputElement, 'files'); state.multiple = read(HTMLInputElement, 'multiple');
      state.files = Array.from(files).slice(0, 16).map(f => ({ name: f.name, size: f.size }));
    }
    if (['number', 'range', 'date'].includes(type)) for (const k of ['min', 'max', 'step']) state[k] = get(k);
    const validity = read(HTMLInputElement, 'validity');
    if (validity) state.valid = Object.getOwnPropertyDescriptor(ValidityState.prototype, 'valid')?.get?.call(validity);
    state.submit = type === 'submit';
  } else if (el instanceof HTMLTextAreaElement) {
    state.kind = 'text'; state.value = read(HTMLTextAreaElement, 'value'); state.readonly = read(HTMLTextAreaElement, 'readOnly');
  } else if (el instanceof HTMLSelectElement) {
    state.kind = 'select'; state.multiple = read(HTMLSelectElement, 'multiple');
    const options = read(HTMLSelectElement, 'options');
    state.options = Array.from(options).slice(0, 100).map(o => ({ value: read(HTMLOptionElement, 'value', o),
      label: read(HTMLOptionElement, 'label', o), disabled: read(HTMLOptionElement, 'disabled', o), selected: read(HTMLOptionElement, 'selected', o) }));
    state.optionsComplete = options.length <= 100;
    state.value = state.multiple ? state.options.filter(o => o.selected).map(o => o.value) : read(HTMLSelectElement, 'value');
  } else {
    state.kind = ['switch', 'checkbox', 'radio'].includes(state.role) ? state.role : el instanceof HTMLButtonElement ? 'button' : 'custom';
    // ARIA state is labeled as such; custom MAIN getters are never invoked here.
    const checked = get('aria-checked');
    if (['true', 'false'].includes(checked)) { state.value = checked === 'true'; state.source = 'ax'; }
    if (el instanceof HTMLButtonElement) state.submit = read(HTMLButtonElement, 'type') === 'submit' && !!read(HTMLButtonElement, 'form');
  }
  state.editable = !state.readonly && state.enabled;
  let hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  while (hit?.shadowRoot?.elementFromPoint) {
    const next = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!next || next === hit) break; hit = next;
  }
  for (let node = hit; node; node = node.parentNode ?? node.getRootNode()?.host) if (node === el) { state.hit = true; break; }
  // Page text can raise payment risk, never authorize a payment.
  state.payment = /\b(?:pay|purchase|buy|checkout|donate|subscribe|place order)\b/i.test(get('aria-label') ?? el.textContent ?? '');
  if (state.kind === 'button' && el.closest('form,dialog,[role="dialog"]') &&
      /^(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test((get('aria-label') ?? el.textContent ?? '').trim())) state.submit = true;
  if (state.payment) state.submit = true;
  return state;
}

let playwright;
export function formInspectors() {
  if (!playwright) {
    loadPlaywrightCore({ turbo: true }); // Verify every package byte before extracting the static literal.
    const bundle = readFileSync(new URL('../../vendor/playwright-core/lib/coreBundle.js', import.meta.url), 'utf8');
    const literal = bundle.match(/source5 = ('(?:\\.|[^'\\])*');/)?.[1];
    if (!literal) throw Error('PLAYWRIGHT_PACKAGE_MISMATCH');
    const source = runInNewContext(literal, Object.create(null), { timeout: 100 });
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (sha256 !== '852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf') throw Error('PLAYWRIGHT_PACKAGE_MISMATCH');
    playwright = Object.freeze({ version: 1, source, sha256, parameters: [] });
  }
  return Object.freeze({ ...fixedFormInspectors, playwright });
}
export const fixedFormInspectors = Object.freeze({
  'form-state': Object.freeze({ version: 1, source: String(formState), sha256: createHash('sha256').update(String(formState)).digest('hex'),
    parameters: [{ type: 'string', maxBytes: 65536 }] }),
});
const equals = (a, b) => Array.isArray(b) ? Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every(v => a.includes(v)) : a === b;
const shape = s => canonical(Object.fromEntries(['kind', 'tag', 'role', 'readonly', 'multiple', 'min', 'max', 'step', 'options', 'protected']
  .filter(k => s[k] !== undefined).map(k => [k, k === 'options' ? s.options.map(({ selected, ...o }) => o) : s[k]])));
const safe = error => ['HIDDEN', 'DISABLED', 'COVERED', 'STALE_REF', 'READONLY_PICKER', 'UNKNOWN_CHECKED_STATE', 'OPTIONS_CHANGED',
  'INVALID_FIELD', 'FRAME_UNQUALIFIED', 'RECOVERY_READ_REQUIRED', 'UNSTABLE', 'BACKGROUND_UNAVAILABLE', 'FILE_AUTHORITY_REQUIRED'].includes(error?.message) ? error.message : 'STATE_UNVERIFIABLE';

// Internal trusted session. None of its provider methods is a model endpoint.
// onOperation publishes only to the branded transport resolver. Input JSON
// supplies refs and values; it cannot set submit, consequence or target checks.
export function createFormSession({ session, identity, current, resolveRef, onOperation, paymentTerms = () => undefined,
  files, observeEffect, onProof = () => {}, helpers = formInspectors, now = Date.now } = {}) {
  if (!session || [current, resolveRef, onOperation].some(f => typeof f !== 'function') || authorityKeys.some(k => identity?.[k] === undefined)) throw Error('FORM_CONTRACT_REQUIRED');
  identity = Object.freeze({ ...identity });
  let world, instance, constructor, sequence = 0, closed = false, active, resolvedOperation, checked, busy = false, submitFence = false, activeNode;
  let dialogSequence = 0, opening, dialogWake;
  const dialogs = new Map();
  const secret = randomBytes(32), prefix = randomBytes(8).toString('hex'), fingerprint = value => createHmac('sha256', secret).update(canonical(value)).digest('hex');
  const operationId = id => 'form:' + prefix + ':' + fingerprint(id).slice(0, 32);
  const pendingReads = new Set(), receipts = new Map(), retained = new Set();
  const fieldOperations = new Map();
  const proveField = effect => {
    for (const op of fieldOperations.values()) onProof(op, effect);
    fieldOperations.clear();
  };
  const dialogOpening = event => {
    if (closed || !active || event.frameId && event.frameId !== identity.frame || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(event.type)) return;
    try { if (new URL(event.url).origin !== identity.origin) return; } catch { return; }
    const id = 'd' + randomBytes(8).toString('hex');
    const state = { payment: active.consequence === 'payment' || /\b(?:pay|purchase|buy|donate|subscribe)\b/i.test(event.message ?? ''),
      submit: active.submit === true || active.consequence === 'payment' };
    const terms = paymentTerms({ ...state, dialog: event.message, type: event.type }, active.scope);
    opening = { id, privateId: 'dialog-' + (++dialogSequence), ref: active.scope.ref, type: event.type, state, terms };
    dialogs.set(id, opening); dialogWake?.(opening);
  };
  session.on('Page.javascriptDialogOpening', dialogOpening);
  const scope = ref => ({ browser: identity.browserIncarnation, broker: identity.brokerEpoch, session: identity.clientSession,
    turn: identity.turn, target: identity.target, lease: identity.leaseGeneration, frame: identity.frame, document: identity.document, ref, origin: identity.origin });
  const fence = ref => {
    if (closed || !sameAuthority(identity, current())) throw Error('STALE_REF');
    const node = resolveRef(ref);
    if (!sameAuthority(identity, node.binding ?? node)) throw Error('STALE_REF');
    return node;
  };
  const activate = (id, ref, kind = 'read', args = {}, state) => {
    fence(ref);
    const terms = state?.payment ? paymentTerms(state, scope(ref)) : undefined;
    active = { id, kind, args, scope: scope(ref), consequence: state?.payment ? 'payment' : 'ordinary',
      ...(state?.submit ? { submit: true } : {}), ...(terms ? { terms } : {}) };
    if (!state) checked = undefined;
    if (state) checked = { operation: canonical(active), present: state.connected === true, visible: state.visible === true,
      enabled: state.enabled === true, same: true };
    if (state && kind !== 'read') fieldOperations.set(id, { id, kind, scope: active.scope });
    onOperation(structuredClone(active));
  };
  const prepId = () => 'prep:' + prefix + ':' + (++sequence);
  const readCommand = (ref, method, params) => { activate(prepId(), ref); return session.send(method, params); };
  const release = async (ref, id) => {
    try { await readCommand(ref, 'Runtime.releaseObject', { objectId: id }); retained.delete(id); }
    catch { retained.add(id); }
  };
  async function setup(ref, deadline) {
    if (!world) {
      await deadline.run(() => readCommand(ref, 'Page.enable', {}));
      world = (await deadline.run(() => readCommand(ref, 'Page.createIsolatedWorld', {
        frameId: identity.frame, worldName: 'sleight-state', grantUniveralAccess: false }))).executionContextId;
    }
    if (!instance) {
      helpers(); // Verify before installation even when a trusted registry was supplied at construction.
      activate(prepId(), ref);
      constructor = (await deadline.run(() => session.installFixed('playwright', world))).objectId;
      activate(prepId(), ref);
      instance = (await deadline.run(() => session.createPlaywright({ constructor }))).objectId;
    }
    return world;
  }
  async function object(ref, deadline, nodeId) {
    await setup(ref, deadline);
    const backendNodeId = nodeId ?? fence(ref).backendNodeId;
    return (await deadline.run(() => readCommand(ref, 'DOM.resolveNode', { backendNodeId, executionContextId: world }))).object.objectId;
  }
  async function inspect(ref, node, expected, deadline) {
    activate(prepId(), ref);
    const reply = await deadline.run(() => session.send('Runtime.callFunctionOn', { objectId: node,
      functionDeclaration: fixedFormInspectors['form-state'].source, arguments: [{ value: typeof expected === 'string' ? expected : '' }], returnByValue: true, awaitPromise: false }));
    fence(ref);
    if (reply.exceptionDetails || !reply.result?.value || typeof reply.result.value !== 'object') throw Error('STATE_UNVERIFIABLE');
    return reply.result.value;
  }
  async function pw(ref, node, method, args, deadline) {
    activate(prepId(), ref);
    const reply = await deadline.run(() => session.callPlaywright({ instance, node, method, args }));
    fence(ref); if (reply.exceptionDetails) throw Error('STATE_UNVERIFIABLE'); return reply.result?.value;
  }
  async function prepare(ref, expected, deadline) {
    const resolved = fence(ref); activeNode = resolved.backendNodeId;
    const validateSemantic = async () => {
      const tree = await deadline.run(() => readCommand(ref, 'Accessibility.getPartialAXTree', {
        backendNodeId: resolved.backendNodeId, fetchRelatives: false, maxNodes: 100 }));
      const node = tree.nodes?.find(n => n.backendDOMNodeId === resolved.backendNodeId);
      let semantic;
      try { semantic = JSON.parse(resolved.semantic); } catch { throw Error('STALE_REF'); }
      if (!node || node.frameId && node.frameId !== identity.frame || !Array.isArray(semantic) ||
          node.role?.value !== semantic[0] || semantic[1] && node.name?.value !== semantic[1]) throw Error('STALE_REF');
    };
    await validateSemantic();
    await deadline.run(() => readCommand(ref, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: activeNode }));
    let node = await object(ref, deadline);
    try {
      let before = await inspect(ref, node, expected, deadline);
      if (before.kind === 'custom' && typeof expected === 'boolean') {
        const tree = await deadline.run(() => readCommand(ref, 'DOM.describeNode', { backendNodeId: resolved.backendNodeId, depth: 2, pierce: false }));
        const candidates = [];
        const walk = (raw, depth = 0) => {
          if (!raw || depth > 3 || raw.frameId && raw.frameId !== identity.frame) return;
          const attrs = Object.fromEntries((raw.attributes ?? []).flatMap((value, i, all) => i % 2 ? [] : [[value, all[i + 1]]]));
          if (['switch', 'checkbox', 'radio'].includes(attrs.role)) candidates.push(raw.backendNodeId);
          for (const child of [...raw.children ?? [], ...raw.shadowRoots ?? []]) walk(child, depth + 1);
        };
        walk(tree.node);
        if (candidates.length !== 1) throw Error('UNKNOWN_CHECKED_STATE');
        await release(ref, node); activeNode = candidates[0]; node = await object(ref, deadline, activeNode);
        before = await inspect(ref, node, expected, deadline);
      }
      if (!before.connected) throw Error('STALE_REF'); if (!before.visible) throw Error('HIDDEN'); if (!before.enabled) throw Error('DISABLED');
      if (before.frameLocal) throw Error('FRAME_UNQUALIFIED');
      const result = await pw(ref, node, 'checkElementStates', { states: ['visible', 'enabled', 'stable'] }, deadline);
      if (result) throw Error('UNSTABLE');
      const rect = before.rect, x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (await pw(ref, node, 'expectHitTarget', { x, y }, deadline) !== 'done') throw Error('COVERED');
      await validateSemantic();
      const after = await inspect(ref, node, expected, deadline);
      if (shape(before) !== shape(after) || ['x', 'y', 'width', 'height'].some(k => Math.abs(rect[k] - after.rect[k]) >= .25)) throw Error('OPTIONS_CHANGED');
      if (!after.connected || !after.visible || !after.enabled) throw Error('STALE_REF');
      return { node, state: after, point: { x, y } };
    } catch (error) { await release(ref, node); throw error; }
  }
  const physical = (id, ref, kind, args, state, method, params, deadline) => deadline.run(() => {
    deadline.check(); activate(id, ref, kind, args, state); // No asynchronous preparation after this current target check.
    return session.input(method, params);
  });
  async function click(id, ref, prepared, deadline) {
    opening = undefined;
    const barrier = new Promise(resolve => { dialogWake = resolve; });
    try {
      for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]]) {
        await Promise.race([physical(id, ref, 'click', {}, prepared.state, 'Input.dispatchMouseEvent', { type, ...prepared.point, button: 'left', buttons, clickCount: 1 }, deadline),
          barrier.then(() => { throw Error('DIALOG_OPEN'); })]);
        if (opening) throw Error('DIALOG_OPEN');
      }
    } finally { dialogWake = undefined; }
  }
  async function field(field, id, deadline) {
    fieldOperations.clear();
    const { ref, value } = field, prepared = await prepare(ref, value, deadline);
    let sent = false, stage, preparing = true;
    const state = prepared.state;
    try {
      if (state.readonly) throw Error('READONLY_PICKER');
      if (state.kind === 'range') {
        const min = Number(state.min ?? 0), max = Number(state.max ?? 100), step = Number(state.step ?? 1), steps = (value - min) / step;
        if (typeof value !== 'number' || ![min, max, step, steps].every(Number.isFinite) || step <= 0 || value < min || value > max ||
            !Number.isInteger(steps) || steps > 1000) throw Error('INVALID_FIELD');
        sent = true; await click(id + ':focus', ref, prepared, deadline);
        for (let i = 0; i <= steps; i++) {
          const key = i ? 'ArrowRight' : 'Home';
          const fresh = await inspect(ref, prepared.node, '', deadline);
          if (!fresh.connected || !fresh.visible || !fresh.enabled || shape(fresh) !== shape(state)) throw Error('STALE_REF');
          for (const type of ['rawKeyDown', 'keyUp']) await physical(id, ref, 'fill', { value: String(value) }, fresh,
            'Input.dispatchKeyEvent', { type, key, code: key, modifiers: 0 }, deadline);
        }
        field = { ref, value: String(value) };
      } else if (['checkbox', 'radio', 'switch'].includes(state.kind)) {
        if (typeof value !== 'boolean' || typeof state.value !== 'boolean') throw Error('UNKNOWN_CHECKED_STATE');
        if (state.value !== value) { sent = true; await click(id, ref, prepared, deadline); }
      } else if (state.kind === 'select') {
        const wanted = Array.isArray(value) ? value : [value];
        if (!state.optionsComplete && state.optionsComplete !== undefined || !state.multiple && wanted.length !== 1 || !wanted.length || new Set(wanted).size !== wanted.length) throw Error('INVALID_FIELD');
        const selected = wanted.map(v => {
          const exact = state.options.filter(o => o.value === v), options = exact.length ? exact : state.options.filter(o => o.label === v);
          if (options.length !== 1 || options[0].disabled) throw Error('INVALID_FIELD'); return options[0].value;
        });
        if (!equals(state.value, state.multiple ? selected : selected[0])) {
          // All setup, option mapping and node preparation precede the typed actuator's terminal fence.
          activate(id, ref, 'select', { values: selected }, state); sent = true;
          const reply = await deadline.run(() => { activate(id, ref, 'select', { values: selected }, state);
            return session.callPlaywright({ instance, node: prepared.node, method: 'selectOptions', args: { options: selected.map(value => ({ value })) } }); });
          if (reply.exceptionDetails) throw Error('STATE_UNVERIFIABLE');
        }
        field = { ref, value: state.multiple ? selected : selected[0] };
      } else if (state.kind === 'file') {
        if (!files || !Array.isArray(value?.files)) throw Error('FILE_AUTHORITY_REQUIRED');
        const binding = { ...identity, operation: id, ref };
        const marker = 'stage:' + id; retained.add(marker);
        stage = await deadline.run(() => {
          const pending = Promise.resolve(files.stage(value.files, binding));
          pending.then(late => {
            retained.delete(marker);
            if (!preparing || closed) {
              try { if (late.cleanup()?.retained !== false) retained.add(late); } catch { retained.add(late); }
            }
          }, () => retained.delete(marker));
          return pending;
        });
        const final = await inspect(ref, prepared.node, '', deadline);
        if (!final.connected || !final.visible || !final.enabled || shape(final) !== shape(state)) throw Error('STALE_REF');
        activate(id, ref, 'upload', { files: value.files }, final); sent = true;
        const transfer = await deadline.run(() => { activate(id, ref, 'upload', { files: value.files }, final);
          return session.setFilePayloads({ backendNodeId: activeNode, operation: id, executionContextId: world }, stage); });
        if (transfer.transfer.effect !== 'transferred' || transfer.cleanup.object.retained) throw Error('STATE_UNVERIFIABLE');
        proveField('verified');
        return { effect: 'verified', observation: { files: { transferred: true, count: transfer.transfer.count } } };
      } else {
        if (!['text', 'date', 'number'].includes(state.kind)) throw Error('INVALID_FIELD');
        let text = value;
        if (state.kind === 'date') {
          text = value?.date;
          if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) !== text) throw Error('INVALID_FIELD');
        } else if (state.kind === 'number') {
          const steps = (value - Number(state.min || 0)) / Number(state.step || 1);
          if (typeof value !== 'number' || !Number.isFinite(value) || state.min && value < Number(state.min) || state.max && value > Number(state.max) ||
              state.step !== 'any' && (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-9)) throw Error('INVALID_FIELD'); text = String(value);
        }
        if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('INVALID_FIELD');
        if (!state.protected && state.value === text) return { effect: 'unchanged', observation: { target: true } };
        activate(id, ref, 'fill', { value: text }, state); sent = true;
        const reply = await deadline.run(() => { activate(id, ref, 'fill', { value: text }, state);
          return session.callPlaywright({ instance, node: prepared.node, method: 'fill', args: { value: text } }); });
        if (reply.exceptionDetails) throw Error('STATE_UNVERIFIABLE');
        if (reply.result?.value === 'needsinput') {
          const final = await inspect(ref, prepared.node, text, deadline);
          if (!final.connected || !final.visible || !final.enabled || final.readonly || shape(final) !== shape(state)) throw Error('STALE_REF');
          await physical(id, ref, 'fill', { value: text }, final, 'Input.insertText', { text }, deadline);
        }
        else if (reply.result?.value !== 'done') throw Error('STATE_UNVERIFIABLE');
        field = { ref, value: text };
      }
      const after = await inspect(ref, prepared.node, field.value, deadline);
      if (!after.connected || shape(state) !== shape(after)) throw Error('OPTIONS_CHANGED');
      if (after.valid === false || (state.protected ? after.matched !== true : !equals(after.value, field.value))) throw Error('STATE_UNVERIFIABLE');
      fence(ref); deadline.check(); proveField(state.protected ? 'protected' : 'verified');
      return { effect: state.protected ? 'protected' : sent ? 'verified' : 'unchanged', observation: { target: true,
        ...(state.protected ? { protected: true } : {}), source: state.source ?? 'native' } };
    } catch (error) {
      if (sent && (state.submit || state.payment)) submitFence = true;
      return { effect: sent ? 'unknown' : 'none', observation: { code: safe(error) } };
    }
    finally {
      preparing = false;
      fieldOperations.clear();
      if (stage) {
        try { const result = await stage.cleanup(); if (result?.retained) retained.add(stage); }
        catch { retained.add(stage); }
      }
      await release(ref, prepared.node);
    }
  }
  async function fill(fields, { operation, timeoutMs = 3000, signal } = {}) {
    if (closed || busy || typeof operation !== 'string' || !Array.isArray(fields) || !fields.length || fields.length > 50) throw Error('INVALID_FIELD');
    const input = structuredClone(fields), key = operation, hash = fingerprint(input);
    if (receipts.has(key)) { const old = receipts.get(key); if (old.fingerprint !== hash) throw Error('OPERATION_REUSED'); return structuredClone(old.receipt); }
    if (receipts.size >= 1024) throw Error('FORM_JOURNAL_FULL');
    busy = true; const deadline = new Deadline(timeoutMs, { signal, now }), results = [];
    let stopped;
    try {
      for (let i = 0; i < input.length; i++) {
        let result;
        const pulse = eventPulse();
        for (;;) {
          try { result = await field(input[i], operationId(operation + ':' + i), deadline); }
          catch (error) { result = { effect: 'none', observation: { code: safe(error) } }; }
          // Dependent controls are checked anew after the preceding field. Only
          // a proved no-input disabled refusal may retry; unknown writes never do.
          if (!i || result.effect !== 'none' || result.observation.code !== 'DISABLED') break;
          try { await pulse.wait(deadline, pulse.version); } catch { break; }
        }
        if (!['verified', 'protected', 'unchanged'].includes(result.effect)) { stopped = result; break; }
        results.push(result);
      }
      const receipt = { effect: stopped?.effect ?? 'verified', completed: results.length,
        untouched: input.length - results.length - (stopped?.effect === 'unknown' ? 1 : 0), results,
        observation: stopped?.observation ?? { targets: results.length, complete: false },
        ...(retained.size ? { cleanupRequired: true } : {}) };
      receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
    } finally { input.forEach(f => { f.value = undefined; }); busy = false; }
  }
  async function act(step, { operation, timeoutMs = 3000, signal } = {}) {
    canonical(step); step = structuredClone(step);
    const key = operation, hash = fingerprint(step);
    if (receipts.has(key)) { const old = receipts.get(key); if (old.fingerprint !== hash) throw Error('OPERATION_REUSED'); return structuredClone(old.receipt); }
    if (receipts.size >= 1024) throw Error('FORM_JOURNAL_FULL');
    if (closed || busy) throw Error('FORM_BUSY'); busy = true;
    let prepared, sent = false;
    const deadline = new Deadline(timeoutMs, { signal, now });
    try {
      if (step.op === 'select') {
        const result = await field({ ref: step.ref, value: step.value }, operationId(operation), deadline);
        const receipt = { ...result, completed: ['verified', 'unchanged', 'protected'].includes(result.effect) ? 1 : 0, untouched: result.effect === 'none' ? 1 : 0 };
        receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
      }
      if (step.op === 'wait') {
        const node = await object(step.ref, deadline), pulse = eventPulse();
        try {
          for (;;) {
            const state = await inspect(step.ref, node, '', deadline);
            const matches = { visible: state.visible, hidden: state.visible === false, enabled: state.enabled, disabled: state.enabled === false }[step.state];
            if (state.connected && matches === true) {
              const receipt = { effect: 'verified', completed: 1, untouched: 0, observation: { target: true, source: 'native' } };
              receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
            }
            await pulse.wait(deadline, pulse.version);
          }
        } finally { await release(step.ref, node); }
      }
      if (step.op === 'dialog') {
        const dialog = dialogs.get(step.dialog);
        if (!dialog || !['accept', 'dismiss'].includes(step.action) || !['confirm', 'prompt'].includes(dialog.type) && step.action === 'accept') throw Error('STALE_REF');
        const id = operationId(operation), accept = step.action === 'accept';
        if (accept && dialog.state.submit && submitFence) throw Error('RECOVERY_READ_REQUIRED');
        const state = { ...dialog.state, ...(dialog.terms ? { terms: dialog.terms } : {}) };
        activate(id, dialog.ref, 'dialog', { action: step.action, ...(step.value === undefined ? {} : { text: step.value }) }, state);
        // Use the dialog's observed exact terms, not the initiating button's terms.
        if (dialog.terms) active.terms = dialog.terms;
        onOperation(structuredClone(active));
        dialog.decision = { ...identity, cdpSessionId: session.sessionId, epoch: identity.leaseGeneration,
          operation: id, dialogId: dialog.privateId, accept, ...(step.value === undefined ? {} : { promptText: step.value }) };
        sent = true;
        if (accept && dialog.state.submit) submitFence = true;
        await deadline.run(() => { fence(dialog.ref); return session.answerDialog({ dialogId: dialog.privateId, operation: id, accept,
          ...(step.value === undefined ? {} : { promptText: step.value }) }); });
        dialogs.delete(step.dialog);
        if (accept && dialog.state.submit) submitFence = true;
        const receipt = { effect: 'unknown', completed: 0, untouched: 0, observation: { code: 'EFFECT_UNKNOWN' } };
        receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
      }
      if (!['click', 'key', 'scroll', 'hover'].includes(step.op)) throw Error('BACKGROUND_UNAVAILABLE');
      prepared = await prepare(step.ref, '', deadline);
      if (step.op === 'click' && prepared.state.payment) prepared.state.submit = true;
      const id = operationId(operation);
      if (step.op === 'key') {
        const parts = step.key.split('+'), key = parts.pop(), modifiers = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
        if (parts.some(p => !Object.hasOwn(modifiers, p)) || new Set(parts).size !== parts.length) throw Error('INVALID_FIELD');
        const mask = parts.reduce((mask, name) => mask | modifiers[name], 0);
        const named = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (!named.includes(key) && !/^[a-zA-Z0-9]$/.test(key)) throw Error('INVALID_FIELD');
        const state = { ...prepared.state, submit: (key === 'Enter' || key === 'Space' && prepared.state.kind === 'button') && (prepared.state.submit || prepared.state.form &&
          (prepared.state.tag !== 'textarea' || mask & 6)) };
        state.payment = state.payment && state.submit;
        if (state.submit && submitFence) throw Error('RECOVERY_READ_REQUIRED');
        if (!state.focused) { sent = true; await click(id + ':focus', step.ref, prepared, deadline); }
        const fresh = await inspect(step.ref, prepared.node, '', deadline);
        if (!fresh.connected || !fresh.visible || !fresh.enabled || shape(fresh) !== shape(prepared.state)) throw Error('STALE_REF');
        prepared.state = { ...fresh, submit: state.submit }; sent = true;
        const code = /^[a-zA-Z]$/.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key : key;
        for (const type of ['rawKeyDown', 'keyUp']) await physical(id, step.ref, 'key', { key: step.key }, prepared.state,
          'Input.dispatchKeyEvent', { type, key: key === 'Space' ? ' ' : key, code, modifiers: mask }, deadline);
      } else if (step.op === 'scroll') {
        const dx = step.dx ?? 0, dy = step.dy ?? 0;
        if (![dx, dy].every(v => Number.isFinite(v) && Math.abs(v) <= 100000)) throw Error('INVALID_FIELD');
        sent = true; await physical(id, step.ref, 'scroll', { deltaX: dx, deltaY: dy }, { ...prepared.state, submit: false, payment: false },
          'Input.dispatchMouseEvent', { type: 'mouseWheel', ...prepared.point, deltaX: dx, deltaY: dy }, deadline);
        const after = await inspect(step.ref, prepared.node, '', deadline);
        if (after.connected && (after.scrollTop !== prepared.state.scrollTop || after.scrollLeft !== prepared.state.scrollLeft)) {
          const receipt = { effect: 'verified', completed: 1, untouched: 0, observation: { target: true, source: 'native' } };
          receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
        }
      } else if (step.op === 'hover') {
        sent = true; await physical(id, step.ref, 'click', {}, { ...prepared.state, submit: false, payment: false },
          'Input.dispatchMouseEvent', { type: 'mouseMoved', ...prepared.point, buttons: 0 }, deadline);
        const after = await inspect(step.ref, prepared.node, '', deadline);
        if (after.connected && after.hovered === true) {
          const receipt = { effect: 'verified', completed: 1, untouched: 0, observation: { target: true, source: 'native' } };
          receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
        }
      } else {
        if (prepared.state.submit && submitFence) throw Error('RECOVERY_READ_REQUIRED');
        sent = true; await click(id, step.ref, prepared, deadline);
      }
      const proof = typeof observeEffect === 'function' ? await deadline.run(() => observeEffect({ identity, ref: step.ref, operation, signal })) : null;
      fence(step.ref);
      const verified = proof?.matched === true && sameAuthority(identity, proof.identity) && ['native', 'ax', 'causal-event'].includes(proof.source);
      if (prepared.state.submit && !verified) submitFence = true;
      const receipt = { effect: verified ? 'verified' : 'unknown', completed: verified ? 1 : 0, untouched: 0,
        observation: { target: true, ...(verified ? { source: proof.source } : { code: 'EFFECT_UNKNOWN' }) } };
      receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
    } catch (error) {
      if (sent && opening && error.message === 'DIALOG_OPEN') {
        const receipt = { effect: 'verified', completed: 1, untouched: 0, observation: { dialog: { id: opening.id, type: opening.type } } };
        receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
      }
      if (sent && prepared?.state.submit) submitFence = true;
      const receipt = { effect: sent ? 'unknown' : 'none', completed: 0, untouched: sent ? 0 : 1, observation: { code: safe(error) } };
      receipts.set(key, { fingerprint: hash, receipt }); return structuredClone(receipt);
    } finally { if (prepared) await release(step.ref, prepared.node); busy = false; }
  }
  return Object.freeze({ fill, act, get activeNode() { return activeNode; },
    dialogBinding() { return [...dialogs.values()].find(d => d.decision?.operation === active?.id)?.decision ?? null; },
    resolveOperation(command) {
      if (!active) throw Error('SEMANTIC_OPERATION_MISMATCH');
      const { method, params } = command;
      const physical = method.startsWith('Input.') || method === 'Page.handleJavaScriptDialog' ||
        method === 'Runtime.callFunctionOn' && /^(?:function\(node,(?:value|options)\)\{return this\.(?:fill|selectOptions)\(|function\(payloads\)\s*\{)/.test(params.functionDeclaration);
      if (physical) {
        if (active.kind === 'read') throw Error('SEMANTIC_OPERATION_MISMATCH');
        if (method === 'Input.insertText' && (active.kind !== 'fill' || params.text !== active.args.value) ||
            method === 'Runtime.callFunctionOn' && active.kind === 'fill' && params.arguments?.[1]?.value !== active.args.value ||
            method === 'Runtime.callFunctionOn' && active.kind === 'select' && !equals(params.arguments?.[1]?.value?.map(o => o.value), active.args.values)) throw Error('SEMANTIC_OPERATION_MISMATCH');
        resolvedOperation = active;
      } else resolvedOperation = { id: prepId(), kind: 'read', args: {}, scope: active.scope, consequence: 'ordinary' };
      return structuredClone(resolvedOperation);
    },
    classify(op) {
      const expected = canonical(op) === canonical(active) ? active : resolvedOperation;
      if (!expected || canonical(op) !== canonical(expected)) throw Error('SEMANTIC_OPERATION_MISMATCH');
      return structuredClone(expected);
    },
    checkTarget(op) {
      return !closed && sameAuthority(identity, current()) && checked?.operation === canonical(op) ?
        { present: checked.present, visible: checked.visible, enabled: checked.enabled, same: checked.same } : null;
    },
    // P3 records only an actually successful scoped read, then acknowledges it
    // after delivery. Private inspectors and failed/foreign reads cannot release.
    pendingRead(observation, observedIdentity) {
      if (!closed && typeof observation === 'string' && sameAuthority(identity, observedIdentity)) pendingReads.add(observation);
    },
    deliveredRead(observation, observedIdentity) {
      if (closed || !sameAuthority(identity, current()) || !sameAuthority(identity, observedIdentity) || !pendingReads.delete(observation)) return false;
      submitFence = false; return true;
    },
    cleanup({ remoteReleased = false } = {}) {
      for (const item of retained) {
        if (typeof item === 'string') { if (remoteReleased && !item.startsWith('stage:')) retained.delete(item); }
        else try { if (item.cleanup()?.retained === false) retained.delete(item); } catch {}
      }
      return { retained: retained.size };
    },
    dispose() { closed = true; checked = active = undefined; pendingReads.clear(); dialogs.clear(); session.off('Page.javascriptDialogOpening', dialogOpening); },
  });
}

// P1/P3 join entry. P3 owns selection, connection approval, leased frame/node
// metadata and actual delivery; this entry never discovers or connects a root.
// A connection-owned TransportOwner retains both delivered refs and forms.
export function createSemanticAdapter({ owner, leaseFor, current, paymentTerms, files, observeEffect } = {}) {
  if (!isTransportOwner(owner) || [leaseFor, current].some(f => typeof f !== 'function')) throw Error('SEMANTIC_OWNER_REQUIRED');
  const sessions = new Map(); let active, authority;
  const identityFor = lease => Object.fromEntries(authorityKeys.map(k => [k,
    k === 'leaseGeneration' ? lease.epoch : lease[k]]));
  const stateFor = lease => sessions.get(canonical(lease));
  return Object.freeze({
    bindAuthority(value) { if (authority || !isAuthority(value)) throw Error('TRUSTED_AUTHORITY_REQUIRED'); authority = value; },
    prepare(args, context, operationName) {
      if (!['browser_read', 'browser_fill', 'browser_act'].includes(operationName)) throw Error('BACKGROUND_UNAVAILABLE');
      const lease = leaseFor(args.tab, context), identity = identityFor(lease);
      if (!sameAuthority(identity, current(lease)) || identity.clientSession !== context.session || identity.turn !== context.turn ||
          identity.browserIncarnation !== context.browserIncarnation || identity.brokerEpoch !== context.brokerEpoch) throw Error('STALE_REF');
      return { target: lease.target, lease };
    },
    authorize: () => true, // P1's physical authority is the terminal payment/target gate.
    dispatchFence(plan) { return sameAuthority(identityFor(plan.lease), current(plan.lease)); },
    async dispatch(plan, context) {
      if (!authority) throw Error('TRUSTED_AUTHORITY_REQUIRED');
      const { lease } = plan, identity = identityFor(lease);
      return owner.run(lease, context, async view => {
        const reader = owner.reader(lease, 'semantics', () => {
          const reader = new BrowserReads({ identity, authorize: () => sameAuthority(identity, current(lease)) });
          reader.addFrame({ session: view, frameId: lease.frame, target: lease.target, document: lease.document }); return reader;
        });
        const form = owner.reader(lease, 'forms', () => createFormSession({ session: view, identity,
          current: () => current(lease), resolveRef: ref => reader.resolve(ref), files, paymentTerms, observeEffect,
          onProof(op, effect) {
            const record = authority.receipt(op.id);
            if (!record || record.phase !== 'dispatched') throw Error('HOST_PROOF_REQUIRED');
            authority.observe(op.id); authority.verify(op.id, effect);
          },
          onOperation: operation => { active = { operation, form: stateFor(lease)?.form, lease }; } }));
        const cursors = stateFor(lease)?.cursors ?? new Map();
        sessions.set(canonical(lease), { reader, form, identity, cursors });
        if (plan.operationName === 'browser_read') {
          const scope = { browser: identity.browserIncarnation, broker: identity.brokerEpoch, session: identity.clientSession, turn: identity.turn,
            target: identity.target, lease: identity.leaseGeneration, frame: identity.frame, document: identity.document, ref: plan.args.scope ?? 'read', origin: identity.origin };
          active = { lease, operation: { id: 'read:' + randomBytes(16).toString('hex'), kind: 'read', args: {}, scope, consequence: 'ordinary' } };
          const continuation = cursors.get(plan.args.scope);
          if (continuation && !continuation.delivered) return { effect: 'none', completed: 0, observation: { code: 'STALE_REF' } };
          const observation = await reader.read({ ...(continuation ? { cursor: continuation.cursor } : { ref: plan.args.scope }),
            maxBytes: Math.min(plan.args.max_bytes ?? 12000, 11000) - 80 });
          form.pendingRead(observation.observation, identity);
          // Cursor handles are scoped read continuations, never element refs or
          // input capabilities. The closed host already admits r read scopes.
          if (observation.cursor) {
            const handle = 'r' + randomBytes(16).toString('hex');
            cursors.set(handle, { cursor: observation.cursor, observation: observation.observation, delivered: false });
            while (cursors.size > 32) cursors.delete(cursors.keys().next().value);
            return { effect: 'verified', observation: { ...observation, cursor: handle } };
          }
          return { effect: 'verified', observation };
        }
        const options = { operation: context.operation, timeoutMs: plan.args.timeout_ms ?? 3000, signal: context.signal };
        if (plan.operationName === 'browser_fill') return form.fill(plan.args.fields, options);
        if (plan.args.steps) {
          const results = [];
          for (let i = 0; i < plan.args.steps.length; i++) {
            const r = await form.act(plan.args.steps[i], { ...options, operation: options.operation + ':' + i });
            if (!['verified', 'unchanged', 'protected'].includes(r.effect)) return { ...r, completed: results.length, results, untouched: plan.args.steps.length - results.length - (r.effect === 'unknown' ? 1 : 0) };
            results.push({ effect: r.effect, observation: r.observation });
          }
          return { effect: 'verified', completed: results.length, results, untouched: 0, observation: { targets: results.length } };
        }
        return form.act(plan.args, options);
      });
    },
    resolveOperation(plan, context, command) {
      if (!active || canonical(active.lease) !== canonical(plan.lease)) throw Error('SEMANTIC_OPERATION_MISMATCH');
      return active.form ? active.form.resolveOperation(command) : structuredClone(active.operation);
    },
    classify(operation) { return active?.form ? active.form.classify(operation) :
      canonical(operation) === canonical(active?.operation) ? structuredClone(operation) : (() => { throw Error('SEMANTIC_OPERATION_MISMATCH'); })(); },
    currentScope() {
      if (!active || !sameAuthority(identityFor(active.lease), current(active.lease))) throw Error('STALE_REF');
      return structuredClone(active.operation.scope);
    },
    checkTarget: operation => active?.form?.checkTarget(operation),
    fileBinding(lease, backendNodeId) {
      const state = stateFor(lease), operation = active?.operation;
      if (!state || active.form !== state.form || state.form.activeNode !== backendNodeId || operation?.kind !== 'upload' ||
          !sameAuthority(state.identity, current(lease))) return null;
      return { ...state.identity, operation: operation.id, ref: operation.scope.ref };
    },
    dialogBinding: (id, lease) => stateFor(lease)?.form.dialogBinding() ?? null,
    async cleanupSession(id) {
      const remote = await owner.cleanupSession(id), local = files?.cleanup(id) ?? { retained: 0 };
      let retained = local.retained;
      for (const state of sessions.values()) if (state.identity.clientSession === id) retained += state.form.cleanup({ remoteReleased: remote.closed }).retained;
      return { closed: remote.closed && retained === 0, retained, cleanup: remote.cleanup };
    },
    // Only the host's actual delivery path calls this, after a successful read
    // survived serialization/output limits and reached that owning client.
    delivered(lease, observation) {
      const state = stateFor(lease);
      if (!state || !sameAuthority(state.identity, current(lease)) || !state.reader.acknowledge(observation)) return false;
      for (const cursor of state.cursors.values()) if (cursor.observation === observation) cursor.delivered = true;
      state.form.deliveredRead(observation, state.identity); return true;
    },
  });
}
