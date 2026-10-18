// App target admission for an opted-in Electron app (EPV3-3). The graph comes only from the app's own
// pipe (electron-connection.mjs), whose identity must match the instance the user opted in. A target is a
// member when it is a top-level page of that pipe with an app document (a recipe file root or custom
// scheme) or a real HTTPS document. Membership lets sleight attach to read the target's geometry for the
// native join; only a grant (made after a unique join, electron-pages.mjs) lets the CDP filter own it.
// DevTools, workers, webviews, extensions and other schemes never get an attach. An opener ID is
// recorded and never consulted. Nothing imports this file in the installed path yet (EPV3-7 wires it).
import { appRecipe, documentKind } from './electron-identity.mjs';

const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const lifecycleTypes = new Set(['worker', 'service_worker', 'shared_worker', 'worklet', 'shared_storage_worklet', 'auction_worklet']);
const geometryKeys = ['height', 'scale', 'visible', 'width', 'x', 'y'];
// Read in an isolated world, so a page cannot replace these getters. Geometry and visibility only, no document content.
export const geometryExpression = `(() => ({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight,
  scale: window.devicePixelRatio, visible: document.visibilityState === 'visible' }))()`;

// One geometry read on a target session. send(method, params) is bound to that session; fenced() runs after every
// await and throws when the target changed. The page's main world never runs this expression.
export async function readIsolatedGeometry(send, fenced = () => {}) {
  const { frameTree } = await send('Page.getFrameTree', {}); fenced();
  if (!id(frameTree?.frame?.id)) fail('ELECTRON_GEOMETRY_INVALID');
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'sleight-geometry', grantUniveralAccess: false });
  fenced();
  if (!Number.isSafeInteger(executionContextId)) fail('ELECTRON_GEOMETRY_INVALID');
  const reply = await send('Runtime.evaluate', { expression: geometryExpression, contextId: executionContextId, returnByValue: true });
  fenced();
  const value = reply?.result?.value;
  if (reply?.exceptionDetails || !plain(value) || Object.keys(value).sort().join() !== geometryKeys.join() || typeof value.visible !== 'boolean' ||
      !['x', 'y', 'width', 'height', 'scale'].every(key => Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0 || value.scale <= 0)
    fail('ELECTRON_GEOMETRY_INVALID');
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height, scale: value.scale, visible: value.visible });
}

const checkedRecipes = new WeakSet();
const rulesOf = recipe => {
  if (checkedRecipes.has(recipe)) return recipe;
  const rules = appRecipe(recipe); checkedRecipes.add(rules); return rules;
};

export function classifyTarget(info, recipe) {
  const rules = rulesOf(recipe);
  if (!plain(info) || !id(info.targetId) || typeof info.type !== 'string') return Object.freeze({ kind: 'hidden', reason: 'malformed' });
  if (lifecycleTypes.has(info.type)) return Object.freeze({ kind: 'lifecycle', reason: info.type });
  if (info.type !== 'page') return Object.freeze({ kind: 'hidden', reason: 'type' });
  try { documentKind(String(info.url ?? ''), rules); } catch { return Object.freeze({ kind: 'hidden', reason: 'document' }); }
  return Object.freeze({ kind: 'member', reason: 'app-page' });
}

/** One mutation owner per app instance, so two sessions never interleave input on one native window.
 * The resident host must hold the shared instance (EPV3-7); a park stops every owner until resume. */
export function createInstanceFence() {
  let holder, parked;
  const owner = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID_FENCE_OWNER'); return value; };
  return Object.freeze({
    acquire(value) { owner(value); if (parked || holder !== undefined && holder !== value) return false; holder = value; return true; },
    release(value) { if (holder === owner(value)) holder = undefined; },
    holder: () => holder, parked: () => parked,
    park(reason) { parked = typeof reason === 'string' && reason ? reason : 'parked'; },
    resume() { parked = undefined; },
  });
}

