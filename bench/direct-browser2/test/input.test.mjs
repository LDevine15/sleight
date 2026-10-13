import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInputController, inspectNode } from '../input.mjs';
import { Deadline } from '../waits.mjs';

const identity = { browserIncarnation: 'b1', brokerEpoch: 1, clientSession: 's1', turn: 'turn1',
  leaseGeneration: 1, targetId: 't1', frameId: 'f1', documentEpoch: 1, origin: 'http://127.0.0.1' };
const request = (id = 'op1', extra = {}) => ({ ...identity, operationId: id, sequence: 1,
  ref: 'r1', op: 'click', expect: { kind: 'state', field: 'checked', equals: true }, ...extra });

function fixture(options = {}) {
  const events = new EventEmitter();
  const calls = [];
  let dispatches = 0;
  let observed = false;
  const session = { sessionId: 'cdp1', on: events.on.bind(events), off: events.off.bind(events),
    async send(method, params) {
      assert.match(method, /^(Input\.(dispatchMouseEvent|dispatchKeyEvent|insertText)|Page\.handleJavaScriptDialog)$/);
      calls.push({ method, params });
      dispatches++;
      if (options.send) return options.send(method, params, events);
      if (params.type === 'mouseReleased') {
        observed = true;
        events.emit('DOM.documentUpdated', {});
      }
      return {};
    } };
  const resolved = { ...identity, session, rootSession: session, backendNodeId: 7, executionContextId: 2 };
  let checks = 0;
  const hooks = {
    resolve: async () => resolved,
    authorize: async () => ({ allowed: true }),
    fence: async () => ({ ...identity }),
    inspect: async () => ({ connected: true, visible: true, enabled: true, editable: true,
      hit: true, focused: true, rect: { x: 1, y: 2, width: 30, height: 20 } }),
    observe: async () => { checks++; return { matched: observed, complete: true, unchanged: !observed,
      documentEpoch: 1, source: 'native' }; },
    ...options.hooks,
  };
  return { controller: createInputController(hooks), calls, session, events, resolved,
    get checks() { return checks; }, get dispatches() { return dispatches; } };
}

test('trusted click arms events first and verifies an effect, never the CDP acknowledgement', async () => {
  const f = fixture({ send: async (method, params, events) => {
    assert.ok(events.listenerCount('Page.frameNavigated'));
    assert.ok(events.listenerCount('Page.windowOpen'));
    assert.ok(events.listenerCount('Page.downloadWillBegin'));
    if (params.type === 'mouseReleased') events.emit('Page.frameNavigated', { frame: { id: 'f1', loaderId: 'new' } });
    return {};
  }, hooks: { observe: async () => ({ matched: true, complete: true, documentEpoch: 1, source: 'native' }) } });
  const r = await f.controller.act(request());
  assert.equal(r.phase, 'verified');
  assert.equal(r.effect, 'verified');
  assert.deepEqual(f.calls.map(c => c.params.type), ['mousePressed', 'mouseReleased']);
  assert.equal(f.events.eventNames().length, 0);
});

for (const [field, code] of [['visible', 'NOT_VISIBLE'], ['enabled', 'DISABLED'], ['hit', 'COVERED']]) {
  test(`${field} refusal sends no trusted input`, async () => {
    const f = fixture({ hooks: { inspect: async () => ({ connected: true, visible: true, enabled: true,
      editable: true, hit: true, rect: { x: 1, y: 1, width: 20, height: 20 }, [field]: false }) } });
    assert.equal((await f.controller.act(request())).code, code);
    assert.equal(f.dispatches, 0);
  });
}

test('read-only and unfocused text controls refuse insertion', async () => {
  for (const field of ['editable', 'focused']) {
    const f = fixture({ hooks: { inspect: async () => ({ connected: true, visible: true, enabled: true,
      editable: true, focused: true, hit: true, rect: { x: 1, y: 1, width: 20, height: 20 }, [field]: false }) } });
    const r = await f.controller.act(request('type1', { op: 'insertText', text: 'private value' }));
    assert.equal(r.effect, 'none');
    assert.equal(f.dispatches, 0);
    assert.ok(!JSON.stringify(r).includes('private value'));
  }
});

test('moving target is not dispatched at old coordinates', async () => {
  let n = 0;
  const f = fixture({ hooks: { inspect: async () => ({ connected: true, visible: true, enabled: true,
    hit: true, rect: { x: ++n, y: 0, width: 20, height: 20 } }) } });
  assert.equal((await f.controller.act(request())).code, 'UNSTABLE');
  assert.equal(f.dispatches, 0);
});

