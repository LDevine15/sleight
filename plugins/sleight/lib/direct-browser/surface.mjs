import { randomUUID } from 'node:crypto';
import { browserTools, validateCall } from './schemas.mjs';
import { browserError, BrowserFailure } from './errors.mjs';
import { immutableJSON, FRAME_LIMIT } from './ipc.mjs';
import { createBrokerSessionHost } from './session-host.mjs';
import { bindSemanticAdapter } from './lifecycle.mjs';
import { isInstalledBridge } from './installed-bridge.mjs';
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

const frontends = new WeakSet();
export const isFrontend = value => !!value && frontends.has(value);
// This forwarding route exists before the first genuine user turn. Only the
// fixed worker bridge can bind its private turn and package authority.
export function createInstalledFrontend(bridge) {
  if (!isInstalledBridge(bridge)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const frontend = Object.freeze({ browser: bridge.browser, tools: () => bridge.tools(),
    call: input => bridge.call(input), delivered: value => bridge.delivered(value), end: () => bridge.endTurn() });
  frontends.add(frontend); return frontend;
}
const sessions = new WeakSet();
export const isFrontendSession = value => !!value && sessions.has(value);
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
  endSession, verifyResume = () => false, timeoutMs = 30000, selectedBrowser, ownership,
  onDelivered = () => false, onUnknown = () => {} } = {}) {
  if ([verifyOptIn, packageCurrent, status, redact, endSession, verifyResume, onDelivered, onUnknown].some(f => typeof f !== 'function') ||
      typeof client?.request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('TRUSTED_ROUTE_REQUIRED');
  if (selectedBrowser !== undefined && !/^b[A-Za-z0-9_-]{1,63}$/.test(selectedBrowser)) throw Error('TRUSTED_ROUTE_REQUIRED');
  if (ownership !== undefined && (!ownership || !['session', 'turn'].every(key =>
    typeof ownership[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ownership[key])) ||
    !Number.isSafeInteger(ownership.brokerEpoch) || ownership.brokerEpoch < 1 ||
    Object.keys(ownership).some(key => !['session', 'turn', 'brokerEpoch'].includes(key)))) throw Error('TRUSTED_ROUTE_REQUIRED');
  let accepted = false;
  try { accepted = await verifyOptIn(proof) === true && packageCurrent() === true; } catch {}
  if (!accepted) throw Error('TRUSTED_ROUTE_REQUIRED');
  let generation = 0, ended = false, ending, detached = false, lastState;
  const history = new Map();
  const pendingCalls = new Map();
  let deliveries = new WeakMap();
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
  const remember = (request, response, operation = randomUUID().replaceAll('-', '')) => {
    const completed = response.error?.completed ?? response.completed ?? 0;
    const effect = response.error?.effect ?? response.effect ?? 'verified';
    const stage = response.error ? effect === 'none' ? completed ? 'observed' : 'prepared' : 'unknown' : 'verified';
    const total = units(request), unknown = stage === 'unknown';
    const maximum = Math.max(0, total - completed - (unknown && completed < total ? 1 : 0));
    const untouched = response.untouched ?? (unknown ? 0 : maximum);
    if (!Number.isInteger(untouched) || untouched < 0 || untouched > maximum) throw Error('INVALID_RECEIPT');
    const receipt = { operation, stage, effect, completed, untouched, connectionGeneration: generation,
      ...(response.unknownStep === undefined ? {} : { unknownStep: response.unknownStep }) };
    if (unknown && request.name !== 'browser_read') try {
      const pending = onUnknown(observationJSON({ ...receipt, name: request.name, tab: request.arguments.tab ?? null }));
      if (pending?.then) Promise.resolve(pending).catch(() => {});
    } catch {} // Retain the receipt even if the ownership provider is unavailable.
    const result = { route: 'direct', ...response, receipt };
    const budget = request.arguments.max_bytes ?? 12000;
    if (Buffer.byteLength(JSON.stringify(result)) > budget) {
      const omitted = { omitted: true, reason: 'output_budget', next: 'browser_read' };
      if (Object.hasOwn(result, 'observation')) result.observation = omitted;
      if (result.error) result.error = { ...result.error, observation: omitted };
      if (result.results) result.results = result.results.map(row => ({ ...row, observation: omitted }));
    }
    if (Buffer.byteLength(JSON.stringify(result)) > budget) throw Error('INVALID_RECEIPT');
    // Contract 3 fences uncertain submits inside trusted host classification.
    // The frontend cannot infer submit intent from model refs or page text, and
    // incomplete page sensing must not block a checked ordinary field.
    history.set(operation, structuredClone(receipt));
    if (history.size > 128) {
      const removable = [...history].find(([, entry]) => entry.stage !== 'unknown');
      if (removable) history.delete(removable[0]);
    }
    if (!result.error && result.observation && result.observation.omitted !== true) {
      deliveries.set(result, { generation, serialized: JSON.stringify(result),
        data: observationJSON({ operation, name: request.name, tab: result.tab ?? request.arguments.tab,
          observation: result.observation }) });
    }
    return result;
  };
  const project = (raw, request) => {
    const response = observationJSON(raw), total = units(request);
    const completed = response.completed ?? response.error?.completed ?? 0;
    if (!Number.isInteger(completed) || completed < 0 || completed > total) throw Error('INVALID_RECEIPT');
    const prefix = response.results ?? (completed === 1 && !response.error ?
      [{ effect: response.effect, observation: response.observation }] : response.error ?
        Array.from({ length: completed }, () => ({ effect: 'verified',
          observation: { omitted: true, reason: 'host_prefix_observations_withheld', next: 'browser_read' } })) : []);
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
      const unknownStep = response.unknownStep ?? response.error.unknownStep;
      if (unknownStep !== undefined && unknownStep !== null &&
          (!Number.isInteger(unknownStep) || unknownStep !== completed || unknownStep >= total || response.effect !== 'unknown'))
        throw Error('INVALID_RECEIPT');
      const untouched = response.untouched ?? response.error.untouched;
      const failure = new BrowserFailure(response.error.code, { phase: response.error.phase, effect: response.effect });
      if (failure.code !== response.error.code) failure.effect = 'unknown';
      return { error: browserError(failure, { tab: request.arguments.tab, completed, observation: safe(response.observation) }),
        results: rows, ...(untouched === undefined ? {} : { untouched }),
        ...(unknownStep === undefined ? {} : { unknownStep }) };
    }
    if (completed !== total || !['verified', 'unchanged', 'protected'].includes(response.effect) ||
        !Object.hasOwn(response, 'observation')) throw Error('INVALID_RECEIPT');
    return { completed, effect: response.effect, results: rows, observation: safe(response.observation), untouched: 0,
      ...(request.name === 'browser_open' ? { tab: response.tab } : {}) };
  };
  const frontend = Object.freeze({
    browser: selectedBrowser,
    ownership: ownership === undefined ? undefined : observationJSON(ownership),
    tools() {
      const tools = compactTools();
      if (selectedBrowser) tools.find(tool => tool.name === 'browser_open').inputSchema.properties.browser = { type: 'string', const: selectedBrowser };
      return tools;
    },
    receipt: operation => history.has(operation) ? structuredClone(history.get(operation)) : null,
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || ended || !current() || connection() !== 'connected' || record.generation !== generation ||
          record.serialized !== JSON.stringify(result)) return false;
      try {
        const acknowledged = onDelivered(record.data);
        if (acknowledged?.then) { Promise.resolve(acknowledged).catch(() => {}); return false; }
        return acknowledged === true;
      } catch { return false; }
    },
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
      const tab = request.arguments.tab, state = connection(), epoch = generation;
      const refused = code => remember(request, errorResult(code, tab));
      if (ended) return refused('LEASE_LOST');
      if (request.name === 'browser_open' && selectedBrowser && request.arguments.browser !== selectedBrowser) return refused('FOREIGN_REF');
      if (!current()) return refused('VERSION_MISMATCH');
      if (states[state]) return refused(states[state]);
      if (detached && request.name !== 'browser_read') return refused('USER_TAKEOVER');
      if ([...history.values()].filter(row => row.stage === 'unknown').length >= 128) return refused('HISTORY_FULL');
      const operation = randomUUID().replaceAll('-', '');
      let timer, response;
      try {
        pendingCalls.set(operation, request);
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
        return remember(request, response, operation);
      } catch {
        return remember(request, { ...errorResult('EFFECT_UNKNOWN', tab, request.name === 'browser_read' ? 'none' : 'unknown'),
          untouched: 0 }, operation);
      } finally { pendingCalls.delete(operation); clearTimeout(timer); }
    },
    end() {
      if (ending) return ending;
      ended = true; generation++; deliveries = new WeakMap();
      // A broker reply may have settled while frontend delivery still waits.
      // Retain those exact operations before synchronous host revocation, too.
      for (const [operation, request] of pendingCalls) if (request.name !== 'browser_read') try {
        const result = onUnknown(observationJSON({ operation, name: request.name, tab: request.arguments.tab ?? null }));
        if (result?.then) Promise.resolve(result).catch(() => {});
      } catch {}
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
  if (typeof options.turn !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options.turn)) throw Error('TRUSTED_ROUTE_REQUIRED');
  if (options.semanticLifecycle !== undefined && options.semanticAdapter !== undefined) throw Error('TRUSTED_ROUTE_REQUIRED');
  const semantic = options.semanticAdapter === undefined ? options.semanticLifecycle : bindSemanticAdapter({
    session: options.identity?.session, adapter: options.semanticAdapter, transportOwner: options.transportOwner,
    lifecycle: options.lifecycle, hook: options.lifecycleHook, leaseFor: options.leaseFor });
  if (semantic !== undefined && (semantic.session !== options.identity?.session ||
      typeof semantic.revoke !== 'function' || typeof semantic.cleanup !== 'function')) throw Error('TRUSTED_ROUTE_REQUIRED');
  const host = createBrokerSessionHost(options);
  const ownership = Object.freeze({ session: options.identity.session, turn: options.turn, brokerEpoch: options.broker.status().epoch });
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
      const safe = observationJSON(options.redact(value));
      if (!Array.isArray(safe?.cleanup)) throw Error('CLEANUP_UNPROVED');
      return safe.cleanup;
    }).catch(() => [{ resource: 'semantic-journals', status: 'retained',
      code: !semantic ? 'SEMANTIC_LIFECYCLE_UNJOINED' : semanticRevoked ? 'CLEANUP_UNPROVED' : 'SEMANTIC_REVOCATION_UNPROVED' }])])
      .then(([hostReceipt, cleanup]) => ({ revoked: hostReceipt.revoked === true && semanticRevoked,
        cleanup: [...hostReceipt.cleanup, ...cleanup] }))
      .finally(() => { clearTimeout(timer); ending = undefined; });
    return ending;
  }
  const controller = Object.freeze({
    ownership,
    enable() {
      if (ended) return Promise.reject(Error('LEASE_LOST'));
      if (frontend) return Promise.resolve(frontend);
      if (enabling) return enabling;
      enabling = (async () => {
        const proof = await host.requestOptIn();
        if (!proof || ended) return null;
        if (options.broker.status().epoch !== ownership.brokerEpoch) { ended = true; await endSession(); return null; }
        const prepared = await createFrontend({ ...host, endSession, proof, timeoutMs: options.timeoutMs,
          selectedBrowser: options.selectedBrowser, ownership,
          onDelivered: delivery => semantic?.delivered?.(delivery) ?? false,
          onUnknown: receipt => semantic?.uncertain?.(receipt) });
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
  sessions.add(controller);
  return controller;
}
