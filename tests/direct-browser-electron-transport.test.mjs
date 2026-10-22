import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ElectronBroker, PipeTransport, transportMethodAllowed } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { hostDependencies } from '../plugins/sleight/lib/direct-browser/electron-host-run.mjs';
import { errorFrame } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { recipe } from './fixtures/electron-graph.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
// Back-to-back replies (one per cleanup detach) are dispatched one setImmediate apart: wait until every answer is in.
const settled = async h => { for (let i = 0; i < 50 && (i === 0 || h.broker.pipe.pending.size || h.broker.pipe.gate !== undefined); i++) await tick(); };

function harness(options = {}, { targetInfos = new Map() } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const frames = [], hang = new Set();
  let sessions = 0;
  input.on('data', data => {
    for (const raw of data.toString().split('\0').filter(Boolean)) {
      const request = JSON.parse(raw);
      frames.push(request);
      if (hang.has(request.method)) continue;
      const route = request.sessionId ? { sessionId: request.sessionId } : {};
      const send = body => queueMicrotask(() => output.write(JSON.stringify({ id: request.id, ...body, ...route }) + '\0'));
      if (request.method === 'Target.attachToTarget') send({ result: { sessionId: 'S' + (++sessions) } });
      else if (request.method === 'Target.getTargetInfo') {
        const targetId = request.params.targetId;
        send({ result: { targetInfo: targetInfos.get(targetId) ?? { targetId, type: targetId.startsWith('W') ? 'service_worker' : 'page',
          url: targetId.startsWith('D') ? 'devtools://devtools/inspector.html' : 'app://main/index.html' } } });
      }
      else if (request.method === 'Page.fail') send({ error: { code: -32000, message: 'no such node' } });
      else send({ result: { ok: true } });
    }
  });
  const events = new EventEmitter(), owned = { pid: 100, birth: 'one' };
  let alive = true;
  const calls = [];
  const child = { identity: owned, input, output, events,
    inspect: async () => ({ parent: alive ? owned : null, descendants: [], complete: true }),
    requestQuit: async () => { alive = false; events.emit('exit', 0); } };
  const broker = new ElectronBroker({
    ownership: { reserve: async () => ({}), record: async () => {}, remove: async () => calls.push('remove') },
    launch: async () => child, authorizeLaunch: async () => true,
    admitTarget: async info => info.type === 'page' && !info.url.startsWith('devtools:'), ...options,
  });
  return { broker, child, frames, input, output, hang, calls, setAlive: value => { alive = value; } };
}
const ready = async options => { const h = harness(options); await h.broker.start({}); return h; };
const methods = h => h.frames.map(frame => frame.method + (frame.sessionId ? '@' + frame.sessionId : ''));
// The pipe holds records that follow a reply until a setImmediate after it (wire order, see PipeTransport.receive);
// the tick lets an event the test writes next arrive the way a later pipe chunk does.
const attach = async (h, client, targetId = 'T1') => {
  const { sessionId } = await h.broker.transportSend(client, { method: 'Target.attachToTarget', params: { targetId, flatten: true } });
  await tick();
  return sessionId;
};

async function ownedIframeFilter(t, brokerOptions = {}) {
  const build = 'fixture@1', reviewed = { ...recipe, build, sha256: 'a'.repeat(64) };
  const deps = hostDependencies({ registry: { recipes: [reviewed] }, builds: [build] });
  const rootInfo = { targetId: 'T1', type: 'page', url: 'app://main/index.html' };
  const childInfo = { targetId: 'F1', type: 'iframe', url: 'vscode-webview://fixture/index.html' };
  const targetInfos = new Map([['T1', rootInfo], ['F1', childInfo]]);
  const h = harness({ ...deps, ...brokerOptions }, { targetInfos });
  await h.broker.start({ build });
  const client = h.broker.connect('owned-iframe-test'), listeners = new Set();
  const routed = (owner, frame) => { if (owner === client) for (const listener of listeners) listener(frame); };
  h.broker.on('routed', routed);
  const upstream = { sessionId: 'worker-root',
    send: (method, params = {}, route) => h.broker.transportSend(client, { method, params,
      ...(route === undefined || route === 'worker-root' ? {} : { sessionId: route }) }),
    on(name, listener) { assert.equal(name, 'event'); listeners.add(listener); },
    off(name, listener) { assert.equal(name, 'event'); listeners.delete(listener); } };
  const filter = createCDPFilter({ session: upstream, app: {
    admit: info => info.targetId === rootInfo.targetId && deps.admitTarget(info),
    current: targetId => targetId === rootInfo.targetId && h.broker.state === 'ready' && h.broker.clients.has(client),
  } });
  t.after(async () => { await filter.dispose(); h.broker.detach(client); await tick(); h.broker.off('routed', routed); });
  await filter.own('T1');
  const parent = (await filter.session.send('Target.attachToTarget', { targetId: 'T1', flatten: true })).sessionId;
  await filter.session.send('Target.setAutoAttach', { autoAttach: true, flatten: true }, parent);
  h.output.write(JSON.stringify({ sessionId: parent, method: 'Target.attachedToTarget',
    params: { sessionId: 'existing-iframe', targetInfo: childInfo, waitingForDebugger: false } }) + '\0');
  await tick();
  const emit = frame => h.output.write(JSON.stringify(frame) + '\0');
  const addFrame = (sessionId, targetId, parentSession = parent, type = 'iframe') => {
    const info = { targetId, ...(type === null ? {} : { type }), url: 'vscode-webview://fixture/index.html' };
    targetInfos.set(targetId, { ...info, type: 'iframe' });
    emit({ sessionId: parentSession, method: 'Target.attachedToTarget', params: { sessionId, targetInfo: info, waitingForDebugger: false } });
  };
  return { ...h, deps, client, filter, parent, childInfo, targetInfos, emit, addFrame };
}
const lastRequest = (h, method) => h.frames.findLast(frame => frame.method === method);
const answer = (h, request, body) => h.emit({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...body });
const detachFrame = (h, sessionId = 'existing-iframe', parent = h.parent) => h.emit({ sessionId: parent,
  method: 'Target.detachedFromTarget', params: { sessionId } });

