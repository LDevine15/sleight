// Bounded retries for turbo's read-only startup checks. A check that only reads (a helper subprocess, a file Chrome
// writes) can fail for a moment on a loaded Mac without telling anything about the browser, so it gets one more look.
// None of these send anything to the browser.

// The helper never ran to completion: its timeout killed it, a signal stopped it, or it could not start because the
// process or file table was full. A helper that ran and refused (a non-zero exit) is an answer and is never retried.
const SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EINTR', 'ETIMEDOUT']);
export const transientRunFailure = error => !!error && typeof error === 'object' &&
  (error.killed === true || typeof error.signal === 'string' && error.signal.length > 0 || SPAWN_CODES.has(error.code));

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** run has execFile's promise shape. One more run after delayMs when the first never completed. */
export async function runOnceMore(run, file, args, options, { delayMs = 100, wait = pause } = {}) {
  try { return await run(file, args, options); }
  catch (error) {
    if (!transientRunFailure(error)) throw error;
    await wait(delayMs);
    return run(file, args, options);
  }
}

/** Up to `attempts` calls of fn, delayMs apart, while it throws one of the given codes (its message). */
export async function retryCodes(fn, codes, { attempts = 3, delayMs = 100, wait = pause } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt >= attempts || !codes.includes(error?.message)) throw error;
      await wait(delayMs);
    }
  }
}
