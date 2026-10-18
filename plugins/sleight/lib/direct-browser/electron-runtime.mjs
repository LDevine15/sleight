// Wires an opted-in Electron app into the turbo worker (EPV3-7b): one app connection per approved,
// opted-in app, the v3 contexts bound to each native window, and the composite the five tools see.
// Nothing here takes a value from tool JSON or page text. The bundle id comes from the operator's opt-in
// file and the relay's engine approvals, the recipe from the reviewed registry, the process identity from
// the resident host, and the debugger grant from an authenticated click on sleight's own card.
// The worker never quits the app: it releases control, and the host keeps the app's pipe.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV3Context } from './v3-context.mjs';
import { UNLAUNCHED, appKey } from './electron-identity.mjs';
import { createAppProcesses, quitAndReopen, relaunchError, runningCopy } from './electron-relaunch.mjs';

const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
export const validBundleId = value => typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(value);
const retained = resource => ({ resource, status: 'retained', code: 'CLEANUP_UNPROVED' });
const hooked = new WeakSet(), released = new WeakMap();
// The parked reasons that mean the app's process ended (broker.mjs), as electron-host-run.mjs's exit rule reads them.
const APP_GONE = new Set(['child exited', 'pipe EOF']);

// After a launch, the windows the app restores on its own can appear a moment later. Waits for one joined window, at most timeoutMs.
async function waitForWindows(pages, timeoutMs, now = Date.now) {
  const started = now();
  for (;;) {
    let rows = [];
    try { rows = await pages.list(); } catch { /* the next pass decides */ }
    if (rows.some(row => row.status === 'joined') || now() - started >= timeoutMs) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

// Sibling modules other lanes own load at first use, so this file loads before they land.
async function pick(dependencies, key, module) {
  if (typeof dependencies[key] === 'function') return dependencies[key];
  let loaded;
  try { loaded = await import(`./${module}.mjs`); } catch { fail('ELECTRON_RUNTIME_UNAVAILABLE'); }
  if (typeof loaded[key] !== 'function') fail('ELECTRON_RUNTIME_UNAVAILABLE');
  return loaded[key];
}

// The window metadata helper (electron-windows.js), started per read; the reader caches for 250 ms.
const windowScript = fileURLToPath(new URL('./electron-windows.js', import.meta.url));
export function runWindowHelper(request, { run = execFile, script = windowScript, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(request)], { timeout: timeoutMs, maxBuffer: 1 << 20, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout) => error ? reject(Error('ELECTRON_WINDOWS_UNAVAILABLE')) : resolve(String(stdout)));
  });
}

/** The instance mutation fence, held by the resident host (its `fence` channel op). acquire() is synchronous for the page
 * registry, so it answers from the cached lease; renew() asks the host again and runs on each connection verify. */
export function createHostFence({ owner, op, now = Date.now, renewMs = 10000 } = {}) {
  if (typeof owner !== 'string' || !SESSION.test(owner) || typeof op !== 'function') fail('ELECTRON_FENCE_UNAVAILABLE');
  let lease = { held: false, until: 0, at: -Infinity }, ended = false, renewing;
  const drop = () => { lease = { held: false, until: 0, at: now() }; };
  const apply = reply => {
    if (!plain(reply) || typeof reply.held !== 'boolean' || !Number.isSafeInteger(reply.leaseMs) || reply.leaseMs < 1 || reply.leaseMs > 60000) { drop(); return; }
    const at = now();
    lease = { held: reply.held && reply.holder === owner, until: at + reply.leaseMs, at };
  };
  const fresh = () => lease.held && now() < lease.until && now() - lease.at < renewMs;
  async function renew(force = false) {
    if (ended) return false;
    if (!force && fresh()) return true;
    if (!renewing) {
      const run = (async () => {
        try { apply(await op('acquire')); } catch { drop(); }
        // A release that landed while the acquire was in flight gives the lease straight back.
        if (ended && lease.held) { drop(); await Promise.resolve().then(() => op('release')).catch(() => {}); }
      })();
      renewing = run; run.finally(() => { if (renewing === run) renewing = undefined; });
    }
    await renewing;
    return !ended && lease.held;
  }
  return Object.freeze({
    acquire: value => value === owner && !ended && lease.held && now() < lease.until,
    release(value) {
      if (value !== owner || ended) return;
      const held = lease.held; ended = true; drop();
      if (held) Promise.resolve().then(() => op('release')).catch(() => {});
    },
    renew,
    holder: () => !ended && lease.held && now() < lease.until ? owner : undefined,
  });
}

