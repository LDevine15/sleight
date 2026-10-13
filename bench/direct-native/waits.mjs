// Read-only prototype. The adapter must perform normal relay authorization and
// supply engine-full provenance; this module neither acquires nor renews a grant.
const identityKeys = ['session', 'runtime', 'pid', 'processStart', 'window', 'lease', 'policy', 'document'];
const equalBinding = (a, b) => identityKeys.every(key => a?.[key] !== undefined && a[key] === b?.[key]);
const validBinding = binding => identityKeys.every(key => typeof binding?.[key] === 'string' ? binding[key].length > 0
  : typeof binding?.[key] === 'number' && Number.isFinite(binding[key]));

function validatePredicate(until) {
  const allowed = ['id', 'role', 'name', 'state', 'title', 'absent'];
  if (!until || typeof until !== 'object' || Array.isArray(until) || !Object.keys(until).length ||
      Object.keys(until).some(key => !allowed.includes(key)) ||
      !['id', 'role', 'name', 'title'].some(key => typeof until[key] === 'string' && until[key]) ||
      Object.entries(until).some(([key, value]) => key === 'absent' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) ||
      (until.title !== undefined && Object.keys(until).some(key => key !== 'title')))
    throw new Error('invalid native wait predicate');
}

function match(observation, until) {
  if (until.title !== undefined) return observation.title === until.title ? 'matched' : observation.complete ? 'complete-not-matched' : 'incomplete';
  const rows = observation.rows ?? [];
  const found = rows.filter(row => ['id', 'role', 'name'].every(key => until[key] === undefined || row[key] === until[key]));
  if (found.length > 1) return 'incomplete';
  if (until.absent) return found.length === 0 && observation.complete ? 'matched' : observation.complete ? 'complete-not-matched' : 'incomplete';
  if (found.length === 1 && found[0].visible === true && (until.state === undefined || found[0].state === until.state)) return 'matched';
  return observation.complete ? 'complete-not-matched' : 'incomplete';
}

export function createNativeWaiter(adapter, { now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof adapter?.read !== 'function' || typeof adapter?.authorized !== 'function') throw new Error('authorized read adapter required');
  // Pending reads stay in this table after a client deadline or cancellation.
  // Their queue ownership is released only when the original promise settles.
  const pending = new Map();
  let queue = Promise.resolve();
  const sameLineage = (state, binding, scope) => state?.source === 'engine-full' &&
    equalBinding(state.binding, binding) && state.scope === scope && Number.isSafeInteger(state.sequence) && state.sequence >= 0;
  const eligible = (state, binding, scope, age) => sameLineage(state, binding, scope) && Number.isFinite(state.observedAt) &&
    state.observedAt <= now() && now() - state.observedAt < age && Array.isArray(state.rows);
  const bounded = (promise, deadline, signal) => new Promise(resolve => {
    let timer;
    const finish = value => { clearTimer(timer); signal?.removeEventListener('abort', abort); resolve(value); };
    const abort = () => finish({ status: 'cancelled' });
    timer = setTimer(() => finish({ status: 'timeout' }), Math.max(0, deadline - now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(value => finish({ value }), () => finish({ status: 'incomplete', code: 'ENGINE_UNAVAILABLE' }));
  });
  const pause = (delay, signal) => new Promise(resolve => {
    let timer;
    const end = now() + delay;
    const finish = () => { clearTimer(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const wake = () => {
      if (signal?.aborted || now() >= end) finish();
      else timer = setTimer(wake, Math.max(1, Math.ceil(end - now())));
    };
    timer = setTimer(wake, Math.ceil(delay));
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
  return {
    pending: () => pending.size,
    async wait({ binding, until, scope = 'window', evidence, timeoutMs = 10000, signal, effect, once = false }) {
      validatePredicate(until);
      until = Object.freeze({ ...until });
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error('timeout must be 0 to 30000 ms');
      if (!validBinding(binding) || !['window', 'sheet', 'region'].includes(scope)) throw new Error('exact authorized binding and scope required');
      binding = Object.freeze({ ...binding });
      const deadline = now() + timeoutMs;
      const counts = { engineOperations: 0, reusedObservations: 0, readReasons: [] };
      let last, backoff = 25, minimumSequence = sameLineage(evidence, binding, scope) ? evidence.sequence : -1;
      const result = (status, code) => ({ status, ...(code ? { code } : {}), observation: last, counts, pending: pending.size });
      const authorized = () => adapter.authorized(binding, scope) === true;
      if (effect === 'unknown') return result('incomplete', 'EFFECT_UNKNOWN');
      if (!authorized() || signal?.aborted) return result('cancelled');
      if (evidence?.complete === true && eligible(evidence, binding, scope, 10000)) {
        last = evidence; counts.reusedObservations++;
        const status = match(last, until);
        if (timeoutMs > 0 && now() >= deadline) return result('timeout');
        if (status === 'matched' || once || timeoutMs === 0) return result(status);
      }
      while (now() < deadline) {
        if (!authorized()) { last = undefined; return result('cancelled'); }
        if (signal?.aborted) return result('cancelled');
        const key = JSON.stringify([identityKeys.map(k => binding[k]), scope]);
        let request = pending.get(key);
        if (!request) {
          const reason = last ? 'predicate-not-yet-matched' : 'fresh-authorized-predicate';
          request = { started: undefined, subscribers: new Set() };
          const owned = request;
          const promise = queue.then(() => {
            const active = [...owned.subscribers].filter(client => !client.signal?.aborted && now() < client.deadline);
            if (!authorized() || !active.length) throw new Error('read no longer authorized or within deadline');
            owned.started = now(); counts.engineOperations++; counts.readReasons.push(reason);
            return adapter.read({ binding, scope, deadline: Math.max(...active.map(client => client.deadline)), reason });
          });
          request.promise = promise;
          queue = promise.catch(() => {});
          pending.set(key, request);
          promise.then(() => { if (pending.get(key) === request) pending.delete(key); },
            () => { if (pending.get(key) === request) pending.delete(key); });
        } else counts.readReasons.push('coalesced-authorized-read');
        const subscriber = { deadline, signal };
        request.subscribers.add(subscriber);
        const response = await bounded(request.promise, deadline, signal);
        request.subscribers.delete(subscriber);
        if (!authorized()) { last = undefined; return result('cancelled'); }
        if (signal?.aborted || response.status === 'cancelled') return result('cancelled');
        // Promise completion can precede the timer callback after the deadline.
        // Each subscriber checks its own monotonic bound before late delivery.
        if (now() >= deadline) return result('timeout');
        if (response.status) return result(response.status, response.code);
        const fresh = response.value;
        if (!eligible(fresh, binding, scope, 10000) || fresh.observedAt < request.started || fresh.sequence <= minimumSequence)
          return result('incomplete', 'OBSERVATION_STALE');
        const status = match(fresh, until);
        if (now() >= deadline) return result('timeout');
        minimumSequence = fresh.sequence;
        last = fresh;
        if (status === 'matched' || once) return result(status);
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await pause(Math.min(backoff, remaining), signal);
        if (signal?.aborted) return result('cancelled');
        backoff = Math.min(250, backoff * 2);
      }
      return result('timeout');
    },
  };
}
