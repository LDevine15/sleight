#!/usr/bin/env node
// Root-owned qualification command. The build lane only tests the injected offline client.
import { existsSync } from 'node:fs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { fileURLToPath } from 'node:url';
import { collectionCertain, diagnosticEnvironment, documentationBootstrapChecks, documentationRelayChecks } from './compat/documentation.mjs';

const LAUNCHER = fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url));

export async function runDocumentationOriginProbe({ env = process.env, signal, exists = existsSync,
  lock = acquireLiveLock, resolve = resolveServer, raw = documentationBootstrapChecks,
  mode = 'raw', launcher = LAUNCHER, relay = documentationRelayChecks } = {}) {
  let release, report, started = false;
  const selected = diagnosticEnvironment(env);
  try {
    if (exists('/tmp/sleight-hold')) throw Error('/tmp/sleight-hold exists.');
    release = await lock('/tmp/sleight-live.lock', { wait: false });
    if (!['raw', 'relay'].includes(mode)) throw Error('Unknown documentation probe mode.');
    const server = mode === 'raw' ? resolve(selected) : undefined;
    if (server?.error) throw Error(server.error);
    started = true;
    report = await (mode === 'raw' ? raw(server, selected, { signal, includeUnknownHeadingTitles: true }) : relay(launcher, selected, { signal }));
  } catch (error) {
    report = { status: 'error', reason: error.message,
      cleanup: error.cleanupReceipt ?? { started, childCollected: !started, groupCollected: !started } };
  } finally {
    if (release && collectionCertain(report?.cleanup)) {
      try { await release(); report.lockRetained = false; }
      catch { report = { ...report, status: 'fail', lockRetained: true, reason: 'live lock release was not confirmed' }; }
    } else if (release) {
      report = { ...report, status: 'fail', lockRetained: true,
        reason: 'live lock retained because owned child or process-group collection is unproved' };
    } else report.lockRetained = false;
  }
  return report;
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    if (process.argv.length > 3 || process.argv.length === 3 && process.argv[2] !== '--relay') throw Error('Use no arguments for raw capture, or --relay for client delivery.');
    const report = await runDocumentationOriginProbe({ signal: controller.signal, mode: process.argv[2] === '--relay' ? 'relay' : 'raw' });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = controller.signal.aborted ? 130 : ['fail', 'error'].includes(report.status) ? 1 : 0;
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
