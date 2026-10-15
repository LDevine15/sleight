// Compact page snapshots for turbo v3, with an independent CR1 closed-root reader.
const pages = new WeakMap();
const REF = /^(?:(?:f\d+)?e\d+|s\d+)$/;
const MORE = /^more\d+_\d+$/;
const SENSITIVE = /password|passcode|secret|one.?time|\botp\b|\bcc[-_ ]|card|expiry|expiration|cvv|cvc|security.?code/i;
const TIMEOUT = 3000;
const scalarRole = role => /^(textbox|searchbox|combobox)$/.test(role);
const normalized = value => String(value ?? '').replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
// CR2: derive from WAI-ARIA with citations (queue/CR2.md).
const CONTROL_ROLE = { test() { throw Error('CR2: CONTROL_ROLE not derived'); } };

async function bounded(action) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Snapshot read timed out; try browser_read again.')), TIMEOUT);
    })]);
  } finally { clearTimeout(timer); }
}

function stateOf(page) {
  let state = pages.get(page);
  if (!state) {
    state = { number: 0, generation: 0, busy: false, history: new Map(), continuations: new Map(),
      closed: new Map(), shadowNumber: 0, deliveredClosed: new Set(), rawRefs: new Map(), usedRefs: new Set(),
      refBank: new Map(), deliveredRefs: new Set(), pending: new Map(), nextRef: 0 };
    pages.set(page, state);
    if (typeof page.locator === 'function') {
      const closedResolver = typeof page.getByRef === 'function' ? page.getByRef.bind(page) : undefined;
      Object.defineProperty(page, 'getByRef', { configurable: true, value(ref) {
        if (/^s\d+$/.test(ref)) {
          closedRefBinding(page, ref);
          if (!closedResolver) throw Error('Closed-root action provider is unavailable; use the engine browser path.');
          return closedResolver(ref);
        }
        return snapshotRefBinding(page, ref);
      } });
    }
    page.on('framenavigated', () => {
      state.generation++; state.rawRefs.clear(); state.deliveredRefs.clear(); state.pending.clear(); state.history.clear(); state.continuations.clear(); state.closed.clear(); state.deliveredClosed.clear();
    });
  }
  return state;
}

// Native CDP values and attributes cannot be hidden by MAIN-world getters.
function sensitiveValues({ strings, documents }) {
  const values = []; values.names = new Set(); values.unnamed = false;
  for (const { nodes } of documents) {
    const count = nodes.nodeName.length;
    if (count > 50000) throw Error('DOM acquisition budget exceeded');
    const attrs = index => {
      const raw = nodes.attributes[index] ?? [], result = {};
      for (let i = 0; i < raw.length; i += 2) result[strings[raw[i]]] = strings[raw[i + 1]];
      return result;
    };
    const labels = new Map(), labelFor = new Map();
    for (let i = 0; i < count; i++) if (strings[nodes.nodeName[i]] === 'LABEL') labels.set(i, '');
    for (let i = 0; i < count; i++) {
      let parent = i, depth = 0;
      while (parent >= 0) {
        if (++depth > 128) throw Error('DOM ancestry budget exceeded');
        if (labels.has(parent)) labels.set(parent, labels.get(parent) + ' ' + (strings[nodes.nodeValue[i]] ?? ''));
        parent = nodes.parentIndex[parent];
      }
    }
    for (const [index, text] of labels) if (attrs(index).for) labelFor.set(attrs(index).for, text);
    const shadows = new Map((nodes.shadowRootType?.index ?? []).map((index, i) => [index, strings[nodes.shadowRootType.value[i]]]));
    const protectedNodes = new Set();
    for (let index = 0; index < count; index++) {
      const attributes = attrs(index), hints = [attributes.type, attributes.name, attributes.id, attributes.autocomplete,
        attributes['aria-label'], attributes['aria-labelledby'], attributes.placeholder, labelFor.get(attributes.id)];
      let closed = false, parent = index;
      const ownLabels = [];
      while (parent >= 0) {
        closed ||= shadows.get(parent) === 'closed';
        if (labels.has(parent)) { hints.push(labels.get(parent)); ownLabels.push(labels.get(parent)); }
        parent = nodes.parentIndex[parent];
      }
      if (closed || SENSITIVE.test(hints.join(' '))) protectedNodes.add(index);
      if (strings[nodes.nodeName[index]] !== 'INPUT' && strings[nodes.nodeName[index]] !== 'TEXTAREA') continue;
      if (!protectedNodes.has(index)) continue;
      // Native attributes/label text mark password fields even with neutral
      // accessible names and blank values. Ambiguous unnamed fields mask scalars.
      const names = [attributes['aria-label'], labelFor.get(attributes.id), ...ownLabels, attributes.placeholder].map(normalized).filter(Boolean);
      for (const name of names) values.names.add(name);
      if (!names.length) values.unnamed = true;
    }
    for (const column of [nodes.inputValue, nodes.textValue]) {
      for (const [i, index] of (column?.index ?? []).entries()) {
        const value = strings[column.value[i]];
        if (value && protectedNodes.has(index)) values.push(value);
      }
    }
  }
  return values;
}

