// Benchmark-only admission to V7's inherited IPC boundary. This never reads the
// owner's installed opt-in config and is never imported by plugin code.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createV3Bridge } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { fixturePolicy } from './setup.mjs';

export async function createSession({ origins, taskMessage, forkWorker = fork } = {}) {
  // Tasks on the public web name no local fixture; any origins that are named still have to be runner fixtures.
  if (!Array.isArray(origins)) throw Error('Runner fixture origins required');
  if (origins.length) fixturePolicy(origins);
  if (typeof taskMessage !== 'string' || !taskMessage.trim() || Buffer.byteLength(taskMessage) > 65536) throw Error('Runner task message required');
  const bridge = await createV3Bridge({}, {
    readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker(_installedEntry, _args, options) {
      // The child receives no credentials, host Claude config, loaders or private
      // engine channels. Only the runner fixture origins enter its environment.
      const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR'].flatMap(key =>
        typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
      env.SLEIGHT_TURBO_ORIGINS = JSON.stringify(origins);
      return forkWorker(fileURLToPath(new URL('./v3-worker.mjs', import.meta.url)), [], { ...options, env });
    },
  });
  let closing;
  try {
    if (!await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'benchturn', text: taskMessage })) throw Error('V3_PRIVATE_PROVIDERS_UNAVAILABLE');
    return Object.freeze({ call: bridge.call, delivered: bridge.delivered,
      close: () => closing ??= bridge.close() });
  } catch (error) { await bridge.close(); throw error; }
}

// Only actual lifecycle evidence can populate these fields. A worker revocation
// alone says nothing about browser closure, profiles, sockets or companion tabs.
export function cleanupMetric(receipt) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { version: 3, phase: 'cleanup', turboTabsLeft: count(receipt?.turboTabsLeft),
    tabsAfterBrowserClose: count(receipt?.tabsAfterBrowserClose), browserClosed: receipt?.browserClosed === true,
    profileDeleted: receipt?.profileDeleted === true, socketsClosed: receipt?.socketsClosed === true };
}
