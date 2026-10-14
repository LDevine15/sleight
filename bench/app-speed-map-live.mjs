import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { startHost } from './battery/runtime.mjs';
import { writeDocument } from './battery/documents.mjs';
import { tasks } from './battery/tasks.mjs';
import { probeClient } from './double-keys-client.mjs';
import { benchmarkDecision } from './approve.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { speedMarkdown, speedScope } from './app-speed-map.mjs';

const cleanupCodes = new Set(['FIXTURE_WINDOW_AMBIGUOUS', 'FOREIGN_WINDOW_ON_START', 'DOCUMENT_NOT_MATCHED', 'WINDOW_NOT_RETAINED',
  'SHEET_PRESENT', 'SHEETS_READ_FAILED', 'FIXTURE_WINDOW_NOT_RETAINED', 'CLOSE_BUTTON_MISSING', 'AXPRESS_FAILED',
  'WINDOW_STILL_PRESENT_AFTER_10S', 'SCRIPTING_NOT_OWN_FIXTURE', 'SCRIPTING_FAILED', 'WINDOW_STILL_PRESENT_AFTER_SCRIPTING',
  'APP_IDENTITY_UNCONFIRMED', 'APP_HAS_WINDOWS', 'APP_NOT_TERMINATED', 'WINDOWS_READ_FAILED', 'HOST_ABORTED', 'HOST_TIMEOUT',
  'HOST_PROCESS_UNCONFIRMED', 'HOST_RECEIPT_MISSING', 'HOST_DETAILS_MISSING', 'CLEANUP_FAILED', 'SERVER_CLEANUP_FAILED']);

export function validateSpeedReceipt(task, receipt) {
  if (task.fixture === 'browser') {
    if (receipt?.ownerApproved !== true || typeof receipt.browserId !== 'string' || !receipt.browserId.trim() ||
        typeof receipt.profileName !== 'string' || !receipt.profileName.trim()) throw Error('BROWSER_PROFILE_RECEIPT_REQUIRED');
    return { browserId: receipt.browserId, profileName: receipt.profileName };
  }
  if (task.fixture !== 'local-container') return {};
  if (receipt?.local !== true || typeof receipt.id !== 'string' || !receipt.id.trim() ||
      typeof receipt.marker !== 'string' || !receipt.marker.trim() || receipt.marker.length > 200) throw Error('LOCAL_CONTAINER_RECEIPT_REQUIRED');
  return { containerId: receipt.id, containerMarker: receipt.marker };
}
export function speedEnvironment(inherited) {
  const keys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']);
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => keys.has(key))),
    SLEIGHT_SURFACES: 'computer,browser', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: '', SLEIGHT_RECEIPTS: '0',
    BENCH_HOOK_LOG: '', BENCH_SUITE: 'app-speed-map', BENCH_ARM_SERVERS: JSON.stringify(['plugin:sleight:computer']) };
}
export function speedLauncher(root, env) {
  return { command: join(root, 'plugins/sleight/bin/sleight-mcp'), args: [], env, inheritEnvironment: false };
}