test('gate and document are rechecked after preparation and before each input part', async () => {
  let count = 0;
  const f = fixture({ hooks: { fence: async () => ({ ...identity, documentEpoch: ++count < 3 ? 1 : 2 }) } });
  const r = await f.controller.act(request());
  assert.equal(r.effect, 'none');
  assert.equal(r.code, 'STALE_REF');
  assert.equal(f.dispatches, 0);
  const denied = fixture({ hooks: { authorize: async () => ({ allowed: false }) } });
  assert.equal((await denied.controller.act(request())).code, 'PERMISSION_REQUIRED');
  assert.equal(denied.dispatches, 0);
});

test('timeout after dispatch stays unknown, deduplicates, and fences repeated Pay IDs', async () => {
  const f = fixture({ send: () => new Promise(() => {}) });
  const r = await f.controller.act(request('pay1', { timeout_ms: 75 }));
  assert.equal(r.effect, 'unknown');
  assert.equal(r.next, 'browser_read');
  assert.deepEqual(await f.controller.act(request('pay1', { timeout_ms: 75 })), r);
  assert.equal((await f.controller.act(request('pay2'))).code, 'EFFECT_UNKNOWN');
  assert.equal(f.dispatches, 1);
});

test('non-Error transport rejection preserves unknown input and blocks another operation ID', async () => {
  const f = fixture({ send: async (method, params) => {
    assert.equal(method, 'Input.dispatchMouseEvent');
    assert.equal(params.type, 'mousePressed');
    throw null;
  } });
  const op = request('first', { timeout_ms: 1000 });
  const first = await f.controller.act(op);
  const second = await f.controller.act({ ...op, operationId: 'second' });
  assert.equal(first.effect, 'unknown', 'send was invoked; null rejection cannot prove no input');
  assert.equal(second.effect, 'none');
  assert.equal(second.code, 'EFFECT_UNKNOWN');
  assert.equal(f.dispatches, 1, 'another ID cannot repeat the indeterminate input');
  assert.deepEqual(await f.controller.act(op), first);
  assert.equal(f.events.eventNames().length, 0);
});

test('arbitrary rejections retain sent state and never expose rejection data', async () => {
  const privateValue = 'private transport data';
  const hostile = Object.defineProperty({}, 'code', { get() { throw null; } });
  for (const error of [null, undefined, privateValue, 7, { code: privateValue }, hostile]) {
    for (const sent of [false, true]) {
      const journal = new Map();
      const hooks = sent ? { journal } : { journal, resolve: async () => { throw error; } };
      const f = fixture({ hooks, send: async () => { throw error; } });
      const op = request('arbitrary', { timeout_ms: 1000 });
      const first = await f.controller.act(op);
      assert.equal(first.effect, sent ? 'unknown' : 'none');
      assert.equal(first.code, sent ? 'EFFECT_UNKNOWN' : 'ADAPTER_FAILURE');
      assert.deepEqual(await f.controller.act(op), first);
      assert.deepEqual([...journal.values()][0].receipt, first);
      assert.ok(!JSON.stringify(first).includes(privateValue));
      const second = await f.controller.act({ ...op, operationId: 'second' });
      assert.equal(second.effect, 'none');
      assert.equal(second.code, sent ? 'EFFECT_UNKNOWN' : 'ADAPTER_FAILURE');
      assert.equal(f.dispatches, sent ? 1 : 0);
    }
  }
});

test('outer error handling retains the write-ahead receipt if listener cleanup throws', async () => {
  const f = fixture({ send: async () => { throw null; } });
  f.session.off = () => { throw undefined; };
  const first = await f.controller.act(request('cleanup', { timeout_ms: 1000 }));
  assert.equal(first.effect, 'unknown');
  assert.equal(first.code, 'EFFECT_UNKNOWN');
  const second = await f.controller.act(request('second'));
  assert.equal(second.effect, 'none');
  assert.equal(second.code, 'EFFECT_UNKNOWN');
  assert.equal(f.dispatches, 1);
  f.events.removeAllListeners();
});

test('operation ID reuse with different arguments is refused', async () => {
  const f = fixture();
  await f.controller.act(request());
  assert.equal((await f.controller.act(request('op1', { op: 'key', key: 'Enter' }))).code, 'OPERATION_REUSED');
  assert.equal(f.dispatches, 2);
});

