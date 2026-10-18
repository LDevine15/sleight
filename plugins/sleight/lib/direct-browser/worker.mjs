import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInstalledConfig, acceptedInstalledPackage } from './installed-config.mjs';
import { browserTools, validateToolCall, createToolDispatcher } from './tools.mjs';
import { createV3TurnBinding, createV3Context } from './v3-context.mjs';
import { browserApplicationName } from './browsers.mjs';

const bridges = new WeakSet(), frontends = new WeakSet();
export const isV3Bridge = value => !!value && bridges.has(value);
export const isV3Frontend = value => !!value && frontends.has(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// The relay's engine app approvals this session, by bundle id. They decide nothing alone: an app also needs the
// operator's opt-in file and its own debugger grant before turbo touches it.
const bundleId = value => typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(value);
const approvedApps = value => Array.isArray(value) && value.length <= 64 && value.every(bundleId) && new Set(value).size === value.length;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unproved = () => ({ revoked: true, cleanup: [{ resource: 'v3-worker', status: 'retained', code: 'CLEANUP_UNPROVED' }] });
const failure = (unknown = false) => ({ text: unknown ? 'Input outcome is unconfirmed. Read state before retrying; use the engine browser path if needed.'
  : 'Turbo is unavailable for this turn. Use the engine browser path.', isError: !unknown });
// The model sees which application turbo selected, so a task naming it needs no engine search.
// The name comes only from the operator-owned config's executable path and a fixed list, never a page.
export const applicationName = browserApplicationName;
const unsafeStartup = new Set(['HOST_PACKAGE_MISMATCH', 'HOST_SOURCE_MISMATCH', 'HOST_CACHE_UNSAFE', 'INSTALLED_CONFIG_UNSAFE']);
// The admin secret of the resident Electron app hosts. The MCP server process makes it once and hands it to each worker
// it forks in the begin frames (IPC only, never argv, env or disk), so a new worker can still administer a host that
// an earlier worker of this server started. A host from an earlier server run stays foreign (docs/known-problems.md).
let appSecret;
export const serverAppSecret = () => (appSecret ??= randomBytes(32).toString('base64url'));
const validAppSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
const printableName = value => typeof value === 'string' && /^[^\x00-\x1f\x7f]{1,64}$/.test(value);
const foreignHost = name => { const app = printableName(name) ? name : 'The app';
  return { text: `${app} is held by an earlier sleight session's host, so turbo can't reach it. Quit the ${app} window sleight opened (the app's own Quit), then retry. Nothing was sent.`, isError: true }; };

export async function createV3Bridge({ startupTimeoutMs = 120000, timeoutMs = 31000 } = {}, dependencies = {}) {
  const config = (dependencies.readConfig ?? readInstalledConfig)();
  if (!config) return null;
  const accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config);
  if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH');
  if (![startupTimeoutMs, timeoutMs].every(n => Number.isInteger(n) && n > 0 && n <= 300000)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:NODE_|DYLD_|LD_)/.test(key)) delete env[key];
  const child = (dependencies.forkWorker ?? fork)(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [],
    { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
  let hello, active = false, lost = false, generation = 0, sequence = 0, ending;
  const pending = new Map(), turns = new Set(); let deliveries = new WeakMap(), resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => lose(), startupTimeoutMs);
  const current = () => { try { return accepted.current() === true; } catch { return false; } };
  function fence() { active = false; generation++; deliveries = new WeakMap(); }
  function lose(code = 'V3_WORKER_UNAVAILABLE') {
    if (lost) return;
    lost = true; fence(); clearTimeout(timer); rejectReady(Error(typeof code === 'string' ? code : 'V3_WORKER_UNAVAILABLE'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('V3_WORKER_UNAVAILABLE')); }
    pending.clear();
    try { if (child.connected) child.disconnect(); child.unref?.(); } catch {}
  }
  child.on('message', frame => {
    if (lost) return;
    if (!hello && exact(frame, ['version', 'status', 'code']) && frame.version === 3 && frame.status === 'unavailable') {
      lose(unsafeStartup.has(frame.code) ? frame.code : 'V3_RUNTIME_UNAVAILABLE'); return;
    }
    if (!hello && exact(frame, ['version', 'session', 'nonce', 'browser']) && frame.version === 3 && id(frame.session) &&
        /^[a-f0-9]{64}$/.test(frame.nonce) && /^b[A-Za-z0-9_-]{1,63}$/.test(frame.browser)) {
      hello = frame; clearTimeout(timer); resolveReady(); return;
    }
    if (!hello || !exact(frame, ['version', 'id', 'result']) || frame.version !== 3 || !pending.has(frame.id)) { lose(); return; }
    const entry = pending.get(frame.id); pending.delete(frame.id); clearTimeout(entry.timer); entry.resolve(frame.result);
  });
  child.on('error', lose); child.on('exit', lose); child.on('disconnect', lose);
  function rpc(method, params) {
    if (lost || !current() || pending.size >= 32) return Promise.reject(Error('V3_WORKER_UNAVAILABLE'));
    const frame = { version: 3, id: 'q' + (++sequence), method, params };
    if (Buffer.byteLength(JSON.stringify(frame)) > 131072) return Promise.reject(Error('INVALID_ARGUMENT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { lose(); reject(Error('V3_WORKER_UNAVAILABLE')); }, timeoutMs);
      pending.set(frame.id, { resolve, reject, timer });
      try { child.send(frame, error => { if (error) lose(); }); } catch { lose(); }
    });
  }
  await ready;
  if (!current()) { lose(); throw Error('HOST_PACKAGE_MISMATCH'); }
  function endTurn() {
    fence();
    if (!ending) ending = rpc('end', {}).catch(unproved).finally(() => { ending = undefined; });
    return ending;
  }
  const bridge = Object.freeze({ browser: hello.browser, application: applicationName(config.executable),
    bootstrapEnvelope: () => ({ version: 1, session: hello.session, nonce: hello.nonce }),
    tools: () => browserTools(hello.browser),
    // apps: the relay's own list of engine-approved bundle ids, never a field of the hook's frame.
    async bind(frame, apps = []) {
      if (!exact(frame, ['version', 'session', 'nonce', 'event', 'turn', 'text']) || frame.version !== 1 ||
          frame.session !== hello.session || frame.nonce !== hello.nonce || frame.event !== 'begin' || !id(frame.turn) ||
          typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536 || !approvedApps(apps) || turns.has(frame.turn) || lost || !current()) throw Error('TRUSTED_TURN_REQUIRED');
      turns.add(frame.turn); fence(); const epoch = generation;
      const result = await rpc('begin', { turn: frame.turn, text: frame.text, apps: [...apps], appSecret: serverAppSecret() });
      if (epoch !== generation || lost || !current()) return false;
      active = result?.available === true; return active;
    },
    async call(input) {
      let request;
      try { request = validateToolCall(input, hello.browser); } catch { return { text: 'Invalid turbo arguments. Use the documented five tool schemas.', isError: true }; }
      if (!active || lost || !current()) return failure();
      const epoch = generation;
      try {
        const reply = await rpc('call', request);
        if (!active || lost || epoch !== generation || !current()) return failure(request.name !== 'browser_read');
        if (!exact(reply, ['resultId', 'result']) || !id(reply.resultId) || !exact(reply.result, ['text', 'isError']) ||
            typeof reply.result.text !== 'string' || typeof reply.result.isError !== 'boolean' || reply.result.text.length > 100000) throw Error();
        const result = reply.result;
        if (!result.isError) deliveries.set(result, { id: reply.resultId, hash: hash(result), epoch });
        return result;
      } catch { lose(); return failure(request.name !== 'browser_read'); }
    },
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || !active || lost || !current() || record.epoch !== generation || record.hash !== hash(result)) return false;
      rpc('delivered', { resultId: record.id, hash: record.hash }).catch(() => {}); return true;
    },
    end: endTurn, endTurn,
    async detach() { const receipt = await endTurn(); lose(); return receipt; },
    async close() { fence(); try { return await rpc('close', {}); } catch { return unproved(); } finally { lose(); } },
  });
  bridges.add(bridge); return bridge;
}
export function createV3Frontend(bridge) {
  if (!isV3Bridge(bridge)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const frontend = Object.freeze({ browser: bridge.browser, application: bridge.application, tools: bridge.tools, call: bridge.call, delivered: bridge.delivered, end: bridge.endTurn });
  frontends.add(frontend); return frontend;
}

// The installed join supplies owned pages and snapshots. Only the worker begin
// binding supplies user authority; MCP arguments never reach this constructor.
export async function createV3TurnRuntime({ binding, browser, pages, snapshot, ui, endpoint, dependencies = {} }) {
  const [{ runSteps }, { fillFields }, { deliverSnapshot }] = await Promise.all([
    import('./act.mjs'), import('./fill.mjs'), import('./rules.mjs'),
  ]);
  const ctx = (dependencies.createContext ?? createV3Context)({ binding, browser, ui });
  const runtime = createToolDispatcher({ browser, pages, snapshot, ctx, endpoint,
    runSteps: dependencies.runSteps ?? runSteps, fillFields: dependencies.fillFields ?? fillFields,
    deliverSnapshot(state, capture) {
      if (capture.state !== state || !Number.isSafeInteger(capture.number) || capture.number < 1 ||
          !Number.isFinite(capture.capturedAt) || capture.capturedAt < 0) return false;
      if (dependencies.acknowledgeSnapshot && dependencies.acknowledgeSnapshot(capture.page, capture.number) !== true) return false;
      deliverSnapshot(state, capture);
      // V6's boolean means a submit fence was released, rather than whether
      // an ordinary snapshot was accepted. Both count as delivered text here.
      return true;
    } });
  return Object.freeze({ call: runtime.call, delivered: runtime.delivered,
    async end() { const cleanup = ctx.dispose(); const previous = await runtime.end();
      const receipt = { ...previous, cleanup: [...previous.cleanup] };
      if ((await cleanup).retained) receipt.cleanup.push({ resource: 'uploads', status: 'retained', code: 'CLEANUP_UNPROVED' });
      return receipt;
    },
  });
}

// Only an inherited fork channel reaches this entry. MCP calls carry tool JSON,
// while begin frames carry the relay hook's authenticated user message separately.
export function serveV3Worker({ channel, browser, begin, current = () => true, close = async () => ({ revoked: true, cleanup: [] }) }) {
  const session = 'v3' + randomBytes(16).toString('hex'), nonce = randomBytes(32).toString('hex');
  let runtime, generation = 0, work = Promise.resolve(), queued = 0, ended = false;
  const seen = new Set(), turns = new Set(), results = new Map();
  const lost = () => { ended = true; Promise.resolve(fence()).catch(() => {}); };
  const send = frame => {
    if (channel.connected === false) return;
    try { channel.send(frame, error => { if (error) lost(); }); } catch { lost(); }
  };
  function fence() { generation++; results.clear(); const old = runtime; runtime = undefined; return old?.end() ?? Promise.resolve({ revoked: true, cleanup: [] }); }
  channel.on('disconnect', () => { ended = true; Promise.resolve(fence()).catch(() => {}); });
  channel.on('message', frame => {
    if (ended) return;
    if (!exact(frame, ['version', 'id', 'method', 'params']) || frame.version !== 3 || !id(frame.id) || seen.has(frame.id) ||
        seen.size >= 65536 || Buffer.byteLength(JSON.stringify(frame)) > 131072) { ended = true; Promise.resolve(fence()).catch(() => {}); return; }
    seen.add(frame.id);
    const respond = result => send({ version: 3, id: frame.id, result });
    if (frame.method === 'end' || frame.method === 'close') {
      if (!exact(frame.params, [])) return respond(unproved());
      if (frame.method === 'close') ended = true;
      const stopped = fence();
      Promise.resolve(stopped).then(async receipt => {
        if (frame.method === 'close') { await work.catch(() => {}); return close(); }
        return receipt;
      }).then(respond, () => respond(unproved()));
      return;
    }
    if (frame.method === 'begin') {
      const keys = Object.hasOwn(frame.params ?? {}, 'appSecret') ? ['turn', 'text', 'apps', 'appSecret'] : ['turn', 'text', 'apps'];
      if (!exact(frame.params, keys) || !id(frame.params.turn) || turns.has(frame.params.turn) ||
          typeof frame.params.text !== 'string' || Buffer.byteLength(frame.params.text) > 65536 || !approvedApps(frame.params.apps)) return respond({ available: false });
      turns.add(frame.params.turn); const stopped = fence(), epoch = generation, apps = Object.freeze([...frame.params.apps]);
      const secret = validAppSecret(frame.params.appSecret) ? frame.params.appSecret : undefined;
      work = work.catch(() => {}).then(async () => {
        await stopped;
        if (ended || epoch !== generation || !current()) return { available: false };
        const message = Object.freeze({ source: 'user', session, turn: frame.params.turn, id: frame.params.turn, text: frame.params.text });
        const binding = createV3TurnBinding(message, () => !ended && epoch === generation && current());
        const prepared = await begin(message, binding, { apps, ...(secret ? { appSecret: secret } : {}) });
        if (ended || epoch !== generation || !current()) { await prepared?.end(); return { available: false }; }
        runtime = prepared; return { available: !!runtime };
      });
      work.then(respond, () => respond({ available: false })); return;
    }
    if (!['call', 'delivered'].includes(frame.method) || queued >= 32) return respond({ resultId: frame.id, result: failure() });
    const epoch = generation; queued++;
    const operation = work.catch(() => {}).then(async () => {
      if (!runtime || ended || epoch !== generation || !current()) return { resultId: frame.id, result: failure() };
      if (frame.method === 'delivered') {
        if (!exact(frame.params, ['resultId', 'hash'])) return false;
        const record = results.get(frame.params.resultId); results.delete(frame.params.resultId);
        return !!record && record.runtime === runtime && record.hash === frame.params.hash && record.hash === hash(record.result) && runtime.delivered(record.result) === true;
      }
      const request = validateToolCall(frame.params, browser), owner = runtime;
      const result = await owner.call(request);
      if (epoch !== generation || ended || runtime !== owner) return { resultId: frame.id, result: failure(request.name !== 'browser_read') };
      if (results.size >= 128) results.delete(results.keys().next().value);
      results.set(frame.id, { runtime: owner, result, hash: hash(result) });
      return { resultId: frame.id, result };
    });
    work = operation.catch(() => {});
    operation.then(respond, () => respond({ resultId: frame.id, result: failure() })).finally(() => { queued--; });
  });
  return Object.freeze({ ready: () => send({ version: 3, session, nonce, browser }), end: fence,
    drain: () => work.catch(() => {}) });
}

// The fixed installed entry owns native UI and the approved upstream connection.
// Dependency injection is a module-only test seam; IPC cannot choose a provider,
// endpoint, package, loader, authority or executable.
export async function startInstalledV3Worker({ channel }, dependencies = {}) {
  let parentLost = channel.connected === false, stopped = false, selected, ui, protocol, timer, unsubscribe;
  let accepted, connecting = false, retryConnection = false, connected = false, sequence = 0, closing, terminalLoss = false, resolveClosed, finalReceipt;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const resources = new Set();
  // Opted-in Electron apps (EPV3-7): this session's id at the resident hosts, the debugger consent, one admin
  // client per app host, qualification receipts and the latest begin frame's engine approvals.
  let appSession, appConsent, appConnected = false, turnApps = Object.freeze([]), hostSecret;
  const admins = new Map(), receipts = new Map();
  // admins: bundle id -> the pending { admin, registry, profile } of that app's resident host.
  const eachAdmin = action => Promise.allSettled([...admins.values()].map(async pending => action((await pending).admin)));
  const revokeApps = () => eachAdmin(admin => appSession && admin.revoke({ session: appSession }));
  const current = () => {
    try { return !parentLost && !stopped && accepted.current() === true; } catch { return false; }
  };
  const startupCurrent = () => { if (parentLost || channel.connected === false) throw Error('PARENT_GONE');
    if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH'); };
  const loss = () => { parentLost = true; terminalLoss = true; close().catch(() => {}); };
  channel.on('disconnect', loss);
  const retained = resource => ({ resource, status: 'retained', code: 'CLEANUP_UNPROVED' });
  async function collect(resource) {
    if (resource.collecting) return resource.collecting;
    resource.collecting = (async () => {
      const cleanup = [];
      if (resource.runtime) {
        const turn = await resource.runtime.end().catch(unproved);
        cleanup.push(...turn.cleanup.filter(row => row.resource !== 'owned-tabs'));
      }
      let tabs = true;
      try { if (resource.pages) tabs = (await resource.pages.endTurn()).cleanedUp === true; } catch { tabs = false; }
      if (!tabs) {
        cleanup.push(retained('owned-tabs'));
        if (!terminalLoss) return { revoked: true, cleanup };
      }
      let detached = true;
      try { if (resource.filter) detached = await resource.filter.dispose() === true; } catch { detached = false; }
      if (!detached) {
        cleanup.push(retained('cdp-filter'));
        if (!terminalLoss) return { revoked: true, cleanup };
      }
      try { await resource.browser?.close(); } catch { cleanup.push(retained('playwright-connection')); }
      try { await resource.listener?.close(); } catch { cleanup.push(retained('cdp-listener')); }
      if (resource.apps) {
        // Releases control and this worker's channels. The app, its windows and the host's pipe stay.
        const { releaseAppConnection } = await import('./electron-runtime.mjs');
        for (const connection of resource.apps) cleanup.push(...await releaseAppConnection(connection));
        try { if (resource.consentTurn) appConsent?.endTurn(resource.consentTurn.session, resource.consentTurn.turn); } catch {}
        if (!cleanup.length) appConnected = false;
      }
      if (!cleanup.length) resources.delete(resource);
      return { revoked: true, cleanup };
    })().finally(() => { resource.collecting = undefined; });
    return resource.collecting;
  }
  async function close() {
    stopped = true;
    if (finalReceipt) return finalReceipt;
    if (closing) return closing;
    closing = (async () => {
      await protocol?.end().catch(unproved);
      await protocol?.drain();
      const receipts = await Promise.all([...resources].map(collect));
      const cleanup = receipts.flatMap(receipt => receipt.cleanup);
      if (!cleanup.length || terminalLoss) {
        let disconnected = !selected;
        try { if (selected) disconnected = await selected.disconnect(selected.session) === true; } catch {}
        connected = false;
        if (!disconnected) cleanup.push(retained('browser-connection'));
        // The session ends at every app host: its grants and tickets go, and each host parks the app's connection.
        if (appSession) {
          try { appConsent?.revokeSession(appSession); } catch {}
          await revokeApps();
          await eachAdmin(admin => admin.close?.());
          admins.clear(); appConnected = false;
        }
      }
      if (!cleanup.length || terminalLoss) {
        finalReceipt = { revoked: true, cleanup };
        unsubscribe?.(); (dependencies.clearSchedule ?? clearInterval)(timer); ui?.close();
        channel.off('disconnect', loss);
        if (terminalLoss && channel.connected) channel.disconnect?.();
        resolveClosed(finalReceipt);
      }
      return { revoked: true, cleanup };
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function status() {
    if (!ui) return;
    const state = resources.size && (parentLost || stopped) ? 'cleanup-required' : stopped ? 'paused'
      : connected || appConnected ? parentLost ? 'connected-idle' : 'connected' : 'disconnected';
    ui.present('v3-control-' + (++sequence), { status: state }, state === 'cleanup-required' ? ['cleanup'] : ['pause','disconnect'], async event => {
      if (ui.authenticate(event) !== true) return;
      if (['disconnect','cleanup'].includes(event.action)) await close();
      else if (event.action === 'pause') { stopped = true; await protocol?.end(); await revokeApps(); status(); }
    }, { deadline: Date.now() + 300000 });
  }
  try {
    const config = (dependencies.readConfig ?? readInstalledConfig)();
    if (!config) throw Error('SETTING_OFF');
    accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config); startupCurrent();
    const host = await import('./host.mjs'); startupCurrent();
    const built = await (dependencies.prepareHelpers ?? host.prepareNativeHelpers)({ inventory: config.receipt }); startupCurrent();
    if (built.status !== 'ready') throw Error(built.code);
    const { createSelectedConnection } = await import('./selected-connection.mjs'); startupCurrent();
    selected = await (dependencies.selectConnection ?? createSelectedConnection)({ config, nativeReceipt: built.receipt }); startupCurrent();
    ui = (dependencies.createUi ?? host.createNativeUi)(built.receipt, () => { if (finalReceipt) return; terminalLoss = true; close().catch(() => {}); });
    startupCurrent();
    const browser = selected.selectedBrowser;
    // Which opted-in apps this turn is for: enabled in the operator's opt-in file and approved by the engine this session.
    // An unreadable or unsafe opt-in file leaves the browser path as it is.
    async function appSelections(apps) {
      if (!apps.length) return [];
      let optIns;
      try { optIns = await (dependencies.readAppOptIns ?? (await import('./electron-config.mjs')).readAppOptIns)(); }
      catch (error) { dependencies.onError?.(error); return []; }
      if (!optIns || typeof optIns.apps !== 'object' || !optIns.apps) return [];
      return Object.entries(optIns.apps).filter(([key, row]) => bundleId(key) && row?.enabled === true && apps.includes(key))
        .slice(0, 4).map(([key]) => ({ bundleId: key }));
    }
    function subscribe() {
      unsubscribe = selected.onConnectionLoss(() => {
        connected = false;
        if (!connecting && !stopped) { retryConnection = true; protocol?.end().catch(() => {}); }
      });
    }
    subscribe();
    protocol = serveV3Worker({ channel, browser: selected.selectedBrowser, current,
      async begin(message, binding, { apps = [], appSecret: secret } = {}) {
        if (!current() || resources.size) throw Error('CLEANUP_UNPROVED');
        turnApps = Object.freeze([...apps]);
        hostSecret ??= secret;
        const selections = await appSelections(apps);
        if (!current() || resources.size) throw Error('CLEANUP_UNPROVED');
        const resource = {}; resources.add(resource);
        let preparing, ending, turnEnded = false;
        // An opted-in app the engine approved this session takes this turn's tools; Chrome is not connected.
        async function prepareApps() {
          const runtimeModule = await import('./electron-runtime.mjs');
          const { loadPlaywrightCore } = await import('./worlds.mjs');
          const playwright = (dependencies.loadPlaywright ?? loadPlaywrightCore)({ turbo: true }).inprocess.playwright;
          const app = dependencies.app ?? {};
          appSession = message.session;
          appConsent ??= await (dependencies.createConsent ?? runtimeModule.createWorkerConsent)({ ui, approvedApps: () => turnApps, dependencies: app });
          resource.apps = []; resource.consentTurn = { session: message.session, turn: message.turn };
          for (const { bundleId } of selections) {
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            if (!admins.has(bundleId)) admins.set(bundleId, (dependencies.connectAppHost ?? runtimeModule.connectAppHost)({ bundleId, secret: hostSecret, dependencies: app }));
            let host;
            try { host = await admins.get(bundleId); } catch (error) { admins.delete(bundleId); throw error; }
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            resource.apps.push(await (dependencies.selectAppConnection ?? runtimeModule.selectAppConnection)({ bundleId, session: message.session, turn: message.turn,
              apps, ui, consent: appConsent, registry: host.registry, admin: host.admin, playwright, windows: dependencies.runWindows ?? runtimeModule.runWindowHelper,
              profile: host.profile, receipts, dependencies: app }));
          }
          if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
          const surface = await (dependencies.createAppTurn ?? runtimeModule.createAppTurn)({ connections: resource.apps, binding, consent: appConsent, ui, dependencies: app });
          resource.pages = surface.pages; appConnected = true;
          const runtime = await (dependencies.createRuntime ?? createV3TurnRuntime)({ binding, browser: selected.selectedBrowser, pages: surface.pages,
            snapshot: surface.snapshot, ui, endpoint: undefined, dependencies: { createContext: () => surface.context,
              runSteps: surface.runSteps, fillFields: surface.fillFields, acknowledgeSnapshot: surface.acknowledgeSnapshot } });
          resource.runtime = runtime;
          return runtime;
        }
        async function prepare() {
          try {
            if (selections.length) return await prepareApps();
            if (!connected) {
              connecting = true;
              try {
                if (retryConnection) {
                  unsubscribe?.();
                  selected = await (dependencies.selectConnection ?? createSelectedConnection)({ config, nativeReceipt: built.receipt });
                  if (selected.selectedBrowser !== browser) throw Error('STALE_INSTANCE');
                  subscribe(); retryConnection = false;
                }
                if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
                if (await selected.connect() !== selected.session) throw Error('STALE_INSTANCE');
                connected = true;
              } catch (error) {
                retryConnection = await selected.disconnect(selected.session).catch(() => false) === true;
                if (!retryConnection) stopped = true;
                throw error;
              } finally { connecting = false; }
            }
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            if (!current() || !await selected.verifyConnection(selected.session)) throw Error('STALE_INSTANCE');
            const { loadPlaywrightCore } = await import('./worlds.mjs');
            const playwright = (dependencies.loadPlaywright ?? loadPlaywrightCore)({ turbo: true }).inprocess.playwright;
            resource.filter = selected.createFilter();
            resource.listener = await resource.filter.listen();
            resource.browser = await playwright.chromium.connectOverCDP(resource.listener.endpoint, { noDefaults: true, timeout: 10000 });
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            const [{ createPageRegistry }, snapshots] = await Promise.all([import('./page.mjs'),
              dependencies.snapshot ? Promise.resolve({ snapshot: dependencies.snapshot }) : import('./snapshot.mjs')]);
            const session = await resource.browser.newBrowserCDPSession();
            resource.pages = (dependencies.createPages ?? createPageRegistry)({ browser: resource.browser, session,
              endpoint: selected.endpoint, endpointBlocked: resource.filter.endpointBlocked, upstream: selected.session, ownTarget: resource.filter.own, releaseTarget: resource.filter.release, frames: resource.filter.frames });
            const runtime = await (dependencies.createRuntime ?? createV3TurnRuntime)({ binding, browser: selected.selectedBrowser, pages: resource.pages,
              snapshot: snapshots.snapshot, ui, endpoint: selected.endpoint, dependencies: {
                // Acknowledgment is coupled to the exact output identity in the
                // fork protocol. Merely taking a snapshot never admits its refs.
                acknowledgeSnapshot: snapshots.acknowledgeSnapshot,
              } });
            resource.runtime = runtime;
            return runtime;
          } catch (error) { dependencies.onError?.(error); await collect(resource); throw error; }
        }
        async function verified() {
          if (!resource.apps) return selected.verifyConnection(selected.session);
          const checks = await Promise.all(resource.apps.map(async connection => connection.grant.current() &&
            await connection.provider.verifyConnection(connection.provider.session) === true));
          return checks.every(Boolean);
        }
        return Object.freeze({
          async call(request) {
            if (!current() || turnEnded) return failure();
            try {
              const runtime = await (preparing ??= prepare());
              if (!current() || turnEnded || !await verified()) throw Error('STALE_INSTANCE');
              return await runtime.call(request);
            } catch (error) { return error?.message === 'ELECTRON_HOST_FOREIGN' ? foreignHost(error.appName) : failure(); }
          },
          delivered: result => !turnEnded && resource.runtime?.delivered(result) === true,
          end() {
            turnEnded = true;
            if (!ending) ending = (async () => { await preparing?.catch(() => {}); return collect(resource); })();
            return ending;
          },
        });
      }, close });
    timer = (dependencies.schedule ?? setInterval)(() => {
      try { status(); } catch { terminalLoss = true; close().catch(() => {}); }
    }, 60000);
    status(); protocol.ready();
    return Object.freeze({ close, closed });
  } catch (error) {
    await close(); channel.off('disconnect', loss); throw error;
  }
}
async function installedMain() { return startInstalledV3Worker({ channel: process }); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.send) {
  installedMain().catch(error => { if (process.connected) {
    process.send({ version: 3, status: 'unavailable', code: unsafeStartup.has(error.message) ? error.message : 'V3_RUNTIME_UNAVAILABLE' });
    process.disconnect();
  } });
}