export function speedOutput(root, requested) {
  const resultsRoot = resolve(root, 'bench/results');
  const output = resolve(requested ?? join(resultsRoot, `am1-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (!output.startsWith(resultsRoot + '/')) throw Error('OUTPUT_OUTSIDE_BENCH_RESULTS');
  for (let path = dirname(output); path !== resolve(root); path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw Error('OUTPUT_SYMLINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of [output + '.json', output + '.md']) {
    try { lstatSync(path); throw Error('OUTPUT_ALREADY_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return output;
}

export async function liveSpeedRuntime(plan, options, {
  platform = process.platform, repositoryRoot = fileURLToPath(new URL('..', import.meta.url)),
  takeLock = acquireLiveLock, makeBank = () => mkdtempSync('/private/tmp/sleight-battery-am1-'),
  startFixtureHost = startHost, makeClient = probeClient,
} = {}) {
  if (platform !== 'darwin') throw Error('MACOS_REQUIRED');
  if (existsSync('/tmp/sleight-hold')) throw Error('HOLD');
  for (const task of plan.apps) speedScope(plan, task);
  const receipts = options.receipts ? JSON.parse(readFileSync(options.receipts, 'utf8')) : {};
  // Validate account boundaries before any child, fixture, server or lock.
  for (const task of plan.apps) validateSpeedReceipt(task, receipts[task.id]);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const root = repositoryRoot, output = speedOutput(root, options.out);
  const unlock = await takeLock(undefined, { signal: controller.signal });
  let bank;
  try { bank = makeBank(); }
  catch (error) { await unlock(); throw error; }
  const env = { ...speedEnvironment(process.env), BENCH_ROOT: root, BENCH_OWNER_PRESENT: plan.ownerPresent ? '1' : '' };
  const resources = new Set(); let activeSessions = 0, closed = false, cleanupFault = false, attentionFault = false, approvalStopped = false;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const held = () => controller.signal.aborted || attentionFault || approvalStopped || existsSync('/tmp/sleight-hold');
  const boundary = () => { if (held()) throw Error('HOLD'); };
  return {
    held, now: () => performance.now(),
    async prepare(task) {
      boundary();
      speedScope(plan, task);
      const dir = join(bank, randomUUID()); mkdirSync(dir, { mode: 0o700 });
      const fixture = { dir, task, ...validateSpeedReceipt(task, receipts[task.id]) };
      resources.add(fixture);
      try {
        const name = 'AM1-' + randomUUID();
        if (['txt', 'docx', 'xlsx'].includes(task.fixture)) {
          fixture.path = fixture.target = join(dir, name + '.' + task.fixture); fixture.marker = basename(fixture.target);
          writeDocument(fixture.path, task.fixture, name);
        } else if (task.fixture === 'workspace' || task.fixture === 'folder') {
          fixture.target = join(dir, name); mkdirSync(fixture.target);
          fixture.marker = fixture.windowMarker = name;
          writeFileSync(join(fixture.target, 'fixture.txt'), name + '\n'.repeat(100), { mode: 0o600 });
        } else if (task.fixture === 'browser') {
          fixture.marker = name;
          const server = createServer((req, res) => {
            if (req.url !== '/fixture' || req.method !== 'GET') { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
            res.end(`<!doctype html><title>${name}</title><div style="width:400px;height:400px;overflow:auto">${'<p>AM1 fixture</p>'.repeat(200)}</div>`);
          });
          fixture.closeServer = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          fixture.url = `http://127.0.0.1:${server.address().port}/fixture`;
        }
        fixture.requireStopped = task.fixture === 'workspace';
        fixture.requireRunning = ['existing', 'local-container', 'browser'].includes(task.fixture);
        fixture.onSample = sample => { if (sample.focusChanged || sample.targetOverOwner) attentionFault = true; };
        fixture.hostAttempted = true;
        fixture.host = await startFixtureHost({ bundle: task.bundle, fixtureKind: fixture.path ? 'doc-file' : 'read' }, fixture, controller.signal);
        return fixture;
      } catch (error) {
        let serverClean = true;
        try { await fixture.closeServer?.(); } catch { serverClean = false; }
        const confirmed = (!fixture.hostAttempted || error.hostCleanup?.confirmed === true) && serverClean;
        if (confirmed) resources.delete(fixture); else cleanupFault = true;
        const safe = Error(/^(APP_ALREADY_RUNNING|FIXTURE_NOT_OPEN)$/.test(error.message) ? error.message : 'FIXTURE_SETUP_FAILED');
        safe.cleanupConfirmed = confirmed; throw safe;
      }
    },
    async openSession(task, fixture) {
      boundary();
      speedScope(plan, task);
      const aliases = tasks.find(item => item.bundle === task.bundle)?.aliases ?? [];
      let client;
      try { client = await makeClient(speedLauncher(root, env), { relay: false, record: () => {}, timeoutMs: 90000,
        approve: async params => {
          let reply = { action: 'decline' };
          const app = /^Allow Computer Use to use "(.+)"\?$/.exec(params.message ?? '')?.[1];
          if ([task.app, task.bundle, ...aliases].includes(app)) {
            const decision = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message: params.message,
              requested_schema: params.requestedSchema, mode: params.mode }, env)?.hookSpecificOutput;
            if (decision) reply = { action: decision.action, ...(decision.content && { content: decision.content }) };
          } else if (task.fixture === 'browser' && params.mode !== 'url' &&
              params.message === `Allow Browser use to access ${new URL(fixture.url).origin}?`) {
            const properties = params.requestedSchema?.properties ?? {}, required = params.requestedSchema?.required ?? [];
            const keys = Object.keys(properties), content = {};
            let valid = keys.length <= 1 && keys.every(key => ['choice', 'persist'].includes(key)) && required.every(key => keys.includes(key));
            for (const key of keys) {
              const choices = properties[key].enum ?? [];
              if (choices.includes('session')) content[key] = 'session';
              else if (choices.includes('once')) content[key] = 'once';
              else valid = false;
            }
            if (valid) reply = { action: 'accept', content };
          }
          if (reply.action !== 'accept') approvalStopped = true;
          return reply;
        } }); } catch (error) { if (error.cleanupConfirmed !== true) cleanupFault = true; throw error; }
      activeSessions++;
      let sessionClosed = false;
      return { js: code => client.call('js', { code, timeout_ms: 60000, title: 'AM1 counts only' }),
        close: async () => {
          if (sessionClosed) return; sessionClosed = true;
          let tabClosed = true;
          try {
            if (task.fixture === 'browser') tabClosed = !(await client.call('js', { code: 'if (typeof am1Tab !== "undefined") await am1Tab.close();', timeout_ms: 10000 })).isError;
          } catch { tabClosed = false; }
          try { await client.close(); activeSessions--; }
          catch { cleanupFault = true; throw Error('SESSION_CLEANUP_UNCONFIRMED'); }
          if (!tabClosed) { cleanupFault = true; throw Error('TAB_CLEANUP_UNCONFIRMED'); }
        } };
    },
    async closeFixture(fixture) {
      let cleanup;
      try { cleanup = await fixture.host.finish(); }
      catch { cleanup = { confirmed: false, samples: [], details: { reasons: ['CLEANUP_FAILED'] } }; }
      const reasons = [...new Set([...(cleanup.details?.reasons ?? []), ...(cleanup.details?.windows ?? []).flatMap(row => row.reasons ?? [])]
        .filter(reason => cleanupCodes.has(reason)))];
      try { await fixture.closeServer?.(); } catch { cleanup.confirmed = false; reasons.push('SERVER_CLEANUP_FAILED'); }
      const confirmed = cleanup.confirmed === true;
      if (confirmed) resources.delete(fixture); else cleanupFault = true;
      return { confirmed, reasons, focusChanged: (cleanup.samples ?? []).some(sample => sample.focusChanged || sample.targetOverOwner) };
    },
    async publish(report) {
      report.approvalStopped = approvalStopped;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      writeFileSync(output + '.md', speedMarkdown(report), { mode: 0o600 });
    },
    async close() {
      if (closed) return; closed = true;
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      if (resources.size || activeSessions || cleanupFault) {
        console.error('AM1_CLEANUP_UNCONFIRMED: retained bank ' + bank + ' and /tmp/sleight-live.lock');
        throw Error('CLEANUP_UNCONFIRMED');
      }
      removeTemp(bank); if (existsSync(bank)) throw Error('TEMP_CLEANUP_UNCONFIRMED'); await unlock();
    },
  };
}