test('an owned auto-attached iframe retains a working existing route while top-level admission stays page-only', async t => {
  const h = await ownedIframeFilter(t);
  assert.equal(h.broker.routes.get(h.parent).client, h.client);
  assert.equal(h.broker.routes.get(h.parent).targetId, 'T1');
  assert.equal(h.broker.routes.get('existing-iframe').client, h.client);
  assert.equal(h.broker.routes.get('existing-iframe').top, false);
  assert.equal(await h.deps.admitTarget(h.childInfo), false, 'an iframe must never become a top-level app member');
  assert.deepEqual(await h.filter.session.send('Runtime.evaluate', { expression: '1' }, 'existing-iframe'), { ok: true });
  assert.equal(h.broker.state, 'ready');
});

test('an owned auto-attached iframe can acquire the private second session required by snapshot', async t => {
  const h = await ownedIframeFilter(t);
  const existing = await h.filter.session.send('Runtime.evaluate', { expression: '1' }, 'existing-iframe');
  let read, refusal = null;
  try { read = await h.filter.session.send('Target.attachToTarget', { targetId: 'F1', flatten: true }); }
  catch (error) { refusal = error.message; }
  assert.deepEqual({ existingRouteWorks: existing.ok, parentStillOwned: h.broker.routes.get(h.parent)?.client === h.client,
    iframeStillOwned: h.broker.routes.get('existing-iframe')?.client === h.client,
    privateAttachWritten: h.frames.some(frame => frame.method === 'Target.attachToTarget' && frame.params.targetId === 'F1'), refusal },
  { existingRouteWorks: true, parentStillOwned: true, iframeStillOwned: true, privateAttachWritten: true, refusal: null },
  'snapshot needs a private read session for the native iframe already owned through the live page route');
  await h.filter.session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, read.sessionId);
  await h.filter.session.send('Target.detachFromTarget', { sessionId: read.sessionId });
  assert.equal(h.broker.routes.has('existing-iframe'), true, 'collecting the private read keeps the original frame route');
});

test('derived iframe attachment supports nested native ancestry and preserves physical cleanup ownership', async t => {
  const h = await ownedIframeFilter(t);
  h.addFrame('nested-iframe', 'F2', 'existing-iframe');
  const read = await h.filter.session.send('Target.attachToTarget', { targetId: 'F2', flatten: true });
  assert.equal(h.broker.routes.get(read.sessionId).top, true, 'the secondary was physically attached from the root session');
  assert.equal(Object.isFrozen(h.broker.routes.get(read.sessionId)), true);
  await h.filter.session.send('DOMSnapshot.captureSnapshot', {}, read.sessionId);
  h.broker.detach(h.client);
  await tick();
  assert.ok(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === read.sessionId));
});

test('a secondary session retains physical worker cleanup ownership after its source authority is invalidated', async t => {
  const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
  const other = h.broker.connect('other-client'), unrelated = await attach(h, other, 'T2');
  detachFrame(h);
  assert.equal(h.broker.routes.has(secondary), false, 'the secondary has no remaining input authority');
  h.broker.detach(h.client);
  await tick();
  const detached = h.frames.filter(frame => frame.method === 'Target.detachFromTarget').map(frame => frame.params.sessionId);
  assert.equal(detached.includes(secondary), true, 'the exact owned physical secondary must still be collected');
  assert.equal(detached.includes(unrelated), false);
  assert.equal(h.broker.routes.has(unrelated), true);
});

test('failed physical secondary collection retains ownership and leaves another client untouched', async t => {
  const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
  const other = h.broker.connect('other-client'), unrelated = await attach(h, other, 'T2');
  detachFrame(h); h.hang.add('Target.detachFromTarget');
  const start = h.frames.length;
  h.broker.detach(h.client); await tick();
  for (const request of h.frames.slice(start).filter(frame => frame.method === 'Target.detachFromTarget'))
    answer(h, request, request.params.sessionId === secondary ? { error: { code: -32000, message: 'cleanup refused' } } : { result: {} });
  await tick();
  assert.equal(h.broker.attachments.has(secondary), true);
  assert.equal(h.broker.routes.has(unrelated), true);
  assert.equal(h.broker.state, 'ready');
  h.hang.delete('Target.detachFromTarget');
  h.broker.detach(h.client); await tick();
  assert.equal(h.broker.attachments.has(secondary), false, 'a later exact retry collects the retained physical session');
});

test('physical secondary ownership survives park and resume until the old worker cleanup is proved', async t => {
  const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
  detachFrame(h);
  h.broker.revoke('user revoked');
  assert.equal(h.broker.attachments.has(secondary), true);
  await h.broker.resume(async () => true);
  h.broker.detach(h.client); await settled(h);
  assert.equal(h.broker.attachments.has(secondary), false);
  assert.equal(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === secondary), true);
});

test('native detach proves retired physical secondary collection without another detach request', async t => {
  const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
  detachFrame(h);
  h.emit({ method: 'Target.detachedFromTarget', params: { sessionId: secondary, targetId: 'F1' } });
  assert.equal(h.broker.attachments.has(secondary), false);
  h.broker.detach(h.client); await tick();
  assert.equal(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === secondary), false);
});

test('scoped native target destruction proves retired physical secondary collection', async t => {
  const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
  detachFrame(h);
  h.emit({ sessionId: h.parent, method: 'Target.targetDestroyed', params: { targetId: 'F1' } });
  assert.equal(h.broker.attachments.has(secondary), false);
});

