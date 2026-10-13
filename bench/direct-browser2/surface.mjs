import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBrowserTools, browserTools, validateCall } from '../direct-browser/tools.mjs';
import { browserError, BrowserFailure } from '../direct-browser/errors.mjs';
import { CONNECTION_STATES, connectionError, surfaceError } from './errors.mjs';

// Deduplicate repeated JSON-schema fragments locally; expansion retains the
// closed discriminated schemas, including every safety-relevant constraint.
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
const units = request => request.name === 'browser_fill' ? request.arguments.fields.length
  : request.name === 'browser_act' ? request.arguments.steps?.length ?? 1 : 1;
const writable = request => request.name !== 'browser_read';
const omittedObservation = () => ({ omitted: true, reason: 'output_budget', next: 'browser_read' });
// Keep v1's closed JSON observation contract before measuring delivery bytes.
// Inspect descriptors so an accessor cannot run during budget serialization.
function observationJSON(value, depth = 0) {
  if (depth > 8) throw Error('Invalid observation');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || !Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Invalid observation');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key])))
    throw Error('Invalid observation');
  if (Array.isArray(value)) {
    if (value.length > 100 || Object.keys(descriptors).length !== value.length + 1) throw Error('Invalid observation');
    return Object.freeze(Array.from({ length: value.length }, (_, i) => observationJSON(descriptors[i]?.value, depth + 1)));
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, item]) =>
    [key, observationJSON(item.value, depth + 1)])));
}
function boundedObservation(value, budget) {
  const safe = observationJSON(value);
  return Buffer.byteLength(JSON.stringify(safe)) > budget ? omittedObservation() : safe;
}
function completeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
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
function untouchedCount(request, result, completed) {
  const unknown = result.error && result.error.effect !== 'none';
  const maximum = Math.max(0, units(request) - completed - (unknown && completed < units(request) ? 1 : 0));
  if (result.untouched === undefined) return unknown ? 0 : maximum;
  if (!Number.isSafeInteger(result.untouched) || result.untouched < 0 || result.untouched > maximum)
    throw Error('Unproved untouched suffix');
  return result.untouched;
}

