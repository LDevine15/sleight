import { selectedBrowser, escapeLabel } from './consent-ui.mjs';
import { createIndicator } from './indicator.mjs';

// Original sleight protocol based on v2 section 6. Chromium is behavior evidence
// only (C151 782af9cb / C155 3ff7ac5a); no Chromium implementation is copied.
export const SETUP_COPY = Object.freeze({
  before: 'Connect sleight to {browser} for fast browser control. No extension needed.\n\nIn {browser}, open its remote debugging settings and turn on Allow remote debugging for this browser instance. Then choose Connect here.\n\n{browser} will ask Allow remote debugging? Choose Allow for the connection you just started. This gives sleight a browser connection; your site permissions and action confirmations still apply.',
  waiting: 'Waiting for {browser}. Review Allow remote debugging? in {browser} and choose Allow to connect.',
  disconnected: "{browser} disconnected. Reconnect when you're ready; {browser} will ask for permission again.",
  unfinished: 'The last action may be unfinished. sleight will check its state before continuing.',
  off: "Pause stops new sleight actions and keeps the connection. Disconnect closes sleight's browser connection for all sessions using it.\n\nTo stop all apps requesting remote debugging, open your browser's remote debugging settings and turn off Allow remote debugging for this browser instance.",
});
const failureStates = { CONNECTION_DECLINED: 'declined', SETTING_OFF: 'setting-off', SETTING_BLOCKED: 'setting-blocked',
  UNSUPPORTED_BROWSER: 'unsupported', STALE_INSTANCE: 'stale-instance' };
const failureCopy = {
  CONNECTION_DECLINED: '{browser} connection was declined. Connect again when you choose.',
  SETTING_OFF: '{browser} remote debugging is off. In {browser}, open its remote debugging settings and turn on Allow remote debugging for this browser instance before choosing Connect.',
  SETTING_BLOCKED: '{browser} remote debugging is blocked by browser policy. Use existing browser control.',
  UNSUPPORTED_BROWSER: 'This browser has not qualified for direct control. Use existing browser control.',
  STALE_INSTANCE: 'The selected {browser} instance changed. Select its current instance before connecting.',
};