for (const scope of ['browser', 'scoped']) {
  test(`${scope} target crash revokes authority while retaining exact physical attachments for client cleanup`, async t => {
    const h = await ownedIframeFilter(t), secondary = await attach(h, h.client, 'F1');
    const other = h.broker.connect('other-client'), unrelated = await attach(h, other, 'T2');
    const physical = h.broker.attachments.get(secondary);
    h.emit({ ...(scope === 'scoped' ? { sessionId: h.parent } : {}), method: 'Target.targetCrashed', params: { targetId: 'F1' } });
    assert.equal(h.broker.routes.has('existing-iframe'), false);
    assert.equal(h.broker.routes.has(secondary), false);
    assert.equal(h.broker.attachments.get(secondary) === physical, true, 'a crash does not prove debugger session detachment');
    h.broker.detach(h.client); await settled(h);
    assert.equal(h.broker.attachments.has(secondary), false);
    assert.equal(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === secondary), true);
    assert.equal(h.broker.routes.has(unrelated), true);
    assert.equal(h.broker.attachments.has(unrelated), true);
    assert.equal(h.input.destroyed, false);
  });
}

for (const ending of ['timeout', 'abort', 'timeout-after-revoke', 'abort-after-revoke']) {
  test(`a dispatched attachment ${ending} without a returned SID parks non-resumably`, async t => {
    const h = await ownedIframeFilter(t, { transport: { timeoutMs: 25 } }), controller = new AbortController();
    const existing = h.broker.attachments.get(h.parent);
    h.hang.add('Target.attachToTarget');
    const pending = h.broker.transportSend(h.client, { method: 'Target.attachToTarget', params: { targetId: 'F1', flatten: true } },
      { signal: controller.signal }).catch(error => error);
    await tick();
    assert.equal(lastRequest(h, 'Target.attachToTarget').params.targetId, 'F1');
    if (ending.endsWith('after-revoke')) h.broker.revoke('user revoked');
    if (ending.startsWith('abort')) controller.abort();
    const error = await pending;
    assert.equal(error.dispatched, true);
    assert.deepEqual(errorFrame(error), { code: 'EFFECT_UNKNOWN', dispatched: true });
    assert.equal(h.broker.state, 'parked');
    assert.equal(h.broker.parkedBy.resumable, false);
    await assert.rejects(h.broker.resume(async () => true), /not resumable/);
    assert.equal(h.broker.attachments.get(h.parent), existing);
    assert.equal(h.input.destroyed, false);
    assert.equal(h.frames.filter(frame => frame.method === 'Target.attachToTarget' && frame.params.targetId === 'F1').length, 1);
  });
}

for (const timing of ['before-call', 'queued-before-write']) {
  test(`attachment cancellation ${timing} does not create an unknown attachment or park`, async t => {
    const h = await ownedIframeFilter(t), controller = new AbortController();
    if (timing === 'before-call') controller.abort();
    else h.hang.add('Target.getTargetInfo');
    const pending = h.broker.transportSend(h.client, { method: 'Target.attachToTarget', params: { targetId: 'F1', flatten: true } },
      { signal: controller.signal }).catch(error => error);
    if (timing === 'queued-before-write') {
      await tick(); h.broker.pipe.blocked = true;
      answer(h, lastRequest(h, 'Target.getTargetInfo'), { result: { targetInfo: h.childInfo } });
      await tick(); assert.equal(h.broker.pipe.writes.size, 1);
      controller.abort();
    }
    const error = await pending;
    h.broker.pipe.blocked = false; h.broker.pipe.flush(); h.hang.delete('Target.getTargetInfo');
    assert.notEqual(error.dispatched, true);
    assert.equal(h.broker.state, 'ready');
    assert.equal(h.broker.pendingAttaches.size, 0);
    assert.equal(h.broker.attachments.size, 1);
    assert.equal(h.frames.some(frame => frame.method === 'Target.attachToTarget' && frame.params.targetId === 'F1'), false);
  });
}

test('retired physical secondaries consume the bounded ownership bank and block new attachment writes', async t => {
  const h = await ownedIframeFilter(t, { maxRoutes: 3 });
  const first = await attach(h, h.client, 'F1'); detachFrame(h);
  h.addFrame('second-frame', 'F2');
  const second = await attach(h, h.client, 'F2'); detachFrame(h, 'second-frame');
  h.addFrame('third-frame', 'F3');
  const before = h.frames.filter(frame => frame.method === 'Target.attachToTarget').length;
  await assert.rejects(attach(h, h.client, 'F3'), /NOT_OWNED|full/);
  assert.equal(h.frames.filter(frame => frame.method === 'Target.attachToTarget').length, before);
  assert.equal(h.broker.attachments.has(first), true);
  assert.equal(h.broker.attachments.has(second), true);
  assert.equal(h.input.destroyed, false);
});

for (const cause of ['source-detach', 'ancestor-detach', 'destroy', 'crash', 'type-drift', 'scoped-destroy', 'scoped-crash']) {
  test(`derived iframe attachment invalidates ${cause} descendants before forwarding native lifecycle`, async t => {
    const h = await ownedIframeFilter(t);
    h.addFrame('nested-iframe', 'F2', 'existing-iframe');
    const read = await attach(h, h.client, 'F2');
    const unrelated = await attach(h, h.client, 'T2');
    let observed;
    h.broker.on('routed', (_owner, frame) => {
      if (frame.method === 'Target.detachedFromTarget' || frame.method === 'Target.targetDestroyed' ||
          frame.method === 'Target.targetCrashed' || frame.method === 'Target.targetInfoChanged')
        observed = ['existing-iframe', 'nested-iframe', read].map(id => h.broker.routes.has(id));
    });
    if (cause === 'source-detach') detachFrame(h);
    else if (cause === 'ancestor-detach') h.emit({ method: 'Target.detachedFromTarget', params: { sessionId: h.parent } });
    else if (cause === 'type-drift') h.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { ...h.childInfo, type: 'page' } } });
    else h.emit({ ...(cause.startsWith('scoped-') ? { sessionId: h.parent } : {}),
      method: cause.endsWith('destroy') ? 'Target.targetDestroyed' : 'Target.targetCrashed', params: { targetId: 'F1' } });
    assert.deepEqual(observed, [false, false, false]);
    assert.equal(h.broker.routes.has(unrelated), true);
    await assert.rejects(h.broker.transportSend(h.client, { method: 'Runtime.evaluate', sessionId: read }), /NOT_OWNED/);
  });
}

