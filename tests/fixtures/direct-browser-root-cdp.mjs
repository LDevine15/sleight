import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywrightCore } from '../../plugins/sleight/lib/direct-browser/worlds.mjs';
import { popupHook } from '../../plugins/sleight/lib/direct-browser/popups.mjs';

const rootMethods = new Set(['Target.createTarget', 'Target.attachToTarget', 'Target.getTargetInfo', 'Target.closeTarget', 'Target.getTargets']);
const pageMethods = new Set(['Page.enable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'DOM.enable', 'Accessibility.enable',
  'Runtime.enable', 'DOM.getDocument', 'DOM.describeNode', 'Accessibility.getPartialAXTree', 'DOM.resolveNode',
  'Runtime.callFunctionOn', 'Runtime.releaseObject', 'DOM.scrollIntoViewIfNeeded', 'Input.dispatchMouseEvent',
  'Input.insertText', 'Input.dispatchKeyEvent', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate',
  'Page.setInterceptFileChooserDialog']);
function strictPopup(source) {
  const prefix = `(${popupHook})('strict', `;
  try {
    if (!source?.startsWith(prefix) || !source.endsWith(')')) return false;
    const owner = JSON.parse(source.slice(prefix.length, -1));
    return typeof owner === 'string' && /^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/.test(owner) &&
      source === prefix + JSON.stringify(owner) + ')';
  } catch { return false; }
}

// Root wire framing is essential: Playwright's page CDPSession.send cannot route
// the attached session returned by Target.attachToTarget. This fixture sends the
// actual flattened child sessionId in every page command and forwards real events.
export async function connectRootCdp(endpoint, { WebSocketClass = globalThis.WebSocket, timeoutMs = 10000 } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      url.username || url.password || url.search || url.hash || typeof WebSocketClass !== 'function') throw Error('FIXTURE_ENDPOINT_DENIED');
  const socket = new WebSocketClass(url.href), pending = new Map(), listeners = new Set(), targets = new Set(), routes = new Set(), calls = [];
  let sequence = 0, closed = false;
  const lose = () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('FIXTURE_CDP_CLOSED')); }
    pending.clear();
  };
  socket.addEventListener('close', lose);
  socket.addEventListener('error', lose);
  socket.addEventListener('message', event => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { lose(); socket.close(); return; }
    if (frame.id !== undefined) {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id); clearTimeout(entry.timer);
      if (frame.sessionId !== entry.route) entry.reject(Error('FIXTURE_ROUTE_MISMATCH'));
      else if (frame.error) entry.reject(Error('FIXTURE_CDP_COMMAND_FAILED'));
      else entry.resolve(frame.result);
    } else if (typeof frame.method === 'string') {
      for (const listener of listeners) listener(frame);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('FIXTURE_CDP_OPEN_TIMEOUT')); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    for (const event of ['close', 'error']) socket.addEventListener(event, () => { clearTimeout(timer); reject(Error('FIXTURE_CDP_CLOSED')); }, { once: true });
  });
  return Object.freeze({ sessionId: 'root', calls,
    on(event, listener) { if (event !== 'event') throw Error('FIXTURE_EVENT_DENIED'); listeners.add(listener); },
    off(event, listener) { if (event !== 'event') throw Error('FIXTURE_EVENT_DENIED'); listeners.delete(listener); },
    async send(method, params = {}, route) {
      calls.push({ method, params: structuredClone(params), route });
      if (closed) throw Error('FIXTURE_CDP_CLOSED');
      if (route === undefined ? !rootMethods.has(method) : !pageMethods.has(method) || !routes.has(route)) throw Error('FIXTURE_COMMAND_DENIED');
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && (Object.keys(params).length !== 1 || !strictPopup(params.source)) ||
          method === 'Runtime.evaluate' && (Object.keys(params).length !== 3 || !strictPopup(params.expression) ||
            params.returnByValue !== true || params.awaitPromise !== false) ||
          method === 'Page.setInterceptFileChooserDialog' && (Object.keys(params).length !== 1 || params.enabled !== true)) throw Error('FIXTURE_COMMAND_DENIED');
      if (method === 'Target.createTarget' && (params.background !== true || !/^http:\/\/127\.0\.0\.1:\d+\/settings$/.test(params.url)) ||
          method === 'Target.attachToTarget' && (params.flatten !== true || !targets.has(params.targetId)) ||
          ['Target.getTargetInfo', 'Target.closeTarget'].includes(method) && !targets.has(params.targetId)) throw Error('FIXTURE_COMMAND_DENIED');
      const id = ++sequence;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('FIXTURE_CDP_COMMAND_TIMEOUT')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, route });
        try { socket.send(JSON.stringify({ id, method, params, ...(route === undefined ? {} : { sessionId: route }) })); }
        catch { pending.delete(id); clearTimeout(timer); reject(Error('FIXTURE_CDP_CLOSED')); }
      });
      if (method === 'Target.createTarget') targets.add(result.targetId);
      if (method === 'Target.attachToTarget') routes.add(result.sessionId);
      return result;
    },
    async close() { if (!closed) { lose(); socket.close(); } listeners.clear(); },
  });
}