/** Releases one app connection's turn resources, in order, and never the app: pages (closing nothing), the filter, Playwright's
 * side of the transport, the target graph, the window reader and this worker's host channel. Repeating it is safe. */
export async function releaseAppConnection(parts) {
  if (!parts) return [];
  const done = released.get(parts) ?? new Set();
  released.set(parts, done);
  const cleanup = [];
  const step = async (resource, fn) => {
    if (done.has(resource)) return;
    try { if (await fn() !== false) { done.add(resource); return; } } catch {}
    cleanup.push(retained(resource));
  };
  if (parts.pages) await step('owned-tabs', async () => (await parts.pages.endTurn()).cleanedUp === true);
  try { parts.fence?.release(parts.session); } catch {}
  if (parts.filter) await step('cdp-filter', async () => await parts.filter.dispose() === true);
  if (parts.browser) await step('playwright-connection', async () => { await parts.browser.close(); });
  try { parts.targets?.stop(); } catch {}
  try { parts.reader?.close?.(); } catch {}
  if (parts.provider) await step('app-connection', async () => await parts.provider.disconnect(parts.provider.session) === true);
  return cleanup;
}

/** The connection for one opted-in app this turn (epv3-contracts.md, EPV3-7, steps 1 to 11). `profile` is the trusted
 * profile identity ({ path, temporary }) shared by the unlaunched and launched forms, so the grant can be adopted.
 * On the user's own profile (temporary false), a copy of the app the user is running without the pipe goes through the
 * relaunch flow (electron-relaunch.mjs) after the debugger grant; a benchmark's temporary profile never looks for one.
 * memory: this worker's { declined } Set of bundle ids whose relaunch card the user cancelled this session. */
