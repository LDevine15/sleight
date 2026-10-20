// One turbo app worker for bench/electron-qualification-live.mjs, forked with an IPC channel. It takes the installed worker's
// own path: connectAppHost with the secret its parent holds (the parent plays the MCP server, worker.mjs serverAppSecret),
// selectAppConnection, createAppTurn and createAppTurnRuntime, one consent instance for the worker's life. A worker serves
// many turns for one session, so a session grant from the user's one click covers every later turn on the same process.
// The debugger card appears in sleight's own consent window and only the user's click answers it; nothing here presses it.
// Grants go to a grant store in the run's temporary state folder, never the owner's. Engine approval is the benchmark
// allowlist (LAWS). Killing this process is the worker-loss cell; the app and its pipe belong to the resident host.
// For the live runner (electron-live-runner.mjs): each card shown and answered is a line in msg.cardLog, so the person
// who clicks learns when the card is up and what to choose. msg.profile 'user' runs the relaunch flow on the runner's
// benchmark copy (msg.home names the profile identity). msg.rehost reconnects to the host after the host-loss cell.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CARD_TTL_MS, cardLine } from './electron-cards.mjs';
import { ensureHost as ensureQualificationHost } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { parkedReceipt } from '../plugins/sleight/lib/direct-browser/electron-host-reasons.mjs';

export const qualificationStatus = (s, hostPid) => ({ ownership: s?.ownership?.state ?? null, hostPid: hostPid ?? null,
  broker: s?.broker?.state ?? null, parked: parkedReceipt(s?.broker?.parked), workers: s?.workers ?? null });

const D = '../plugins/sleight/lib/direct-browser/';
const load = name => import(new URL(D + name, import.meta.url));
const unavailable = { text: 'Turbo is unavailable for this turn. Use the engine browser path.', isError: true };
let base, turn, cards = 0;
const cardStatus = status => status === 'expired' ? 'timeout' : status === 'approved' ? 'granted' : status ?? 'refused';

// Once per worker: modules, the native UI, consent (observed, never answered) and the app's host.
export async function prepareWorker(msg, { loadModule = load } = {}) {
  let stage = 'modules', ui;
  try {
    const [runtimeMod, consentMod, hostMod, configMod, worldsMod, workerMod, contextMod] = await Promise.all(['electron-runtime.mjs', 'electron-consent.mjs', 'host.mjs',
      'installed-config.mjs', 'worlds.mjs', 'worker.mjs', 'v3-context.mjs'].map(loadModule));
    stage = 'installed-config';
    const config = configMod.readInstalledConfig() ?? (() => { throw Error('TURBO_NOT_INSTALLED: run sleight-mcp turbo on first'); })();
    configMod.acceptedInstalledPackage(config);
    stage = 'native-helpers';
    const built = await hostMod.prepareNativeHelpers({ inventory: config.receipt });
    if (built.status === 'unavailable') throw Error(built.code);
    stage = 'consent-ui';
    ui = hostMod.createNativeUi(built.receipt, () => {});
    const allow = new Set(msg.allowlist);
    const consentBase = consentMod.createElectronConsent({ ui, store: consentMod.createGrantStore({ path: join(msg.stateDir, 'grants.json'), keyPath: join(msg.stateDir, 'grant-seal.key') }),
      engineApproval: instance => (allow.has(instance.bundleId) ? 'approved' : 'unknown') });
    const card = {}, relaunchCard = {};
    // Observes the cards; the reply still comes only from the native window's authenticated click.
    const watched = (kind, target, ask) => async (...args) => {
      const shownAt = performance.now(), id = `${process.pid}-${++cards}`, at = Date.now();
      target.shown = true;
      cardLine(msg.cardLog, { event: 'shown', id, kind, at, deadlineAt: at + CARD_TTL_MS, temporary: args[0]?.temporary === true, app: String(args[0]?.name ?? '') });
      const result = await ask(...args);
      Object.assign(target, { ms: Math.round(performance.now() - shownAt), status: cardStatus(result?.status),
        scope: result?.grant?.scope ?? null, by: ['granted', 'approved'].includes(result?.status) ? 'user' : null });
      cardLine(msg.cardLog, { event: 'answered', id, kind, at: Date.now(), status: target.status, scope: target.scope });
      return result;
    };
    const consent = Object.create(consentBase, {
      grantFor: { value(...args) { const grant = consentBase.grantFor(...args); if (grant) Object.assign(card, { existing: true, status: 'granted', scope: grant.scope, by: 'existing' }); return grant; } },
      requestDebugger: { value: watched('debugger', card, (...args) => consentBase.requestDebugger(...args)) },
      requestRelaunch: { value: watched('relaunch', relaunchCard, (...args) => consentBase.requestRelaunch(...args)) },
    });
    const prepared = { runtimeMod, workerMod, contextMod, ui, consent, card, relaunchCard, receipts: new Map(), memory: Object.freeze({ declined: new Set() }),
      playwright: worldsMod.loadPlaywrightCore({ turbo: true }).inprocess.playwright };
    stage = 'app-host';
    prepared.host = await connectHost(msg, runtimeMod);
    return prepared;
  } catch (error) {
    ui?.close();
    error.stage ??= stage;
    throw error;
  }
}
const setup = async msg => base ??= await prepareWorker(msg);