function scrub(value, secrets) {
  let text = String(value ?? '');
  const forms = [...new Set(secrets.flatMap(secret => [secret, normalized(secret)]).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const secret of forms) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:\d[ -]?){12,19}/g, '[redacted]');
}

async function* sessionsOf(page) {
  for (const frame of page.frames()) {
    let session;
    try { session = await bounded(() => page.context().newCDPSession(frame)); }
    catch (error) {
      // Playwright 1.64.0: in-process child frames have no separate target.
      // Their contentDocument is included in their parent's pierced DOM tree.
      if (frame !== page.mainFrame() && /This frame does not have a separate CDP session, it is a part of the parent frame's session/.test(error.message)) continue;
      throw error;
    }
    try { yield { frame, send: (method, params = {}) => bounded(() => session.send(method, params)) }; }
    finally { await bounded(() => session.detach()); }
  }
}

async function nativeSecrets(page) {
  const secrets = []; secrets.names = new Set(); secrets.unnamed = false;
  for await (const { send } of sessionsOf(page)) {
    const native = sensitiveValues(await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }));
    secrets.push(...native); for (const name of native.names) secrets.names.add(name); secrets.unnamed ||= native.unnamed;
  }
  return secrets;
}

async function closedRoots(page, state) {
  const sections = [], secrets = [], next = new Map();
  secrets.names = new Set(); secrets.unnamed = false;
  for await (const { frame, send } of sessionsOf(page)) {
    const native = sensitiveValues(await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }));
    secrets.push(...native);
    for (const name of native.names) secrets.names.add(name);
    secrets.unnamed ||= native.unnamed;
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    const stack = [{ node: root, closed: false }], controls = [], backends = new Set();
    let count = 0;
    // Walk the DOM, not the host's AX subtree: an ignored host can have an
    // empty AX query while its closed root still contains usable controls.
    while (stack.length) {
      const { node, closed } = stack.pop();
      if (++count > 50000) throw Error('DOM acquisition budget exceeded');
      if (!node) throw Error('DOM acquisition unavailable');
      if (closed && node.nodeType === 1 && node.backendNodeId && !backends.has(node.backendNodeId)) {
        backends.add(node.backendNodeId); controls.push(node.backendNodeId);
      }
      const descendants = (node.children ?? []).map(child => ({ node: child, closed }));
      for (const shadow of node.shadowRoots ?? []) descendants.push({ node: shadow, closed: closed || shadow.shadowRootType === 'closed' });
      if (node.contentDocument) descendants.push({ node: node.contentDocument, closed });
      stack.push(...descendants.reverse());
    }
    const refs = new Map(), children = [];
    let probes = 0;
    for (const backendNodeId of controls) {
      if (++probes > 512) throw Error('Closed-root accessibility budget exceeded');
      const { nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
      const node = nodes.find(node => node.backendDOMNodeId === backendNodeId && !node.ignored && CONTROL_ROLE.test(node.role?.value));
      if (!node) continue;
      const role = node.role.value, ref = state.closed.get(frame)?.get(backendNodeId) ?? 's' + (++state.shadowNumber);
      const row = { role, name: node.name?.value ?? '', ref, protected: scalarRole(role) };
      for (const { name, value } of node.properties ?? []) {
        if (!['checked', 'disabled', 'expanded', 'pressed', 'selected'].includes(name)) continue;
        if (value?.value === true || value?.value === 'true') row[name] = true;
        else if (value?.value === 'mixed') row[name] = 'mixed';
      }
      refs.set(backendNodeId, ref); children.push(row);
    }
    if (refs.size) next.set(frame, refs);
    if (children.length) sections.push({ role: 'group', name: 'Closed shadow controls', children });
  }
  const current = new Set([...next.values()].flatMap(refs => [...refs.values()]));
  for (const ref of state.deliveredClosed) if (!current.has(ref)) state.deliveredClosed.delete(ref);
  state.closed = next;
  return { sections, secrets };
}