export const sourceRoot = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');
const spec = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium');
export const executable = process.platform === 'darwin'
  ? join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-mac-' + process.arch,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  : join(homedir(), 'Library/Caches/ms-playwright', 'chromium-' + spec.revision, 'chrome-linux64/chrome');
export const realSkip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'opt-in real-page qualification belongs to sleight-arch'
  : !['darwin', 'linux'].includes(process.platform) || !existsSync(executable) ? 'the pinned Chromium executable is missing'
    : !['settings.html', 'common.js', 'style.css'].every(name => existsSync(join(sourceRoot, name))) ? 'the read-only FowlBrowser form source is missing'
      : typeof globalThis.WebSocket !== 'function' ? 'Node built-in WebSocket is missing' : false;

export async function realSettingsFixture() {
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-p4-headless-')), posts = [], sockets = new Set();
  let context, raw, closing;
  // Exact MIT FowlBrowser demo source, served read-only with its existing notices
  // retained in the cache. No runner, vendored copy, source edit or user profile.
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture.invalid').pathname;
      if (request.method === 'POST' && path === '/submit/settings') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) throw Error('FIXTURE_BODY_LIMIT'); }
        posts.push({ path, data: JSON.parse(body) });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'P4-INSTALLED' })); return;
      }
      const file = { '/settings': 'settings.html', '/common.js': 'common.js', '/style.css': 'style.css' }[path];
      if (request.method !== 'GET' || !file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' })
        .end(readFileSync(join(sourceRoot, file)));
    } catch { response.writeHead(400).end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      let browserError;
      try { await raw?.close(); } catch (error) { browserError = error; }
      // Always collect child closure even if the CDP socket itself failed.
      try { await context?.close(); } catch (error) { browserError = error; }
      const socketClosures = [...sockets].map(socket => new Promise(resolve => {
        socket.once('close', resolve); socket.destroy();
      }));
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(socketClosures);
      // On unproved child closure, retain the owned profile for the owner to inspect.
      if (browserError) throw Error('FIXTURE_BROWSER_CLOSE_UNPROVED');
      rmSync(profile, { recursive: true, force: true });
      return { browserClosed: true, profileDeleted: !existsSync(profile), socketsClosed: sockets.size === 0 };
    })();
    return closing;
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const packaged = loadPlaywrightCore({ turbo: true });
    context = await packaged.inprocess.playwright.chromium.launchPersistentContext(profile, { headless: true, executablePath: executable,
      viewport: { width: 1200, height: 900 }, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
    const active = join(profile, 'DevToolsActivePort'), deadline = Date.now() + 10000;
    while (!existsSync(active) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const [port, path] = readFileSync(active, 'utf8').trim().split('\n');
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error('FIXTURE_ENDPOINT_DENIED');
    raw = await connectRootCdp('ws://127.0.0.1:' + port + path);
    return { raw, posts, origin, profile, close };
  } catch (error) { await close(); throw error; }
}
