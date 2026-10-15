// Benchmark fork entry. V7's worker API is retained unchanged. V10 owns the
// trusted runtime join, including payment terms, consent and staged uploads.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { serveV3Worker } from '../../plugins/sleight/lib/direct-browser/worker.mjs';

export function serveBenchWorker({ channel, begin, close }) {
  return serveV3Worker({ channel, browser: 'bbench', begin, close });
}
export async function prepareBenchRuntime() {
  // TODO(V10): join the owned headless launch to V1's CDP filter, V2's page
  // registry and V10's authenticated per-turn providers. Require exact document,
  // payment and file bindings. Never fall back to v2 or an allow stub.
  // Refuse before browser launch, profile creation, native UI or helper builds.
  throw Error('V3_PRIVATE_PROVIDERS_UNAVAILABLE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.send) {
  prepareBenchRuntime().then(runtime => serveBenchWorker({ channel: process, ...runtime }).ready())
    .catch(() => { if (process.connected) { process.send({ version: 3, status: 'unavailable' }); process.disconnect(); } });
}