// V4/V5 can resolve an s ref into an owned frame's CDP backend node. Only refs
// actually returned in a snapshot are eligible; caller owns its CDP session.
export function closedRefBinding(page, ref) {
  const state = pages.get(page);
  if (state?.deliveredClosed.has(ref)) {
    for (const [frame, refs] of state.closed) for (const [backendNodeId, known] of refs) {
      if (known === ref) return { frame, backendNodeId };
    }
  }
  throw Error('Closed-root ref is stale or unavailable; take a new snapshot.');
}

// Public refs remain distinct across document generations. Playwright may reuse
// eN after navigation; the private map retains its actual aria-ref for resolution.
function publicRefs(nodes, state) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const raw = node.ref;
    if (REF.test(raw) && !/^s\d+$/.test(raw)) {
      let ref = state.rawRefs.get(raw);
      if (!ref) {
        ref = raw;
        const match = /e(\d+)$/.exec(raw); state.nextRef = Math.max(state.nextRef, Number(match[1]));
        while (state.usedRefs.has(ref)) ref = 'e' + (++state.nextRef);
        state.usedRefs.add(ref); state.rawRefs.set(raw, ref);
        state.refBank.set(ref, { raw, generation: state.generation });
      }
      node.ref = ref;
    }
    if (node.children) publicRefs(node.children, state);
  }
}

// The worker calls this only after the exact snapshot text reaches the client.
// A private read or an observation suppressed by observe:none does not qualify.
export function acknowledgeSnapshot(page, number) {
  const state = pages.get(page), record = state?.pending.get(number);
  if (!record || record.generation !== state.generation) return false;
  state.pending.delete(number);
  for (const ref of record.refs) if (!/^s\d+$/.test(ref)) state.deliveredRefs.add(ref);
  return true;
}
export function snapshotRefBinding(page, ref) {
  const state = pages.get(page), record = state?.refBank.get(ref);
  if (!record || record.generation !== state.generation || !state.deliveredRefs.has(ref))
    throw Error('Ref is stale or its snapshot was not delivered; use browser_read again.');
  return page.locator('aria-ref=' + record.raw);
}

