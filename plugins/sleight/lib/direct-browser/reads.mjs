import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RefMap } from './refs.mjs';
import { rowChanges } from './deltas.mjs';
// This fixed inspector runs in a CDP isolated world, with no module closures.
// It reads native standard-control accessors only; custom MAIN getters belong to BP-4.
export function inspectControl() {
  const element = this;
  const attribute = name => Element.prototype.getAttribute.call(element, name);
  const native = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name)?.get?.call(element);
  const bounded = value => {
    if (typeof value !== 'string') return value;
    let result = '', bytes = 0;
    for (const character of value) {
      const code = character.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes > 512) break;
      result += character;
    }
    if (result !== value) state.truncated = true;
    return result;
  };
  if (!(element instanceof Element)) return {};
  const state = { standard: true };
  const labels = element instanceof HTMLInputElement ? Array.from(native(HTMLInputElement, 'labels') ?? []).map(label => label.textContent).join(' ') : '';
  if (/(?:password|secret|otp|token|one[-_ ]?time[-_ ]?code|cc[-_ ]?(?:number|csc)|card(?: ?number)?|cvv|cvc)/i.test(
    [attribute('name'), attribute('id'), attribute('autocomplete'), labels].join(' '))) return { protected: true };
  if (element instanceof HTMLInputElement) {
    const type = native(HTMLInputElement, 'type');
    const autocomplete = attribute('autocomplete') ?? '';
    if (type === 'password' || /(?:^|\s)(?:one-time-code|cc-number|cc-csc|current-password|new-password)(?:\s|$)/i.test(autocomplete)) return { protected: true };
    state.value = bounded(native(HTMLInputElement, 'value'));
    if (type === 'checkbox' || type === 'radio') state.checked = native(HTMLInputElement, 'checked');
    state.disabled = native(HTMLInputElement, 'disabled');
    state.readonly = native(HTMLInputElement, 'readOnly');
    state.required = native(HTMLInputElement, 'required');
  } else if (element instanceof HTMLTextAreaElement) {
    state.value = bounded(native(HTMLTextAreaElement, 'value'));
    state.disabled = native(HTMLTextAreaElement, 'disabled');
    state.readonly = native(HTMLTextAreaElement, 'readOnly');
    state.required = native(HTMLTextAreaElement, 'required');
  } else if (element instanceof HTMLSelectElement) {
    state.value = bounded(native(HTMLSelectElement, 'value'));
    state.multiple = native(HTMLSelectElement, 'multiple');
    const options = native(HTMLSelectElement, 'options');
    state.options = [];
    for (let i = 0; i < Math.min(options.length, 30); i++) {
      const option = options.item(i);
      // Call the option's native getters on the option, not the select.
      const read = name => Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, name).get.call(option);
      state.options.push({ label: bounded(read('label')), value: bounded(read('value')), selected: read('selected'), disabled: read('disabled') });
    }
    state.optionsOmitted = Math.max(0, options.length - state.options.length);
  } else return { ariaOnly: true };
  return state;
}


export const fixedReadInspectors = Object.freeze({
  'control-state': Object.freeze({ version: 1, source: String(inspectControl),
    sha256: createHash('sha256').update(String(inspectControl)).digest('hex'), parameters: [] }),
});