test('a sibling or child native detach cannot invalidate another route and its descendants', async t => {
  const h = await ownedIframeFilter(t);
  h.addFrame('sibling', 'F2'); h.addFrame('nested', 'F3', 'existing-iframe');
  detachFrame(h, 'existing-iframe', 'sibling');
  detachFrame(h, h.parent, 'nested');
  h.emit({ sessionId: 'sibling', method: 'Target.targetDestroyed', params: { targetId: 'F1' } });
  assert.equal(h.broker.routes.has(h.parent), true);
  assert.equal(h.broker.routes.has('existing-iframe'), true);
  assert.equal(h.broker.routes.has('nested'), true);
});

test('a native attach session collision cannot invalidate a foreign client or sibling route', async t => {
  const h = await ownedIframeFilter(t), other = h.broker.connect('other-client');
  const foreign = await attach(h, other, 'T2'), foreignRecord = h.broker.routes.get(foreign);
  h.addFrame('sibling', 'F2'); h.addFrame('nested', 'F3', 'existing-iframe');
  const siblingRecord = h.broker.routes.get('sibling');
  for (const sessionId of [foreign, 'sibling']) h.emit({ sessionId: 'nested', method: 'Target.attachedToTarget',
    params: { sessionId, targetInfo: { targetId: 'forged-target', type: 'iframe' } } });
  assert.equal(h.broker.routes.get(foreign), foreignRecord);
  assert.equal(h.broker.routes.get('sibling'), siblingRecord);
  assert.equal(h.broker.state, 'ready');
});