export function createAppTargets({ upstream, identity, expected, recipe, verify, maxTargets = 64 } = {}) {
  if (!upstream || !['send', 'on', 'off'].every(name => typeof upstream[name] === 'function') || !plain(identity) || !plain(expected) ||
      typeof verify !== 'function' || !Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 1024) fail('ELECTRON_TARGETS_REQUIRED');
  const rules = rulesOf(recipe);
  const records = new Map(), grants = new Map(), privateSessions = new Map(), revokers = new Set();
  let sequence = 0, started = false, stopped = false, overflow = false;
  const sameInstance = () => identity.pid === expected.pid && identity.birth === expected.pidBirth;

  // Callers update the graph first, so a listener already sees the old epoch as dead.
  function revoke(targetId, record) {
    grants.delete(targetId);
    const session = privateSessions.get(targetId);
    if (session) {
      privateSessions.delete(targetId);
      session.pending.then(name => upstream.send('Target.detachFromTarget', { sessionId: name }).catch(() => {}), () => {});
    }
    if (record?.kind === 'member') for (const listener of [...revokers]) try { listener(targetId, record.epoch); } catch { /* one listener cannot stop the others */ }
  }
  function see(info) {
    const known = records.get(info.targetId);
    if (!known && records.size >= maxTargets) { overflow = true; return; }
    const verdict = classifyTarget(info, rules);
    const record = Object.freeze({ targetId: info.targetId, epoch: known?.epoch ?? ++sequence, kind: verdict.kind, reason: verdict.reason, type: info.type,
      url: verdict.kind === 'member' ? info.url : undefined, ...(id(info.openerId) ? { openerId: info.openerId } : {}) });
    // A navigation inside the app keeps the target; leaving the app's documents revokes it.
    records.set(info.targetId, record);
    if (known?.kind === 'member' && record.kind !== 'member') revoke(info.targetId, known);
  }
  function gone(targetId) {
    const record = records.get(targetId);
    if (!record) return;
    records.delete(targetId); revoke(targetId, record);
  }
  function event(frame) {
    if (!plain(frame) || frame.sessionId !== undefined || !plain(frame.params)) return;
    const { params } = frame;
    if (frame.method === 'Target.targetCreated' || frame.method === 'Target.targetInfoChanged') { if (plain(params.targetInfo) && id(params.targetInfo.targetId)) see(params.targetInfo); }
    else if (frame.method === 'Target.targetDestroyed' || frame.method === 'Target.targetCrashed') { if (id(params.targetId)) gone(params.targetId); }
    else if (frame.method === 'Target.detachedFromTarget' && id(params.sessionId)) {
      for (const [targetId, session] of privateSessions) if (session.name === params.sessionId) privateSessions.delete(targetId);
    }
  }
  const member = targetId => { const record = records.get(targetId); return record?.kind === 'member' ? record : undefined; };
  const current = (targetId, epoch) => !stopped && member(targetId)?.epoch === epoch;
  const live = async () => { if (stopped || !sameInstance() || await verify() !== true) fail('ELECTRON_IDENTITY_CHANGED'); };

  async function start() {
    if (started) fail('ELECTRON_TARGETS_STARTED');
    if (!sameInstance()) fail('ELECTRON_IDENTITY_CHANGED');
    await live();
    started = true;
    upstream.on('event', event);
    await upstream.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await upstream.send('Target.getTargets', {});
    // Events that arrived during the read are newer than the reply, so they win.
    for (const info of Array.isArray(targetInfos) ? targetInfos : []) if (plain(info) && id(info.targetId) && !records.has(info.targetId)) see(info);
  }
  // The host delivers a target's lifecycle events only to the client attached to it, so new windows and
  // windows that went away while nothing held them are found here.
  async function sync() {
    if (!started) fail('ELECTRON_TARGETS_REQUIRED');
    await live();
    const { targetInfos } = await upstream.send('Target.getTargets', {});
    if (stopped) fail('ELECTRON_IDENTITY_CHANGED');
    const seen = new Set();
    for (const info of Array.isArray(targetInfos) ? targetInfos : []) {
      if (!plain(info) || !id(info.targetId)) continue;
      seen.add(info.targetId);
      if (!records.has(info.targetId)) see(info);
    }
    for (const targetId of [...records.keys()]) if (!seen.has(targetId)) gone(targetId);
  }
  async function geometry(targetId) {
    const record = member(targetId);
    if (!started || !record) fail('ELECTRON_TARGET_NOT_MEMBER');
    await live();
    if (!current(targetId, record.epoch)) fail('ELECTRON_TARGET_CHANGED');
    // A private read session on a member, never shown to Playwright: the filter routes only its own attaches.
    let session = privateSessions.get(targetId);
    if (!session) {
      session = { pending: upstream.send('Target.attachToTarget', { targetId, flatten: true }).then(result => {
        if (!id(result?.sessionId)) fail('ELECTRON_TARGET_CHANGED'); session.name = result.sessionId; return result.sessionId; }) };
      privateSessions.set(targetId, session);
      session.pending.catch(() => { if (privateSessions.get(targetId) === session) privateSessions.delete(targetId); });
    }
    const name = await session.pending;
    const fenced = () => { if (!current(targetId, record.epoch)) fail('ELECTRON_TARGET_CHANGED'); };
    fenced();
    return readIsolatedGeometry((method, params) => upstream.send(method, params, name), fenced);
  }
  const filterHooks = Object.freeze({
    // The CDP filter asks before it owns a top-level target, and again after its own awaits.
    async admit(info) {
      const grant = plain(info) && grants.get(info.targetId);
      if (!grant || info.type !== 'page' || !current(info.targetId, grant.epoch)) return false;
      try { await live(); } catch { return false; }
      return grants.get(info.targetId) === grant && current(info.targetId, grant.epoch);
    },
    current: targetId => { const grant = grants.get(targetId); return !!grant && current(targetId, grant.epoch); },
  });
  return Object.freeze({
    start, sync, geometry, filterHooks, current, verify: live,
    record: targetId => records.get(targetId),
    members: () => [...records.values()].filter(row => row.kind === 'member'),
    lifecycle: () => [...records.values()].filter(row => row.kind === 'lifecycle').map(row => Object.freeze({ targetId: row.targetId, type: row.type, epoch: row.epoch })),
    overflow: () => overflow,
    grant(targetId, epoch, window) {
      if (!current(targetId, epoch)) fail('ELECTRON_TARGET_NOT_MEMBER');
      if (!plain(window) || Object.keys(window).sort().join() !== 'epoch,id' || !Number.isSafeInteger(window.id) || !Number.isSafeInteger(window.epoch)) fail('ELECTRON_JOIN_INVALID');
      grants.set(targetId, Object.freeze({ epoch, window: Object.freeze({ id: window.id, epoch: window.epoch }) }));
    },
    ungrant(targetId) { grants.delete(targetId); },
    granted(targetId) { const grant = grants.get(targetId); return grant && current(targetId, grant.epoch) ? { epoch: grant.epoch, window: { ...grant.window } } : undefined; },
    onRevoke(listener) { if (typeof listener !== 'function') fail('ELECTRON_TARGETS_REQUIRED'); revokers.add(listener); return () => revokers.delete(listener); },
    stop() {
      if (stopped) return;
      stopped = true; upstream.off('event', event);
      for (const targetId of [...privateSessions.keys()]) revoke(targetId);
      grants.clear();
    },
  });
}
