import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { immutableJSON } from './ipc.mjs';
import { validateCall } from './schemas.mjs';

const limit = 131072;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) &&
  /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const unproved = () => ({ revoked: false, cleanup: [{ resource: 'installed-worker', status: 'retained', code: 'CLEANUP_UNPROVED' }] });
const released = value => value?.revoked === true && Array.isArray(value.cleanup) &&
  value.cleanup.every(row => row.status !== 'retained' && row.code !== 'CLEANUP_UNPROVED');

// Flow the inherited read pipe before the first asynchronous import/build so
// EOF is observable while helpers compile. No legitimate parent frames precede
// ready; premature bytes fail closed. Handoff installs the protocol in the same
// synchronous step that removes this startup-only data guard.
export function createInstalledParentLifetime({ read, write }) {
  if (typeof read?.on !== 'function' || typeof read.resume !== 'function' || typeof write?.on !== 'function') throw Error('TRUSTED_ROUTE_REQUIRED');
  let lost = false, lossHandler;
  const unavailable = () => lost || read.readableEnded || read.destroyed || write.destroyed || write.writableEnded;
  const lose = () => { if (lost) return; lost = true; lossHandler?.(); };
  const premature = () => lose();
  read.on('data', premature); read.on('end', lose); read.on('error', lose); read.on('close', lose);
  write.on('error', lose); write.on('close', lose);
  read.resume();
  return Object.freeze({
    lost: unavailable,
    assertCurrent() { if (unavailable()) throw Error('PARENT_GONE'); },
    handoff(attach) {
      if (unavailable() || typeof attach !== 'function') throw Error('PARENT_GONE');
      read.off('data', premature);
      const owner = attach(); lossHandler = owner.detach;
      if (unavailable()) owner.detach();
      return owner;
    },
  });
}

// Error completion separates native ownership from the still-live parent pipe.
// The typed failure must be queued before this worker ends its output stream.
export function completeInstalledStartupFailure({ parent, read, write, receipt, error, releaseNativeResources, retainNativeResources }) {
  if (released(receipt)) releaseNativeResources(); else retainNativeResources();
  if (parent.lost()) { write.end(); read.destroy(); return; }
  const code = ['SETTING_OFF', 'HOST_PACKAGE_MISMATCH', 'INSTALLED_CONFIG_UNSAFE', 'NATIVE_HELPERS_UNAVAILABLE',
    'HOST_BUILD_BUSY', 'HOST_CACHE_UNSAFE', 'HOST_SOURCE_MISMATCH', 'SELECTED_PATH_UNSAFE', 'SELECTED_PROCESS_UNPROVED',
    'SELECTED_ENDPOINT_UNPROVED', 'SELECTED_LISTENER_UNPROVED', 'DISTRIBUTION_ACCEPTANCE_REQUIRED'].includes(error.message)
    ? error.message : 'INSTALLED_WORKER_UNAVAILABLE';
  write.end(JSON.stringify({ version: 1, status: 'unavailable', code }) + '\n'); read.destroy();
}

// The native controls authenticate once through their original compiled UI.
// Remember that exact accepted event privately so completing Disconnect/Cleanup
// can collect semantic + provider ownership before the worker retires its UI.
export function createInstalledControlUi({ ui, runtime, onReleased }) {
  if (typeof ui?.present !== 'function' || typeof ui.authenticate !== 'function' ||
      typeof runtime?.close !== 'function' || typeof onReleased !== 'function') throw Error('TRUSTED_ROUTE_REQUIRED');
  const authenticated = new WeakSet();
  return Object.freeze({
    authenticate(event) {
      const accepted = ui.authenticate(event) === true;
      if (accepted) authenticated.add(event);
      return accepted;
    },
    present(id, data, choices, deliver, options) {
      return ui.present(id, data, choices, async event => {
        await deliver(event);
        if (!authenticated.delete(event) || !['disconnect', 'cleanup'].includes(event.action)) return;
        let receipt; try { receipt = await runtime.close(); } catch { receipt = unproved(); }
        if (released(receipt)) onReleased(receipt);
      }, options);
    },
  });
}

