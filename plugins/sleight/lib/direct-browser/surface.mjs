import { randomUUID } from 'node:crypto';
import { browserTools, validateCall } from './schemas.mjs';
import { browserError, BrowserFailure } from './errors.mjs';
import { immutableJSON, FRAME_LIMIT } from './ipc.mjs';
import { createBrokerSessionHost } from './session-host.mjs';
function compressSchema(schema) {
  const fragments = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && ['type', 'oneOf', 'anyOf', 'enum', 'const'].some(key => Object.hasOwn(value, key))) {
      const key = JSON.stringify(value);
      if (key.length >= 60) fragments.set(key, (fragments.get(key) ?? 0) + 1);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
  const selected = new Map([...fragments].filter(([, count]) => count > 1).map(([key], i) => [key, 's' + i]));
  const render = (value, definition = false) => {
    if (!value || typeof value !== 'object') return value;
    const name = selected.get(JSON.stringify(value));
    if (name && !definition) return { $ref: '#/$defs/' + name };
    return Array.isArray(value) ? value.map(item => render(item))
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, render(child)]));
  };
  const result = render(schema, true);
  if (selected.size) result.$defs = Object.fromEntries([...selected].map(([json, name]) => [name, render(JSON.parse(json), true)]));
  return result;
}
export function expandSchema(schema) {
  const expand = value => {
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) return expand(schema.$defs[value.$ref.slice('#/$defs/'.length)]);
    return Array.isArray(value) ? value.map(expand)
      : Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$defs').map(([key, child]) => [key, expand(child)]));
  };
  return expand(schema);
}
export function compactTools() {
  return browserTools().map(tool => ({ ...tool, inputSchema: compressSchema(tool.inputSchema) }));
}
function observationJSON(value) {
  const safe = immutableJSON(value);
  if (Buffer.byteLength(JSON.stringify(safe)) > FRAME_LIMIT) throw Error('Invalid observation');
  return safe;
}
function completeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.complete !== true) return false;
  const complete = metadata =>
    (!Object.hasOwn(metadata, 'complete') || metadata.complete === true) &&
    ['pending', 'omitted', 'truncated'].every(key => !Object.hasOwn(metadata, key) ||
      metadata[key] === false || metadata[key] === 0);
  if (!complete(value)) return false;
  if (!Object.hasOwn(value, 'coverage')) return true; // Legacy complete reads have no metadata.
  const coverage = value.coverage;
  if (typeof coverage === 'string') return ['full', 'complete', 'rendered-complete'].includes(coverage);
  return coverage !== null && typeof coverage === 'object' && !Array.isArray(coverage) &&
    complete(coverage) && (!Object.hasOwn(coverage, 'sensing') || coverage.sensing === 'complete');
}

const frontends = new WeakSet();
export const isFrontend = value => !!value && frontends.has(value);
const states = { connected: null, unsupported: 'CONNECTION_UNSUPPORTED', 'setting-off': 'SETTING_OFF',
  'approval-pending': 'CONNECTION_APPROVAL_PENDING', declined: 'CONNECTION_DECLINED',
  'stale-instance': 'STALE_INSTANCE', disconnected: 'DISCONNECTED', paused: 'USER_TAKEOVER' };
const units = request => request.name === 'browser_fill' ? request.arguments.fields.length
  : request.name === 'browser_act' ? request.arguments.steps?.length ?? 1 : 1;
const errorResult = (code, tab, effect = 'none', completed = 0) => ({ error: browserError(
  new BrowserFailure(code, { phase: 'policy', effect }), { tab, completed }) });