for (const loss of ['route', 'source', 'client']) {
  test(`a successful input reply racing ${loss} loss remains dispatched and uncertain`, async t => {
    const h = await ownedIframeFilter(t);
    const read = await attach(h, h.client, 'F1');
    h.hang.add('Input.dispatchKeyEvent');
    const route = loss === 'route' ? h.parent : read;
    const pending = h.broker.transportSend(h.client, { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown' }, sessionId: route }).catch(error => error);
    await tick();
    const request = lastRequest(h, 'Input.dispatchKeyEvent');
    if (loss === 'client') h.broker.detach(h.client);
    else if (loss === 'route') h.emit({ method: 'Target.detachedFromTarget', params: { sessionId: route } });
    else detachFrame(h);
    answer(h, request, { result: { ok: true } });
    const error = await pending;
    assert.equal(error.dispatched, true);
    assert.deepEqual(errorFrame(error), { code: 'EFFECT_UNKNOWN', dispatched: true });
    assert.equal(h.broker.state, 'parked');
    assert.equal(h.frames.filter(frame => frame.method === 'Input.dispatchKeyEvent').length, 1);
  });
}

test('a successful owned detach tolerates its expected native route disappearance before the reply', async t => {
  const h = await ownedIframeFilter(t), read = await attach(h, h.client, 'F1');
  h.hang.add('Target.detachFromTarget');
  const pending = h.broker.transportSend(h.client, { method: 'Target.detachFromTarget', params: { sessionId: read } });
  await tick();
  const request = lastRequest(h, 'Target.detachFromTarget');
  h.emit({ method: 'Target.detachedFromTarget', params: { sessionId: read } });
  answer(h, request, { result: {} });
  assert.deepEqual(await pending, {});
  assert.equal(h.broker.routes.has('existing-iframe'), true);
  assert.equal(h.broker.state, 'ready');
  h.hang.delete('Target.detachFromTarget');
});

test('an old detach reply never collects a reused SID belonging to another client retired secondary', async t => {
  const h = await ownedIframeFilter(t), original = await attach(h, h.client, 'F1');
  const other = h.broker.connect('other-client'), otherParent = await attach(h, other, 'T2');
  h.hang.add('Target.detachFromTarget');
  const detached = h.broker.transportSend(h.client, { method: 'Target.detachFromTarget', params: { sessionId: original } }).catch(error => error);
  await tick(); const oldRequest = lastRequest(h, 'Target.detachFromTarget');
  h.emit({ method: 'Target.detachedFromTarget', params: { sessionId: original } });
  h.addFrame('other-frame', 'F-other', otherParent);
  h.hang.add('Target.attachToTarget');
  const replacement = attach(h, other, 'F-other');
  await tick();
  answer(h, lastRequest(h, 'Target.attachToTarget'), { result: { sessionId: original } });
  assert.equal(await replacement, original);
  const physical = h.broker.attachments.get(original);
  detachFrame(h, 'other-frame', otherParent);
  assert.equal(h.broker.routes.has(original), false);
  answer(h, oldRequest, { result: {} });
  const error = await detached;
  assert.equal(error.dispatched, true);
  assert.equal(h.broker.attachments.get(original), physical);
  assert.equal(physical.client, other);
  h.hang.delete('Target.detachFromTarget'); h.hang.delete('Target.attachToTarget');
});

for (const kind of ['foreign-client', 'missing', 'missing-type', 'wrong-type', 'ambiguous', 'secondary-source', 'secondary-parent', 'cycle', 'depth']) {
  test(`derived iframe attachment refuses ${kind} provenance`, async t => {
    const h = await ownedIframeFilter(t);
    let client = h.client, target = 'F1';
    if (kind === 'foreign-client') client = h.broker.connect('other-client');
    if (kind === 'missing') { target = 'F2'; h.targetInfos.set(target, { targetId: target, type: 'iframe' }); }
    if (kind === 'missing-type' || kind === 'wrong-type') {
      target = 'F2'; h.addFrame('bad-frame', target, h.parent, kind === 'missing-type' ? null : 'worker');
    }
    if (kind === 'ambiguous') h.addFrame('ambiguous-frame', 'F1');
    if (kind === 'secondary-source' || kind === 'secondary-parent') {
      const secondary = await attach(h, client, target);
      if (kind === 'secondary-source') h.broker.routes.delete('existing-iframe');
      else { h.addFrame('under-secondary', 'F2', secondary); target = 'F2'; }
    }
    if (kind === 'cycle') {
      const cyclic = { ...h.broker.routes.get('existing-iframe'), parentSession: 'existing-iframe' };
      cyclic.parent = cyclic; h.broker.routes.set('existing-iframe', Object.freeze(cyclic));
    }
    if (kind === 'depth') {
      let parent = 'existing-iframe';
      for (let i = 0; i < 129; i++) { const name = 'deep-' + i; target = 'F-deep-' + i; h.addFrame(name, target, parent); parent = name; }
    }
    const before = h.frames.filter(frame => frame.method === 'Target.attachToTarget').length;
    await assert.rejects(attach(h, client, target), /NOT_OWNED/);
    assert.equal(h.frames.filter(frame => frame.method === 'Target.attachToTarget').length, before);
  });
}

test('derived iframe attachment rejects native target type changes without admitting it as a page', async t => {
  const h = await ownedIframeFilter(t);
  h.targetInfos.set('F1', { ...h.childInfo, type: 'page', url: 'app://main/changed.html' });
  const before = h.frames.filter(frame => frame.method === 'Target.attachToTarget').length;
  await assert.rejects(attach(h, h.client, 'F1'), /NOT_OWNED/);
  assert.equal(h.frames.filter(frame => frame.method === 'Target.attachToTarget').length, before);
});

for (const loss of ['source', 'ancestor-record', 'client', 'reused-source', 'ambiguous-source']) {
  test(`derived iframe attachment pins ${loss} authority while native target info is pending`, async t => {
    const h = await ownedIframeFilter(t);
    h.hang.add('Target.getTargetInfo');
    const pending = attach(h, h.client, 'F1');
    pending.catch(() => {});
    await tick();
    const query = lastRequest(h, 'Target.getTargetInfo');
    if (loss === 'source' || loss === 'reused-source') detachFrame(h);
    if (loss === 'ancestor-record') h.broker.routes.set(h.parent, Object.freeze({ ...h.broker.routes.get(h.parent) }));
    if (loss === 'client') h.broker.detach(h.client);
    if (loss === 'reused-source') h.addFrame('existing-iframe', 'F1');
    if (loss === 'ambiguous-source') h.addFrame('ambiguous-iframe', 'F1');
    answer(h, query, { result: { targetInfo: h.childInfo } });
    await assert.rejects(pending, /NOT_OWNED|detached|parked/);
    assert.equal(h.frames.some(frame => frame.method === 'Target.attachToTarget' && frame.params.targetId === 'F1'), false);
  });
}

test('derived iframe attachment snapshots params before awaiting identity or target info', async t => {
  const h = await ownedIframeFilter(t);
  h.hang.add('Target.getTargetInfo');
  const params = { targetId: 'F1', flatten: true };
  const pending = h.broker.transportSend(h.client, { method: 'Target.attachToTarget', params });
  await tick();
  params.targetId = 'T-foreign';
  answer(h, lastRequest(h, 'Target.getTargetInfo'), { result: { targetInfo: h.childInfo } });
  assert.ok((await pending).sessionId);
  assert.equal(lastRequest(h, 'Target.attachToTarget').params.targetId, 'F1');
});

test('derived iframe attachment rechecks source at the queued physical write', async t => {
  const h = await ownedIframeFilter(t);
  h.hang.add('Target.getTargetInfo');
  const pending = attach(h, h.client, 'F1');
  pending.catch(() => {});
  await tick();
  h.broker.pipe.blocked = true;
  answer(h, lastRequest(h, 'Target.getTargetInfo'), { result: { targetInfo: h.childInfo } });
  await tick();
  assert.equal(h.broker.pipe.writes.size, 1);
  detachFrame(h);
  h.broker.pipe.blocked = false; h.broker.pipe.flush();
  await assert.rejects(pending, /NOT_OWNED/);
  assert.equal(h.frames.some(frame => frame.method === 'Target.attachToTarget' && frame.params.targetId === 'F1'), false);
});

for (const loss of ['source', 'client', 'collision', 'retired-collision', 'cleanup-failed']) {
  test(`derived iframe attachment ${loss} after dispatch never publishes an orphan`, async t => {
    const h = await ownedIframeFilter(t);
    h.hang.add('Target.attachToTarget');
    const pending = attach(h, h.client, 'F1');
    pending.catch(() => {});
    await tick();
    const request = lastRequest(h, 'Target.attachToTarget');
    assert.equal(request.params.targetId, 'F1');
    if (loss === 'client') h.broker.detach(h.client); else detachFrame(h);
    if (loss === 'cleanup-failed') h.hang.add('Target.detachFromTarget');
    answer(h, request, { result: { sessionId: loss === 'collision' ? h.parent : loss === 'retired-collision' ? 'existing-iframe' : 'new-orphan' } });
    if (loss === 'cleanup-failed') {
      await tick(); const cleanup = lastRequest(h, 'Target.detachFromTarget');
      assert.equal(cleanup.params.sessionId, 'new-orphan');
      answer(h, cleanup, { error: { code: -32000, message: 'cleanup refused' } });
    }
    await assert.rejects(pending, /NOT_OWNED|parked|authority|detached/);
    assert.equal(h.broker.routes.has('new-orphan'), false);
    const detaches = h.frames.filter(frame => frame.method === 'Target.detachFromTarget').map(frame => frame.params.sessionId);
    if (loss === 'collision' || loss === 'retired-collision') {
      assert.equal(detaches.includes(loss === 'collision' ? h.parent : 'existing-iframe'), false);
      assert.equal(h.broker.state, 'parked');
    }
    else assert.equal(detaches.includes('new-orphan'), true);
    if (loss === 'cleanup-failed') { assert.equal(h.broker.state, 'parked'); assert.equal(h.broker.attachments.has('new-orphan'), true); }
  });
}

test('the host fence matches the app filter: app-mode denials, a session on page commands, attach only to admitted targets', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  for (const [method, params] of [['Runtime.evaluate', { expression: '1' }], ['Fetch.enable', {}], ['Input.dispatchKeyEvent', { type: 'keyDown' }],
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }], ['Page.navigate', { url: 'https://x.example/' }],
    ['Target.setDiscoverTargets', { discover: true, filter: [{}] }], ['Target.attachToTarget', { targetId: 'T1' }],
    ['Target.attachToTarget', { targetId: 'T1', flatten: true, waitForDebuggerOnStart: true }]])
    await assert.rejects(h.broker.transportSend(client, { method, params }), /CDP_COMMAND_REFUSED/, method);
  assert.deepEqual(methods(h), ['Browser.getVersion'], 'nothing sessionless beyond the browser and target reads reaches the app');
  for (const targetId of ['D1', 'W1']) await assert.rejects(attach(h, client, targetId), /CDP_TARGET_NOT_OWNED/);
  assert.ok(!h.frames.some(frame => frame.method === 'Target.attachToTarget'), 'DevTools and workers are never attached');
  const sessionId = await attach(h, client);
  for (const method of ['Page.close', 'Page.crash', 'Emulation.setFocusEmulationEnabled', 'Target.createTarget', 'Target.closeTarget'])
    await assert.rejects(h.broker.transportSend(client, { method, params: {}, sessionId }), /CDP_COMMAND_REFUSED/, method);
  await assert.rejects(h.broker.transportSend(client, { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId }),
    /CDP_COMMAND_REFUSED/, 'child auto-attach must ask for frames only');
  await h.broker.transportSend(client, { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'iframe' }, { exclude: true }] }, sessionId });
  await h.broker.transportSend(client, { method: 'Target.setDiscoverTargets', params: { discover: true } });
  assert.deepEqual(await h.broker.transportSend(client, { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }), { ok: true });
  assert.equal(h.broker.state, 'ready');
  const closed = await ready({ admitTarget: undefined });
  await assert.rejects(attach(closed, closed.broker.connect('a')), /CDP_TARGET_NOT_OWNED/, 'without a parent callback nothing is attachable');
});