// Pure pipe protocol. The real entry below creates every native dependency;
// tests supply owned streams and a fake runtime without opening apps or sockets.
export function serveInstalledWorker({ read, write, runtime, control, hello, browser, onClose = () => {}, onDetach = () => {} }) {
  const envelope = immutableJSON(hello);
  if (!exact(envelope, ['version', 'session', 'nonce']) || envelope.version !== 1 || !identifier(envelope.session) ||
      !equal(envelope.nonce, envelope.nonce) || !/^b[A-Za-z0-9_-]{1,63}$/.test(browser)) throw Error('TRUSTED_ROUTE_REQUIRED');
  let buffer = '', work = Promise.resolve(), detached = false, stopping = false, approved = false, generation = 0, queued = 0, lossCleanup;
  const seen = new Set(), turns = new Set(), results = new Map();
  function send(frame) {
    if (detached || write.destroyed) return;
    const bytes = JSON.stringify(immutableJSON(frame)) + '\n';
    if (Buffer.byteLength(bytes) > limit || write.writableLength > limit) { lose(); return; }
    try { write.write(bytes); } catch { lose(); }
  }
  function fence() { generation++; results.clear(); }
  function lose() {
    if (detached) return lossCleanup;
    detached = true; fence();
    // A genuine prior opt-in owns an idle host. Before that opt-in, a timed-out
    // parent must collect the partial startup instead of orphaning a native UI.
    let enabled = approved; try { enabled ||= runtime.enabled?.() === true; } catch {}
    let cleanup;
    try {
      cleanup = runtime.endTurn();
      if (!enabled && !stopping) { Promise.resolve(cleanup).catch(() => {}); cleanup = runtime.close(); }
    } catch { cleanup = unproved(); }
    lossCleanup = Promise.resolve(cleanup).catch(unproved).then(receipt => {
      if (!enabled && !stopping && released(receipt)) onClose(receipt);
      else onDetach(receipt);
      return receipt;
    });
    return lossCleanup;
  }
  function respond(id, promise, after) {
    Promise.resolve(promise).then(result => { send({ version: 1, id, result }); after?.(result); })
      .catch(() => send({ version: 1, id, error: 'INVALID_WORKER_REQUEST' }));
  }
  function receive(frame) {
    if (!exact(frame, ['version', 'session', 'nonce', 'id', 'method', 'params']) || frame.version !== 1 ||
        frame.session !== envelope.session || !equal(frame.nonce, envelope.nonce) || !identifier(frame.id) ||
        seen.has(frame.id) || seen.size >= 65536) { lose(); return; }
    seen.add(frame.id);
    const bad = () => send({ version: 1, id: frame.id, error: 'INVALID_WORKER_REQUEST' });
    if (frame.method === 'begin') {
      if (stopping || !exact(frame.params, ['turn', 'text']) || !identifier(frame.params.turn) || turns.has(frame.params.turn) ||
          typeof frame.params.text !== 'string' || Buffer.byteLength(frame.params.text) > 65536) return bad();
      turns.add(frame.params.turn); fence(); const epoch = generation;
      control.read.write(JSON.stringify({ ...envelope, event: 'begin', ...frame.params }) + '\n');
      return respond(frame.id, Promise.resolve(runtime.ready()).then(frontend => {
        const available = epoch === generation && !!frontend && frontend === runtime.current();
        approved ||= available;
        return { available, browser };
      }));
    }
    if (['end', 'close', 'detach'].includes(frame.method)) {
      if (!exact(frame.params, [])) return bad();
      fence();
      if (frame.method === 'close') {
        stopping = true;
        return respond(frame.id, runtime.close(), receipt => { if (released(receipt)) onClose(receipt); });
      }
      let enabled = approved; try { enabled ||= runtime.enabled?.() === true; } catch {}
      const cleanup = frame.method === 'detach' && !enabled ? runtime.close() : runtime.endTurn();
      return respond(frame.id, cleanup, receipt => {
        if (frame.method === 'detach') {
          detached = true;
          if (!enabled && released(receipt)) onClose(receipt); else onDetach(receipt);
        }
      });
    }
    if (!['call', 'delivered'].includes(frame.method) || stopping || queued >= 32) return bad();
    queued++;
    let request;
    try {
      if (frame.method === 'call') request = validateCall(frame.params);
      else if (!exact(frame.params, ['resultId', 'hash']) || !identifier(frame.params.resultId) || !equal(frame.params.hash, frame.params.hash)) throw Error();
    } catch { queued--; return bad(); }
    const epoch = generation;
    work = work.then(async () => {
      if (detached || stopping || epoch !== generation) throw Error('LEASE_LOST');
      const frontend = runtime.current(); if (!frontend) throw Error('LEASE_LOST');
      if (frame.method === 'delivered') {
        const record = results.get(frame.params.resultId); results.delete(frame.params.resultId);
        return !!record && record.frontend === frontend && equal(record.hash, frame.params.hash) &&
          equal(record.hash, digest(record.result)) && frontend.delivered(record.result) === true;
      }
      const result = await frontend.call(request);
      if (request.name === 'browser_read' && !result.error && epoch === generation && frontend === runtime.current()) {
        if (results.size >= 128) results.delete(results.keys().next().value);
        results.set(frame.id, { frontend, result, hash: digest(result) });
      }
      return result;
    });
    const operation = work; work = operation.catch(() => {});
    respond(frame.id, operation.finally(() => { queued--; }));
  }
  read.on('data', chunk => {
    if (detached) return;
    try {
      buffer += chunk; if (Buffer.byteLength(buffer) > limit) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); receive(frame);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  if (read.readableEnded || read.destroyed || write.destroyed || write.writableEnded) lose();
  else { send(envelope); send({ version: 1, ready: true, browser }); }
  return Object.freeze({ detach: lose, settled: () => lossCleanup ?? Promise.resolve(null) });
}

// No configurable entry path, arguments, fd, loader, endpoint or opt-in input.
// The inherited pair authenticates this worker's actual fixed launch parent.
async function installedMain() {
  const read = createReadStream(null, { fd: 3, autoClose: true });
  const write = createWriteStream(null, { fd: 4, autoClose: true });
  const parent = createInstalledParentLifetime({ read, write });
  let runtime, selected, ui, timer, controls, nativeReleased = false;
  const releaseNative = receipt => {
    if (nativeReleased || !released(receipt)) return;
    nativeReleased = true; clearInterval(timer); ui?.close(); write.end(); read.destroy();
  };
  try {
    const { readInstalledConfig, acceptedInstalledPackage } = await import('./installed-config.mjs');
    parent.assertCurrent();
    const config = readInstalledConfig(); if (!config) throw Error('SETTING_OFF');
    const accepted = acceptedInstalledPackage(config);
    const { prepareNativeHelpers, createNativeUi, createBrokerControls } = await import('./host.mjs');
    parent.assertCurrent();
    const built = await prepareNativeHelpers({ inventory: config.receipt });
    parent.assertCurrent();
    if (built.status !== 'ready') throw Error(built.code);
    const { createSelectedConnection } = await import('./selected-connection.mjs');
    parent.assertCurrent();
    selected = await createSelectedConnection({ config, nativeReceipt: built.receipt });
    parent.assertCurrent();
    if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH');
    const { createInstalledRuntime } = await import('./startup.mjs');
    parent.assertCurrent();
    const control = { read: new PassThrough(), write: new PassThrough() };
    let hello;
    control.write.on('data', chunk => { hello = JSON.parse(chunk); });
    ui = createNativeUi(built.receipt, () => {
      runtime?.endTurn(); runtime?.close().then(releaseNative).catch(() => {});
    });
    parent.assertCurrent();
    const status = value => { try { controls?.status(value); } catch { runtime?.endTurn(); } };
    runtime = createInstalledRuntime({ packageInventory: accepted.inventory, packageCurrent: accepted.current, ui, ...selected,
      logicalSession: 'l' + randomBytes(16).toString('hex'), control, onStatus: status });
    parent.assertCurrent();
    const controlUi = createInstalledControlUi({ ui, runtime, onReleased: releaseNative });
    controls = createBrokerControls({ broker: runtime.broker, ui: controlUi, revokeSessions: () => { runtime.endTurn(); } });
    const refresh = () => status(runtime.broker.status());
    timer = setInterval(refresh, 60000); refresh();
    parent.handoff(() => serveInstalledWorker({ read, write, runtime, control, hello, browser: selected.selectedBrowser,
      onClose(receipt) { control.read.end(); control.write.end(); releaseNative(receipt); },
      onDetach() { refresh(); write.end(); read.destroy(); } }));
    // Native Disconnect/Cleanup retains the host while shutdown is unproved.
    // The status heartbeat and UI, rather than the absent model pipe, own idle.
  } catch (error) {
    let receipt;
    if (runtime) receipt = await runtime.close().catch(unproved);
    else {
      let closed = !selected;
      try { if (selected) closed = await selected.disconnect(selected.session) === true; } catch {}
      receipt = closed ? { revoked: true, cleanup: [] } : unproved();
    }
    completeInstalledStartupFailure({ parent, read, write, receipt, error,
      releaseNativeResources() { nativeReleased = true; clearInterval(timer); ui?.close(); },
      retainNativeResources() { if (!timer) timer = setInterval(() => { void selected; void runtime; }, 60000); } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await installedMain();
