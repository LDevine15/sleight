// Metadata-only join between an Electron app's renderers and its native windows (EPV3-3).
// readWindows is the trusted reader of the app's window metadata, used only after the engine approved
// the app (LAWS: accessibility metadata, never document content). Its schema has no title or any text:
// ids, epochs, owning PID and birth, frame, scale, on-screen, minimized and modal state. A renderer joins
// a window only when it is visible, the window belongs to the exact instance, frame and scale match, and
// the match is one to one. Anything else is hidden, ambiguous or parked, and parked means no input.
// Nothing imports this file in the installed path yet (EPV3-7 wires the reader and the join).
const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, wanted) => plain(value) && Object.keys(value).sort().join() === wanted;
const natural = value => Number.isSafeInteger(value) && value >= 1;
const frameKeys = 'height,width,x,y', windowKeys = 'epoch,frame,id,minimized,modal,onScreen,pid,pidBirth,scale';
const modalKinds = new Set(['sheet', 'dialog', 'menu', 'permission']);

function validFrame(frame) {
  return keys(frame, frameKeys) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame[key])) && frame.width > 0 && frame.height > 0;
}
function validSnapshot(snapshot) {
  if (!keys(snapshot, 'observedAt,windows') || !Number.isFinite(snapshot.observedAt) || !Array.isArray(snapshot.windows) || snapshot.windows.length > 256) return false;
  const ids = new Set();
  for (const row of snapshot.windows) {
    if (!keys(row, windowKeys) || !natural(row.id) || !natural(row.epoch) || !natural(row.pid) || typeof row.pidBirth !== 'string' || !row.pidBirth ||
        !validFrame(row.frame) || !(Number.isFinite(row.scale) && row.scale > 0) || typeof row.onScreen !== 'boolean' || typeof row.minimized !== 'boolean' ||
        row.modal !== false && !modalKinds.has(row.modal)) return false;
    const key = row.pid + ':' + row.id;
    if (ids.has(key)) return false;
    ids.add(key);
  }
  return true;
}
const close = (a, b, tolerance) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= tolerance);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });

/** Pure matching over one validated snapshot. candidates: [{ targetId, geometry }], geometry from electron-targets.geometry(). */
export function matchWindows({ app, snapshot, candidates, tolerance = 2 }) {
  const windows = snapshot.windows.filter(row => row.pid === app.pid && row.pidBirth === app.pidBirth);
  const usable = windows.filter(row => row.onScreen && !row.minimized);
  const matches = new Map(), uses = new Map();
  for (const { targetId, geometry } of candidates) {
    if (!geometry.visible) continue;
    const found = usable.filter(row => row.scale === geometry.scale && close(row.frame, geometry, tolerance));
    matches.set(targetId, found);
    for (const row of found) uses.set(row.id, (uses.get(row.id) ?? 0) + 1);
  }
  const out = new Map();
  for (const { targetId, geometry } of candidates) {
    const found = matches.get(targetId);
    if (!geometry.visible) out.set(targetId, result('hidden', { reason: 'not-visible' }));
    else if (!found.length) out.set(targetId, result('hidden', { reason: 'no-window' }));
    else if (found.length > 1 || uses.get(found[0].id) > 1) out.set(targetId, result('ambiguous'));
    else if (found[0].modal) out.set(targetId, result('parked', { reason: 'native-modal', window: Object.freeze({ id: found[0].id, epoch: found[0].epoch }) }));
    else out.set(targetId, result('joined', { window: Object.freeze({ id: found[0].id, epoch: found[0].epoch }) }));
  }
  return out;
}

export function createNativeJoin({ app, approved, readWindows, now = Date.now, maxAgeMs = 1500, tolerance = 2 } = {}) {
  if (!plain(app) || !natural(app.pid) || typeof app.pidBirth !== 'string' || typeof approved !== 'function' || typeof readWindows !== 'function' ||
      typeof now !== 'function' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(tolerance) || tolerance < 0) fail('ELECTRON_JOIN_REQUIRED');
  const listeners = new Set();
  let generation = 0, parked;
  const changed = reason => { generation++; for (const listener of [...listeners]) try { listener(reason); } catch { /* one listener cannot stop the others */ } };
  const everyone = (candidates, reason) => new Map(candidates.map(({ targetId }) => [targetId, result('parked', { reason })]));

  // One fresh, validated snapshot, or the reason there is none.
  async function snapshot() {
    if (parked) return { reason: parked };
    let allowed = false;
    try { allowed = approved() === true; } catch { /* no approval */ }
    if (!allowed) return { reason: 'engine-approval' };
    let value;
    try { value = await readWindows(); } catch { return { reason: 'native-metadata-unavailable' }; }
    if (parked) return { reason: parked };
    if (!validSnapshot(value)) return { reason: 'native-metadata-invalid' };
    const age = now() - value.observedAt;
    if (age > maxAgeMs || age < -maxAgeMs) return { reason: 'stale' };
    return { value };
  }
  async function resolve(candidates) {
    if (!Array.isArray(candidates)) fail('ELECTRON_JOIN_INVALID');
    const read = await snapshot();
    return read.value ? matchWindows({ app, snapshot: read.value, candidates, tolerance }) : everyone(candidates, read.reason);
  }
  // Before input: the target's geometry must still join exactly the window it was admitted with.
  async function check(targetId, admitted, geometry) {
    if (!keys(admitted, 'epoch,id') || !natural(admitted.id) || !natural(admitted.epoch) || !plain(geometry)) fail('ELECTRON_JOIN_INVALID');
    const start = generation;
    const row = (await resolve([{ targetId, geometry }])).get(targetId);
    if (generation !== start) fail('ELECTRON_JOIN_PARKED: native-change');
    if (row.status !== 'joined') fail('ELECTRON_JOIN_PARKED: ' + (row.reason ?? row.status));
    if (row.window.id !== admitted.id || row.window.epoch !== admitted.epoch) fail('ELECTRON_JOIN_CHANGED');
    return Object.freeze({ window: row.window });
  }
  return Object.freeze({
    resolve, check,
    generation: () => generation,
    parked: () => parked,
    // A native change the reader or host saw (a sheet, a moved window): every guard in flight fails.
    invalidate(reason = 'native-change') { changed(reason); },
    // The user took over, or the host paused: no join until resume().
    park(reason = 'parked') { parked = String(reason); changed(parked); },
    resume() { parked = undefined; changed('resume'); },
    onChange(listener) { if (typeof listener !== 'function') fail('ELECTRON_JOIN_REQUIRED'); listeners.add(listener); return () => listeners.delete(listener); },
  });
}