// A negative launch probe must not show a debugger card or start a replacement if EOF already ended the app.
export async function probeLaunch(admin, attempt) {
  // Run the real selection guard when unresolved. A free or reattached host stops before selection can ask for consent.
  const guarded = Object.freeze({ ...admin, async status() {
    const status = await admin.status(), state = status?.ownership?.state;
    if (!['free', 'unresolved', 'owned'].includes(state)) throw Error('ELECTRON_OWNERSHIP_UNKNOWN');
    if (state !== 'unresolved') throw Error('ELECTRON_OWNERSHIP_' + state.toUpperCase());
    return status;
  }, start() { throw Error('ELECTRON_PROBE_LAUNCH_REFUSED'); }, issue() { throw Error('ELECTRON_PROBE_LAUNCH_REFUSED'); } });
  try { await attempt(guarded); return { code: 'ELECTRON_PROBE_UNEXPECTED_SUCCESS', launched: false }; }
  catch (error) { return { code: /^[A-Z_]+$/.test(error.message) ? error.message : 'ELECTRON_PROBE_FAILED', launched: false }; }
}

// The product's host path: this run's registry, state folder and temporary root, and the parent's secret. The benchmark's
// own instance on a temporary profile (LAWS); with profile 'user', the runner's own benchmark copy on its own profile.
const connectHost = (msg, runtimeMod = base.runtimeMod) => runtimeMod.connectAppHost({ bundleId: msg.bundleId, secret: msg.appSecret, profile: msg.profile === 'user' ? 'user' : 'temporary',
  dependencies: { registryPath: msg.registryPath, config: { tempRoot: msg.tempRoot, hostStateDir: () => msg.stateDir }, ...(msg.home ? { home: msg.home } : {}),
    ensureHost: options => ensureQualificationHost({ ...options, ...(msg.python ? { python: msg.python } : {}), qualificationDiagnosticPath: msg.qualificationDiagnosticPath }) } });