export async function selectAppConnection({ bundleId, session, turn, apps, ui, consent, registry, admin, playwright, windows, profile, receipts, memory,
  quitWaitMs = 60000, restoreWaitMs = 15000, dependencies = {} } = {}) {
  if (!validBundleId(bundleId) || !SESSION.test(session ?? '') || typeof turn !== 'string' || !turn || !Array.isArray(apps) || !consent || !admin ||
      typeof windows !== 'function' || !plain(profile) || typeof profile.path !== 'string' || typeof profile.temporary !== 'boolean') fail('ELECTRON_CONNECTION_REQUIRED');
  void ui; // the debugger card goes through consent's own native channel
  const d = {
    recipeFor: await pick(dependencies, 'recipeFor', 'electron-recipes'),
    instanceFromRecipe: await pick(dependencies, 'instanceFromRecipe', 'electron-recipes'),
    createElectronConnection: await pick(dependencies, 'createElectronConnection', 'electron-connection'),
    createAppTargets: await pick(dependencies, 'createAppTargets', 'electron-targets'),
    createNativeJoin: await pick(dependencies, 'createNativeJoin', 'electron-native-join'),
    createAppPageRegistry: await pick(dependencies, 'createAppPageRegistry', 'electron-pages'),
    createWindowReader: await pick(dependencies, 'createWindowReader', 'electron-windows'),
    qualify: await pick(dependencies, 'qualify', 'electron-capabilities'),
    receiptCurrent: await pick(dependencies, 'receiptCurrent', 'electron-capabilities'),
    read: await pick(dependencies, 'snapshot', 'snapshot'),
  };
  // 1. The reviewed recipe, and the engine's own approval of this app this session.
  const recipe = d.recipeFor(registry, bundleId);
  if (recipe?.bundleId !== bundleId) fail('RECIPE_NOT_FOUND');
  const engineApproved = instance => apps.includes(instance.bundleId);
  if (!apps.includes(bundleId)) fail('ELECTRON_ENGINE_APPROVAL_REQUIRED');
  const form = { profile: profile.path, temporary: profile.temporary };
  const launchedFrom = status => d.instanceFromRecipe(recipe, { ...form, pid: status.broker.identity.pid, pidBirth: status.broker.identity.birth });
  const running = status => ['ready', 'parked'].includes(status?.broker?.state) && plain(status.broker.identity);
  // 2. The process the host already holds, or the build and profile before any process exists.
  let status = await admin.status();
  // Another session's worker is connected: busy now, before sleight's card asks the user for anything.
  if (Array.isArray(status?.workers) && status.workers.some(other => other !== session)) fail('ELECTRON_BUSY: another session is acting in this app; nothing was sent');
  // The app the host held has exited since (the user quit it): the host collects it first, so this turn starts afresh.
  if (status?.broker?.state === 'parked' && APP_GONE.has(status.broker.parked?.reason)) {
    await Promise.resolve().then(() => admin.collect()).catch(() => {});
    status = await admin.status();
  }
  // Nothing running and ownership not free: the launch would be refused, so no card asks for it.
  if (!running(status) && status?.ownership?.state !== 'free') fail('ELECTRON_OWNERSHIP_UNRESOLVED');
  // The user's own copy, running without the pipe. Another user's process, two processes or another build refuse here, before any card.
  let processes, copy;
  if (!running(status) && !profile.temporary) {
    if (memory?.declined?.has(bundleId)) throw relaunchError('ELECTRON_RELAUNCH_DECLINED', recipe.name);
    processes = dependencies.processes ?? createAppProcesses();
    copy = await runningCopy({ recipe, processes, uid: dependencies.uid ?? process.getuid() });
  }
  let instance = running(status) ? launchedFrom(status) : d.instanceFromRecipe(recipe, { ...form, pid: 0, pidBirth: UNLAUNCHED });
  // 3. The debugger grant: an existing one for this exact process, else sleight's own card.
  let grant = consent.grantFor(instance, { session, turn });
  if (!grant) {
    const answer = await consent.requestDebugger(instance, { session, turn });
    if (answer?.status !== 'granted' || !answer.grant) fail('ELECTRON_DEBUGGER_REQUIRED');
    grant = answer.grant;
  }
  // 4. One launch at most, only when nothing is owned; the grant then moves to the launched process once. The user's running
  // copy is reopened only through its relaunch card and its own Quit.
  let launchedNow = false, relaunched;
  if (!running(status)) {
    if (status?.ownership?.state !== 'free') fail('ELECTRON_OWNERSHIP_UNRESOLVED');
    if (copy) {
      const named = d.instanceFromRecipe(recipe, { ...form, pid: copy.pid, pidBirth: copy.birth });
      const reopened = await quitAndReopen({ recipe, copy, instance: named, session, turn, consent, admin, processes, uid: dependencies.uid ?? process.getuid(),
        quitWaitMs, declined: memory?.declined });
      status = reopened.status;
      relaunched = { quitMs: reopened.quitMs, launchMs: reopened.launchMs, wasFront: reopened.wasFront };
    } else {
      await admin.start({ build: recipe.build, ...(profile.temporary ? {} : { profile: 'user' }) });
      status = await admin.status();
    }
    if (status?.broker?.state !== 'ready' || !plain(status.broker.identity)) fail('ELECTRON_APP_UNAVAILABLE');
    const launched = launchedFrom(status);
    consent.adopt(grant, launched);
    instance = launched; launchedNow = true;
  } else if (status.broker.state === 'parked') {
    // A revoked once grant or a pause parked the connection; the host resumes it only for the same process.
    await admin.resume();
    status = await admin.status();
    if (status?.broker?.state !== 'ready' || status.broker.identity?.pid !== instance.pid || status.broker.identity?.birth !== instance.pidBirth) fail('ELECTRON_PARKED');
  }
  if (!grant.current()) fail('ELECTRON_DEBUGGER_REQUIRED');
  // Revoking the grant stops this session's commands at the host. The pipe stays open.
  if (!hooked.has(grant)) {
    hooked.add(grant);
    grant.onRevoke(() => { Promise.resolve().then(() => admin.revoke({ session })).catch(() => {}); });
  }
  const parts = { session };
  try {
    // 5. This session's ticket, and the channel to the host.
    const handle = await admin.issue({ session });
    parts.provider = await d.createElectronConnection({ handle });
    await parts.provider.connect();
    const identity = parts.provider.identity;
    if (identity?.pid !== instance.pid || identity.birth !== instance.pidBirth) fail('ELECTRON_IDENTITY_CHANGED');
    const expected = Object.freeze({ pid: instance.pid, pidBirth: instance.pidBirth });
    const fenceOp = dependencies.fenceOp ?? (typeof parts.provider.fence === 'function' ? action => parts.provider.fence(action) : undefined);
    if (typeof fenceOp !== 'function') fail('ELECTRON_FENCE_UNAVAILABLE');
    const fence = parts.fence = createHostFence({ owner: session, op: fenceOp });
    const verify = async () => {
      if (!grant.current() || await parts.provider.verifyConnection(parts.provider.session) !== true) return false;
      await fence.renew();
      return true;
    };
    // 6. The app's own targets, admitted against the exact process.
    const rules = Object.freeze({ schemes: [...recipe.schemes], fileRoots: [...recipe.fileRoots] });
    parts.targets = d.createAppTargets({ upstream: parts.provider.session, identity, expected, recipe: rules, verify });
    await parts.targets.start();
    // 7. Playwright over the in-process filter transport. No listener, no port.
    parts.filter = parts.provider.createFilter({ app: parts.targets.filterHooks });
    parts.browser = await parts.filter.connectPlaywright(playwright);
    // 8. Window metadata for this PID only, used while the engine's approval stands.
    parts.reader = d.createWindowReader({ pid: instance.pid, pidBirth: instance.pidBirth, run: windows });
    parts.join = d.createNativeJoin({ app: expected, approved: () => engineApproved(instance) && grant.current(), readWindows: () => parts.reader.read(),
      tolerance: recipe.joinTolerance });
    // 9. The host's fence lease, cached for the registry's synchronous check.
    await fence.renew();
    // 10. The app's existing renderers, seeded; nothing is created.
    parts.pages = d.createAppPageRegistry({ browser: parts.browser, filter: parts.filter, targets: parts.targets, join: parts.join, fence, owner: session });
    await parts.pages.seed();
    if (launchedNow) await waitForWindows(parts.pages, restoreWaitMs);
    // Whether macOS brought the reopened app forward. Recorded only: sleight never activates or hides anything to undo it.
    if (relaunched) relaunched.activated = await processes.front().catch(() => null) === instance.pid;
    // 11. A dry run of this path on this process, unless a current receipt says it already passed. A receipt authorizes nothing.
    let receipt = receipts?.get(bundleId);
    if (!receipt || d.receiptCurrent(receipt, identity, recipe) !== true) {
      receipt = await d.qualify({ provider: parts.provider, targets: parts.targets, join: parts.join, pages: parts.pages, read: d.read, windows: parts.reader, recipe });
      receipts?.set(bundleId, receipt);
    }
    if (receipt?.qualified !== true) fail('ELECTRON_UNQUALIFIED');
    return Object.freeze({ ...parts, grant, instance, recipe, receipt, turn, ...(relaunched ? { relaunch: Object.freeze(relaunched) } : {}) });
  } catch (error) {
    await releaseAppConnection(parts);
    throw error;
  }
}