test('one semantic deadline covers preparation, input and effect proof', async () => {
  let now = 0;
  const f = fixture({ hooks: { now: () => now,
    inspect: async () => { now += 9; return { connected: true, visible: true, enabled: true, hit: true,
      rect: { x: 1, y: 1, width: 20, height: 20 } }; } } });
  const r = await f.controller.act(request('budget', { timeout_ms: 25 }));
  assert.equal(r.code, 'DEADLINE');
  assert.equal(r.effect, 'none');
  assert.equal(f.dispatches, 0);
});

test('late underlying preparation cannot dispatch after timeout or cancellation', async () => {
  let release;
  const f = fixture({ hooks: { resolve: () => new Promise(r => { release = r; }) } });
  const r = await f.controller.act(request('late', { timeout_ms: 20 }));
  release(f.resolved);
  await new Promise(r => setImmediate(r));
  assert.equal(r.effect, 'none');
  assert.equal(f.dispatches, 0);
  const abort = new AbortController();
  abort.abort();
  const cancelled = await f.controller.act(request('cancel'), { signal: abort.signal });
  assert.equal(cancelled.code, 'CANCELLED');
});

test('batch returns completed prefix and untouched suffix at first barrier', async () => {
  const f = fixture({ hooks: { authorize: async op => ({ allowed: op.operationId !== 'blocked' }) } });
  const r = await f.controller.batch([request('first'), request('blocked'), request('untouched')]);
  assert.equal(r.completed.length, 1);
  assert.equal(r.stopped.code, 'PERMISSION_REQUIRED');
  assert.deepEqual(r.untouched, ['untouched']);
  assert.equal(f.dispatches, 2);
});

test('targets overlap but same target serializes through proof', async () => {
  const f = fixture();
  const r = await Promise.all([f.controller.act(request('a')), f.controller.act(request('b'))]);
  assert.ok(r.every(x => x.effect === 'verified'));
  assert.deepEqual(f.calls.map(x => x.params.type), ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
  let release;
  const gate = new Promise(r => { release = r; });
  const g = fixture({ hooks: { resolve: async op => {
    if (op.targetId === 't1') await gate;
    return { ...g.resolved, targetId: op.targetId };
  }, fence: async op => ({ ...identity, targetId: op.targetId }) } });
  const pending = g.controller.act(request('slow'));
  assert.equal((await g.controller.act(request('fast', { targetId: 't2' }))).effect, 'verified');
  release();
  await pending;
});

test('dialog is an observed barrier; successful transport without proof remains unchanged', async () => {
  const f = fixture({ send: async (m, p, e) => {
    if (p.type === 'mouseReleased') e.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'SECRET' });
  }, hooks: { observe: async () => ({ matched: false, complete: true, unchanged: true, documentEpoch: 1 }) } });
  const r = await f.controller.act(request());
  assert.equal(r.code, 'DIALOG_OPEN');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const noEffect = fixture({ send: async () => ({}), hooks: { observe: async () => ({ matched: false,
    complete: true, unchanged: true, documentEpoch: 1 }) } });
  assert.equal((await noEffect.controller.act(request('no', { timeout_ms: 75 }))).effect, 'unchanged');
});

test('closed predicate grammar and absent trusted hooks fail closed', async () => {
  const f = fixture();
  assert.equal((await f.controller.act(request('bad', { expect: { kind: 'evaluate', code: '1' } }))).code, 'INVALID_OPERATION');
  assert.equal((await createInputController({}).act(request())).code, 'ADAPTER_UNAVAILABLE');
  assert.equal(f.dispatches, 0);
});

test('fixed inspector uses CDP node and isolated world, no DOM click or focus workaround', async () => {
  const calls = [];
  const session = { sessionId: 'session', async send(method, params) {
    calls.push({ method, params });
    if (method === 'DOM.scrollIntoViewIfNeeded') return {};
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { connected: true } } };
    if (method === 'Runtime.releaseObject') return {};
    throw new Error('Unexpected CDP method ' + method);
  } };
  await inspectNode({ session, backendNodeId: 7, executionContextId: 12 }, new Deadline(100));
  assert.equal(calls[1].params.executionContextId, 12);
  assert.ok(!calls.some(c => /bringToFront|Emulation/.test(c.method)));
  assert.ok(!calls[2].params.functionDeclaration.includes('.click('));
});

