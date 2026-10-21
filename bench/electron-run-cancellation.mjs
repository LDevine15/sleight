// Cancellation is cooperative: finish an existing call before cleanup, and retain ownership on uncertainty.
export const interrupted = () => Object.assign(Error('RUN_INTERRUPTED'), { code: 'RUN_INTERRUPTED' });
export function checkRunSignal(signal) { if (signal?.aborted) throw interrupted(); }

export function installRunCancellation({ events = process } = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM']) events.on(name, abort);
  return { signal: controller.signal, dispose() { for (const name of ['SIGINT', 'SIGTERM']) events.off(name, abort); } };
}

// Racing a passive wait is safe; this helper must never wrap a mutating operation.
export async function interruptibleWait(wait, signal) {
  checkRunSignal(signal);
  if (!signal) return wait;
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(interrupted()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([wait, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

// The original promise stays observed. A timeout blocks every later cleanup/remove boundary in its lifecycle.
export async function settleRunOperation(work, { signal, lifecycle, graceMs = 60_000 } = {}) {
  if (!signal) return work;
  let onAbort, timer;
  const stopped = new Promise((_, reject) => {
    onAbort = () => { timer = setTimeout(() => {
      lifecycle.cleanupAllowed = false; lifecycle.unsettled = true;
      reject(Object.assign(Error('RUN_CANCELLATION_UNSETTLED'), { code: 'RUN_CANCELLATION_UNSETTLED' }));
    }, graceMs); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

const safeReads = new Set(['cleanup', 'identity', 'build', 'launchWindows', 'fixturePids', 'readFile', 'armConfig']);
export function cancellableDriver(driver, signal) {
  if (!signal) return driver;
  return new Proxy(driver, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    if (safeReads.has(key)) return value.bind(target);
    return (...args) => {
      checkRunSignal(signal);
      const result = value.apply(target, args);
      if (result?.then) return result.then(value => { checkRunSignal(signal); return value; });
      checkRunSignal(signal); return result;
    };
  } });
}