/** One v3 context per native window (id and epoch), each bound to the debugger grant, the exact process and that window. */
export function createAppContexts({ binding, consent, grant, instance, recipe, provider, targets, ui, createContext = createV3Context } = {}) {
  if (typeof consent?.bindApp !== 'function' || typeof targets?.current !== 'function' || typeof createContext !== 'function') fail('TRUSTED_TURN_REQUIRED');
  const cache = new Map();
  let disposed = false;
  const contexts = entry => {
    if (disposed || !plain(entry?.window)) fail('TRUSTED_TURN_REQUIRED');
    const key = entry.window.id + ':' + entry.window.epoch;
    let context = cache.get(key);
    if (!context) {
      const { targetId, epoch } = entry;
      const app = consent.bindApp({ grant, instance, window: { id: entry.window.id, epoch: entry.window.epoch }, brokerEpoch: provider.identity.epoch,
        recipe: { schemes: [...recipe.schemes], fileRoots: [...recipe.fileRoots] }, verify: () => targets.current(targetId, epoch) === true });
      context = createContext({ binding, app, ui });
      cache.set(key, context);
    }
    return context;
  };
  contexts.dispose = async () => {
    disposed = true;
    const receipts = await Promise.allSettled([...cache.values()].map(context => context.dispose()));
    cache.clear();
    return { retained: receipts.reduce((sum, row) => sum + (row.status === 'fulfilled' ? Number(row.value?.retained) || 0 : 1), 0) };
  };
  return contexts;
}