// The launcher supplies authenticated host dependencies, never model/project
// JSON. The client is P1's attach(...).request interface. It dispatches one
// entire logical operation so a once grant is not consumed once per CDP send.
// P2 supplies semantic/protected proof behind that broker boundary. No socket,
// authority, helper, arbitrary JS or CDP entry is returned to the model.
export async function createFrontend({ proof, verifyOptIn, packageCurrent, status, client, redact,
  endSession, verifyResume = () => false, timeoutMs = 30000, selectedBrowser } = {}) {
  if ([verifyOptIn, packageCurrent, status, redact, endSession, verifyResume].some(f => typeof f !== 'function') ||
      typeof client?.request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('TRUSTED_ROUTE_REQUIRED');
  if (selectedBrowser !== undefined && !/^b[A-Za-z0-9_-]{1,63}$/.test(selectedBrowser)) throw Error('TRUSTED_ROUTE_REQUIRED');
  let accepted = false;
  try { accepted = await verifyOptIn(proof) === true && packageCurrent() === true; } catch {}
  if (!accepted) throw Error('TRUSTED_ROUTE_REQUIRED');
  let generation = 0, sequence = 0, ended = false, ending, detached = false, lastState;
  const history = new Map(), recovery = new Map();
  const current = () => { try { return packageCurrent() === true; } catch { return false; } };
  const connection = () => {
    let value; try { value = status(); } catch {}
    if (!Object.hasOwn(states, value)) value = 'disconnected';
    if (lastState !== undefined && value !== lastState) {
      generation++;
      if (value !== 'connected') detached = true;
    }
    lastState = value;
    if (value !== 'connected') detached = true;
    return value;
  };
  const safe = value => observationJSON(redact(value ?? null));
  const remember = (request, response, at, operation = randomUUID().replaceAll('-', '')) => {
    const completed = response.error?.completed ?? response.completed ?? 0;
    const effect = response.error?.effect ?? response.effect ?? 'verified';
    const stage = response.error ? effect === 'none' ? completed ? 'observed' : 'prepared' : 'unknown' : 'verified';
    const total = units(request), unknown = stage === 'unknown';
    const maximum = Math.max(0, total - completed - (unknown && completed < total ? 1 : 0));
    const untouched = response.untouched ?? (unknown ? 0 : maximum);
    if (!Number.isInteger(untouched) || untouched < 0 || untouched > maximum) throw Error('INVALID_RECEIPT');
    const receipt = { operation, stage, effect, completed, untouched, connectionGeneration: generation };
    const result = { route: 'direct', ...response, receipt };
    const budget = request.arguments.max_bytes ?? 12000;
    if (Buffer.byteLength(JSON.stringify(result)) > budget) {
      const omitted = { omitted: true, reason: 'output_budget', next: 'browser_read' };
      if (Object.hasOwn(result, 'observation')) result.observation = omitted;
      if (result.error) result.error = { ...result.error, observation: omitted };
      if (result.results) result.results = result.results.map(row => ({ ...row, observation: omitted }));
    }
    if (Buffer.byteLength(JSON.stringify(result)) > budget) throw Error('INVALID_RECEIPT');
    const target = request.arguments.tab ?? null;
    if (unknown && request.name !== 'browser_read') {
      if (!recovery.has(target)) recovery.set(target, new Map());
      recovery.get(target).set(operation, ++sequence);
    }
    // The broker remains responsible for policy/quarantine reconciliation. This
    // delivery gate only proves that the model received a later relevant read.
    if (!result.error && request.name === 'browser_read' && !request.arguments.scope && completed === 1 &&
        completeObservation(result.observation) && result.observation !== null) {
      const pending = recovery.get(target);
      if (pending) {
        for (const [id, started] of pending) if (started <= at) pending.delete(id);
        if (!pending.size) recovery.delete(target);
      }
    }
    history.set(operation, structuredClone(receipt));
    if (history.size > 128) {
      const removable = [...history].find(([, entry]) => entry.stage !== 'unknown');
      if (removable) history.delete(removable[0]);
    }
    return result;
  };
  const project = (raw, request) => {
    const response = observationJSON(raw), total = units(request);
    const completed = response.completed ?? response.error?.completed ?? 0;
    if (!Number.isInteger(completed) || completed < 0 || completed > total) throw Error('INVALID_RECEIPT');
    const prefix = response.results ?? (completed === 1 && !response.error ?
      [{ effect: response.effect, observation: response.observation }] : []);
    if (!Array.isArray(prefix) || prefix.length !== completed ||
        prefix.some(row => !['verified', 'unchanged', 'protected'].includes(row.effect))) throw Error('INVALID_RECEIPT');
    const rows = prefix.map(row => ({ effect: row.effect, observation: safe(row.observation) }));
    if (request.name === 'browser_open' && completed === 1) {
      validateCall({ name: 'browser_read', arguments: { tab: response.tab } });
      rows[0].tab = response.tab;
    }
    if (response.error) {
      if (response.error.completed !== undefined && response.error.completed !== completed ||
          response.error.effect !== response.effect) throw Error('INVALID_RECEIPT');
      const failure = new BrowserFailure(response.error.code, { phase: response.error.phase, effect: response.effect });
      if (failure.code !== response.error.code) failure.effect = 'unknown';
      return { error: browserError(failure, { tab: request.arguments.tab, completed, observation: safe(response.observation) }),
        results: rows, ...(response.untouched === undefined ? {} : { untouched: response.untouched }) };
    }
    if (completed !== total || !['verified', 'unchanged', 'protected'].includes(response.effect) ||
        !Object.hasOwn(response, 'observation')) throw Error('INVALID_RECEIPT');
    return { completed, effect: response.effect, results: rows, observation: safe(response.observation), untouched: 0,
      ...(request.name === 'browser_open' ? { tab: response.tab } : {}) };
  };
  const frontend = Object.freeze({
    browser: selectedBrowser,
    tools() {
      const tools = compactTools();
      if (selectedBrowser) tools.find(tool => tool.name === 'browser_open').inputSchema.properties.browser = { type: 'string', const: selectedBrowser };
      return tools;
    },
    receipt: operation => history.has(operation) ? structuredClone(history.get(operation)) : null,
    async resume(authority) {
      if (ended || !current() || connection() !== 'connected') return false;
      const epoch = generation;
      let allowed = false; try { allowed = await verifyResume(authority) === true; } catch {}
      if (!allowed || ended || !current() || connection() !== 'connected' || epoch !== generation) return false;
      detached = false; generation++; return true;
    },
    async call(input) {
      let request;
      try { request = validateCall(input); } catch { return errorResult('INVALID_ARGUMENT'); }
      const tab = request.arguments.tab, at = sequence, state = connection(), epoch = generation;
      const refused = code => remember(request, errorResult(code, tab), at);
      if (ended) return refused('LEASE_LOST');
      if (request.name === 'browser_open' && selectedBrowser && request.arguments.browser !== selectedBrowser) return refused('FOREIGN_REF');
      if (!current()) return refused('VERSION_MISMATCH');
      if (states[state]) return refused(states[state]);
      if (detached && request.name !== 'browser_read') return refused('USER_TAKEOVER');
      if ([...history.values()].filter(row => row.stage === 'unknown').length >= 128) return refused('HISTORY_FULL');
      if (request.name !== 'browser_read' && (recovery.has(null) || recovery.has(tab))) return refused('RECOVERY_READ_REQUIRED');
      const operation = randomUUID().replaceAll('-', '');
      let timer, response;
      try {
        // No await after the package/session fence and before broker entry.
        const pending = client.request({ id: operation, operation: request.name, args: request.arguments });
        const raw = await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('DEADLINE_EXCEEDED')), request.arguments.timeout_ms ?? timeoutMs);
        })]);
        response = project(raw, request);
        if (ended || !current() || connection() !== 'connected' || epoch !== generation) {
          const completed = response.error?.completed ?? response.completed ?? 0;
          const effect = request.name === 'browser_read' ? 'none' : 'unknown';
          const omitted = { omitted: true, reason: 'connection_changed', next: 'browser_read' };
          response = { ...response, ...errorResult(!current() ? 'VERSION_MISMATCH' : 'LEASE_LOST', tab, effect, completed),
            effect, observation: omitted, results: response.results?.map(row => ({ ...row, observation: omitted })),
            untouched: response.untouched ?? 0 };
          // The handle belongs to the lost session/connection, even when opening
          // completed. Retain proof counts, never advertise a reusable old handle.
          delete response.tab;
        }
        return remember(request, response, at, operation);
      } catch {
        return remember(request, { ...errorResult('EFFECT_UNKNOWN', tab, request.name === 'browser_read' ? 'none' : 'unknown'),
          untouched: 0 }, at, operation);
      } finally { clearTimeout(timer); }
    },
    end() {
      if (ending) return ending;
      ended = true; generation++;
      let timer, cleanup;
      try { cleanup = endSession(); } catch { cleanup = Promise.reject(Error('CLEANUP_UNPROVED')); }
      ending = Promise.race([Promise.resolve(cleanup), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('CLEANUP_UNPROVED')), timeoutMs);
      })]).then(value => {
        if (typeof value?.revoked !== 'boolean' || !Array.isArray(value.cleanup)) throw Error('CLEANUP_UNPROVED');
        return observationJSON(value);
      }).catch(() => ({ revoked: false, cleanup: [{ status: 'retained', code: 'CLEANUP_UNPROVED' }] }))
        .finally(() => { clearTimeout(timer); ending = undefined; });
      return ending;
    },
  });
  frontends.add(frontend);
  return frontend;
}

