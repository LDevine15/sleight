#!/usr/bin/env node
// Measures production turbo's tools and modules, not the installed path.
// Bench-only enable, exact runner fixture trust and original task authority.
// This file is never imported by plugins/ and never launches a native UI.
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactTools } from '../../plugins/sleight/lib/direct-browser/surface.mjs';
import { validateCall } from '../../plugins/sleight/lib/direct-browser/schemas.mjs';
import { loadPlaywrightCore } from '../../plugins/sleight/lib/direct-browser/worlds.mjs';
import { bounded } from '../../plugins/sleight/lib/direct-browser/lifecycle.mjs';
import { fixturePolicy, MEASUREMENT } from './setup.mjs';
import { paymentEvidence } from './payment.mjs';
import { createModuleSession } from './session.mjs';
import { connectRoot } from './transport.mjs';

const spec = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium');
export const executable = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-linux64/chrome');
export function launchOptions() {
  return { headless: true, executablePath: executable, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block',
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check'], timeout: 30000,
    // The browser has no reason to inherit model credentials, session channels,
    // project loaders or a Claude config. Keep only ordinary OS launch inputs.
    env: Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR'].flatMap(key =>
      typeof process.env[key] === 'string' ? [[key, process.env[key]]] : [])) };
}
export async function createSession({ origins, taskMessage, chromium, temporaryRoot = tmpdir(), connect = connectRoot,
  modules = createModuleSession } = {}) {
  const permits = fixturePolicy(origins);
  chromium ??= loadPlaywrightCore({ turbo: true }).inprocess.playwright.chromium;
  const profile = mkdtempSync(join(realpathSync(temporaryRoot), 'sleight-turbo-bench-'));
  let context, raw, session, closing, startupSocketUnproved = false;
  const close = () => closing ??= (async () => {
    let moduleRevoked = !session, socketClosed = !raw && !startupSocketUnproved, browserClosed = !context;
    try { if (session) moduleRevoked = (await bounded(() => session.close(), 30000))?.revoked === true; } catch {}
    try { if (raw) socketClosed = await raw.close() === true; } catch {}
    try { if (context) { await bounded(() => context.close(), 30000); browserClosed = true; } } catch {}
    if (!moduleRevoked || !socketClosed || !browserClosed) throw Error('CLEANUP_UNPROVED: retained ' + profile);
    rmSync(profile, { recursive: true, force: true });
    // Whole disposable-child closure collects even targets intentionally parked
    // by production's unknown-submit journal. It never closes an owner browser.
    return { browserClosed, profileDeleted: !existsSync(profile), socketsClosed: socketClosed };
  })();
  try {
    context = await chromium.launchPersistentContext(profile, launchOptions());
    await context.route('**/*', route => permits(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
    raw = await connect(profile);
    session = await modules({ raw, origins, taskMessage, async readPayment() {
      const pages = context.pages().filter(page => permits(page.url()));
      if (pages.length !== 1) return null;
      const page = pages[0], url = page.url();
      const evidence = await bounded(() => page.evaluate(paymentEvidence), 1000).catch(() => null);
      return page.url() === url && evidence ? { page: evidence, url } : null;
    } });
    return Object.freeze({ profile, call: session.call, delivered: session.delivered, close,
      metadata: { measurement: MEASUREMENT, headless: true, playwright: '1.64.0', chromiumBuild: spec.revision } });
  } catch (error) { startupSocketUnproved = error.message === 'SOCKET_CLEANUP_UNPROVED'; await close(); throw error; }
}

export function createProtocol({ output = process.stdout, start } = {}) {
  let session, starting, queue = Promise.resolve(), closing = false, cleanup;
  const send = value => new Promise((resolve, reject) => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n', error => error ? reject(error) : resolve());
  });
  const run = async message => {
    const id = message?.id; if (id === undefined) return;
    if (closing) return send({ id, error: { code: -32000, message: 'Session closing' } });
    if (message.method === 'initialize') return send({ id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'sleight-turbo-bench', version: '0.1.0' }, instructions: MEASUREMENT } });
    if (message.method === 'ping') return send({ id, result: {} });
    if (message.method === 'tools/list') return send({ id, result: { tools: compactTools() } });
    if (message.method !== 'tools/call') return send({ id, error: { code: -32601, message: 'Method not found' } });
    let request;
    // Only the call itself, as the relay passes it: Claude Code adds _meta to every tools/call.
    try { request = validateCall({ name: message.params?.name, arguments: message.params?.arguments }); }
    catch { return send({ id, error: { code: -32602, message: 'Invalid turbo tool request' } }); }
    try {
      starting ??= Promise.resolve().then(start); session = await starting;
      const result = await session.call(request);
      await send({ id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!result.error } });
      // A receipt enters the production delivered-read gate only after the
      // successful serialized write. Failed or omitted reads cannot unlock it.
      if (request.name === 'browser_read') session.delivered(result);
    } catch { await send({ id, error: { code: -32000, message: 'Turbo bench unavailable; no blind retry' } }); }
  };
  return Object.freeze({
    message(message) { const work = queue.then(() => run(message)); queue = work.catch(() => {}); return work; },
    close() {
      closing = true;
      return cleanup ??= (async () => {
        await queue;
        if (starting) { try { session = await starting; } catch {} }
        return session?.close();
      })();
    } });
}
async function main() {
  const protocol = createProtocol({ start: () => createSession({ origins: JSON.parse(process.env.SLEIGHT_TURBO_ORIGINS ?? '[]'),
    taskMessage: process.env.SLEIGHT_TURBO_TASK ?? '' }) });
  const lines = createInterface({ input: process.stdin }); let stopping;
  const stop = () => stopping ??= protocol.close().then(receipt => {
    if (receipt) process.stderr.write(JSON.stringify({ turboBenchCleanup: receipt }) + '\n');
  }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; })
    .finally(() => { lines.close(); process.stdin.destroy(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  process.stdout.once('error', stop);
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 131072) { lines.close(); return; }
    try { void protocol.message(JSON.parse(line)); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
  });
  lines.once('close', stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
