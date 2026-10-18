// One turbo app worker for bench/electron-qualification-live.mjs, forked with an IPC channel. It takes the installed worker's
// own path: connectAppHost with the secret its parent holds (the parent plays the MCP server, worker.mjs serverAppSecret),
// selectAppConnection, createAppTurn and createAppTurnRuntime, one consent instance for the worker's life. A worker serves
// many turns for one session, so a session grant from the user's one click covers every later turn on the same process.
// The debugger card appears in sleight's own consent window and only the user's click answers it; nothing here presses it.
// Grants go to a grant store in the run's temporary state folder, never the owner's. Engine approval is the benchmark
// allowlist (LAWS). Killing this process is the worker-loss cell; the app and its pipe belong to the resident host.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const D = '../plugins/sleight/lib/direct-browser/';
const load = name => import(new URL(D + name, import.meta.url));
const unavailable = { text: 'Turbo is unavailable for this turn. Use the engine browser path.', isError: true };
let base, turn;

// Once per worker: modules, the native UI, consent (observed, never answered) and the app's host.
async function setup(msg) {
  if (base) return base;
  const [runtimeMod, consentMod, hostMod, configMod, worldsMod, workerMod, contextMod] = await Promise.all(['electron-runtime.mjs', 'electron-consent.mjs', 'host.mjs',
    'installed-config.mjs', 'worlds.mjs', 'worker.mjs', 'v3-context.mjs'].map(load));
  const config = configMod.readInstalledConfig() ?? (() => { throw Error('TURBO_NOT_INSTALLED: run sleight-mcp turbo on first'); })();
  const built = await hostMod.prepareNativeHelpers({ inventory: config.receipt });
  if (built.status === 'unavailable') throw Error(built.code);
  const ui = hostMod.createNativeUi(built.receipt, () => {});
  const allow = new Set(msg.allowlist);
  const consentBase = consentMod.createElectronConsent({ ui, store: consentMod.createGrantStore({ path: join(msg.stateDir, 'grants.json'), keyPath: join(msg.stateDir, 'grant-seal.key') }),
    engineApproval: instance => (allow.has(instance.bundleId) ? 'approved' : 'unknown') });
  const card = {};
  // Observes the card; the reply still comes only from the native window's authenticated click.
  const consent = Object.create(consentBase, {
    grantFor: { value(...args) { const grant = consentBase.grantFor(...args); if (grant) Object.assign(card, { existing: true, status: 'granted', scope: grant.scope, by: 'existing' }); return grant; } },
    requestDebugger: { async value(...args) {
      const shownAt = performance.now(); card.shown = true;
      const result = await consentBase.requestDebugger(...args);
      Object.assign(card, { ms: Math.round(performance.now() - shownAt), status: result?.status === 'expired' ? 'timeout' : result?.status ?? 'refused',
        scope: result?.grant?.scope ?? null, by: result?.status === 'granted' ? 'user' : null });
      return result;
    } },
  });
  // The product's host path: this run's registry, state folder and temporary root, and the parent's secret. The benchmark's
  // own instance on a temporary profile (LAWS); the installed default is the user's own profile.
  const host = await runtimeMod.connectAppHost({ bundleId: msg.bundleId, secret: msg.appSecret, profile: 'temporary',
    dependencies: { registryPath: msg.registryPath, config: { tempRoot: msg.tempRoot, hostStateDir: () => msg.stateDir } } });
  base = { runtimeMod, workerMod, contextMod, ui, consent, card, host, receipts: new Map(), playwright: worldsMod.loadPlaywrightCore({ turbo: true }).inprocess.playwright };
  return base;
}

// One turn, as the installed worker's prepareApps composes it.
async function select(msg, b) {
  const id = 'turn-' + randomUUID();
  const connection = await b.runtimeMod.selectAppConnection({ bundleId: msg.bundleId, session: msg.session, turn: id, apps: msg.allowlist, ui: b.ui, consent: b.consent,
    registry: b.host.registry, admin: b.host.admin, playwright: b.playwright, windows: b.runtimeMod.runWindowHelper, profile: b.host.profile, receipts: b.receipts });
  const message = Object.freeze({ source: 'user', session: msg.session, turn: id, id, text: msg.text });
  const binding = b.contextMod.createV3TurnBinding(message, () => true);
  try {
    const surface = await b.runtimeMod.createAppTurn({ connections: [connection], binding, consent: b.consent, ui: b.ui });
    const runtime = await b.workerMod.createAppTurnRuntime({ surface, binding, ui: b.ui });
    return { id, session: msg.session, connection, surface, runtime };
  } catch (error) { await b.runtimeMod.releaseAppConnection(connection); b.consent.endTurn(msg.session, id); throw error; }
}

