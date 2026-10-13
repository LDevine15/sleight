// Offline, opt-in presentation prototype. Trusted adapters supply policy-redacted
// engine observations using NP-1's identity/row fields. No engine or AX calls,
// approvals, actions, persisted content or production relay hooks live here.
import { createHash, randomUUID } from 'node:crypto';

const identityKeys = ['session', 'runtimeEpoch', 'pid', 'processStart', 'windowEpoch',
  'windowId', 'appId', 'title', 'url', 'document', 'leaseGeneration'];
const roles = new Set(['button', 'checkbox', 'text field', 'text', 'switch', 'row', 'cell',
  'menu item', 'window', 'dialog', 'sheet', 'group', 'container', 'slider', 'radio button',
  'link', 'list', 'outline', 'combo box', 'pop up button', 'tab', 'table', 'image']);
const refusalCodes = new Set(['APPROVAL_REQUIRED', 'DENIED', 'FORBIDDEN', 'LEASE_BUSY', 'USER_TAKEOVER',
  'WINDOW_CHANGED', 'VIEW_INCOMPLETE', 'AX_UNSUPPORTED', 'AX_TIMEOUT', 'ENGINE_UNAVAILABLE', 'EFFECT_UNKNOWN']);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const same = (a, b) => identityKeys.every(key => a?.[key] !== undefined && a[key] === b?.[key]);
const validIdentity = value => value && identityKeys.every(key =>
  typeof value[key] === 'string' || typeof value[key] === 'number' && Number.isFinite(value[key])) &&
  ['session', 'runtimeEpoch', 'windowEpoch', 'appId', 'document'].every(key => typeof value[key] === 'string' && value[key]) &&
  ['pid', 'windowId', 'leaseGeneration'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) && value.processStart > 0;
export class NativeViewError extends Error {
  constructor(code) { super(code); this.code = code; }
  toJSON() {
    return { version: 1, code: this.code, phase: 'prepared', effect: 'none',
      next: { kind: 'native_read', scope: this.code === 'WINDOW_CHANGED' ? 'window' : 'narrower' } };
  }
}
const fail = code => { throw new NativeViewError(code); };
const publicRow = row => ({ number: row.number, parent: row.parent ?? null,
  role: roles.has(row.role) ? row.role : 'unknown', name: row.secure ? '' : row.name.toWellFormed(),
  ...(typeof row.value === 'string' && !row.secure ? { value: row.value.toWellFormed() } : {}),
  ...Object.fromEntries(['selected', 'focused', 'enabled', 'checked', 'expanded', 'secure']
    .filter(key => typeof row[key] === 'boolean').map(key => [key, row[key]])) });
const scopeKey = request => JSON.stringify([request.scope ?? { kind: 'window' }, request.query ?? null]);