test('private NUL events become v3 session events; malformed events and replies fault the pipe', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output });
  const seen = [];
  transport.on('event', frame => seen.push(frame));
  output.write('{"method":"Page.frameNavigated","params":{"a":1},"sessionId":"S1"}\0{"method":"Target.targetCreated"}\0');
  await tick();
  assert.deepEqual(seen, [{ method: 'Page.frameNavigated', params: { a: 1 }, sessionId: 'S1' }, { method: 'Target.targetCreated', params: {} }]);
  assert.ok(Object.isFrozen(seen[0]));
  for (const bad of ['{"method":"nodots"}', '{"method":"A.b","params":[]}', '{"method":"A.b","sessionId":""}', '{"method":5}']) {
    const faulty = new PipeTransport({ input: new PassThrough(), output: new PassThrough() });
    let fault;
    faulty.on('fault', error => { fault = error; });
    faulty.output.write(bad + '\0');
    await tick();
    assert.match(fault?.message, /invalid pipe event/, bad);
  }
  const throwing = new PipeTransport({ input: new PassThrough(), output: new PassThrough() });
  throwing.on('event', () => { throw Error('listener bug'); });
  throwing.output.write('{"method":"A.b"}\0'); await tick();
  assert.equal(throwing.failed, false, 'a throwing listener is not a pipe fault');
});

test('a reply must come on its request route and carry exactly one of result or error', async () => {
  for (const reply of ['{"id":1,"result":{},"sessionId":"S2"}', '{"id":1,"result":{},"error":{}}', '{"id":1}']) {
    const input = new PassThrough(), output = new PassThrough();
    const transport = new PipeTransport({ input, output, timeoutMs: 100 });
    const pending = transport.request('A.b', {}, { sessionId: 'S1' });
    output.write(reply.replace('S2', 'S2') + '\0');
    await assert.rejects(pending, /invalid pipe reply/, reply);
    assert.equal(transport.failed, true);
    assert.equal(input.destroyed, false);
  }
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output });
  const pending = transport.request('A.b', {}, { sessionId: 'S1' });
  output.write('{"id":1,"result":{"ok":1},"sessionId":"S1"}\0');
  assert.deepEqual(await pending, { ok: 1 });
});

test('bounds: oversized outbound, invalid commands and a full queue are refused without touching the pipe', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output, maxFrameBytes: 64, maxPending: 2, timeoutMs: 30 });
  await assert.rejects(transport.request('A.b', { value: 'x'.repeat(100) }), /too large/);
  await assert.rejects(transport.request('', {}), /invalid/);
  await assert.rejects(transport.request('A.b', []), /invalid/);
  await assert.rejects(transport.request('A.b', {}, { sessionId: '' }), /invalid/);
  const a = transport.request('A.b'), b = transport.request('A.c');
  await assert.rejects(transport.request('A.d'), /queue/);
  await Promise.allSettled([a, b]);
  assert.equal(input.destroyed, false);
});