// P1I exposes shallow owned DOM and per-node ARIA, never a full target tree.
// Frame contents need their own leased view; closed roots are explicitly omitted.
async function acquireARIA({ session, frameId, backendNodeId, maxNodes, run }) {
  const reply = await run(() => session.send(backendNodeId ? 'DOM.describeNode' : 'DOM.getDocument',
    { ...(backendNodeId ? { backendNodeId } : {}), depth: 1, pierce: false }));
  const root = reply[backendNodeId ? 'node' : 'root'], nodes = new Map(), seen = new Set();
  let complete = true;
  async function walk(raw, depth = 0) {
    if (!raw || depth > 64 || seen.size >= maxNodes) { complete = false; return; }
    if (seen.has(raw.backendNodeId)) { complete = false; return; }
    seen.add(raw.backendNodeId);
    if (raw.frameId && raw.frameId !== frameId && !['iframe', 'frame'].includes(raw.localName)) { complete = false; return; }
    const partial = await run(() => session.send('Accessibility.getPartialAXTree',
      { backendNodeId: raw.backendNodeId, fetchRelatives: false, maxNodes }));
    for (const node of partial.nodes) {
      if (node.frameId && node.frameId !== frameId) { complete = false; continue; }
      if (nodes.size >= maxNodes && !nodes.has(node.nodeId)) { complete = false; continue; }
      nodes.set(node.nodeId, node);
    }
    if (['iframe', 'frame', 'object', 'embed'].includes(raw.localName)) { complete = false; return; }
    let expanded = raw;
    if (raw.childNodeCount > (raw.children?.length ?? 0)) {
      expanded = (await run(() => session.send('DOM.describeNode',
        { backendNodeId: raw.backendNodeId, depth: 1, pierce: false }))).node;
    }
    if (expanded.childNodeCount > (expanded.children?.length ?? 0)) complete = false;
    if (expanded.shadowRoots?.length) complete = false;
    for (const child of expanded.children ?? []) await walk(child, depth + 1);
    // Explicit shallow closed-root expansion, under the same node/frame budget.
    // It never promotes closed coverage to whole-page completeness.
    for (const shadow of expanded.shadowRoots ?? []) await walk(shadow, depth + 1);
  }
  await walk(root);
  // AX children outside this bounded DOM acquisition are omitted, never absence proof.
  for (const node of nodes.values()) if (node.childIds?.some(id => !nodes.has(id))) complete = false;
  return { nodes: [...nodes.values()], complete };
}


const DEFAULT_BYTES = 12000;
const MAX_BYTES = 64000;
const MAX_CURSORS = 32;
const controlRoles = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']);
const byteLength = value => Buffer.byteLength(JSON.stringify(value));
const text = value => {
  if (typeof value !== 'string') return '';
  let result = '', bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > 512) break;
    result += character;
  }
  return result;
};
const property = (node, name) => node.properties?.find(p => p.name === name)?.value?.value;

function stateOf(node, native) {
  if (native.protected || property(node, 'protected') === true) return { protected: true };
  const state = {};
  for (const field of ['checked', 'selected', 'expanded', 'disabled', 'readonly', 'required', 'focused', 'invalid', 'multiselectable', 'valuemin', 'valuemax']) {
    const value = property(node, field);
    if (typeof value === 'boolean' || typeof value === 'number' || ['mixed', 'true', 'false'].includes(value)) state[field] = value;
  }
  if (!native.ariaOnly && typeof node.value?.value === 'string') state.value = text(node.value.value);
  if (native.ariaOnly) state.source = 'ax';
  for (const field of ['checked', 'selected', 'expanded', 'disabled', 'readonly', 'required', 'multiple']) {
    if (typeof native[field] === 'boolean') state[field] = native[field];
  }
  if (typeof native.value === 'string') { state.value = text(native.value); state.valueTruncated = native.truncated === true || state.value !== native.value; }
  if (Array.isArray(native.options)) {
    state.options = [];
    let bytes = 0;
    for (const option of native.options.slice(0, 30)) {
      const row = { label: text(option.label), value: text(option.value), selected: option.selected === true, disabled: option.disabled === true };
      bytes += byteLength(row);
      if (bytes > 2400) break;
      state.options.push(row);
    }
    state.optionsOmitted = Math.max(0, native.options.length - state.options.length) + (Number.isSafeInteger(native.optionsOmitted) ? Math.max(0, native.optionsOmitted) : 0);
  }
  return state;
}

