import { performance } from 'node:perf_hooks';
import { nativeTools } from './tools.mjs';

const schemaByName = new Map(nativeTools.map(tool => [tool.name, tool.inputSchema]));
const codes = new Set(['OK', 'INVALID_REQUEST', 'TARGET_STALE', 'TARGET_AMBIGUOUS', 'VIEW_INCOMPLETE', 'WINDOW_CHANGED',
  'BUDGET_TOO_SMALL', 'APPROVAL_REQUIRED', 'DENIED', 'FORBIDDEN', 'LEASE_BUSY', 'USER_TAKEOVER', 'WAIT_TIMEOUT',
  'AX_UNSUPPORTED', 'AX_TIMEOUT', 'ENGINE_UNAVAILABLE', 'EFFECT_UNKNOWN', 'DOCUMENT_SCOPE', 'CHANGE_REVIEW',
  'FLOW_REFUSED', 'CLIPBOARD_REFUSED', 'DEPENDENCY_FAILED', 'NEW_DECISION_REQUIRED']);
const failure = code => Object.assign(new Error(code), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

// The validator and published schema use the same closed grammar. Reject extras before calling any port.
function valid(value, schema) {
  if (schema.oneOf) return schema.oneOf.filter(branch => valid(value, branch)).length === 1;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'object') return plain(value) &&
    Object.keys(value).length >= (schema.minProperties ?? 0) &&
    (schema.required ?? []).every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && valid(value[key], schema.properties[key]));
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems &&
    Array.from(value).every(item => valid(item, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) &&
    value.length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) &&
    value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity) &&
    (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum);
}

export function validateRequest(name, request) {
  if (!schemaByName.has(name) || !valid(request, schemaByName.get(name))) throw failure('INVALID_REQUEST');
  // Include the tool name and envelope, not just action strings, in the 16 KiB ceiling.
  if (Buffer.byteLength(JSON.stringify({ name, arguments: request })) > 16384) throw failure('INVALID_REQUEST');
  return structuredClone(request);
}

export function compileAction(action, binding, selector) {
  if (!valid(action, schemaByName.get('native_act').properties.actions.items) ||
      !/^[A-Za-z_$][\w$]*$/.test(binding?.handle ?? '')) throw failure('INVALID_REQUEST');
  const receiver = binding.handle;
  const target = () => {
    // The session ref adapter supplies a delivered semantic selector, never an old stored number.
    if (!plain(selector) || Object.keys(selector).length !== 1 ||
        !['id', 'label'].some(key => typeof selector[key] === 'string' && selector[key].length > 0 && selector[key].length <= 4096)) {
      throw failure('TARGET_STALE');
    }
    return JSON.stringify(selector);
  };
  if ('click' in action) return `await ${receiver}.click(${target()});`;
  if ('type' in action) return `await ${receiver}.typeText(${JSON.stringify(action.type)});`;
  if ('key' in action) return `await ${receiver}.pressKey(${JSON.stringify(action.key)});`;
  if ('set' in action) return `await ${receiver}.setValue(${target()},${JSON.stringify(action.set.value)});`;
  return `await ${receiver}.scroll(${target()},${JSON.stringify(action.scroll.direction)},${action.scroll.amount});`;
}

export function measureExchange(name, request, response) {
  validateRequest(name, request);
  return { requestBytes: Buffer.byteLength(JSON.stringify({ name, arguments: request })),
    responseBytes: Buffer.byteLength(JSON.stringify(response)), schemaBytes: Buffer.byteLength(JSON.stringify(nativeTools)),
    tokens: null, schemaTokens: null, modelTimeMs: null };
}

