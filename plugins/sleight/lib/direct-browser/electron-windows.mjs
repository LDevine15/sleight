// The native window reader for one Electron app instance (EPV3-6): the JS side of electron-windows.js. run(request)
// is the plugin's lazy JXA helper runner (EPV3-7 supplies it). The reply must match the content-free schema exactly,
// so a title, URL or any other key refuses it, and the process must still have the birth the pipe reported.
// Each CG window number gets an epoch the first time this reader sees it, kept for the reader's lifetime.
// Output is electron-native-join's WindowSnapshot.
const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, wanted) => plain(value) && Object.keys(value).sort().join() === wanted;
const natural = value => Number.isSafeInteger(value) && value >= 1;
const modalKinds = new Set([false, 'sheet', 'dialog', 'menu', 'permission']);
const MAX_WINDOWS = 64, MAX_EPOCHS = 4096;

function rowsOf(reply, pid) {
  if (!keys(reply, 'observedAt,processStart,status,windows') || !Number.isFinite(reply.observedAt) ||
      reply.processStart !== null && typeof reply.processStart !== 'string' || !Array.isArray(reply.windows) || reply.windows.length > MAX_WINDOWS) fail('ELECTRON_WINDOWS_INVALID');
  const ids = new Set();
  for (const row of reply.windows) {
    if (!keys(row, 'frame,id,minimized,modal,onScreen,pid,scale') || !natural(row.id) || row.pid !== pid || ids.has(row.id) ||
        !keys(row.frame, 'height,width,x,y') || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(row.frame[key])) || row.frame.width <= 0 || row.frame.height <= 0 ||
        !Number.isFinite(row.scale) || row.scale <= 0 || typeof row.onScreen !== 'boolean' || typeof row.minimized !== 'boolean' || !modalKinds.has(row.modal)) fail('ELECTRON_WINDOWS_INVALID');
    ids.add(row.id);
  }
  return reply.windows;
}

export function createWindowReader({ pid, pidBirth, run, cacheMs = 250, now = Date.now } = {}) {
  if (!natural(pid) || typeof pidBirth !== 'string' || !pidBirth || pidBirth.length > 64 || typeof run !== 'function' ||
      !Number.isFinite(cacheMs) || cacheMs < 0 || cacheMs > 5000 || typeof now !== 'function') fail('ELECTRON_WINDOWS_REQUIRED');
  const epochs = new Map();
  let closed = false, cached, inflight;

  async function fetch() {
    let text;
    try { text = await run({ pid, pidBirth }); } catch { fail(closed ? 'ELECTRON_WINDOWS_CLOSED' : 'ELECTRON_WINDOWS_UNAVAILABLE'); }
    if (closed) fail('ELECTRON_WINDOWS_CLOSED');
    let reply;
    try { if (typeof text !== 'string' || text.length > 1048576) throw Error(); reply = JSON.parse(text); } catch { fail('ELECTRON_WINDOWS_INVALID'); }
    if (keys(reply, 'status') && reply.status === 'denied') fail('ELECTRON_WINDOWS_DENIED');
    if (keys(reply, 'message,status') && reply.status === 'error' && typeof reply.message === 'string') fail('ELECTRON_WINDOWS_UNAVAILABLE');
    if (reply?.status !== 'ok') fail('ELECTRON_WINDOWS_INVALID');
    const rows = rowsOf(reply, pid);
    if (reply.processStart !== pidBirth) fail('ELECTRON_WINDOWS_PID_CHANGED');
    const windows = rows.map(row => {
      if (!epochs.has(row.id)) {
        if (epochs.size >= MAX_EPOCHS) fail('ELECTRON_WINDOWS_INVALID');
        epochs.set(row.id, epochs.size + 1);
      }
      return Object.freeze({ id: row.id, epoch: epochs.get(row.id), pid, pidBirth, frame: Object.freeze({ ...row.frame }), scale: row.scale,
        onScreen: row.onScreen, minimized: row.minimized, modal: row.modal });
    });
    return Object.freeze({ observedAt: reply.observedAt, windows: Object.freeze(windows) });
  }

  return Object.freeze({
    async read() {
      if (closed) fail('ELECTRON_WINDOWS_CLOSED');
      if (cached && now() - cached.at < cacheMs) return cached.value;
      if (!inflight) {
        const at = now();
        inflight = fetch().then(value => { if (!closed) cached = { at, value }; return value; }).finally(() => { inflight = undefined; });
      }
      return inflight;
    },
    close() { closed = true; cached = undefined; },
  });
}