// The trusted list label: the registry's app name, the native window number and the join state. Never page text.
const labelOf = (connection, row) => `${connection.recipe.name} window ${row.window.id}` +
  (row.status === 'parked' ? `, parked: ${row.reason}` : '') + (row.renderer === 'hidden' ? ', renderer hidden' : '');

/** What the tool dispatcher sees for this turn's apps: one page registry, snapshot, runner pair and context function that
 * route by the tab's own app. Reads take the registry's read path; the handoff runners fence each mutation themselves. */
export function composeAppTurn(apps) {
  if (!Array.isArray(apps) || !apps.length) fail('ELECTRON_CONNECTION_REQUIRED');
  const tabs = new Map(), owners = new WeakMap(), byPage = new WeakMap();
  const ownerOf = id => { const app = tabs.get(id); if (!app) fail('unknown or released app page'); return app; };
  const unsent = async run => { try { return await run(); } catch (error) { error.notRun = true; throw error; } };
  const entryOwner = entry => { const app = owners.get(entry); if (!app) fail('unknown or released app page'); return app; };
  const pages = Object.freeze({
    async list() {
      const rows = [];
      for (const app of apps) for (const row of await app.connection.pages.list()) { tabs.set(row.tab, app); rows.push({ ...row, label: labelOf(app.connection, row) }); }
      return rows;
    },
    tab: id => ownerOf(id).connection.pages.tab(id),
    enqueue(id, run) {
      const app = ownerOf(id);
      return app.connection.pages.enqueue(id, entry => { owners.set(entry, app); byPage.set(entry.page, app); return run(entry); }, { mutation: false });
    },
    // Opening and closing app windows is the app's own: the registry refuses both before anything is sent.
    openTab: options => unsent(() => apps[0].connection.pages.openTab(options)),
    close: id => unsent(() => ownerOf(id).connection.pages.close(id)),
    keep: id => ownerOf(id).connection.pages.keep(id),
    handoff: id => ownerOf(id).connection.pages.handoff(id),
    closedOpener: () => undefined,
    async endTurn() {
      const results = await Promise.allSettled(apps.map(app => app.connection.pages.endTurn()));
      return { cleanedUp: results.every(row => row.status === 'fulfilled' && row.value?.cleanedUp === true),
        rows: results.flatMap(row => row.status === 'fulfilled' ? row.value?.rows ?? [] : []) };
    },
  });
  const context = entry => entryOwner(entry).contexts(entry);
  context.dispose = async () => {
    const receipts = await Promise.allSettled(apps.map(app => app.contexts.dispose()));
    return { retained: receipts.reduce((sum, row) => sum + (row.status === 'fulfilled' ? Number(row.value?.retained) || 0 : 1), 0) };
  };
  const pageOwner = page => { const app = byPage.get(page); if (!app) fail('ELECTRON_PAGE_UNKNOWN'); return app; };
  return Object.freeze({ pages, context,
    // The handoff runners' read records the join each capture was taken at; their acknowledgment marks it delivered.
    snapshot: (page, options) => pageOwner(page).runners.read(page, options),
    acknowledgeSnapshot(page, number) { const app = byPage.get(page); return !!app && app.runners.acknowledgeSnapshot(page, number) === true; },
    runSteps: (entry, steps, ctx) => entryOwner(entry).runners.runSteps(entry, steps, ctx),
    fillFields: (entry, fields, options, ctx) => entryOwner(entry).runners.fillFields(entry, fields, options, ctx),
  });
}

/** The turn's tool surface over every selected app connection: EPV3-4's header read (through EPV3-5's read, which records
 * the join of each capture), EPV3-5's fenced runners, one context per window. */