// Private installed-loader entry. Build the concrete P1 host before offering its
// own session-bound UI. No argument from the model supplies an enable/resume
// decision. The returned controller is never advertised as an MCP endpoint.
export function createBrokerFrontendSession(options) {
  if (typeof options?.selectedBrowser !== 'string' || !/^b[A-Za-z0-9_-]{1,63}$/.test(options.selectedBrowser)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const semantic = options.semanticLifecycle;
  if (semantic !== undefined && (semantic.session !== options.identity?.session ||
      typeof semantic.revoke !== 'function' || typeof semantic.cleanup !== 'function')) throw Error('TRUSTED_ROUTE_REQUIRED');
  const host = createBrokerSessionHost(options);
  let frontend, enabling, ended = false, ending, semanticRevoked = false;
  function endSession() {
    const hostEnd = host.endSession(); // Fence P1 authority/transport synchronously.
    if (!semanticRevoked && semantic) try {
      const result = semantic.revoke();
      if (result?.then) Promise.resolve(result).catch(() => {});
      else semanticRevoked = result === true;
    } catch {}
    if (ending) return ending;
    let timer;
    const collect = semanticRevoked ? Promise.race([Promise.resolve().then(() => semantic.cleanup()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CLEANUP_UNPROVED')), options.timeoutMs ?? 30000); })])
      : Promise.reject(Error('SEMANTIC_LIFECYCLE_UNJOINED'));
    ending = Promise.all([hostEnd, collect.then(value => {
      const safe = observationJSON(value);
      if (!Array.isArray(safe?.cleanup)) throw Error('CLEANUP_UNPROVED');
      return safe.cleanup;
    }).catch(() => [{ resource: 'semantic-journals', status: 'retained',
      code: !semantic ? 'SEMANTIC_LIFECYCLE_UNJOINED' : semanticRevoked ? 'CLEANUP_UNPROVED' : 'SEMANTIC_REVOCATION_UNPROVED' }])])
      .then(([hostReceipt, cleanup]) => ({ revoked: hostReceipt.revoked === true && semanticRevoked,
        cleanup: [...hostReceipt.cleanup, ...cleanup] }))
      .finally(() => { clearTimeout(timer); ending = undefined; });
    return ending;
  }
  return Object.freeze({
    enable() {
      if (ended) return Promise.reject(Error('LEASE_LOST'));
      if (frontend) return Promise.resolve(frontend);
      if (enabling) return enabling;
      enabling = (async () => {
        const proof = await host.requestOptIn();
        if (!proof || ended) return null;
        const prepared = await createFrontend({ ...host, endSession, proof, timeoutMs: options.timeoutMs, selectedBrowser: options.selectedBrowser });
        if (ended) { await prepared.end(); return null; }
        frontend = prepared;
        return frontend;
      })().finally(() => { enabling = undefined; });
      return enabling;
    },
    async resume() {
      if (ended || !frontend) return false;
      const proof = await host.requestResume();
      return !!proof && !ended && frontend.resume(proof);
    },
    end() {
      ended = true;
      return frontend ? frontend.end() : endSession();
    },
  });
}
