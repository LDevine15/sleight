// One budget starts at admission, including queue time. This is an internal broker API.
export class Deadline {
  constructor(timeoutMs = 3000, { signal, now = () => performance.now() } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw fault('INVALID_OPERATION');
    this.now = now;
    this.started = now();
    this.ends = this.started + timeoutMs;
    this.signal = signal;
  }

  check() {
    if (this.signal?.aborted) throw fault('CANCELLED');
    if (this.now() >= this.ends) throw fault('DEADLINE');
  }

  async run(fn) {
    this.check();
    let timer;
    let abort;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fault('DEADLINE')), this.ends - this.now());
      abort = () => reject(fault('CANCELLED'));
      this.signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      // fn is called only after the deadline and cancellation checks, never as a queued continuation.
      const value = await Promise.race([Promise.resolve().then(() => { this.check(); return fn(); }), interrupted]);
      this.check();
      return value;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', abort);
    }
  }
}

export function fault(code) {
  return Object.assign(new Error(code), { code });
}

// Events wake a narrow semantic predicate. The timer is a fallback, not an idle proof.
export function eventPulse() {
  let version = 0;
  const waiters = new Set();
  return {
    get version() { return version; },
    wake() { version++; for (const wake of waiters) wake(); },
    async wait(deadline, since, interval = 25) {
      if (version !== since) return;
      let wake;
      let timer;
      try {
        await deadline.run(() => new Promise(resolve => {
          wake = resolve;
          waiters.add(wake);
          timer = setTimeout(resolve, Math.min(interval, deadline.ends - deadline.now()));
          if (version !== since) resolve();
        }));
      } finally { clearTimeout(timer); waiters.delete(wake); }
    },
  };
}