export async function createAppTurn({ connections, binding, consent, ui, dependencies = {} } = {}) {
  const createAppSnapshot = await pick(dependencies, 'createAppSnapshot', 'electron-read');
  const createAppRunners = await pick(dependencies, 'createAppRunners', 'electron-handoff');
  const invalidateRefs = await pick(dependencies, 'invalidateRefs', 'snapshot');
  const base = await pick(dependencies, 'snapshot', 'snapshot'), acknowledgeSnapshot = await pick(dependencies, 'acknowledgeSnapshot', 'snapshot');
  const check = await pick(dependencies, 'check', 'rules'), inspectElement = await pick(dependencies, 'inspectElement', 'rules');
  // The ghost hand over the app's windows, as over the browser's (hand/browser-hand.mjs). A missing module means no hand.
  const hand = Object.hasOwn(dependencies, 'hand') ? dependencies.hand : await import('../hand/browser-hand.mjs').then(m => m.sharedBrowserHand(), () => undefined);
  return composeAppTurn(connections.map(connection => {
    const snapshot = createAppSnapshot({ snapshot: base, pages: connection.pages, targets: connection.targets,
      app: { name: connection.instance.name, version: connection.instance.version, pid: connection.instance.pid } });
    const runners = createAppRunners({ pages: connection.pages, invalidateRefs, check, snapshot, inspectElement, acknowledgeSnapshot, hand });
    const contexts = createAppContexts({ binding, consent, grant: connection.grant, instance: connection.instance, recipe: connection.recipe,
      provider: connection.provider, targets: connection.targets, ui, ...(dependencies.createContext ? { createContext: dependencies.createContext } : {}) });
    return { connection, snapshot, runners, contexts };
  }));
}

// --- Installed defaults (7a's config, admin client and registry; loaded only on an opted-in app's turn) ---
const value = item => typeof item === 'function' ? item() : item;
export const registryPath = fileURLToPath(new URL('./electron/recipes.json', import.meta.url));

/** The worker's debugger consent: sleight's own native card, Always records in the operator's sealed store,
 * and the engine's approval read from the relay's begin frames (`approvedApps()`). */
export async function createWorkerConsent({ ui, approvedApps, dependencies = {} } = {}) {
  const { createElectronConsent, createGrantStore } = await import('./electron-consent.mjs');
  const grantStorePath = dependencies.grantStorePath ?? value((await import('./electron-config.mjs')).grantStorePath);
  return createElectronConsent({ ui, store: createGrantStore({ path: grantStorePath }),
    engineApproval: instance => approvedApps().includes(instance.bundleId) ? 'approved' : 'unknown' });
}

/** The registry recipe, the profile identity and an admin client to this app's own resident host (started if needed).
 * secret: the MCP server's admin secret (worker.mjs serverAppSecret), so every worker of one server reaches the same host.
 * A host started under another secret is ELECTRON_HOST_FOREIGN, carrying the registry's app name for the user's message.
 * profile: 'user', the default, is the user's own app and profile (the relaunch flow); 'temporary' is a separate instance on
 * a temporary profile, which LAWS keeps for benchmarks. The two never share a host. */
export async function connectAppHost({ bundleId, secret, profile: mode = 'user', dependencies = {} } = {}) {
  if (mode !== 'user' && mode !== 'temporary') fail('ELECTRON_CONNECTION_REQUIRED');
  const readRecipeRegistry = await pick(dependencies, 'readRecipeRegistry', 'electron-recipes');
  const recipeFor = await pick(dependencies, 'recipeFor', 'electron-recipes');
  const instanceFromRecipe = await pick(dependencies, 'instanceFromRecipe', 'electron-recipes');
  const userProfileFor = await pick(dependencies, 'userProfileFor', 'electron-recipes');
  const ensureHost = await pick(dependencies, 'ensureHost', 'electron-admin');
  const config = dependencies.config ?? await import('./electron-config.mjs');
  const path = dependencies.registryPath ?? registryPath;
  const registry = readRecipeRegistry(path), recipe = recipeFor(registry, bundleId);
  const tempRoot = value(config.tempRoot);
  let profile;
  if (mode === 'temporary') profile = Object.freeze({ path: join(tempRoot, bundleId), temporary: true });
  else {
    try { profile = userProfileFor(recipe, ...(dependencies.home ? [dependencies.home] : [])); }
    catch { throw relaunchError('ELECTRON_USER_PROFILE_UNSUPPORTED', recipe.name); }
  }
  const key = appKey(instanceFromRecipe(recipe, { profile: profile.path, temporary: profile.temporary, pid: 0, pidBirth: UNLAUNCHED }));
  let admin;
  try { admin = await ensureHost({ stateDir: config.hostStateDir(key), registryPath: path, tempRoot, build: recipe.build, secret }); }
  catch (error) { if (error?.message === 'ELECTRON_HOST_FOREIGN') error.appName = recipe.name; throw error; }
  return Object.freeze({ admin, registry, profile });
}