test('transport methods: browser-wide and foreground commands are refused, page commands pass', () => {
  for (const method of ['Browser.close', 'Browser.crash', 'Browser.setDownloadBehavior', 'Page.bringToFront', 'Target.activateTarget', 'Target.createTarget',
    'Target.closeTarget', 'Target.sendMessageToTarget', 'Network.getAllCookies', 'Page.setDownloadBehavior', 'SystemInfo.getInfo', 'nodots', 'A.b.c', '']) {
    assert.equal(transportMethodAllowed(method), false, method);
  }
  for (const method of ['Browser.getVersion', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Target.attachToTarget', 'Target.setAutoAttach', 'Page.captureScreenshot']) {
    assert.equal(transportMethodAllowed(method), true, method);
  }
});

test('transportSend gates by client, epoch and method before any pipe write', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  await assert.rejects(h.broker.transportSend({ ...client }, { method: 'Runtime.evaluate' }), /unauthenticated/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Browser.close' }), /CDP_COMMAND_REFUSED/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', params: [] }), /CDP_COMMAND_REFUSED/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate' , sessionId: 'S404' }), /CDP_SESSION_NOT_OWNED/);
  assert.deepEqual(methods(h), ['Browser.getVersion']);
  const sessionId = await attach(h, client);
  assert.deepEqual(await h.broker.transportSend(client, { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }), { ok: true });
  assert.equal(h.broker.state, 'ready');
});

test('a command the app answers with an error is an ordinary failure and does not park', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const { sessionId } = await h.broker.transportSend(client, { method: 'Target.attachToTarget', params: { targetId: 'T', flatten: true } });
  await assert.rejects(h.broker.transportSend(client, { method: 'Page.fail', sessionId }), error => error.cdp === true && error.dispatched === true);
  assert.equal(h.broker.state, 'ready');
});

test('sessions: a client may only use, detach or be told about sessions its own attach created', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const before = h.frames.length;
  // The route id and every session id named inside params are checked before anything is written.
  await assert.rejects(h.broker.transportSend(a, { method: 'Runtime.evaluate', sessionId: theirs }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: theirs } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: 'S404' } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: 7 } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Page.enable', params: { targetSessionId: theirs }, sessionId: mine }), /CDP_SESSION_NOT_OWNED/);
  assert.equal(h.frames.length, before, 'no forged command reached the app');
  assert.equal(h.broker.routes.get(theirs).client, b, 'the other client keeps its session');
  await h.broker.transportSend(b, { method: 'Runtime.evaluate', sessionId: theirs });
  await h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: mine } });
  assert.equal(h.broker.routes.has(mine), false);
});

test('the identity check awaited inside transportSend cannot be used to smuggle a foreign session past the check', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const params = { sessionId: mine };
  const call = h.broker.transportSend(a, { method: 'Target.detachFromTarget', params });
  await tick();
  // The caller keeps its params object; changing it while the check awaits must not matter.
  params.sessionId = theirs;
  const before = h.frames.length;
  release();
  await assert.rejects(call, /CDP_SESSION_NOT_OWNED/);
  assert.equal(h.frames.length, before);
  assert.equal(h.broker.routes.get(theirs).client, b);
});

test('events: session events go to the owner; browser-level events naming a session go to its owner only', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const seen = [];
  h.broker.on('routed', (client, frame) => seen.push([client === a ? 'a' : client === b ? 'b' : 'all', frame.method, frame.sessionId ?? frame.params?.sessionId]));
  const emit = frame => h.output.write(JSON.stringify(frame) + '\0');
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: mine });
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: theirs });
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'S404' });
  emit({ method: 'Target.attachedToTarget', params: { sessionId: theirs, targetInfo: { targetId: 'T2' } } });
  emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S404', targetInfo: { targetId: 'T9' } } });
  emit({ method: 'Target.attachedToTarget', params: { targetInfo: { targetId: 'T9' } } });
  emit({ method: 'Target.receivedMessageFromTarget', params: { sessionId: mine, message: '{}' } });
  emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3' } } });
  emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T1', url: 'app://main/next' } } });
  emit({ method: 'Target.targetDestroyed', params: { targetId: 'T2' } });
  emit({ method: 'Target.targetCrashed', params: { targetId: 'T9' } });
  emit({ method: 'Target.targetInfoChanged', params: {} });
  await tick();
  // Target lifecycle events go only to the client attached to that target; a target nobody holds tells nobody.
  assert.deepEqual(seen, [
    ['a', 'Page.loadEventFired', mine], ['b', 'Page.loadEventFired', theirs],
    ['b', 'Target.attachedToTarget', theirs], ['a', 'Target.receivedMessageFromTarget', mine],
    ['a', 'Target.targetInfoChanged', undefined], ['b', 'Target.targetDestroyed', undefined]]);
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: theirs } });
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: mine }, sessionId: 'S404' });
  await tick();
  assert.equal(seen.at(-1)[0], 'b', 'a detach event reaches the owner and drops the route');
  assert.equal(h.broker.routes.has(theirs), false);
  assert.equal(h.broker.routes.has(mine), true, 'a detach event for an unrelated route cannot drop a session');
});

test('child sessions announced under an owned session belong to the same client; the route bank is bounded', async () => {
  const h = await ready({ maxRoutes: 3 });
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const parent = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-1', targetInfo: { targetId: 'F1' } }, sessionId: parent }) + '\0');
  await tick();
  assert.equal(h.broker.routes.get('child-1').client, a);
  await assert.rejects(h.broker.transportSend(b, { method: 'Runtime.evaluate', sessionId: 'child-1' }), /CDP_SESSION_NOT_OWNED/);
  await h.broker.transportSend(a, { method: 'Runtime.evaluate', sessionId: 'child-1' });
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-2', targetInfo: {} }, sessionId: parent }) + '\0');
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-3', targetInfo: {} }, sessionId: parent }) + '\0');
  await tick();
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.parkedBy.reason, 'route bank full');
  assert.equal(h.input.destroyed, false);
});