export function createSetupUi({ browser, authenticate = () => false, connect, fence, cancelQueued, invalidateRefs,
  revokeConfirmations, refreshState, indicator = createIndicator() }) {
  const selected = Object.freeze(selectedBrowser(browser)), identity = JSON.stringify(selected);
  let state = 'setup', code = 'SETUP_REQUIRED', generation = 0, attempt, socket, onLoss;
  const receipts = new Map(), dispatchEpochs = new Map();
  const pendingClose = new Set(), closed = new WeakSet();
  const copy = text => text.replaceAll('{browser}', escapeLabel(selected.name));
  function closeConnection(connection) {
    if (!connection || closed.has(connection)) return true;
    pendingClose.add(connection);
    try {
      const result = connection.close();
      if (result === false || typeof result?.then === 'function') {
        // The joining adapter must confirm teardown synchronously. An async
        // reply is not closure proof; retain ownership for explicit cleanup.
        if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
        return false;
      }
      pendingClose.delete(connection); closed.add(connection); return true;
    } catch { return false; }
  }
  function requireHost(event) {
    if (authenticate(event) !== true) throw Error('UNAUTHENTICATED_UI');
    if (JSON.stringify(selectedBrowser(event.selection)) !== identity) throw Error('STALE_SELECTION');
  }
  function stop(reason, disconnect = true) {
    generation++;
    state = disconnect ? 'disconnected' : 'paused'; code = disconnect ? 'DISCONNECTED' : 'PAUSED';
    attempt?.abort(); attempt = undefined;
    // Local state fences first, even if a joining broker callback fails. Revoke
    // priority and final authorization must also be enforced inside BP2-2.
    const errors = [];
    for (const [hook, value] of [[fence, reason], [cancelQueued], [revokeConfirmations], ...(disconnect ? [[invalidateRefs]] : [])]) {
      try { if (typeof hook !== 'function') throw Error('BROKER_HOOK_UNAVAILABLE'); hook(value); } catch { errors.push('BROKER_CONTROL_UNCONFIRMED'); }
    }
    for (const receipt of receipts.values()) if (receipt.phase === 'dispatched') receipt.effect = 'unknown';
    if (disconnect) {
      const retry = [...pendingClose];
      const old = socket; socket = undefined;
      try { old?.cdp.off('disconnected', onLoss); } catch { errors.push('LISTENER_REMOVAL_UNCONFIRMED'); }
      if (!closeConnection(old)) errors.push('SOCKET_CLOSE_UNCONFIRMED');
      for (const connection of retry) if (connection !== old && !closeConnection(connection)) errors.push('SOCKET_CLOSE_UNCONFIRMED');
      indicator.disconnected();
    } else indicator.pause(true);
    return { phase: 'prepared', effect: 'none', completed: [], next: errors.length ? 'confirm broker teardown' : 'explicit user resume', errors };
  }
  async function start() {
    if (pendingClose.size) throw Error('SOCKET_CLOSE_UNCONFIRMED');
    if (state === 'connected' || state === 'approval-pending' || state === 'paused') throw Error('EXPLICIT_DISCONNECT_REQUIRED');
    if ([connect, fence, cancelQueued, invalidateRefs, revokeConfirmations].some(hook => typeof hook !== 'function')) throw Error('BROKER_HOOK_UNAVAILABLE');
    const epoch = ++generation, controller = new AbortController();
    attempt = controller; state = 'approval-pending'; code = 'CONNECTION_APPROVAL_PENDING';
    let connection;
    try {
      connection = await connect({ selected: { ...selected }, signal: controller.signal });
      if (epoch !== generation || controller.signal.aborted) { closeConnection(connection); return; }
      let connectionIdentity;
      try { connectionIdentity = JSON.stringify(selectedBrowser(connection?.selected)); }
      catch { throw Object.assign(Error('STALE_INSTANCE'), { code: 'STALE_INSTANCE' }); }
      if (connectionIdentity !== identity || !connection.cdp?.sessionId ||
        ['send', 'on', 'off'].some(method => typeof connection.cdp[method] !== 'function') || typeof connection.close !== 'function') {
        throw Object.assign(Error('STALE_INSTANCE'), { code: 'STALE_INSTANCE' });
      }
      socket = connection;
      // An event already queued before off() can arrive after a reconnect.
      // Only the socket that owns this listener may revoke the current state.
      onLoss = () => { if (socket === connection) stop('socket-loss'); };
      socket.cdp.on('disconnected', onLoss);
      state = 'connected'; code = 'CONNECTED'; attempt = undefined; indicator.connected(selected.name);
    } catch (error) {
      // Returned connections remain ours even if identity validation throws.
      // A stale attempt may close only its own result, never a replacement.
      if (connection && connection !== socket) closeConnection(connection);
      if (epoch !== generation) return;
      if (socket) stop('connection-failed');
      code = Object.hasOwn(failureStates, error.code) ? error.code : 'DISCONNECTED';
      state = failureStates[code] ?? 'disconnected'; attempt = undefined;
    }
  }
  return {
    async control(event) {
      requireHost(event);
      if (event.action === 'connect' || event.action === 'reconnect') return start();
      if (event.action === 'cancel' || event.action === 'disconnect') return stop(event.action);
      if (event.action === 'pause') return stop('pause', false);
      if (event.action === 'resume') {
        if (pendingClose.size) throw Error('SOCKET_CLOSE_UNCONFIRMED');
        if (state !== 'paused' || !socket) throw Error('EXPLICIT_RECONNECT_REQUIRED');
        // Fresh broker state/epoch approval is mandatory, never just a UI toggle.
        if (typeof refreshState !== 'function' || refreshState({ ...selected }) !== true) throw Error('FRESH_STATE_REQUIRED');
        state = 'connected'; code = 'CONNECTED'; indicator.pause(false); return;
      }
      if (event.action === 'not-now' || event.action === 'existing-control') { stop(event.action); state = 'fallback'; return; }
      throw Error('INVALID_CONTROL');
    },
    // Broker-only lifecycle input. Never register this on a page event channel.
    lost(reason) { return stop(reason); },
    assertDispatch() {
      if (pendingClose.size) throw Error('SOCKET_CLOSE_UNCONFIRMED');
      if (state !== 'connected' || !socket) throw Error(code);
      return { phase: 'prepared', effect: 'none', completed: [], next: 'site/action authority and broker dispatch fence' };
    },
    dispatched(id) {
      this.assertDispatch();
      if (receipts.has(id)) throw Error(receipts.get(id).effect === 'unknown' ? 'EFFECT_UNKNOWN' : 'OPERATION_REPLAY');
      receipts.set(id, { phase: 'dispatched', effect: 'unknown', completed: [], next: 'observe exact operation effect' });
      dispatchEpochs.set(id, generation);
    },
    verified(id) {
      const receipt = receipts.get(id);
      if (!receipt || receipt.phase !== 'dispatched' || state !== 'connected' || dispatchEpochs.get(id) !== generation) throw Error('EFFECT_UNKNOWN');
      receipt.phase = 'verified'; receipt.effect = 'verified'; receipt.completed = [id]; receipt.next = null;
    },
    receipt(id) { const receipt = receipts.get(id); return receipt ? structuredClone(receipt) : null; },
    addSession(id) { if (state !== 'connected') throw Error(code); indicator.addSession(id); },
    removeSession(id) { indicator.removeSession(id); },
    view() {
      const unfinished = [...receipts.values()].some(receipt => receipt.phase === 'dispatched');
      if (pendingClose.size) return { selection: { ...selected }, state: 'teardown-unconfirmed', code: 'SOCKET_CLOSE_UNCONFIRMED',
        text: 'Browser connection cleanup is unconfirmed. Disconnect again before connecting.',
        buttons: ['Disconnect'], off: copy(SETUP_COPY.off) };
      return { selection: { ...selected }, state, code,
        text: copy(state === 'setup' ? SETUP_COPY.before : state === 'approval-pending' ? SETUP_COPY.waiting
          : state === 'connected' || state === 'paused' ? indicator.view().text
            : `${failureCopy[code] ?? SETUP_COPY.disconnected}${unfinished ? ` ${SETUP_COPY.unfinished}` : ''}`),
        buttons: state === 'setup' ? ['Connect', 'Use existing browser control', 'Not now']
          : state === 'approval-pending' ? ['Cancel connection'] : state === 'connected' || state === 'paused' ? indicator.view().buttons
            : ['Reconnect', 'Use existing browser control'], off: copy(SETUP_COPY.off) };
    },
  };
}