// Trusted ports, to be joined with NP-1 refs and NP-2 views at NP-8. They are not model arguments.
// dispatch must submit ordinary js to the complete relay, without bypassing any gate. acquire uses
// its supported selection path and initial observation. bind/resolve revalidate session, runtime,
// process/window/document/lease identity, delivered membership and correspondence on every step.
// project applies effective read policy and redaction. predicate uses authorized scope coverage.
// This prototype has no live backend or tool registration, and never calls an engine handle directly.
export function createNativeCompiler({ route, now = () => performance.now(), pollMs = 50 } = {}) {
  if (typeof now !== 'function' || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 1000 ||
      route?.kind !== 'full-relay' || ['acquire', 'bind', 'resolve', 'dispatch', 'project', 'predicate']
    .some(name => typeof route[name] !== 'function')) throw failure('INVALID_REQUEST');
  const observations = new Map();
  let pending = false, unknown = false;
  const safeCode = error => codes.has(error?.code) ? error.code : 'ENGINE_UNAVAILABLE';

  async function call(name, input) {
    const request = validateRequest(name, input);
    const actions = request.actions ?? [];
    let app = request.app, last, matched, deadline;
    const completedSteps = [];
    const result = async (code, phase, effect = completedSteps.length ? 'observed' : 'none') => {
      const receipt = { code, phase, app, completedSteps, failedStep: completedSteps.length < actions.length ? completedSteps.length : null,
        remainingSteps: actions.slice(completedSteps.length), effect,
        ...(matched === undefined ? {} : { matched }),
        ...(code === 'TARGET_STALE' || code === 'TARGET_AMBIGUOUS' || code === 'VIEW_INCOMPLETE'
          ? { next: { name: 'native_read', arguments: { app } } } : {}) };
      if (last) {
        try { receipt.observation = await bounded(() => route.project(last, request)); }
        catch (error) {
          receipt.code = unknown ? 'EFFECT_UNKNOWN' : safeCode(error);
          if (unknown) { receipt.phase = 'unknown'; receipt.effect = 'unknown'; }
        }
      }
      return receipt;
    };
    if (unknown) return result('EFFECT_UNKNOWN', 'unknown', 'unknown');
    if (pending) return result('LEASE_BUSY', 'prepared');
    pending = true;
    const started = now();
    if (!Number.isFinite(started)) { pending = false; throw failure('INVALID_REQUEST'); }
    deadline = started + (request.timeout ?? (name === 'native_wait' ? 10000 : 30000));
    let inDispatch = false;
    // A client deadline does not prove cancellation. Poison the session if a port remains pending.
    async function bounded(operation) {
      const remaining = deadline - now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw failure('WAIT_TIMEOUT');
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(() => {
          // Time can expire between preparation and the port's actual entry.
          const available = deadline - now();
          if (!Number.isFinite(available) || available <= 0) throw failure('WAIT_TIMEOUT');
          return operation();
        }), new Promise((_, reject) => {
          timer = setTimeout(() => { unknown = true; reject(failure('EFFECT_UNKNOWN')); }, remaining);
        })]);
      } finally { clearTimeout(timer); }
    }
    function remember(observation) {
      if (!observation || observation.source !== 'engine-full') throw failure('VIEW_INCOMPLETE');
      last = observation; observations.set(app, observation);
    }
    async function dispatch(code) {
      const reply = await bounded(() => {
        const submit = route.dispatch;
        if (typeof submit !== 'function') throw failure('ENGINE_UNAVAILABLE');
        const enteredAt = now();
        const timeout_ms = Math.floor(deadline - enteredAt);
        if (!Number.isFinite(enteredAt) || !Number.isFinite(timeout_ms) || timeout_ms <= 0) throw failure('WAIT_TIMEOUT');
        const request = { code, timeout_ms };
        // Preparation failure proves no port entry. Set the fence only at entry.
        inDispatch = true;
        return Reflect.apply(submit, route, [request]);
      });
      inDispatch = false;
      if (reply?.status !== 'ok') {
        if (reply?.status === 'unknown' || reply?.dispatched !== false) { unknown = true; throw failure('EFFECT_UNKNOWN'); }
        throw failure(safeCode(reply));
      }
      if (reply.effect === 'unknown') { unknown = true; throw failure('EFFECT_UNKNOWN'); }
      // A successful mutation without its required authorized readback is still indeterminate.
      if (reply.observation?.source !== 'engine-full') { unknown = true; throw failure('EFFECT_UNKNOWN'); }
      remember(reply.observation);
    }
    try {
      let binding;
      if (name === 'native_open') {
        const acquired = await bounded(() => route.acquire({ app, window: request.window, deadline }));
        binding = acquired.binding; app = binding?.alias;
        if (!/^a[1-9][0-9]*$/.test(app ?? '')) throw failure('TARGET_STALE');
        remember(acquired.observation);
      } else {
        binding = await bounded(() => route.bind(app));
        last = observations.get(app);
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(binding?.handle ?? '')) throw failure('TARGET_STALE');
      const read = () => {
        if (!/^[A-Za-z_$][\w$]*$/.test(binding?.handle ?? '')) throw failure('TARGET_STALE');
        return dispatch(`await ${binding.handle}.${request.image ? 'getAXStateAndScreenshot' : 'getAXState'}({disableDiffing:true});`);
      };
      if (name === 'native_read') { await read(); return await result('OK', 'observed'); }
      if (name === 'native_wait') {
        do {
          binding = await bounded(() => route.bind(app));
          await read();
          const condition = await bounded(() => route.predicate(last, request.until, binding));
          if (condition.matched === true) { matched = true; return await result('OK', 'verified', 'verified'); }
          matched = false;
          if (deadline - now() <= pollMs) return await result('WAIT_TIMEOUT', 'observed');
          await bounded(() => new Promise(resolve => setTimeout(resolve, pollMs)));
        } while (now() < deadline);
        return await result('WAIT_TIMEOUT', 'observed');
      }
      for (const action of actions) {
        binding = await bounded(() => route.bind(app));
        const ref = action.click ?? action.set?.ref ?? action.scroll?.ref;
        const selector = ref ? await bounded(() => route.resolve(binding, ref, last)) : undefined;
        const code = compileAction(action, binding, selector);
        // One relay request per step keeps all outer gates and a mandatory transition barrier.
        // This conservative prototype reduces model decisions, not native wrapper invocations.
        await dispatch(code + `\nawait ${binding.handle}.getAXState({disableDiffing:true});`);
        completedSteps.push({ index: completedSteps.length, phase: 'observed', effect: 'observed' });
      }
      if (request.expect) {
        binding = await bounded(() => route.bind(app));
        const condition = await bounded(() => route.predicate(last, request.expect, binding));
        matched = condition.matched === true;
        if (!matched) return await result(condition.complete ? 'DEPENDENCY_FAILED' : 'VIEW_INCOMPLETE', 'observed');
        return await result('OK', 'verified', 'verified');
      }
      return await result('OK', 'observed');
    } catch (error) {
      if (inDispatch && error?.dispatched !== false) unknown = true;
      return await result(unknown ? 'EFFECT_UNKNOWN' : safeCode(error), unknown ? 'unknown' : completedSteps.length ? 'observed' : 'prepared',
        unknown ? 'unknown' : completedSteps.length ? 'observed' : 'none');
    } finally { pending = false; }
  }
  return { call };
}
