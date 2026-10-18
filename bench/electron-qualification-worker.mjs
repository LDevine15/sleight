// One turbo app worker for bench/electron-qualification-live.mjs, forked with an IPC channel. It composes the EPV3-4 to 7
// modules the way epv3-contracts.md has EPV3-7's worker branch compose them, and answers the five tools for one session.
// The debugger card appears in sleight's own consent window and only the user's click answers it; nothing here presses it.
// Grants go to a grant store in the run's temporary state folder, never the owner's. Engine approval is the benchmark
// allowlist (LAWS). Killing this process is the worker-loss cell; the app and its pipe belong to the resident host.
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const D = '../plugins/sleight/lib/direct-browser/';
const load = name => import(new URL(D + name, import.meta.url));
let runtime, connection, admin, sessionId;

async function start(msg) {
  const [runtimeMod, consentMod, recipesMod, readMod, handoffMod, windowsMod, adminMod, hostMod, configMod, worldsMod, workerMod, contextMod, snapshotMod, rulesMod, fillMod] =
    await Promise.all(['electron-runtime.mjs', 'electron-consent.mjs', 'electron-recipes.mjs', 'electron-read.mjs', 'electron-handoff.mjs',
      'electron-windows.mjs', 'electron-admin.mjs', 'host.mjs', 'installed-config.mjs', 'worlds.mjs', 'worker.mjs', 'v3-context.mjs',
      'snapshot.mjs', 'rules.mjs', 'fill.mjs'].map(load));
  sessionId = msg.session;
  const config = configMod.readInstalledConfig() ?? (() => { throw Error('TURBO_NOT_INSTALLED: run sleight-mcp turbo on first'); })();
  const built = await hostMod.prepareNativeHelpers({ inventory: config.receipt });
  if (built.status === 'unavailable') throw Error(built.code);
  const ui = hostMod.createNativeUi(built.receipt, () => {});
  const allow = new Set(msg.allowlist);
  const consentBase = consentMod.createElectronConsent({ ui, store: consentMod.createGrantStore({ path: join(msg.stateDir, 'grants.json'), keyPath: join(msg.stateDir, 'grant-seal.key') }),
    engineApproval: instance => (allow.has(instance.bundleId) ? 'approved' : 'unknown') });
  const card = { shown: false, existing: false, by: null, status: null, scope: null, ms: null };
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
  admin = await adminMod.ensureHost({ stateDir: msg.stateDir, registryPath: msg.registryPath, tempRoot: msg.tempRoot, build: msg.build, adminSecret: msg.adminSecret });
  const registry = recipesMod.readRecipeRegistry(msg.registryPath);
  const started = performance.now();
  connection = await runtimeMod.selectAppConnection({ bundleId: msg.bundleId, session: msg.session, turn: msg.turn, apps: msg.allowlist, ui, consent, registry, admin,
    playwright: worldsMod.loadPlaywrightCore({ turbo: true }).inprocess.playwright, windows: windowsMod });
  const connectMs = Math.round(performance.now() - started);
  const { instance, recipe, pages, provider, targets, grant } = connection;
  const runners = handoffMod.createAppRunners({ pages, invalidateRefs: snapshotMod.invalidateRefs, check: rulesMod.check, snapshot: snapshotMod.snapshot,
    inspectElement: fillMod.inspectElement });
  const message = Object.freeze({ source: 'user', session: msg.session, turn: msg.turn, id: msg.turn, text: msg.text });
  const binding = contextMod.createV3TurnBinding(message, () => true);
  runtime = await workerMod.createV3TurnRuntime({ binding, browser: provider.selectedBrowser, pages, ui,
    snapshot: readMod.createAppSnapshot({ snapshot: snapshotMod.snapshot, pages, app: { name: instance.name, version: instance.version, pid: instance.pid } }),
    dependencies: { runSteps: runners.runSteps, fillFields: runners.fillFields,
      createContext: () => runtimeMod.createAppContexts({ binding, consent, grant, instance, recipe, provider, targets, ui }) } });
  return { card, identity: provider.identity && { pid: provider.identity.pid, pidBirth: provider.identity.birth, instance: provider.identity.instance, epoch: provider.identity.epoch },
    launch: { pid: instance.pid, pidBirth: instance.pidBirth, ms: connection.launchMs ?? null }, connectMs, receipt: connection.receipt ?? null };
}

const ops = {
  start,
  async call(msg) {
    if (!runtime) return { result: { text: 'Turbo is not connected. V3_WORKER_UNAVAILABLE', isError: true } };
    const result = await runtime.call({ name: msg.request.name, arguments: msg.request.arguments });
    if (!result.isError) runtime.delivered(result); // the harness reads every result, as the model does
    return { result: { text: result.text, isError: result.isError } };
  },
  async revoke() { await admin.revoke({ session: sessionId }); return {}; },
  async resume() { await admin.resume(); return {}; },
  async status() { const s = await admin.status(); return { status: { ownership: s?.ownership ?? null, hostPid: s?.host?.pid ?? null, broker: s?.broker?.state ?? null } }; },
  async receipt() { return { receipt: connection?.receipt ?? null, recipe: connection && { zoomLevel: connection.recipe.zoomLevel, joinTolerance: connection.recipe.joinTolerance } }; },
  async end() { const receipt = await runtime?.end(); runtime = undefined; return { ended: true, cleanup: receipt?.cleanup ?? [] }; },
};

process.on('message', async msg => {
  const reply = value => process.send?.({ id: msg.id, ...value });
  try { reply({ ok: true, ...await (ops[msg.op] ?? (() => { throw Error('UNKNOWN_OP'); }))(msg) }); }
  catch (error) { reply({ ok: false, error: String(error?.message ?? error).slice(0, 300) }); }
});
process.on('disconnect', () => process.exit(0));