export class NativeViews {
  #current; #snapshot; #evidence = []; #views = new Map(); #cursors = new Map();
  #cacheBytes; #reusable = false; #counter = 0; #incarnation = 0;
  constructor({ current, cacheBytes = 8 * 1024 * 1024 }) {
    if (typeof current !== 'function' || !Number.isSafeInteger(cacheBytes) || cacheBytes < 1) throw new TypeError('Invalid view configuration');
    this.#current = current; this.#cacheBytes = Math.min(cacheBytes, 8 * 1024 * 1024);
  }
  #invalidate() { this.#views.clear(); this.#cursors.clear(); this.#evidence = []; this.#reusable = false; }
  #check() {
    if (!this.#snapshot) fail('VIEW_INCOMPLETE');
    if (!validIdentity(this.#current()) || !same(this.#snapshot.identity, this.#current())) {
      this.#invalidate(); fail('WINDOW_CHANGED');
    }
  }
  observe(input) {
    try {
      const data = structuredClone(input);
      if (!data || !validIdentity(data.identity) || !validIdentity(this.#current()) || !same(data.identity, this.#current())) fail('WINDOW_CHANGED');
      if (!['engine-full', 'engine-partial', 'direct-ax'].includes(data.source) ||
        !['scope-complete', 'rendered-partial', 'unknown'].includes(data.coverage) ||
        !['window', 'sheet', 'region'].includes(data.scope) || !Number.isFinite(data.observedAt) ||
        !Number.isSafeInteger(data.fullGeneration) || data.fullGeneration < 1 || !Array.isArray(data.rows) || data.rows.length > 20000) fail('VIEW_INCOMPLETE');
      if (data.refusal != null && !refusalCodes.has(data.refusal.code)) fail('VIEW_INCOMPLETE');
      const numbers = new Set();
      for (const row of data.rows) {
        if (!row || !Number.isSafeInteger(row.number) || row.number < 0 || numbers.has(row.number) ||
          typeof row.name !== 'string' || typeof row.role !== 'string' ||
          !(row.parent == null || Number.isSafeInteger(row.parent))) fail('VIEW_INCOMPLETE');
        numbers.add(row.number);
      }
      const parents = new Map(data.rows.map(row => [row.number, row.parent]));
      for (const row of data.rows) {
        const seen = new Set([row.number]); let parent = row.parent;
        while (parent != null) {
          if (!numbers.has(parent) || seen.has(parent)) fail('VIEW_INCOMPLETE');
          seen.add(parent); parent = parents.get(parent);
        }
      }
      if (this.#snapshot && same(data.identity, this.#snapshot.identity)) {
        if (data.fullGeneration <= this.#snapshot.fullGeneration) fail('TARGET_STALE');
      } else { this.#invalidate(); this.#incarnation++; }
      this.#cursors.clear();
      this.#evidence.push(data);
      while (this.#evidence.length > 2 || bytes(this.#evidence) > this.#cacheBytes) this.#evidence.shift();
      const retained = this.#evidence.includes(data);
      this.#reusable = retained;
      if (!retained) {
        this.#invalidate();
        // Retain only a bounded preview after evidence eviction, never an
        // oversized private document disguised as a guard cache.
        const preview = []; let used = 0;
        const all = new Map(data.rows.map(row => [row.number, row]));
        for (const row of data.rows) {
          let node = row, hidden = false;
          while (node) { hidden ||= !!node.hidden; node = all.get(node.parent); }
          const safe = publicRow(row), size = bytes(safe);
          if (hidden || size > 64000 - used) continue;
          preview.push(safe); used += size;
        }
        this.#snapshot = { identity: data.identity, source: data.source, scope: data.scope,
          observedAt: data.observedAt, fullGeneration: data.fullGeneration, rows: preview,
          refusal: data.refusal ? { code: data.refusal.code } : null, coverage: 'unknown', evicted: true };
      } else this.#snapshot = data;
      for (const [id, view] of this.#views) if (!this.#evidence.some(e => e.fullGeneration === view.generation)) this.#views.delete(id);
    } catch (error) {
      if (!(error instanceof NativeViewError) || error.code !== 'TARGET_STALE') { this.#invalidate(); this.#snapshot = undefined; }
      if (error instanceof NativeViewError) throw error;
      fail('VIEW_INCOMPLETE');
    }
  }
  guardEvidence() {
    this.#check();
    return this.#reusable && this.#snapshot.source === 'engine-full' ? structuredClone(this.#snapshot) : null;
  }
  legacyFull() {
    this.#check();
    if (!this.#reusable || this.#snapshot.source !== 'engine-full') fail('VIEW_INCOMPLETE');
    return structuredClone(this.#snapshot);
  }
  #select(request) {
    const data = this.#snapshot, scope = request.scope ?? { kind: 'window' }, query = request.query;
    if (!scope || !['window', 'sheet', 'region'].includes(scope.kind) ||
      Object.keys(scope).some(key => !['kind', 'number'].includes(key)) ||
      scope.kind !== 'window' && !Number.isSafeInteger(scope.number)) fail('AX_UNSUPPORTED');
    if (query && (typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key =>
      !['id', 'number', 'role', 'name', 'contains'].includes(key)) ||
      Object.entries(query).some(([key, value]) => key === 'number' ? !Number.isSafeInteger(value) : typeof value !== 'string' || value.length > 4096))) fail('AX_UNSUPPORTED');
    if (data.source === 'direct-ax' && query && Object.keys(query).some(key => key !== 'role')) fail('AX_UNSUPPORTED');
    if (data.refusal) return { rows: [], matchedRows: 0, required: new Set(), lineage: [], scope, searched: false };
    if (data.scope !== 'window' && (scope.kind !== data.scope || !data.rows.some(row => row.number === scope.number))) fail('AX_UNSUPPORTED');
    const all = new Map(data.rows.map(row => [row.number, row]));
    const visible = row => {
      let node = row;
      while (node) { if (node.hidden) return false; node = all.get(node.parent); }
      return true;
    };
    const rows = data.rows.filter(visible), map = new Map(rows.map(row => [row.number, row]));
    const ancestors = row => {
      const result = []; let parent = row.parent;
      while (parent != null && map.has(parent)) { result.push(parent); parent = map.get(parent).parent; }
      return result;
    };
    const inside = row => scope.kind === 'window' || row.number === scope.number || ancestors(row).includes(scope.number);
    const matches = row => !query || Object.entries(query).every(([key, value]) =>
      key === 'contains' ? !row.secure && row.name.includes(value) :
        ['name', 'id'].includes(key) && row.secure ? false : row[key] === value);
    const chosen = new Set(rows.filter(row => inside(row) && matches(row)).map(row => row.number));
    const matchedRows = chosen.size;
    const modals = rows.filter(row => ['sheet', 'dialog'].includes(row.role)).map(row => row.number);
    for (const row of rows) if (modals.includes(row.number) || ancestors(row).some(n => modals.includes(n))) chosen.add(row.number);
    for (const number of [...chosen]) for (const parent of ancestors(map.get(number))) chosen.add(parent);
    const required = new Set();
    for (const row of rows) if (chosen.has(row.number) && (row.parent == null || row.focused || row.selected ||
      modals.includes(row.number) || ancestors(row).some(n => modals.includes(n)))) {
      required.add(row.number); for (const parent of ancestors(row)) required.add(parent);
    }
    return { rows: rows.filter(row => chosen.has(row.number)).map(publicRow), matchedRows, required,
      lineage: rows.filter(row => chosen.has(row.number)).map(row => {
        const strong = [row.id, row.nodeIdentity, row.ancestor].every(value => typeof value === 'string' && value);
        return [row.number, strong ? createHash('sha256').update(JSON.stringify([row.id, row.nodeIdentity, row.ancestor])).digest('hex') : null];
      }),
      scope, query: query ?? null, searched: (scope.kind === 'window' || map.has(scope.number)) &&
        !data.rows.some(row => row.hidden || row.secure) };
  }
  read(request = {}) {
    this.#check();
    if (!request || typeof request !== 'object') fail('VIEW_INCOMPLETE');
    const budget = request.budgetBytes ?? 12000, reader = request.reader ?? 'default';
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 64000) fail('BUDGET_TOO_SMALL');
    if (typeof reader !== 'string' || !reader || reader.length > 128) fail('VIEW_INCOMPLETE');
    const data = this.#snapshot, selected = this.#select(request), key = scopeKey(request);
    let offset = 0;
    if (request.cursor) {
      const cursor = this.#cursors.get(request.cursor);
      if (!cursor || cursor.reader !== reader || cursor.generation !== data.fullGeneration || cursor.scope !== key) fail('TARGET_STALE');
      offset = cursor.offset;
    }
    const base = request.deltaFrom && this.#views.get(request.deltaFrom);
    const previous = base?.rows ?? [];
    const sameOrder = previous.length === selected.rows.length && previous.every((row, i) => row.number === selected.rows[i].number);
    const delta = !request.cursor && base?.reader === reader && base.scope === key &&
      base.complete && sameOrder && selected.lineage.every(parts => parts.slice(1).every(part => typeof part === 'string' && part)) &&
      JSON.stringify(base.lineage) === JSON.stringify(selected.lineage) && this.#reusable && !data.refusal;
    const candidates = delta ? selected.rows.filter((row, i) => JSON.stringify(row) !== JSON.stringify(previous[i])) : selected.rows;
    const cursorId = randomUUID(), viewId = `v${++this.#counter}`;
    const reply = { version: 1, app: `a${this.#incarnation}`, window: `w${this.#incarnation}`, view: viewId,
      fullGeneration: data.fullGeneration, source: data.source, scope: selected.scope,
      coverage: data.coverage, observedAt: data.observedAt, refusal: data.refusal ? { code: data.refusal.code } : null, mode: delta ? 'delta' : 'full',
      base: delta ? request.deltaFrom : null, resync: !!request.deltaFrom && !delta || !this.#reusable,
      acquisitionReduced: false, truncated: false, omittedRows: 0, remainingRows: 0,
      absence: 'unknown', cursor: cursorId, oversizedRows: [], rows: [] };
    if (bytes(reply) > budget) fail('BUDGET_TOO_SMALL');
    if (!delta) {
      reply.rows = selected.rows.filter(row => selected.required.has(row.number));
      if (bytes({ ...reply, omittedRows: data.rows.length, remainingRows: candidates.length, truncated: true }) > budget) fail('BUDGET_TOO_SMALL');
    }
    let position = offset;
    for (; position < candidates.length; position++) {
      const row = candidates[position];
      if (reply.rows.some(kept => kept.number === row.number)) continue;
      // Check the final receipt, including changing counters, before accepting a
      // whole row. JSON escapes and multibyte strings count toward the budget.
      const ancestors = []; let parent = row.parent;
      while (parent != null) {
        const ancestor = selected.rows.find(candidate => candidate.number === parent);
        if (!ancestor) break;
        if (!reply.rows.some(kept => kept.number === parent)) ancestors.unshift(ancestor);
        parent = ancestor.parent;
      }
      const trial = { ...reply, rows: [...reply.rows, ...ancestors, row], omittedRows: data.rows.length,
        remainingRows: candidates.length, truncated: true };
      if (bytes(trial) <= budget) { reply.rows.push(...ancestors, row); continue; }
      const required = selected.rows.filter(candidate => selected.required.has(candidate.number));
      const minimum = [...required, ...ancestors.filter(ancestor => !selected.required.has(ancestor.number)), row];
      if (bytes({ ...trial, rows: minimum }) > budget) {
        const omission = { ...trial, rows: reply.rows, oversizedRows: [...reply.oversizedRows, row.number] };
        if (bytes(omission) <= budget) { reply.oversizedRows.push(row.number); continue; }
      }
      break;
    }
    if (position === offset && position < candidates.length) fail('BUDGET_TOO_SMALL');
    reply.remainingRows = candidates.length - position;
    const order = new Map(selected.rows.map((row, i) => [row.number, i]));
    reply.rows.sort((a, b) => order.get(a.number) - order.get(b.number));
    reply.cursor = reply.remainingRows && this.#reusable ? cursorId : null;
    reply.omittedRows = data.rows.length - (delta ? selected.rows.length : reply.rows.length);
    reply.truncated = reply.remainingRows > 0 || reply.oversizedRows.length > 0 || !!data.evicted;
    if (data.coverage === 'scope-complete' && selected.searched && !reply.truncated && !offset) reply.absence = 'scoped';
    if (reply.cursor) this.#cursors.set(cursorId, { reader, generation: data.fullGeneration, scope: key, offset: position });
    this.#views.set(viewId, { reader, generation: data.fullGeneration, scope: key,
      rows: structuredClone(delta ? selected.rows : selected.rows.filter(row => reply.rows.some(kept => kept.number === row.number))),
      lineage: !offset && !reply.truncated ? selected.lineage : [], complete: !offset && !reply.truncated,
      actionable: data.source === 'engine-full' && data.coverage === 'scope-complete' && this.#reusable });
    while (this.#views.size > 32) {
      const oldest = this.#views.keys().next().value; this.#views.delete(oldest);
    }
    // Cursors are bounded independently from delivered views.
    while (this.#cursors.size > 32) this.#cursors.delete(this.#cursors.keys().next().value);
    if (data.source === 'direct-ax') reply.rows = reply.rows.map(row => ({ role: row.role,
      ...Object.fromEntries(['selected', 'focused', 'enabled', 'checked', 'expanded'].filter(key => key in row).map(key => [key, row[key]])) }));
    return reply;
  }
  delivered(reader, number) {
    this.#check();
    return [...this.#views.values()].some(view => view.reader === reader && view.generation === this.#snapshot.fullGeneration &&
      view.actionable && view.rows.some(row => row.number === number));
  }
  stats() {
    return { evidenceGenerations: this.#evidence.length, evidenceBytes: bytes(this.#evidence),
      views: this.#views.size, cursors: this.#cursors.size,
      deliveredNodes: new Set([...this.#views.values()].filter(view => view.generation === this.#snapshot?.fullGeneration)
        .flatMap(view => view.rows.map(row => row.number))).size };
  }
}