test('cancellation after mouse press is indeterminate and never schedules release later', async () => {
  const abort = new AbortController();
  const f = fixture({ send: async () => { abort.abort(); return {}; } });
  const r = await f.controller.act(request('cancel-sent'), { signal: abort.signal });
  assert.equal(r.effect, 'unknown');
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.eventNames().length, 0);
});

test('hidden mouseMoved five-second regression uses the existing budget without focus emulation', async () => {
  let now = 0;
  const f = fixture({ hooks: { now: () => now }, send: async (method, params) => {
    assert.equal(method, 'Input.dispatchMouseEvent');
    assert.equal(params.type, 'mouseMoved');
    now += 5000;
    return {};
  } });
  assert.equal((await f.controller.act(request('hidden', { op: 'hover' }))).effect, 'unknown');
  assert.equal(f.calls.length, 1);
});

test('wrong-document and page-reported matching state cannot independently verify an action', async () => {
  for (const proof of [{ matched: true, complete: true, source: 'native', documentEpoch: 2 },
    { matched: true, complete: true, source: 'page-reported', documentEpoch: 1 }]) {
    const f = fixture({ hooks: { observe: async () => proof } });
    assert.notEqual((await f.controller.act(request('proof', { timeout_ms: 75 }))).effect, 'verified');
  }
});

test('frame-local coordinates require qualified parent hit test and root conversion', async () => {
  const f = fixture({ hooks: { inspect: async () => ({ connected: true, visible: true, enabled: true,
    hit: true, frameLocal: true, rect: { x: 1, y: 1, width: 20, height: 20 } }) } });
  assert.equal((await f.controller.act(request())).code, 'FRAME_UNQUALIFIED');
  assert.equal(f.dispatches, 0);
});

test('retained unknown journal survives new broker epoch without replay', async () => {
  const journal = new Map();
  const f = fixture({ hooks: { journal }, send: () => new Promise(() => {}) });
  await f.controller.act(request('once', { timeout_ms: 75 }));
  const reconnected = fixture({ hooks: { journal,
    resolve: async () => ({ ...reconnected.resolved, brokerEpoch: 2 }),
    fence: async () => ({ ...identity, brokerEpoch: 2 }) } });
  assert.equal((await reconnected.controller.act(request('new', { brokerEpoch: 2 }))).code, 'EFFECT_UNKNOWN');
  assert.equal(reconnected.dispatches, 0);
});

test('batch deadline cannot multiply per-step budgets', async () => {
  const f = fixture();
  const r = await f.controller.batch([request('one'), request('two'), request('three')], { timeout_ms: 50 });
  assert.equal(r.completed.length, 1);
  assert.equal(r.stopped.effect, 'none');
  assert.deepEqual(r.untouched, ['three']);
  assert.equal(f.dispatches, 2);
});

test('delayed and out-of-order wakeups never become effect proof or a second dispatch', async () => {
  let release;
  let matched = false;
  const barrier = new Promise(r => { release = r; });
  const f = fixture({ send: async (method, params, events) => {
    if (params.type === 'mouseReleased') {
      events.emit('Page.frameNavigated', { frame: { id: 'other-frame' } });
      events.emit('Page.downloadWillBegin', { guid: 'unattributed' });
      queueMicrotask(() => { matched = true; release(); events.emit('DOM.documentUpdated', {}); });
    }
    return {};
  }, hooks: { observe: async () => { await barrier; return { matched, complete: true, documentEpoch: 1, source: 'native' }; } } });
  assert.equal((await f.controller.act(request())).effect, 'verified');
  assert.equal(f.dispatches, 2);
});

test('pre-armed dialog interrupts a stalled input reply and preserves the batch suffix', async () => {
  const f = fixture({ send: async (method, params, events) => {
    if (params.type === 'mouseReleased') {
      events.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'private page message' });
      return new Promise(() => {});
    }
    return {};
  } });
  const r = await f.controller.batch([request('confirm', { expect: { kind: 'dialog', type: 'confirm' } }), request('suffix')]);
  assert.equal(r.stopped.code, 'DIALOG_OPEN');
  assert.equal(r.stopped.effect, 'verified');
  assert.deepEqual(r.untouched, ['suffix']);
  assert.equal(f.dispatches, 2);
});