test('a lost worker: its sessions are detached in the app, other clients keep theirs, the writer stays open', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  h.broker.detach(a);
  await tick();
  assert.ok(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === mine));
  assert.ok(!h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === theirs));
  assert.equal(h.broker.routes.has(mine), false);
  assert.equal(h.broker.state, 'ready');
  assert.equal(h.input.destroyed, false);
  await assert.rejects(h.broker.transportSend(a, { method: 'Runtime.evaluate' }), /unauthenticated/);
});

test('revocation during the identity check: the delayed command is never written', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const call = h.broker.transportSend(client, { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown' }, sessionId });
  await tick();
  h.broker.revoke('user revoked');
  release();
  await assert.rejects(call, /parked/);
  assert.ok(!h.frames.some(frame => frame.method === 'Input.dispatchKeyEvent'));
  assert.equal(h.input.destroyed, false);
  assert.equal(h.broker.status().parked.resumable, true);
});

test('PID reuse: a different birth time parks before the command is written; a stale check is not reused', async () => {
  let now = 0;
  const h = await ready({ now: () => now, identityMaxAgeMs: 1000 });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let inspections = 0;
  const original = h.child.inspect;
  h.child.inspect = async () => { inspections++; return original(); };
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  assert.equal(inspections, 0, 'a fresh check is reused inside its window');
  now = 5000;
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'recycled' }, descendants: [], complete: true });
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /identity/);
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.status().parked.resumable, false);
  assert.deepEqual(methods(h), ['Browser.getVersion', 'Target.getTargetInfo', 'Target.attachToTarget', 'Runtime.evaluate@S1', 'Runtime.evaluate@S1']);
  await assert.rejects(h.broker.resume(async () => true), /not resumable/);
});

test('an incomplete census or a vanished parent parks; a child exit parks immediately', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  h.child.inspect = async () => ({ descendants: [], complete: true });
  h.broker.verifiedAt = -Infinity;
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /census/);
  assert.equal(h.broker.state, 'parked');
  const exited = await ready();
  exited.child.events.emit('exit', 0);
  assert.equal(exited.broker.state, 'parked');
  assert.equal(exited.broker.parkedBy.reason, 'child exited');
});

test('timeouts and cancellation leave the effect unknown: park, resumable, never replayed', async () => {
  const h = await ready({ transport: { timeoutMs: 20 } });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  h.hang.add('Input.dispatchKeyEvent');
  await assert.rejects(h.broker.transportSend(client, { method: 'Input.dispatchKeyEvent', sessionId }), error => error.dispatched === true && /effect unknown/.test(error.message));
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.frames.filter(frame => frame.method === 'Input.dispatchKeyEvent').length, 1);
  h.hang.clear();
  assert.equal((await h.broker.resume(async () => true)).event, 'resumed');
  assert.equal(h.frames.filter(frame => frame.method === 'Input.dispatchKeyEvent').length, 1, 'resume replays nothing');
  const aborted = await ready();
  aborted.hang.add('Input.dispatchKeyEvent');
  const controller = new AbortController();
  const other = aborted.broker.connect('b'), first = aborted.broker.connect('a');
  const route = await attach(aborted, first);
  const call = aborted.broker.transportSend(first, { method: 'Input.dispatchKeyEvent', sessionId: route }, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(call, /effect unknown/);
  assert.equal(aborted.input.destroyed, false);
  await assert.rejects(aborted.broker.transportSend(other, { method: 'Runtime.evaluate' }), /parked/);
});

test('resume needs authority, a quiescent healthy pipe, and the same app incarnation; clients must reconnect', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  h.broker.revoke('disconnect');
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate' }), /parked/);
  await assert.rejects(h.broker.resume(), /authority/);
  await assert.rejects(h.broker.resume(async () => false), /authority/);
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'other' }, descendants: [], complete: true });
  await assert.rejects(h.broker.resume(async () => true), /identity/);
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.status().parked.resumable, false, 'a failed resume is final');
  const second = await ready();
  second.broker.revoke('disconnect');
  const receipt = await second.broker.resume(async () => true);
  assert.equal(receipt.event, 'resumed');
  await assert.rejects(second.broker.transportSend(client, { method: 'Runtime.evaluate' }), /unauthenticated/);
  assert.ok(second.broker.connect('again'));
  const faulted = await ready();
  faulted.broker.revoke('x');
  faulted.output.end(); await tick();
  await assert.rejects(faulted.broker.resume(async () => true), /not resumable|quiescent/);
});

test('descendants are handed to the durable journal before the next command relies on them', async () => {
  const observed = [];
  const h = await ready({ ownership: { reserve: async () => ({}), record: async () => {}, remove: async () => {}, observe: async (_o, fresh) => observed.push(...fresh) } });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  const original = h.child.inspect;
  h.child.inspect = async () => ({ ...(await original()), descendants: [{ pid: 101, birth: 'kid' }] });
  h.broker.verifiedAt = -Infinity;
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await h.broker.inspect();
  assert.deepEqual(observed, [{ pid: 101, birth: 'kid' }], 'each incarnation is journaled once');
  h.child.inspect = async () => ({ ...(await original()), descendants: [{ pid: 102, birth: 'kid2' }] });
  h.broker.ownership.observe = async () => { throw Error('journal write failed'); };
  h.broker.verifiedAt = -Infinity;
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /journal/);
  assert.equal(h.broker.state, 'parked', 'an unrecorded descendant fails closed');
});

test('a full authorization queue refuses new commands without parking', async () => {
  const h = await ready({ maxTransportQueue: 1 });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const first = h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await tick();
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /queue full/);
  release(); await first;
  assert.equal(h.broker.state, 'ready');
});