function rowsOf(tree, secrets) {
  const rows = [];
  const visit = (nodes, parent = null, depth = 0) => {
    let previous = null;
    for (const [index, raw] of nodes.entries()) {
      const node = typeof raw === 'string' ? { role: 'text', text: raw } : raw;
      const ref = REF.test(node.ref) ? node.ref : null;
      const role = /^[a-zA-Z][\w-]*$/.test(node.role) ? node.role : 'group';
      const protectedValue = scalarRole(role) && (node.protected === true || secrets.unnamed ||
        secrets.names?.has(normalized(node.name)) || SENSITIVE.test([node.name, node.placeholder].join(' ')));
      let line = '- ' + role;
      if (node.name) line += ' ' + JSON.stringify(scrub(node.name, secrets));
      for (const flag of ['checked', 'disabled', 'expanded', 'active', 'pressed', 'selected', 'invalid', 'level']) {
        if (node[flag]) line += ` [${flag}${node[flag] === true ? '' : '=' + JSON.stringify(node[flag])}]`;
      }
      if (ref) line += ` [ref=${ref}]`;
      if (protectedValue) line += ': "[redacted]"';
      else if (node.text !== undefined) line += ': ' + JSON.stringify(scrub(node.text, secrets));
      else if (node.children?.length) line += ':';
      // Non-ref text rows are keyed by parent and position. Refs keep their key
      // through value changes and sibling reorders, including child-frame refs.
      const key = ref ?? `${parent ?? 'root'}/${index}`;
      rows.push({ key, ref, parent, depth, line, previous });
      previous = key;
      if (!protectedValue && node.children) visit(node.children, key, depth + 1);
      if (!protectedValue && node.url) rows.push({ key: key + '/url', parent: key, depth: depth + 1,
        line: '- /url: ' + JSON.stringify(scrub(node.url, secrets)), ref: null });
    }
  };
  visit(tree);
  return rows;
}

function ancestors(rows, wanted) {
  const byKey = new Map(rows.map(row => [row.key, row]));
  for (const key of [...wanted]) {
    let row = byKey.get(key);
    while (row?.parent) { wanted.add(row.parent); row = byKey.get(row.parent); }
  }
  return rows.filter(row => wanted.has(row.key));
}

function select(rows, ref, find) {
  let selected = rows;
  if (ref) {
    if (!rows.some(row => row.ref === ref)) throw Error('Ref unavailable');
    const wanted = new Set([ref]);
    for (const row of rows) if (wanted.has(row.parent)) wanted.add(row.key);
    selected = ancestors(rows, wanted);
  }
  if (find !== undefined) {
    const wanted = new Set(selected.filter(row => row.line.toLowerCase().includes(find.toLowerCase())).map(row => row.key));
    selected = ancestors(rows, wanted);
  }
  return selected;
}

function changes(rows, baseline) {
  const old = new Map(baseline.map(row => [row.key, row]));
  const changed = new Set(rows.filter(row => {
    const before = old.get(row.key);
    return !before || before.line !== row.line || before.parent !== row.parent || before.previous !== row.previous;
  }).map(row => row.key));
  const current = new Set(rows.map(row => row.key));
  const removed = baseline.filter(row => !current.has(row.key));
  return [...ancestors(rows, changed).map(row => ({ ...row, marker: changed.has(row.key) ? '+ ' : '  ' })),
    ...removed.map(row => ({ ...row, key: 'removed/' + row.key, parent: null, depth: 0,
      line: `# Removed from this view: ${row.ref ? '[ref=' + row.ref + ']' : 'text row'}`, marker: '- ', removed: row.key }))];
}

function cap(rows, offset, header, maxChars, continuation) {
  const footer = `# Cut: more rows omitted. Continue with ref="${continuation}".`;
  const lines = [header], delivered = [];
  let size = header.length, next = offset;
  const context = offset ? ancestors(rows.filter(row => !row.removed), new Set([rows[offset]?.key])).filter(row => row.key !== rows[offset]?.key) : [];
  const keptContext = [];
  let contextSize = 0;
  for (const row of context.toReversed()) {
    const line = (row.marker ?? '') + '  '.repeat(Math.min(row.depth, 32)) + row.line;
    if (contextSize + line.length + 1 > Math.floor((maxChars - header.length - footer.length - 2) / 3)) break;
    keptContext.unshift(row); contextSize += line.length + 1;
  }
  if (keptContext.length < context.length) { lines.push('# Earlier ancestors omitted by size cap.'); size += lines.at(-1).length + 1; }
  for (const row of [...keptContext, ...rows.slice(offset)]) {
    const prefix = (row.marker ?? '') + '  '.repeat(Math.min(row.depth, 32));
    let line = prefix + row.line, shortened = false;
    const available = maxChars - size - footer.length - 2;
    if (line.length > available) {
      if (next > offset) break;
      // Keep valid YAML and any usable ref, rather than slicing a quoted name.
      const role = /^- ([\w-]+)/.exec(row.line)?.[1] ?? 'text';
      line = prefix + `- ${role}${row.ref ? ' [ref=' + row.ref + ']' : ''}: `
        + JSON.stringify('[line shortened; read with max_chars: 40000 or the engine browser path]');
      shortened = true;
    }
    lines.push(line); size += line.length + 1;
    delivered.push(shortened ? { ...row, line: line.slice(prefix.length) } : row);
    if (!keptContext.includes(row)) next++;
    if (shortened) break;
  }
  if (next < rows.length) lines.push(footer);
  return { text: lines.join('\n'), delivered, next };
}

