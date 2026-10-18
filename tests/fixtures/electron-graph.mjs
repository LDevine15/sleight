// Strict fakes for EPV3-3: an app pipe's target graph, its renderers' geometry, the native window
// metadata reader and a Playwright-shaped browser. Every fake throws on a method it does not model,
// so a test fails when the code under test sends something unexpected.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

export const app = Object.freeze({ pid: 4100, pidBirth: '1700000000.000001' });
export const identity = Object.freeze({ host: 'h', pid: 4100, birth: '1700000000.000001', epoch: 1, instance: 'i' });
export const recipe = Object.freeze({ schemes: ['app'], fileRoots: ['/Applications/Fixture.app/Contents/Resources/app'] });
export const page = (targetId, url = 'app://main/index.html', extra = {}) =>
  ({ targetId, type: 'page', title: 'ignored', url, attached: false, canAccessOpener: false, browserContextId: 'ctx', ...extra });
export const rect = (x, y, width = 800, height = 600) => ({ x, y, width, height });

/** The app's side of the pipe as the electron connection presents it. */
export function fakeUpstream(initial = []) {
  const listeners = new Set(), calls = [], targets = new Map(initial.map(info => [info.targetId, info]));
  const geometry = new Map(), sessions = new Map();
  let attachment = 0;
  const emit = frame => { for (const listener of [...listeners]) listener(frame); };
  const session = {
    sessionId: 'root',
    on(name, listener) { assert.equal(name, 'event'); listeners.add(listener); },
    off(name, listener) { assert.equal(name, 'event'); listeners.delete(listener); },
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
      if (route !== 'root' && route !== undefined && !sessions.has(route)) throw Error('fake: no session ' + route);
      const target = sessions.get(route);
      switch (method) {
        case 'Target.setDiscoverTargets': return {};
        case 'Target.getTargets': return { targetInfos: [...targets.values()].map(info => ({ ...info })) };
        case 'Target.getTargetInfo': {
          const info = targets.get(params.targetId ?? target);
          if (!info) throw Error('fake: no target'); return { targetInfo: { ...info } };
        }
        case 'Target.attachToTarget': {
          const info = targets.get(params.targetId);
          if (!info) throw Error('fake: no target');
          const sessionId = 's' + (++attachment) + '-' + params.targetId;
          sessions.set(sessionId, params.targetId);
          emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false } });
          return { sessionId };
        }
        case 'Target.detachFromTarget': {
          const owner = sessions.get(params.sessionId);
          if (owner === undefined) throw Error('fake: no session');
          sessions.delete(params.sessionId);
          emit({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId, targetId: owner } });
          return {};
        }
        case 'Target.setAutoAttach': return {};
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'frame-' + target, url: targets.get(target)?.url } } };
        case 'Page.createIsolatedWorld': return { executionContextId: 70 + attachment };
        case 'Runtime.evaluate': {
          assert.equal(typeof params.contextId, 'number', 'geometry is read in an isolated world');
          const value = geometry.get(target);
          if (value instanceof Error) throw value;
          if (typeof value === 'function') return { result: { type: 'object', value: await value() } };
          return { result: { type: 'object', value: value ?? { x: 0, y: 0, width: 800, height: 600, scale: 2, visible: true } } };
        }
        case 'Runtime.runIfWaitingForDebugger': return {};
        default: throw Error('fake has no CDP method: ' + method);
      }
    },
  };
  const create = info => { targets.set(info.targetId, info); emit({ method: 'Target.targetCreated', params: { targetInfo: { ...info } } }); };
  // As Chromium does: every session on the target detaches, then the target is destroyed.
  const destroy = targetId => {
    for (const [sessionId, owner] of [...sessions]) if (owner === targetId) { sessions.delete(sessionId); emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } }); }
    targets.delete(targetId); emit({ method: 'Target.targetDestroyed', params: { targetId } });
  };
  const change = info => { targets.set(info.targetId, info); emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...info } } }); };
  const attaches = () => calls.filter(row => row.method === 'Target.attachToTarget').map(row => row.params.targetId);
  return { session, calls, emit, targets, geometry, sessions, create, destroy, change, attaches, listeners };
}

/** Native window metadata, content-free: ids, epochs, PID and birth, frame, scale and modal state. */
export function fakeWindows(windows = [], { now = () => 1000 } = {}) {
  const state = { windows, observedAt: undefined, reads: 0, approved: true, now };
  state.read = async () => {
    state.reads++;
    return { observedAt: state.observedAt ?? state.now(), windows: state.windows.map(row => ({ ...row, frame: { ...row.frame } })) };
  };
  return state;
}
export const nativeWindow = (id, frame, extra = {}) =>
  ({ id, epoch: 1, pid: app.pid, pidBirth: app.pidBirth, frame, scale: 2, onScreen: true, minimized: false, modal: false, ...extra });

/** A Playwright-shaped browser over the filter: it turns on root auto-attach on connect, as Playwright does,
 * and makes a page for each top-level attach the filter lets through. */
export function fakeBrowser(filter) {
  const context = new EventEmitter(), pages = [], closes = [], detaches = [];
  context.pages = () => pages.filter(row => !row.closedFlag);
  context.newCDPSession = async target => {
    const { sessionId } = await filter.session.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    return { async send(method, params = {}) { return filter.session.send(method, params, sessionId); },
      async detach() { detaches.push(target.targetId); await filter.session.send('Target.detachFromTarget', { sessionId }); } };
  };
  const live = new Map(); // targetId -> page, while Playwright's own session for it is attached
  filter.session.on('event', frame => {
    if (frame.sessionId !== undefined) return;
    if (frame.method === 'Target.detachedFromTarget') {
      for (const [targetId, row] of live) if (row.sessionId === frame.params.sessionId) { row.closedFlag = true; live.delete(targetId); row.emit('close'); }
      return;
    }
    if (frame.method !== 'Target.attachedToTarget' || frame.params.targetInfo.type !== 'page') return;
    const targetId = frame.params.targetInfo.targetId;
    if (live.has(targetId)) return;
    const row = new EventEmitter();
    live.set(targetId, row);
    Object.assign(row, { targetId, sessionId: frame.params.sessionId, closedFlag: false, isClosed: () => row.closedFlag, url: () => frame.params.targetInfo.url,
      close: async () => { closes.push(targetId); throw Error('fake: an app page must never be closed by the registry'); } });
    pages.push(row);
    queueMicrotask(() => context.emit('page', row));
  });
  const browser = { contexts: () => [context], async ready() { await filter.session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }); } };
  return { browser, context, pages, closes, detaches };
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
