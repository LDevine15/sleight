#!/usr/bin/env node
// Five production v3 schemas beside the unchanged engine companion. Installed
// activation and the default refusing V10 join remain outside this measurement.
import { createInterface } from 'node:readline';
import { constants, openSync, writeSync, closeSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProtocol } from './v3-protocol.mjs';
import { createSession, cleanupMetric } from './v3-session.mjs';
export { createProtocol, createSession };

export function recordCleanup(file, receipt) {
  const metric = cleanupMetric(receipt);
  if (file) {
    if (!file.startsWith('/') || resolve(file) !== file || basename(file) !== 'turbo-metrics.jsonl' ||
        realpathSync(dirname(file)) !== dirname(file)) throw Error('Invalid metrics destination');
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(metric) + '\n'); } finally { closeSync(fd); }
  }
  return metric;
}
async function main() {
  const protocol = createProtocol({ start: () => createSession({ origins: JSON.parse(process.env.SLEIGHT_TURBO_ORIGINS ?? '[]'),
    taskMessage: process.env.SLEIGHT_TURBO_TASK ?? '' }) });
  const lines = createInterface({ input: process.stdin }); let stopping;
  const stop = () => stopping ??= protocol.close().then(receipt => {
    if (!receipt) return;
    const metric = recordCleanup(process.env.SLEIGHT_TURBO_METRICS, receipt);
    process.stderr.write(JSON.stringify({ turboBenchCleanup: metric }) + '\n');
    if (!metric.browserClosed || !metric.profileDeleted || !metric.socketsClosed) process.exitCode = 1;
  }).catch(() => { process.stderr.write('V3_BENCH_CLEANUP_UNPROVED\n'); process.exitCode = 1; })
    .finally(() => { lines.close(); process.stdin.destroy(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  process.stdout.once('error', stop);
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 131072) { void stop(); return; }
    try { void protocol.message(JSON.parse(line)).catch(() => stop()); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
  });
  lines.once('close', stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
