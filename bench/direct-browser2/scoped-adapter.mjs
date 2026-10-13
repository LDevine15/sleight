import { immutableJSON } from './ipc.mjs';

const allowed = new Set(['Page.enable', 'Page.getFrameTree', 'DOM.enable', 'DOM.getDocument', 'DOM.describeNode',
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'Runtime.enable']);
// Virtual-target architecture reference: Apache-2.0 FowlBrowser vendor/browserModel.mjs
// and cdpRelay.mjs at 8b689249ba4e33d2626487aad930605c62e2c6a7. This is a new,
// deliberately smaller implementation, not a copied or complete Playwright relay.
// No generic connectOverCDP initializer may use the real root socket.
export function createScopedAdapter({ session, checkLease, helpers }) {
  if (!session || ['send', 'on', 'off'].some(k => typeof session[k] !== 'function') || typeof checkLease !== 'function') throw Error('SCOPED_CONTRACT_REQUIRED');
  const fixed = immutableJSON(helpers), views = new Set(); let connected = true;
  const events = event => {
    for (const view of views) {
      if (!connected || event.sessionId !== view.lease.cdpSessionId || checkLease(view.lease) !== true) continue;
      for (const fn of view.listeners.get(event.method) ?? []) fn(immutableJSON(event.params ?? {}));
    }
  };
  session.on('event', events);
  return Object.freeze({
    forLease(input) {
      const lease = immutableJSON(input);
      if (['target', 'cdpSessionId', 'frame', 'origin'].some(k => typeof lease[k] !== 'string' || !lease[k]) ||
          !Number.isInteger(lease.document) || !Number.isInteger(lease.epoch) || checkLease(lease) !== true) throw Error('LEASE_LOST');
      const listeners = new Map(), view = { lease, listeners }; views.add(view);
      const check = () => { if (!connected || checkLease(lease) !== true) throw Error('LEASE_LOST'); };
      return Object.freeze({ sessionId: lease.cdpSessionId,
        on(event, fn) { check(); if (typeof fn !== 'function') throw Error('INVALID_ARGUMENT'); if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        off(event, fn) { listeners.get(event)?.delete(fn); },
        async send(method, input = {}) {
          check(); const params = immutableJSON(input);
          if (method === 'Target.getTargets') return { targetInfos: [{ targetId: lease.target, type: 'page', attached: true }] };
          if (method === 'Target.setAutoAttach') {
            if (Object.keys(params).some(k => !['autoAttach', 'waitForDebuggerOnStart', 'flatten'].includes(k))) throw Error('SCOPED_COMMAND_DENIED');
            // Virtual-only registration. Never forward a browser-wide pause.
            return {};
          }
          if (method === 'Target.attachToTarget') {
            if (params.targetId !== lease.target || Object.keys(params).some(k => !['targetId', 'flatten'].includes(k))) throw Error('FOREIGN_TARGET');
            return { sessionId: lease.cdpSessionId };
          }
          if (!allowed.has(method) || Object.keys(params).length) throw Error('SCOPED_COMMAND_DENIED');
          check(); return session.send(method, params, lease.cdpSessionId);
        },
        async callFixed(name, args) {
          check(); const helper = Object.hasOwn(fixed, name) ? fixed[name] : undefined;
          if (!helper || !Number.isInteger(helper.version) || helper.version < 1 || typeof helper.source !== 'string' || !helper.source || helper.source.length > 65536) throw Error('FIXED_HELPER_REQUIRED');
          if (!Number.isInteger(lease.executionContextId) || lease.executionContextId < 1) throw Error('FRAME_CONTEXT_REQUIRED');
          const values = immutableJSON(args);
          if (!Array.isArray(values) || values.length > 16) throw Error('INVALID_ARGUMENT');
          // The fixed template is internal trusted code, never model evaluate.
          // BP2-4/5 must resolve and validate this context's frame/world/document.
          check(); return session.send('Runtime.callFunctionOn', { functionDeclaration: helper.source,
            executionContextId: lease.executionContextId, arguments: values.map(value => ({ value })), returnByValue: true }, lease.cdpSessionId);
        },
        async input(method, input) {
          check(); const params = immutableJSON(input);
          const fields = method === 'Input.dispatchMouseEvent' ? ['type', 'x', 'y', 'button', 'clickCount']
            : method === 'Input.insertText' ? ['text'] : method === 'Input.dispatchKeyEvent' ? ['type', 'key', 'code', 'modifiers'] : [];
          if (!fields.length || Object.keys(params).some(k => !fields.includes(k))) throw Error('SCOPED_COMMAND_DENIED');
          // Internal actuator entry only; the broker never exposes this view to
          // an IPC client. The trusted fixture driver validates semantics first.
          check(); return session.send(method, params, lease.cdpSessionId);
        },
      });
    },
    disconnect() { connected = false; session.off('event', events); views.clear(); },
  });
}