// Internal adapter only. BP-2 supplies selected/authorized sessions; this module
// never discovers, connects, attaches, opens, focuses, or grants browser access.
export class BrowserReads {
  #identity;
  #refs;
  #frames = new Map();
  #baselines = new Map();
  #pending = new Map();
  #maxNodes;
  #pages = new Map();
  #authorize;
  #prefix = randomBytes(4).toString('hex');
  #sequence = 0;
  #frameSequence = 0;
  #documentSequence = 0;
  #busy = false;
  #disposed = false;
  #exposed = new Set();
  #timeout;

  constructor({ identity, authorize = () => false, timeoutMs = 10000, maxNodes = 1000 }) {
    this.#identity = Object.freeze({ ...identity }); this.#refs = new RefMap(identity);
    this.#authorize = authorize; this.#timeout = timeoutMs;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 2048) throw Error('Invalid acquisition budget');
    this.#maxNodes = maxNodes;
  }

  addFrame({ session, frameId, document, target, parent = null }) {
    if (frameId !== this.#identity.frame || document !== this.#identity.document || target !== this.#identity.target) throw Error('Invalid frame identity');
    if (this.#disposed || !frameId || !document || !target || !session?.sessionId || ['send', 'on', 'off'].some(name => typeof session[name] !== 'function')) throw Error('Invalid frame session');
    this.#invalidate(frameId);
    this.#remove(frameId);
    const frame = { session, frameId, document, target, parent, alias: `f${++this.#frameSequence}`, generation: ++this.#documentSequence, context: null, enabled: false };
    const retire = () => { this.#invalidate(frameId); this.#remove(frameId); };
    frame.listeners = [['Page.frameNavigated', event => { if (event.frame?.id === frameId) retire(); }],
      ['Page.frameDetached', event => { if (event.frameId === frameId) retire(); }],
      ['Page.navigatedWithinDocument', event => { if (event.frameId === frameId) retire(); }],
      ['DOM.documentUpdated', retire], ['Runtime.executionContextsCleared', retire],
      ['Runtime.executionContextDestroyed', () => { this.#invalidate(frameId); frame.context = null; }]];
    for (const [name, listener] of frame.listeners) session.on(name, listener);
    this.#frames.set(frameId, frame);
  }

  #remove(frameId) {
    const frame = this.#frames.get(frameId);
    if (!frame) return;
    for (const [name, listener] of frame.listeners) frame.session.off(name, listener);
    this.#frames.delete(frameId);
  }

  #invalidate(frameId) {
    const frame = this.#frames.get(frameId);
    if (frame) frame.generation = ++this.#documentSequence;
    this.#refs.invalidateFrame(frameId);
    for (const [id, child] of this.#frames) if (child.parent === frameId) { this.#invalidate(id); this.#remove(id); }
    for (const [scope, baseline] of this.#baselines) if (baseline.frame === frameId) this.#baselines.delete(scope);
    for (const [id, page] of this.#pages) if (page.frame.frameId === frameId) this.#pages.delete(id);
    for (const [scope, pending] of this.#pending) if (pending.frame === frameId) this.#pending.delete(scope);
  }

  resolve(ref) {
    if (!this.#exposed.has(ref)) throw Error('Ref is stale or unavailable');
    return this.#refs.resolve(ref, this.#identity);
  }

  acknowledge(observation) {
    const entry = [...this.#pending].find(([, pending]) => pending.observation === observation);
    if (!entry) return false;
    const [scope, pending] = entry;
    this.#baselines.set(scope, pending); this.#pending.delete(scope);
    for (const ref of pending.rows.keys()) this.#exposed.add(ref);
    return true;
  }

  async #bounded(action, deadline) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timeout')), Math.max(1, deadline - performance.now()));
      })]);
    } finally { clearTimeout(timer); }
  }

  #send(frame, method, params, deadline) { return this.#bounded(() => frame.session.send(method, params), deadline); }

  #permit(frame, deadline) {
    return this.#bounded(() => this.#authorize({ ...this.#identity, target: frame.target, frame: frame.frameId, document: frame.document }), deadline);
  }

  async #acquire(frame, backendNode, deadline) {
    if (!frame.enabled) {
      await this.#send(frame, 'Page.enable', {}, deadline);
      await this.#send(frame, 'Accessibility.enable', {}, deadline); frame.enabled = true;
    }
    const aria = await acquireARIA({ session: frame.session, frameId: frame.frameId,
      backendNodeId: backendNode, maxNodes: this.#maxNodes, run: action => this.#bounded(action, deadline) });
    if (!Array.isArray(aria.nodes) || aria.nodes.length > this.#maxNodes) throw Error('ARIA acquisition budget exceeded');
    const nodes = new Map(aria.nodes.map(n => [n.nodeId, n]));
    let complete = aria.complete === true;
    if (backendNode && ![...nodes.values()].some(n => n.backendDOMNodeId === backendNode)) throw Error('missing node');
    const parents = new Map();
    for (const node of nodes.values()) for (const child of node.childIds ?? []) parents.set(child, node.nodeId);
    const ordered = [], seen = new Set();
    const visit = id => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = nodes.get(id);
      if (!node) { complete = false; return; }
      if (node.frameId && node.frameId !== frame.frameId) { complete = false; return; }
      if (ordered.length >= this.#maxNodes) { complete = false; return; }
      ordered.push(node);
      for (const child of node.childIds ?? []) visit(child);
    };
    if (backendNode) visit([...nodes.values()].find(n => n.backendDOMNodeId === backendNode).nodeId);
    else for (const node of nodes.values()) if (!parents.has(node.nodeId)) visit(node.nodeId);
    if (seen.size < nodes.size && !backendNode) complete = false;
    const rows = [], publicRefs = new Map();
    for (const node of ordered) {
      if (!Number.isSafeInteger(node.backendDOMNodeId) || node.backendDOMNodeId <= 0) { complete = false; continue; }
      if (aria && node.axEnrich === true) {
        const supplement = await this.#send(frame, 'Accessibility.getPartialAXTree', { backendNodeId: node.backendDOMNodeId, fetchRelatives: false }, deadline);
        const ax = supplement.nodes?.find(n => n.backendDOMNodeId === node.backendDOMNodeId);
        if (ax && (!ax.frameId || ax.frameId === frame.frameId)) {
          node.properties ??= ax.properties; node.value ??= ax.value;
        } else complete = false;
      }
      const role = text(node.role?.value) || 'group';
      let native = {}, sensed = true;
      if (controlRoles.has(role)) {
        let objectId;
        try {
          if (!frame.context) frame.context = (await this.#send(frame, 'Page.createIsolatedWorld', { frameId: frame.frameId, worldName: 'sleight-state', grantUniveralAccess: false }, deadline)).executionContextId;
          objectId = (await this.#send(frame, 'DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, executionContextId: frame.context }, deadline)).object?.objectId;
          if (!objectId) throw Error('no object');
          const read = await this.#send(frame, 'Runtime.callFunctionOn', { objectId, functionDeclaration: inspectControl.toString(), returnByValue: true, awaitPromise: false }, deadline);
          if (read.exceptionDetails || !read.result?.value || typeof read.result.value !== 'object') throw Error('unreadable');
          native = read.result.value;
          if (native.unsupported) throw Error('unsupported control');
        } catch { sensed = false; complete = false; }
        finally { if (objectId) await this.#send(frame, 'Runtime.releaseObject', { objectId }, deadline).catch(() => {}); }
      }
      // Unreadable control state must not leak the AX fallback's protected value.
      const state = sensed ? stateOf(node, native) : { unreadable: true };
      if (native.truncated || state.valueTruncated || state.optionsOmitted > 0) complete = false;
      const name = state.protected || !sensed ? '' : text(node.name?.value);
      const semantic = [role, state.protected || !sensed ? '' : node.name?.value,
        ['row', 'listitem', 'option'].includes(role) && !state.protected ? node.value?.value : null];
      const ref = this.#refs.observe(this.#identity, node.backendDOMNodeId, JSON.stringify(semantic));
      publicRefs.set(node.nodeId, ref);
      rows.push({ ref, role, name, ...(name !== (state.protected || !sensed ? '' : node.name?.value ?? '') ? { nameTruncated: true } : {}), state, parent: publicRefs.get(parents.get(node.nodeId)) ?? null, position: rows.length });
    }
    // Refs authorize only nodes re-observed in this acquisition. An unreadable
    // value does not preserve missing nodes. A topology gap leaves absence
    // unknown in coverage, while unchecked old refs require a fresh observation.
    if (!backendNode) this.#refs.retain(this.#identity, new Set(ordered.map(n => n.backendDOMNodeId)));
    return { rows, complete };
  }

  async read({ frame: frameId, ref, since, cursor, query, private: privateRead = false, maxBytes = DEFAULT_BYTES } = {}) {
    if (this.#disposed || this.#busy) throw Error('Reader unavailable');
    this.#busy = true;
    const started = performance.now(), deadline = started + this.#timeout;
    try {
      if (!Number.isFinite(maxBytes) || maxBytes < 700 || (query !== undefined && (typeof query !== 'string' || query.length > 512))) throw Error('Invalid read request');
      maxBytes = Math.min(Math.floor(maxBytes), MAX_BYTES);
      let binding = ref ? this.resolve(ref) : null;
      const page = cursor ? this.#pages.get(cursor) : null;
      if (cursor && !page) throw Error('Cursor stale or unavailable');
      if (page) { binding = page.binding ? this.resolve(page.binding.ref) : null; query = page.query; }
      const frame = page?.frame ?? this.#frames.get(binding?.frame ?? frameId ?? this.#frames.keys().next().value);
      if (!frame) throw Error('Frame unavailable');
      const generation = frame.generation;
      const permitted = await this.#permit(frame, deadline);
      if (permitted !== true) throw Error('Read not authorized');
      const scope = page?.scope ?? JSON.stringify([frame.frameId, binding?.backendNode ?? null, query ?? null]);
      let acquired;
      try { acquired = await this.#acquire(frame, binding?.backendNode, deadline); }
      catch (error) {
        // The active scope may come from a cursor rather than the caller ref.
        // Retire that binding and its views, without touching another scope.
        if (binding) {
          this.#refs.invalidateRef(binding.ref); this.#exposed.delete(binding.ref);
          for (const [id, existing] of this.#pages) if (existing.binding?.ref === binding.ref) this.#pages.delete(id);
          for (const views of [this.#pending, this.#baselines]) for (const key of views.keys()) {
            const [viewFrame, backendNode] = JSON.parse(key);
            if (viewFrame === binding.frame && backendNode === binding.backendNode) views.delete(key);
          }
        }
        throw error;
      }
      if (binding) this.resolve(binding.ref);
      if (page && JSON.stringify(acquired) !== JSON.stringify(page.acquired)) throw Error('Cursor stale or unavailable');
      if (frame.generation !== generation || !this.#frames.has(frame.frameId)) throw Error('observation invalidated');
      if (await this.#permit(frame, deadline) !== true) throw Error('Read not authorized');
      if (frame.generation !== generation || this.#disposed || this.#frames.get(frame.frameId) !== frame) throw Error('observation invalidated');
      const byRef = new Map(acquired.rows.map(row => [row.ref, row]));
      let selected = acquired.rows;
      if (query) {
        const wanted = new Set();
        for (const row of selected) if (row.name.includes(query)) {
          for (let current = row; current && !wanted.has(current.ref); current = byRef.get(current.parent)) wanted.add(current.ref);
        }
        selected = selected.filter(row => wanted.has(row.ref));
      }
      // A cursor returned only in the preceding envelope is also a delivery receipt.
      if (page && !privateRead) this.acknowledge(page.observation);
      const baseline = this.#baselines.get(scope);
      const delta = page ? page.mode === 'delta' : acquired.complete && since && baseline?.observation === since;
      const from = page ? page.observation : since;
      const observation = `o${this.#prefix}${(++this.#sequence).toString(36)}`;
      const resync = !acquired.complete ? 'incomplete-sensing' : since && !delta ? 'baseline-mismatch' : null;
      const changes = delta ? rowChanges(selected, baseline.rows, byRef) : new Map();
      const candidates = page?.candidates ?? (delta ? selected.filter(row => changes.has(row.ref)).map(row => changes.get(row.ref)) : selected.map(row => ({ ...row, kind: 'row' })));
      if (delta && !page) for (const old of baseline.rows.values()) if (!byRef.has(old.ref)) candidates.push({ ref: old.ref, kind: 'removed' });
      const offset = page?.offset ?? 0;
      const nextCursor = `c${this.#prefix}${this.#sequence.toString(36)}`;
      const result = { observation, from: delta ? from : null, to: observation, frame: frame.alias, document: frame.generation,
        mode: delta ? 'delta' : 'full', resync, complete: false, omitted: candidates.length - offset, pending: !acquired.complete,
        coverage: { acquired: acquired.rows.length, matched: selected.length, delivered: 0, offset, sensing: acquired.complete ? 'complete' : 'incomplete' },
        cursor: nextCursor, note: 'Page truncated; more with scope or max_bytes.', data: [] };
      const formatStarted = performance.now();
      for (const row of candidates.slice(offset)) {
        const { kind, ...plain } = row;
        const parent = plain.parent;
        if (parent && !result.data.some(r => r.ref === parent) && !baseline?.rows.has(parent) && !page) break;
        result.data.push(row); result.omitted--; result.coverage.delivered++;
        if (byteLength(result) > maxBytes) { result.data.pop(); result.omitted++; result.coverage.delivered--; break; }
      }
      result.complete = acquired.complete && result.omitted === 0;
      if (result.omitted === 0) { result.cursor = null; delete result.note; }
      if (result.omitted > 0 && result.data.length === 0) { result.cursor = null; result.resync = 'budget-too-small'; }
      // Acknowledged delta state includes only changes that actually fit in this envelope.
      const delivered = delta || page ? new Map(baseline?.rows) : new Map();
      for (const row of result.data) {
        if (row.kind === 'removed') delivered.delete(row.ref);
        else { const { kind, ...plain } = row; delivered.set(row.ref, plain);  }
      }
      if (!privateRead) this.#pending.set(scope, { observation, scope, frame: frame.frameId, rows: delivered });
      if (!privateRead) for (const [id, existing] of this.#pages) if (existing.scope === scope) this.#pages.delete(id);
      if (result.cursor && !privateRead) this.#pages.set(nextCursor, { frame, acquired, binding, query, candidates, scope, observation, mode: result.mode, offset: offset + result.data.length });
      while (this.#pages.size > MAX_CURSORS) this.#pages.delete(this.#pages.keys().next().value);
      this.lastMetrics = Object.freeze({ acquisitionMs: formatStarted - started, formattingMs: performance.now() - formatStarted,
        acquiredNodes: acquired.rows.length, utf8Bytes: byteLength(result), tokenProxy: Math.ceil(byteLength(result) / 4), tokenProxyName: 'UTF-8 bytes / 4 (not model tokens)' });
      return result;
    } catch (error) {
      // Browser errors and page exceptions can contain protected values or hostile text.
      const known = ['Read not authorized', 'observation invalidated', 'Invalid read request', 'Frame unavailable', 'Cursor stale or unavailable', 'Ref is stale or unavailable'];
      throw Error(known.includes(error.message) ? error.message : 'Read unavailable; request a fresh scoped observation');
    } finally { this.#busy = false; }
  }

  dispose() {
    this.#disposed = true;
    for (const id of [...this.#frames.keys()]) this.#remove(id);
    this.#refs.clear(); this.#baselines.clear(); this.#pages.clear(); this.#pending.clear();
    this.#exposed.clear();
  }
}