// Internal front-end contract, not production routing or an authority bridge.
// connect/fallback/authorize/resume/redact are trusted broker/engine adapters.
export function createSurface({ state = 'disconnected', connect, authorize, redact, authorizeResume = () => false,
  fallback, allowEngineFallback = false }) {
  if (!CONNECTION_STATES.has(state)) throw Error('Unknown connection state');
  if (typeof authorize !== 'function' || typeof redact !== 'function') throw Error('Trusted policy and redaction required');
  if (typeof allowEngineFallback !== 'boolean') throw Error('Trusted fallback configuration required');
  let currentState = state, generation = 0, initialized, reconnecting, reconnectRead = false, sequence = 0;
  const history = new Map(), recovery = new Map(), deliveryBudget = new AsyncLocalStorage();
  const remember = (request, result, route, readSequence = -1) => {
    const completed = result.error?.completed ?? result.completed ?? 0;
    const effect = result.error?.effect ?? (result.results?.some(row => row.effect === 'protected') ? 'protected' : 'verified');
    const stage = result.error ? effect === 'none' ? completed > 0 ? 'observed' : 'prepared' : 'unknown' : 'verified';
    const receipt = { operation: 'op' + (++sequence).toString(36), stage, effect, completed,
      untouched: untouchedCount(request, result, completed), connectionGeneration: generation };
    if (stage === 'unknown' && writable(request)) {
      const target = request.arguments.tab ?? null;
      if (!recovery.has(target)) recovery.set(target, new Map());
      recovery.get(target).set(receipt.operation, sequence);
    }
    const response = { route, ...result, receipt };
    // Combined envelope budget includes the new connection/operation receipt.
    if (Buffer.byteLength(JSON.stringify(response)) > (request.arguments.max_bytes ?? 12000)) {
      const omitted = omittedObservation();
      if (response.observation) response.observation = omitted;
      if (response.error) response.error = { ...response.error, observation: omitted };
      if (response.results) response.results = response.results.map(row => ({ ...row, observation: omitted }));
    }
    // Only a later full, delivered observation of the affected tab reconciles
    // its gate. A scope read, omitted state or an earlier concurrent read cannot.
    if (!result.error && request.name === 'browser_read' && !request.arguments.scope &&
        result.completed === 1 && completeObservation(response.observation)) {
      const pending = recovery.get(request.arguments.tab);
      if (pending) {
        for (const [operation, at] of pending) if (at <= readSequence) pending.delete(operation);
        if (!pending.size) recovery.delete(request.arguments.tab);
      }
      reconnectRead = false;
    }
    history.set(receipt.operation, structuredClone(receipt));
    if (history.size > 128) {
      const complete = [...history].find(([, entry]) => entry.stage !== 'unknown');
      if (complete) history.delete(complete[0]);
    }
    return response;
  };
  const initialize = () => {
    if (!initialized) initialized = Promise.resolve().then(async () => {
      if (typeof connect !== 'function') throw Error('Missing broker adapter');
      const epoch = generation;
      const connection = await connect();
      const gated = async (...args) => await authorize(...args) === true && currentState === 'ready' && generation === epoch;
      return createBrowserTools({ ...connection, authorize: gated,
        redact: value => boundedObservation(redact(value), deliveryBudget.getStore() ?? 12000) });
    });
    return initialized;
  };
  return {
    tools: compactTools,
    status: () => ({ connection: currentState, generation, needsRead: reconnectRead || recovery.size > 0 }),
    receipt: operation => history.has(operation) ? structuredClone(history.get(operation)) : null,
    setState(next) {
      if (!CONNECTION_STATES.has(next)) throw Error('Unknown connection state');
      if (next !== currentState) { currentState = next; generation++; }
      // Status events never initialize a new connection or resume queued work.
    },
    async reconnect(authority) {
      let allowed = false;
      try { allowed = await authorizeResume(authority); } catch {}
      if (allowed !== true) return { error: surfaceError('PERMISSION_REQUIRED') };
      if (!reconnecting) {
        generation++; initialized = undefined; currentState = 'approval_pending'; reconnectRead = true;
        const epoch = generation;
        reconnecting = initialize().then(() => {
          if (generation !== epoch || currentState !== 'approval_pending') return { error: connectionError(currentState) };
          currentState = 'ready'; return { connected: true, requiresRead: true };
        }, () => {
          if (generation === epoch && currentState === 'approval_pending') currentState = 'disconnected';
          return { error: connectionError(currentState) };
        }).finally(() => { reconnecting = undefined; });
      }
      return reconnecting;
    },
    async call(input) {
      let request;
      try { request = validateCall(input); }
      catch { return { error: browserError(new BrowserFailure('INVALID_ARGUMENT', { phase: 'validate', effect: 'none' })),
        receipt: { stage: 'prepared', effect: 'none', completed: 0, untouched: 0 } }; }
      if ([...history.values()].filter(entry => entry.stage === 'unknown').length >= 128)
        return remember(request, { error: surfaceError('HISTORY_FULL') }, 'direct');
      if (writable(request) && (reconnectRead || recovery.has(null) || recovery.has(request.arguments.tab)))
        return remember(request, { error: surfaceError('RECOVERY_READ_REQUIRED', { tab: request.arguments.tab }) }, 'direct');
      const epoch = generation, readSequence = sequence;
      const routeEngine = async () => {
        let attempted = false, proved = [];
        try {
          if (await authorize(request.name, request.arguments, { route: 'engine' }) !== true)
            return remember(request, { error: surfaceError('PERMISSION_REQUIRED') }, 'engine');
          if (generation !== epoch) return remember(request, { error: connectionError(currentState) }, 'engine');
          attempted = true;
          const result = await fallback(request);
          // Closed result projection: an engine adapter must preserve policy,
          // proof and partial effects. No raw engine exception or JS is exposed.
          if (result?.error) {
            const completed = result.error.completed ?? 0;
            const prefix = result.results ?? [];
            if (!Number.isSafeInteger(completed) || completed < 0 || completed > units(request) || !Array.isArray(prefix) ||
                prefix.length !== completed || prefix.some(row => !['verified', 'unchanged', 'protected'].includes(row.effect)))
              throw Error('Unproved fallback prefix');
            const failure = new BrowserFailure(result.error.code, { phase: result.error.phase, effect: result.error.effect });
            if (failure.code !== result.error.code) failure.effect = 'unknown';
            proved = prefix.map(row => ({ effect: row.effect,
              observation: boundedObservation(redact(row.observation ?? null), request.arguments.max_bytes ?? 12000) }));
            const projected = { error: browserError(failure, { tab: request.arguments.tab, completed }),
              results: proved,
              untouched: untouchedCount(request, result, completed) };
            if (generation !== epoch) projected.error = connectionError(currentState, { effect: failure.effect, completed });
            return remember(request, projected, 'engine', readSequence);
          }
          if (!result || result.completed !== units(request) || !Array.isArray(result.results) ||
              result.results.length !== result.completed || result.results.some(row => !['verified', 'unchanged', 'protected'].includes(row.effect)))
            throw Error('Unproved fallback result');
          if (request.name === 'browser_open') validateCall({ name: 'browser_read', arguments: { tab: result.results[0].tab } });
          const projected = { completed: result.completed, untouched: 0,
            results: result.results.map(row => ({ effect: row.effect, observation: boundedObservation(redact(row.observation ?? null), request.arguments.max_bytes ?? 12000),
              ...(request.name === 'browser_open' ? { tab: row.tab } : {}) })),
            observation: boundedObservation(redact(result.observation ?? null), request.arguments.max_bytes ?? 12000) };
          if (generation !== epoch) projected.error = connectionError(currentState,
            { effect: writable(request) ? 'unknown' : 'none', completed: result.completed });
          return remember(request, projected, 'engine', readSequence);
        } catch { return remember(request, { error: surfaceError(attempted ? 'CAPABILITY_UNAVAILABLE' : 'PERMISSION_REQUIRED',
          { effect: attempted ? 'unknown' : 'none', phase: attempted ? 'dispatch' : 'policy', completed: proved.length }),
          ...(proved.length ? { results: proved } : {}),
          ...(attempted ? { untouched: 0 } : {}) }, 'engine'); }
      };
      if (currentState !== 'ready') {
        // Only a trusted preselected engine route can handle unavailable setup.
        // Decline, pending consent, stale identity and disconnect never fall back.
        if (allowEngineFallback && ['unsupported', 'setting_off'].includes(currentState) && typeof fallback === 'function') {
          return routeEngine();
        }
        return remember(request, { error: connectionError(currentState) }, 'direct');
      }
      let adapter;
      try { adapter = await initialize(); }
      catch {
        if (generation === epoch && currentState === 'ready') { currentState = 'disconnected'; generation++; }
        return remember(request, { error: connectionError(currentState) }, 'direct');
      }
      if (generation !== epoch || currentState !== 'ready')
        return remember(request, { error: connectionError(currentState) }, 'direct');
      const result = await deliveryBudget.run(request.arguments.max_bytes ?? 12000, () => adapter.call(request));
      if (generation !== epoch || currentState !== 'ready')
        return remember(request, { error: connectionError(currentState, { effect: result.error?.effect ?? (writable(request) ? 'unknown' : 'none'),
          completed: result.error?.completed ?? result.completed ?? 0 }), results: result.results ?? [],
          untouched: untouchedCount(request, result, result.error?.completed ?? result.completed ?? 0) }, 'direct');
      if (allowEngineFallback && typeof fallback === 'function' && result.error?.code === 'BACKGROUND_UNAVAILABLE' &&
          result.error.effect === 'none' && result.error.completed === 0) return routeEngine();
      return remember(request, result, 'direct', readSequence);
    },
  };
}
export async function measureSurface(surface, request, samples = 20) {
  if (!Number.isInteger(samples) || samples < 20 || samples > 1000) throw Error('Bounded sample count required');
  const times = [], sizes = [], raw = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const call = JSON.stringify(request), response = JSON.stringify(await surface.call(JSON.parse(call)));
    const elapsed = performance.now() - start, responseBytes = Buffer.byteLength(response);
    times.push(elapsed); sizes.push(responseBytes);
    raw.push({ trial: i + 1, overhead_ms: elapsed, response_bytes: responseBytes });
  }
  times.sort((a, b) => a - b); sizes.sort((a, b) => a - b);
  return { samples, raw, overhead_p50_ms: times[Math.ceil(samples * .5) - 1], overhead_p90_ms: times[Math.ceil(samples * .9) - 1],
    call_bytes: Buffer.byteLength(JSON.stringify(request)), response_bytes: sizes[Math.ceil(samples * .5) - 1],
    schema_bytes: Buffer.byteLength(JSON.stringify(compactTools())), tokenizer: 'UTF-8 bytes / 4 (proxy)',
    actual_model_tokens: null, thinking_tokens: null, transport: 'unmeasured; supplied adapter' };
}
