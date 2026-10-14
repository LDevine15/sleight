import { randomBytes } from 'node:crypto';
import { canonical } from './authority.mjs';
import { isBrokerTransport } from './broker.mjs';
import { immutableJSON } from './ipc.mjs';
import { bounded } from './attachment.mjs';

const roots = new WeakSet();
export const isRootTargets = value => !!value && roots.has(value);
const token = prefix => prefix + randomBytes(16).toString('hex');
const same = (a, b) => ['browserIncarnation', 'brokerEpoch', 'turn'].every(k => a?.[k] === b?.[k]) &&
  (a?.clientSession ?? a?.session) === (b?.clientSession ?? b?.session);
const urlOrigin = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('BACKGROUND_UNAVAILABLE');
  return url.origin;
};

// Connection-owned root entry, separate from the leased content adapter. Only
// an authentic broker transport can allocate/attach. Cleanup retains the actual
// command lifetime; a client deadline never erases a late acquired target.
export function createRootTargets({ session, current, timeoutMs = 1000 } = {}) {
  if (!session || ['send', 'on', 'off'].some(k => typeof session[k] !== 'function') || typeof current !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('TRUSTED_ROUTE_REQUIRED');
  const records = new Map(), tabs = new Map(), revoked = new Set(), observations = new WeakMap(); let closed = false;
  const live = record => !closed && !record.revoked && !record.absent && !record.retired &&
    !revoked.has(record.binding.session) && same(record.binding, current(record.binding));
  const get = plan => {
    const record = records.get(plan.allocation);
    if (!record || record.key !== plan.target || record.url !== plan.url || !same(record.binding, plan)) throw Error('LEASE_LOST');
    return record;
  };
  const bindDocument = (record, frame, sameDocument = false) => {
    const generation = (record.lease?.leaseGeneration ?? 0) + 1;
    const document = (record.lease?.document ?? 0) + (sameDocument ? 0 : 1);
    record.loader = frame.loaderId; record.unqualified = false; record.refreshWanted = undefined; record.nodes?.clear();
    record.lease = immutableJSON({ ...record.binding, clientSession: record.binding.session, target: record.target,
      cdpSessionId: record.route, frame: frame.id, document, epoch: generation, leaseGeneration: generation, origin: record.origin });
  };
  const refreshDocument = record => {
    if (record.refreshing || !record.refreshWanted || !record.lease || !live(record)) return;
    const version = record.refreshWanted, old = record.lease, deadline = Date.now() + timeoutMs;
    const checked = () => live(record) && record.refreshWanted === version && record.navigationVersion === version;
    const remaining = () => { if (!checked()) throw Error('LEASE_LOST'); const left = deadline - Date.now(); if (left <= 0) throw Error('FRAME_UNQUALIFIED'); return left; };
    record.refreshing = (async () => {
      while (checked()) {
        const budget = remaining(); record.pending++;
        let raw;
        // Event-driven bootstrap reads only the exact owned route's root frame
        // metadata. It cannot send content/input commands or create a loader.
        try { raw = Promise.resolve(session.send('Page.getFrameTree', {}, record.route)); }
        catch (error) { raw = Promise.reject(error); }
        const actual = raw.finally(() => { record.pending--; });
        const frame = (await bounded(() => actual, budget)).frameTree?.frame;
        if (!checked()) return;
        if (frame?.parentId) return;
        if (frame?.url && frame.url !== 'about:blank') {
          if (urlOrigin(frame.url) !== record.origin) return;
          if (frame.id && frame.loaderId) {
            bindDocument(record, frame, frame.id === old.frame && frame.loaderId === record.loader); return;
          }
        }
        await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(10, remaining()))), remaining());
      }
    })().catch(() => {}).finally(() => {
      record.refreshing = undefined;
      if (record.refreshWanted && record.refreshWanted !== version && live(record)) refreshDocument(record);
    });
  };
  const event = raw => {
    for (const record of records.values()) {
      if (raw.method === 'Target.targetDestroyed' && raw.params?.targetId === record.target) record.absent = true;
      if (raw.method === 'Target.detachedFromTarget' && raw.params?.sessionId === record.route) record.retired = true;
      if (raw.sessionId !== record.route || !record.route) continue;
      if (raw.method === 'DOM.documentUpdated') {
        record.navigationVersion = (record.navigationVersion ?? 0) + 1;
        if (!record.lease || !live(record)) continue;
        record.unqualified = true; record.nodes?.clear(); record.refreshWanted = record.navigationVersion;
        refreshDocument(record);
      } else if (raw.method === 'Page.frameNavigated' && raw.params?.frame && !raw.params.frame.parentId) {
        record.navigationVersion = (record.navigationVersion ?? 0) + 1;
        if (!record.lease || !live(record)) continue;
        const frame = raw.params.frame;
        // The flattened route is still the exact owned page. A genuine root
        // document commit creates fresh content authority; it never revives old
        // refs or admits a child frame or a different origin implicitly.
        let qualified = false;
        try { qualified = !!frame.id && !!frame.loaderId && urlOrigin(frame.url) === record.origin; } catch {}
        if (!qualified) { record.unqualified = true; record.nodes?.clear(); continue; }
        if (record.unqualified || frame.id !== record.lease.frame || frame.loaderId !== record.loader) bindDocument(record, frame);
      } else if (record.lease && live(record) && raw.method === 'Page.navigatedWithinDocument' && raw.params?.frameId === record.lease.frame) {
        let qualified = false;
        try { qualified = !record.unqualified && urlOrigin(raw.params.url) === record.origin; } catch {}
        if (!qualified) { record.unqualified = true; record.nodes?.clear(); continue; }
        bindDocument(record, { id: record.lease.frame, loaderId: record.loader }, true);
      } else if (raw.method === 'Page.frameDetached') {
        record.navigationVersion = (record.navigationVersion ?? 0) + 1;
        if (record.lease && raw.params?.frameId === record.lease.frame) {
          if (raw.params.reason === 'swap') { record.unqualified = true; record.nodes?.clear(); }
          else record.retired = true;
        }
      }
    }
  };
  session.on('event', event);
  const api = Object.freeze({
    prepare(args, context, operation) {
      if (operation !== 'browser_open' || closed || revoked.has(context.session) || !same(context, current(context))) throw Error('LEASE_LOST');
      const origin = urlOrigin(args.url), allocation = token('a'), key = token('allocation:');
      const binding = immutableJSON({ session: context.session, turn: context.turn, browserIncarnation: context.browserIncarnation, brokerEpoch: context.brokerEpoch });
      records.set(allocation, { binding, url: args.url, origin, key, allocation, pending: 0 });
      return { target: key, allocation, url: args.url };
    },
    dispatchFence(plan) { try { return live(get(plan)); } catch { return false; } },
    resolveOperation(plan, context, command) {
      const record = get(plan);
      if (!live(record) || !same(record.binding, context)) throw Error('LEASE_LOST');
      const root = command.route == null;
      const allowed = root && (command.method === 'Target.createTarget' && !record.target &&
          canonical(command.params) === canonical({ url: record.url, background: true }) ||
        command.method === 'Target.attachToTarget' && record.target && !record.route &&
          canonical(command.params) === canonical({ targetId: record.target, flatten: true }) ||
        command.method === 'Target.getTargetInfo' && record.target && canonical(command.params) === canonical({ targetId: record.target })) ||
        command.route === record.route && record.route && ['Page.enable', 'Page.getFrameTree'].includes(command.method) && canonical(command.params) === '{}';
      if (!allowed) throw Error('SCOPED_COMMAND_DENIED');
      return { id: token('open:'), kind: command.method === 'Target.createTarget' ? 'open' : 'read',
        args: command.method === 'Target.createTarget' ? { url: record.url } : {}, consequence: 'ordinary',
        scope: { browser: record.binding.browserIncarnation, broker: record.binding.brokerEpoch, session: record.binding.session,
          turn: record.binding.turn, target: record.key, lease: 0, frame: 'allocation', document: 0, ref: record.allocation, origin: record.origin } };
    },
    async open(plan, context) {
      if (!isBrokerTransport(context?.session) || context.session.sessionId !== session.sessionId) throw Error('TRUSTED_ROUTE_REQUIRED');
      const record = get(plan);
      const check = () => { if (!live(record) || context.signal?.aborted) throw Error('LEASE_LOST'); };
      const send = async (method, params, route, acquire, budget = timeoutMs) => {
        check(); record.pending++;
        let raw;
        try { raw = Promise.resolve(context.session.send(method, params, route)); }
        catch (error) { raw = Promise.reject(error); }
        const actual = raw.then(value => { acquire?.(value); return value; }).finally(() => { record.pending--; });
        const result = await bounded(() => actual, budget, context.signal); check(); return result;
      };
      try {
        await send('Target.createTarget', { url: record.url, background: true }, undefined, value => {
          if (typeof value?.targetId !== 'string' || !value.targetId) throw Error('TARGET_UNKNOWN');
          record.target = value.targetId;
        });
        await send('Target.attachToTarget', { targetId: record.target, flatten: true }, undefined, value => {
          if (typeof value?.sessionId !== 'string' || !value.sessionId) throw Error('ATTACHMENT_UNKNOWN');
          record.route = value.sessionId;
        });
        await send('Page.enable', {}, record.route);
        const deadline = Date.now() + timeoutMs;
        const remaining = () => { check(); const left = deadline - Date.now(); if (left <= 0) throw Error('FRAME_UNQUALIFIED'); return left; };
        const transient = url => url == null || url === '' || url === 'about:blank';
        const requested = new URL(record.url).href;
        while (true) {
          const version = record.navigationVersion ?? 0;
          const info = (await send('Target.getTargetInfo', { targetId: record.target }, undefined, undefined, remaining())).targetInfo;
          if (info?.targetId !== record.target || info.type !== 'page') throw Error('TARGET_UNKNOWN');
          let targetReady = false;
          if (!transient(info.url)) {
            if (new URL(info.url).href !== requested) throw Error('TARGET_UNKNOWN');
            targetReady = true;
          }
          const frame = (await send('Page.getFrameTree', {}, record.route, undefined, remaining())).frameTree?.frame;
          if (frame?.parentId) throw Error('FRAME_UNQUALIFIED');
          let frameReady = false;
          if (!transient(frame?.url)) {
            if (new URL(frame.url).href !== requested || urlOrigin(frame.url) !== record.origin) throw Error('FRAME_UNQUALIFIED');
            frameReady = !!frame.id && !!frame.loaderId;
          }
          if (targetReady && frameReady && version === (record.navigationVersion ?? 0)) { bindDocument(record, frame); break; }
          await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(10, remaining()))), remaining(), context.signal);
        }
        record.tab = token('t'); tabs.set(record.tab, record);
        return { effect: 'verified', completed: 1, tab: record.tab, observation: { opened: true, background: true } };
      } catch (error) {
        record.revoked = true;
        throw error;
      }
    },
    leaseFor(tab, context) {
      const record = tabs.get(tab);
      if (!record || !live(record) || record.unqualified || !same(record.binding, context)) throw Error('LEASE_LOST');
      return record.lease;
    },
    checkLease(lease) {
      return [...tabs.values()].some(r => live(r) && !r.unqualified && canonical(r.lease) === canonical(lease));
    },
    current(lease) {
      return api.checkLease(lease) ? immutableJSON(Object.fromEntries(['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn',
        'leaseGeneration', 'target', 'frame', 'document', 'origin'].map(k => [k, lease[k]]))) : null;
    },
    revokeSession(id) { revoked.add(id); for (const r of records.values()) if (r.binding.session === id) r.revoked = true; return true; },
    retainTarget(target) { for (const r of records.values()) if (r.target === target) r.keep = true; },
    captureObservation(route) {
      const record = [...records.values()].find(r => r.route === route && r.lease && live(r) && !r.unqualified);
      if (!record) return null;
      const fence = Object.freeze({}); observations.set(fence, { record, lease: record.lease }); return fence;
    },
    observeNodes(route, method, value, fence) {
      if (!['DOM.getDocument', 'DOM.describeNode', 'Accessibility.getPartialAXTree'].includes(method)) return;
      const record = [...records.values()].find(r => r.route === route && r.lease && live(r) && !r.unqualified);
      if (!record) return;
      // Installed senders pass their pre-await captured fence as argument four.
      // Three arguments are retained only for synchronous trusted fixtures.
      if (arguments.length >= 4) {
        const captured = fence && observations.get(fence); if (fence) observations.delete(fence);
        if (!captured || captured.record !== record || captured.lease !== record.lease) return;
      }
      record.nodes ??= new Set();
      const collect = (node, depth = 0) => {
        if (!node || depth > 4 || record.nodes.size >= 4096 || node.frameId && node.frameId !== record.lease.frame) return;
        const id = node.backendNodeId ?? node.backendDOMNodeId;
        if (Number.isSafeInteger(id) && id > 0) record.nodes.add(id);
        for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) collect(child, depth + 1);
      };
      if (value.nodes) for (const node of value.nodes) collect(node);
      else collect(value.root ?? value.node);
    },
    nodeBinding(id, lease) {
      const record = [...records.values()].find(r => r.lease && canonical(r.lease) === canonical(lease));
      return api.checkLease(lease) && record?.nodes?.has(id) ? { ...lease, backendNodeId: id } : null;
    },
    cleanupSession: id => cleanup(id),
    close() { closed = true; for (const r of records.values()) r.revoked = true; return cleanup(); },
  });
  roots.add(api); return api;
  async function cleanup(id) {
    const rows = [];
    for (const record of records.values()) {
      if (id !== undefined && record.binding.session !== id) continue;
      record.revoked = true;
      if (record.collecting) { rows.push(await record.collecting); continue; }
      record.collecting = (async () => {
        const retained = code => ({ resource: 'owned-target', status: 'retained', ...(record.target ? { target: record.target } : {}), code });
        if (record.pending) return retained('ACQUISITION_PENDING');
        if (record.keep) return retained('EFFECT_UNKNOWN');
        if (!record.target) return retained('TARGET_UNKNOWN');
        try {
          if (!record.absent) {
            const info = (await bounded(() => session.send('Target.getTargetInfo', { targetId: record.target }), timeoutMs)).targetInfo;
            if (!info || info.targetId !== record.target || info.type !== 'page') return retained('IDENTITY_UNPROVED');
            if (!record.closure) {
              record.closePending = true;
              record.closure = Promise.resolve().then(() => session.send('Target.closeTarget', { targetId: record.target }))
                .then(result => result?.success === true, () => false).finally(() => { record.closePending = false; });
            }
            const result = await bounded(() => record.closure, timeoutMs);
            if (result !== true) { record.closure = undefined; return retained('CLOSE_UNPROVED'); }
            const inventory = await bounded(() => session.send('Target.getTargets', {}), timeoutMs);
            if (!Array.isArray(inventory?.targetInfos) || inventory.targetInfos.some(t => t.targetId === record.target)) return retained('ABSENCE_UNPROVED');
          }
          records.delete(record.allocation); if (record.tab) tabs.delete(record.tab);
          return { resource: 'owned-target', target: record.target, status: 'closed', absenceVerified: true };
        } catch { return retained('CLEANUP_UNPROVED'); }
      })();
      try { rows.push(await record.collecting); } finally { record.collecting = undefined; }
    }
    if (closed && !records.size) session.off('event', event);
    return { closed: rows.every(r => r.status === 'closed'), cleanup: rows };
  }
}