export async function snapshot(page, { ref, find, maxChars = 8000, since } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 40000
    || find !== undefined && (typeof find !== 'string' || find.length > 512)
    || since !== undefined && (!Number.isSafeInteger(since) || since < 1)
    || ref !== undefined && (typeof ref !== 'string' || !REF.test(ref) && !MORE.test(ref))) throw Error('Invalid snapshot request');
  const state = stateOf(page);
  if (state.busy) throw Error('Snapshot read in progress; try browser_read again.');
  state.busy = true;
  const generation = state.generation, url = page.url();
  try {
    const secrets = await nativeSecrets(page);
    const tree = await bounded(() => page.ariaSnapshotJSON({ mode: 'ai', timeout: TIMEOUT }));
    const closed = await closedRoots(page, state);
    secrets.push(...closed.secrets);
    for (const name of closed.secrets.names) secrets.names.add(name); secrets.unnamed ||= closed.secrets.unnamed;
    publicRefs(tree, state);
    const rows = rowsOf([...tree, ...closed.sections], secrets);
    if (generation !== state.generation || url !== page.url()) throw Error('Page changed; try browser_read again.');
    const continuation = MORE.test(ref) ? state.continuations.get(ref) : null;
    if (MORE.test(ref) && (!continuation || continuation.source !== JSON.stringify(rows))) throw Error('Continuation expired');
    const scope = continuation?.scope ?? JSON.stringify([ref ?? null, find ?? null]);
    const selected = continuation?.selected ?? select(rows, ref, find);
    const baseline = continuation?.baseline ?? state.history.get(since);
    const delta = continuation?.delta ?? Boolean(baseline && baseline.scope === scope);
    const candidates = continuation?.candidates ?? (delta ? changes(selected, baseline.rows) : selected);
    const number = ++state.number;
    const token = `more${number}_${continuation?.offset ?? 0}`;
    const header = `# ${delta ? 'Changes since snapshot ' + (continuation?.since ?? since) + '; snapshot' : 'Snapshot'} ${number} (untrusted page content)`;
    const result = cap(candidates, continuation?.offset ?? 0, header, maxChars, token);
    if (!candidates.length) result.text += delta ? '\n# No visible changes.' : '\n# No matching content.';
    const delivered = new Map(delta || continuation ? baseline?.rows?.map(row => [row.key, row]) : []);
    for (const row of result.delivered) {
      if (row.removed) delivered.delete(row.removed);
      else delivered.set(row.key, row);
      if (/^s\d+$/.test(row.ref)) state.deliveredClosed.add(row.ref);
    }
    const history = { scope, rows: [...delivered.values()] };
    state.pending.set(number, { generation, refs: result.delivered.filter(row => row.ref && !row.removed).map(row => row.ref) });
    state.history.set(number, history);
    if (result.next < candidates.length) state.continuations.set(token, { source: JSON.stringify(rows), scope, selected,
      candidates, baseline: history, delta, since: continuation?.since ?? since, offset: result.next });
    if (continuation) state.continuations.delete(ref);
    for (const map of [state.history, state.continuations, state.pending]) while (map.size > 8) map.delete(map.keys().next().value);
    return { text: result.text, number };
  } catch {
    state.deliveredClosed.clear();
    throw Error('Snapshot unavailable; try browser_read again or use the engine browser path.');
  } finally { state.busy = false; }
}