// The installed worker's collect for an app turn: the tool runtime, the pages, the connection, then the turn's once grants.
async function endTurn() {
  const current = turn; turn = undefined;
  if (!current) return { ended: true, cleanup: [] };
  const cleanup = [];
  try { cleanup.push(...(await current.runtime.end()).cleanup.filter(row => row.resource !== 'owned-tabs')); } catch { cleanup.push({ resource: 'v3-runtime', status: 'retained' }); }
  try { if ((await current.surface.pages.endTurn()).cleanedUp !== true) cleanup.push({ resource: 'owned-tabs', status: 'retained' }); } catch { cleanup.push({ resource: 'owned-tabs', status: 'retained' }); }
  cleanup.push(...await base.runtimeMod.releaseAppConnection(current.connection));
  try { base.consent.endTurn(current.session, current.id); } catch {}
  return { ended: true, cleanup };
}

const ops = {
  async start(msg) {
    const b = await setup(msg);
    await endTurn();
    for (const key of Object.keys(b.card)) delete b.card[key];
    Object.assign(b.card, { shown: false, existing: false, by: null, status: null, scope: null, ms: null });
    const started = performance.now();
    turn = await select(msg, b);
    const connectMs = Math.round(performance.now() - started);
    const { instance, provider, receipt } = turn.connection;
    return { card: { ...b.card }, identity: provider.identity && { pid: provider.identity.pid, pidBirth: provider.identity.birth, instance: provider.identity.instance, epoch: provider.identity.epoch },
      launch: { pid: instance.pid, pidBirth: instance.pidBirth, ms: null }, connectMs, receipt: receipt ?? null, hostPid: b.host.admin.pid ?? null };
  },
  // The installed worker's call: refuse unless the grant and the host channel still verify, then the dispatcher.
  async call(msg) {
    if (!turn) return { result: { text: 'Turbo is not connected. V3_WORKER_UNAVAILABLE', isError: true } };
    const { connection, runtime } = turn;
    try {
      if (!connection.grant.current() || await connection.provider.verifyConnection(connection.provider.session) !== true) return { result: unavailable };
      const result = await runtime.call({ name: msg.request.name, arguments: msg.request.arguments });
      if (!result.isError) runtime.delivered(result); // the harness reads every result, as the model does
      return { result: { text: result.text, isError: result.isError } };
    } catch { return { result: unavailable }; }
  },
  // Contention inside one server: other sessions over the same host channel. Each must refuse busy before any card.
  async contend(msg) {
    const b = await setup(msg), row = { busy: 0, other: 0, cards: 0 };
    for (let i = 0; i < msg.count; i++) {
      const saved = { ...b.card };
      b.card.shown = false;
      try { const extra = await select({ ...msg, session: 'v3' + randomUUID().replaceAll('-', '') }, b); await b.runtimeMod.releaseAppConnection(extra.connection); row.other++; }
      catch (error) { if (/ELECTRON_BUSY/.test(error.message)) row.busy++; else row.other++; }
      if (b.card.shown) row.cards++;
      Object.assign(b.card, saved);
    }
    return { row };
  },
  async revoke() { await base.host.admin.revoke({ session: turn.session }); return {}; },
  async resume() { await base.host.admin.resume(); return {}; },
  async status() {
    const s = await base.host.admin.status();
    return { status: { ownership: s?.ownership?.state ?? null, hostPid: base.host.admin.pid ?? null, broker: s?.broker?.state ?? null, workers: s?.workers ?? null } };
  },
  // After the app is gone: the host's own ownership recovery, with no launch and no card.
  async reconcile(msg) {
    const b = await setup(msg);
    const outcome = await b.host.admin.reconcile({}).catch(error => ({ resolved: false, reason: error.message }));
    return { resolved: outcome?.resolved === true, reason: outcome?.reason ?? null };
  },
  async receipt() { return { receipt: turn?.connection.receipt ?? null, recipe: turn && { zoomLevel: turn.connection.recipe.zoomLevel, joinTolerance: turn.connection.recipe.joinTolerance } }; },
  end: () => endTurn(),
};

process.on('message', async msg => {
  const reply = value => process.send?.({ id: msg.id, ...value });
  try { reply({ ok: true, ...await (ops[msg.op] ?? (() => { throw Error('UNKNOWN_OP'); }))(msg) }); }
  catch (error) { reply({ ok: false, error: String(error?.message ?? error).slice(0, 300), ...(base?.card.shown || base?.card.existing ? { card: { ...base.card } } : {}) }); }
});
process.on('disconnect', () => process.exit(0));