test('new-document proof requires a fresh site authorization and the actual document epoch', async () => {
  for (const allowed of [true, false]) {
    let epoch = 1;
    let observations = 0;
    const f = fixture({ send: async (m, p) => { if (p.type === 'mouseReleased') epoch = 2; return {}; },
      hooks: { fence: async () => ({ ...identity, documentEpoch: epoch, origin: epoch === 1 ? identity.origin : 'http://127.0.0.1:9000' }),
        authorizeObservation: async (op, current) => { assert.equal(current.documentEpoch, 2); return { allowed }; },
        observe: async () => { observations++; return { matched: true, complete: true, documentEpoch: 2, source: 'causal-event' }; } } });
    const r = await f.controller.act(request('nav', { expect: { kind: 'navigation' } }));
    assert.equal(r.effect, allowed ? 'verified' : 'unknown');
    assert.equal(observations, allowed ? 1 : 0);
  }
});

test('fake-CDP action/proof workload at 1/4/13 reports raw phase samples without a browser speed claim', async t => {
  for (const n of [1, 4, 13]) {
    const samples = [];
    for (let trial = 0; trial < 3; trial++) {
      const lanes = Array.from({ length: n }, () => fixture());
      const results = await Promise.all(lanes.map((f, i) => f.controller.act(request(`measure-${trial}-${i}`))));
      assert.ok(results.every(r => r.effect === 'verified'));
      samples.push(...results.map(r => r.timing));
    }
    const percentile = q => samples.map(r => r.total_ms).sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1];
    t.diagnostic(JSON.stringify({ workload: 'fake-CDP-three-stability-samples', concurrency: n,
      trials: 3, forbidden_effects: 0, p50_ms: percentile(.5), p90_ms: percentile(.9), samples }));
  }
});
test('real input fixtures register six named skips without enabling a browser or loading Playwright', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', new URL('./input.real.test.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, SLEIGHT_LIVE_DOM_TEST: '0' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# tests 6\b/);
  assert.match(result.stdout, /# pass 0\b/);
  assert.match(result.stdout, /# fail 0\b/);
  assert.match(result.stdout, /# skipped 6\b/);
});

for (const reason of ['timeout', 'cancel']) {
  test(`a ${reason} in queued work cannot release its active target predecessor`, async () => {
    let markPressed;
    const pressed = new Promise(resolve => { markPressed = resolve; });
    let release;
    const firstReply = new Promise(resolve => { release = resolve; });
    let first = true;
    const f = fixture({ send: async (method, params) => {
      if (first && params.type === 'mousePressed') { first = false; markPressed(); await firstReply; }
      return {};
    }, hooks: { observe: async () => ({ matched: true, complete: true, documentEpoch: 1, source: 'native' }) } });
    const active = f.controller.act(request('active', { timeout_ms: 2000 }));
    await pressed;
    try {
      const abort = new AbortController();
      const queued = f.controller.act(request('queued', { timeout_ms: reason === 'timeout' ? 10 : 2000 }), { signal: abort.signal });
      if (reason === 'cancel') abort.abort();
      assert.equal((await queued).code, reason === 'cancel' ? 'CANCELLED' : 'DEADLINE');
      const third = await f.controller.act(request('third', { timeout_ms: 75 }));
      assert.equal(f.calls.length, 1, 'only the first press may dispatch before its reply');
      assert.equal(third.effect, 'none');
    } finally { release(); await active; }
    assert.equal((await f.controller.act(request('after'))).effect, 'verified');
    assert.equal(f.calls.length, 4);
  });
}

for (const field of ['leaseGeneration', 'clientSession', 'documentEpoch', 'origin', 'grant']) {
  test(`a ${field} change during proof cannot verify dispatched input`, async () => {
    let current = { ...identity };
    let allowed = true;
    const f = fixture({ hooks: {
      fence: async () => ({ ...current }),
      authorize: async () => ({ allowed }),
      observe: async () => {
        if (field === 'grant') allowed = false;
        else current[field] = typeof current[field] === 'number' ? current[field] + 1 : 'changed';
        return { matched: true, complete: true, documentEpoch: 1, source: 'native' };
      },
    } });
    const receipt = await f.controller.act(request('revoked'));
    assert.equal(receipt.effect, 'unknown');
    assert.equal(f.dispatches, 2);
    assert.notEqual((await f.controller.act(request('retry'))).effect, 'verified');
    assert.equal(f.dispatches, 2);
  });
}

for (const reason of ['lease', 'document', 'grant']) {
  test(`new-document proof rechecks its ${reason} after observing`, async () => {
    let current = { ...identity };
    let allowed = true;
    const f = fixture({ send: async (method, params) => {
      if (params.type === 'mouseReleased') current = { ...identity, documentEpoch: 2, origin: 'http://127.0.0.1:9000' };
      return {};
    }, hooks: {
      fence: async () => ({ ...current }),
      authorizeObservation: async () => ({ allowed }),
      observe: async () => {
        if (reason === 'lease') current.leaseGeneration++;
        if (reason === 'document') current.documentEpoch++;
        if (reason === 'grant') allowed = false;
        return { matched: true, complete: true, documentEpoch: 2, source: 'causal-event' };
      },
    } });
    assert.equal((await f.controller.act(request('navigate', { expect: { kind: 'navigation' } }))).effect, 'unknown');
    assert.equal(f.dispatches, 2);
  });
}

// BP2-6R review: authority can change while the allow response is pending.
for (const part of ['mousePressed', 'mouseReleased']) test(`lease revoked during ${part} authorization fences that input part`, async () => {
  let enter, release, checks = 0, current = { ...identity };
  const entered = new Promise(r => { enter = r; });
  const gate = new Promise(r => { release = r; });
  const calls = []; const events = new EventEmitter();
  const session = { sessionId: 'fake', on: events.on.bind(events), off: events.off.bind(events), async send(method, params) {
    assert.equal(method, 'Input.dispatchMouseEvent');
    assert.ok(['mousePressed', 'mouseReleased'].includes(params.type));
    calls.push({ type: params.type, lease: current.leaseGeneration });
    return {};
  } };
  const controller = createInputController({ resolve: async () => ({ ...identity, session }),
    fence: async () => ({ ...current }), authorize: async () => {
      if (++checks === (part === 'mousePressed' ? 5 : 6)) { enter(); await gate; }
      return { allowed: true };
    }, inspect: async () => ({ connected: true, visible: true, enabled: true, hit: true,
      rect: { x: 0, y: 0, width: 20, height: 20 } }),
    observe: async () => ({ matched: true, complete: true, documentEpoch: 1, source: 'native' }),
  });
  const pending = controller.act({ ...identity, operationId: 'revoked', timeout_ms: 1000, sequence: 1,
    ref: 'r1', op: 'click', expect: { kind: 'state', field: 'checked', equals: true } });
  await entered; current.leaseGeneration = 2; release();
  const receipt = await pending;
  console.log(JSON.stringify({ part, calls, effect: receipt.effect, code: receipt.code }));
  assert.equal(calls.length, part === 'mousePressed' ? 0 : 1, 'revoked authorization must not dispatch its input part');
});

for (const field of Object.keys(identity)) for (const part of ['mousePressed', 'mouseReleased']) {
  test(`${field} changing during ${part} authorization refuses that input part`, async () => {
    let current = { ...identity }, enter, release, checks = 0;
    const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
    const f = fixture({ hooks: { fence: async () => ({ ...current }), authorize: async () => {
      if (++checks === (part === 'mousePressed' ? 5 : 6)) { enter(); await gate; }
      return { allowed: true };
    } } });
    const op = request('revoked'); const pending = f.controller.act(op);
    await entered;
    current[field] = typeof current[field] === 'number' ? current[field] + 1 : `${current[field]}-revoked`;
    release(); const receipt = await pending;
    const count = part === 'mousePressed' ? 0 : 1;
    assert.equal(f.calls.length, count);
    assert.equal(receipt.effect, count ? 'unknown' : 'none');
    assert.equal((await f.controller.act(op)).effect, receipt.effect);
    assert.equal(f.calls.length, count);
  });
}

test('a queued lease change after the allow check is fenced inside the dispatch callback', async () => {
  let checks = 0, queued = false, current = { ...identity };
  const f = fixture({ hooks: { authorize: async () => { checks++; return { allowed: true }; },
    fence: async () => {
      const snapshot = { ...current };
      if (checks === 5 && !queued) { queued = true; queueMicrotask(() => { current.leaseGeneration++; }); }
      return snapshot;
    },
  } });
  const receipt = await f.controller.act(request('queued-revoke'));
  assert.ok(queued); assert.equal(f.calls.length, 0); assert.equal(receipt.effect, 'none');
});