// One turn, as the installed worker's prepareApps composes it.
async function select(msg, b) {
  const id = 'turn-' + randomUUID();
  const connection = await b.runtimeMod.selectAppConnection({ bundleId: msg.bundleId, session: msg.session, turn: id, apps: msg.allowlist, ui: b.ui, consent: b.consent,
    registry: b.host.registry, admin: b.host.admin, playwright: b.playwright, windows: b.runtimeMod.runWindowHelper, profile: b.host.profile, receipts: b.receipts,
    memory: b.memory });
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
  async 'probe-launch'(msg) {
    const b = await setup(msg);
    return { probe: await probeLaunch(b.host.admin, admin => select(msg, { ...b, host: { ...b.host, admin } })) };
  },
  async start(msg) {
    const b = await setup(msg);
    await endTurn();
    if (msg.rehost) b.host = await connectHost(msg);
    for (const target of [b.card, b.relaunchCard]) {
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, { shown: false, existing: false, by: null, status: null, scope: null, ms: null });
    }
    const started = performance.now();
    turn = await select(msg, b);
    const connectMs = Math.round(performance.now() - started);
    const { instance, provider, receipt } = turn.connection;
    return { card: { ...b.card }, identity: provider.identity && { pid: provider.identity.pid, pidBirth: provider.identity.birth, instance: provider.identity.instance, epoch: provider.identity.epoch },
      launch: { pid: instance.pid, pidBirth: instance.pidBirth, ms: null }, connectMs, receipt: receipt ?? null, hostPid: b.host.admin.pid ?? null,
      relaunchCard: { ...b.relaunchCard }, relaunch: turn.connection.relaunch ? { ...turn.connection.relaunch } : null };
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
  async revoke() { await base.host.admin.revoke({ session: turn.session, expected: true }); return {}; },
  // The indicator's Disconnect: the session's grants end here and at the host, which drops this session's channel and parks
  // the app's connection. The turn object stays, so the next call meets the grant and host checks, not a missing turn;
  // the next start releases it. Returns the host's own status once the channel is gone (or after 2 s).
  async disconnect() {
    if (!turn) throw Error('V3_WORKER_UNAVAILABLE');
    // Tag this deliberate park before local consent fires its duplicate host revoke hook.
    try { await base.host.admin.revoke({ session: turn.session, expected: true }); }
    finally { base.consent.revokeSession(turn.session); }
    let s = await base.host.admin.status();
    for (let i = 0; i < 20 && s?.workers?.length; i++) { await new Promise(resolve => setTimeout(resolve, 100)); s = await base.host.admin.status(); }
    return { status: s };
  },
  async resume() { await base.host.admin.resume(); return {}; },
  async status() {
    const s = await base.host.admin.status();
    return { status: qualificationStatus(s, base.host.admin.pid) };
  },
  // After the app is gone: the host's own ownership recovery, with no launch and no card.
  async reconcile(msg) {
    const b = await setup(msg);
    const outcome = await b.host.admin.reconcile({}).catch(error => ({ resolved: false, reason: error.message }));
    return { resolved: outcome?.resolved === true, reason: outcome?.reason ?? null };
  },
  // The host's own collect after the app exited (the user's Quit), then its status: ownership free means the record went.
  async collect() {
    await base.host.admin.collect?.().catch(() => {});
    const s = await base.host.admin.status();
    return { status: { ownership: s?.ownership?.state ?? null, broker: s?.broker?.state ?? null } };
  },
  async receipt() { return { receipt: turn?.connection.receipt ?? null, recipe: turn && { zoomLevel: turn.connection.recipe.zoomLevel, joinTolerance: turn.connection.recipe.joinTolerance } }; },
  end: () => endTurn(),
};

if (process.send) process.on('message', async msg => {
  const reply = value => process.send?.({ id: msg.id, ...value });
  try { reply({ ok: true, ...await (ops[msg.op] ?? (() => { throw Error('UNKNOWN_OP'); }))(msg) }); }
  catch (error) { reply({ ok: false, error: String(error?.message ?? error).slice(0, 300), stage: error.stage ?? 'app-select', ...(base?.card.shown || base?.card.existing ? { card: { ...base.card } } : {}),
    ...(base?.host?.admin?.pid ? { hostPid: base.host.admin.pid } : {}),
    ...(base?.relaunchCard.shown ? { relaunchCard: { ...base.relaunchCard } } : {}) }); }
});
if (process.send) process.on('disconnect', () => process.exit(0));
