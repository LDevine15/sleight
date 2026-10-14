import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as authorityHost from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createFileAuthority } from '../plugins/sleight/lib/direct-browser/host-files.mjs';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
const { createAuthority, createTransportAuthority, completeTransport, completeTransportStep } = authorityHost;

// BP2-P2's FORM-HOST-PREFLIGHT, joined to this worktree's host contract.
// All data and transports are synthetic. Unknown fake methods throw.
const origin = 'https://fixture.invalid';
const scope = ref => ({ browser: 'browser', broker: 1, session: 'client', turn: 'turn',
  target: 'target', lease: 1, frame: 'frame', document: 1, ref, origin });
const context = { session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1, operation: 'form' };
const operations = ['rfirst', 'rsecond'].map((ref, i) => ({ id: 'field-' + i, kind: 'fill',
  scope: scope(ref), args: { value: 'fixture-' + i }, consequence: 'ordinary',
  transmission: { data: 'fixture-' + i, destination: origin } }));
function policy({ once = false, confirm = true, ttl = 5000, ops = operations, resolve } = {}) {
  let current = ops[0].scope, time = 100, terminal;
  const user = {}, authority = createAuthority({ current: () => current, now: () => time, ttl,
    snapshot: () => { terminal?.(); return { scope: current, time }; }, classify: op => op, authenticate: event => event === user });
  const grant = () => authority.user(user, 'grant', { session: 'client', origin, mode: once ? 'once' : 'session' });
  grant();
  if (confirm) for (const operation of ops) authority.user(user, 'confirm', { operation });
  const transport = createTransportAuthority({ authority, resolveOperation(plan, ctx, command) {
    if (command.method === 'DOM.enable') return plan.preparationOperations[0];
    assert.equal(command.method, 'Input.insertText');
    if (resolve) return resolve(command);
    const operation = ops.find(op => op.args.value === command.params.text);
    assert.ok(operation); return operation;
  } });
  return { authority, transport, grant, user, current(op) { current = op.scope; },
    clock(value) { time = value; }, terminal(fn) { terminal = fn; } };
}
function form(t, options = {}) {
  const ops = options.ops ?? operations, p = policy(options), sent = [], errors = [];
  const socket = { sessionId: 'root', on() {}, off() {}, send(method, params, route) {
    assert.ok(['Input.insertText', 'DOM.enable'].includes(method)); assert.equal(route, 'page');
    sent.push(params.text ?? 'read'); return options.send?.(method, params) ?? Promise.resolve({});
  } };
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser',
    connect: async () => socket, verifyConnection: () => true, currentTurn: () => 'turn',
    validateRequest: frame => frame, prepare: () => ({ target: 'target', orderedOperations: ops,
      ...(options.preparation ? { preparationOperations: [options.preparation] } : {}) }), authorize: () => true,
    dispatchFence: () => true, transportAuthority: p.transport, endSession: () => true,
    disconnect: () => true, redact: data => data, timeoutMs: options.timeoutMs ?? 3000,
    async dispatch(plan, ctx) {
      if (options.dispatch) return options.dispatch(plan, ctx, p, sent);
      for (const [index, op] of ops.entries()) {
        p.current(op);
        try {
          await ctx.session.send('Input.insertText', { text: op.args.value }, 'page');
          ctx.session.completeStep(index, 'verified');
        } catch (error) { errors.push(error.message); break; }
      }
      return { effect: sent.length === ops.length ? 'verified' : 'unknown', completed: sent.length,
        observation: { complete: sent.length === ops.length }, untouched: ops.length - sent.length };
    } });
  t.after(() => broker.shutdown());
  const request = async () => {
    await broker.connect({ userInitiated: true });
    const client = broker.attach({ version: 1, secret, uid, session: 'client', incarnation: 'preflight' });
    return client.request({ id: 'form', operation: 'browser_fill', args: {
      tab: 'tfixture', fields: ops.map(op => ({ ref: op.scope.ref, value: op.args.value })) } });
  };
  return { ...p, broker, request, sent, errors };
}
test('preflight control: separate plans dispatch both exact approved fields', () => {
  const p = policy(), sent = [];
  for (const op of operations) {
    p.current(op);
    p.transport({ target: 'target' }, context, { method: 'Input.insertText', params: { text: op.args.value } }, () => sent.push(op.id));
  }
  assert.deepEqual(sent, ['field-0', 'field-1']);
});
test('preflight: one browser_fill request dispatches two exact approved ordered fields', async t => {
  const f = form(t), receipt = await f.request();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.sent, ['fixture-0', 'fixture-1']);
  assert.equal(receipt.effect, 'verified'); assert.equal(receipt.completed, 2);
  assert.equal(receipt.untouched, 0); assert.equal(receipt.unknownStep, null);
  assert.equal(f.authority.receipt('field-0').phase, 'verified');
  assert.equal(f.authority.receipt('field-1').phase, 'verified');
});
test('ordered fields require separate once site grants and preserve the completed prefix', async t => {
  const f = form(t, { once: true }), receipt = await f.request();
  assert.deepEqual(f.sent, ['fixture-0']); assert.equal(receipt.completed, 1);
  assert.equal(receipt.unknownStep, null); assert.equal(receipt.untouched, 1);
  assert.equal(f.authority.receipt('field-0').phase, 'verified');
});
test('a fresh once grant covers the next exact step, not the whole form', async t => {
  const f = form(t, { once: true, async dispatch(plan, ctx, p) {
    for (const [index, op] of operations.entries()) {
      if (index) p.grant(); p.current(op);
      await ctx.session.send('Input.insertText', { text: op.args.value }, 'page');
      ctx.session.completeStep(index, 'verified');
    }
    return { effect: 'verified', completed: 2, observation: null, untouched: 0 };
  } });
  assert.equal((await f.request()).completed, 2); assert.equal(f.sent.length, 2);
});
test('preparation uses independent authority and does not complete or approve a field', async t => {
  const read = { id: 'read', kind: 'read', scope: scope('rread'), args: {}, consequence: 'ordinary' };
  const f = form(t, { preparation: read, confirm: false, async dispatch(plan, ctx, p) {
    p.current(read); await ctx.session.send('DOM.enable', {}, 'page'); ctx.session.completePreparation(read.id, 'verified');
    p.current(operations[0]);
    await assert.rejects(async () => ctx.session.send('Input.insertText', { text: 'fixture-0' }, 'page'), /TRANSPORT_AUTHORITY_REQUIRED/);
    return { effect: 'none', completed: 0, observation: null, untouched: 2 };
  } });
  const receipt = await f.request(); assert.deepEqual(f.sent, ['read']);
  assert.equal(receipt.completed, 0); assert.equal(receipt.untouched, 2);
});
test('ordered operations share one authority deadline across steps', async t => {
  const f = form(t, { ttl: 10, async dispatch(plan, ctx, p) {
    p.current(operations[0]); await ctx.session.send('Input.insertText', { text: 'fixture-0' }, 'page');
    ctx.session.completeStep(0, 'verified'); p.clock(110); p.current(operations[1]);
    await assert.rejects(async () => ctx.session.send('Input.insertText', { text: 'fixture-1' }, 'page'));
    return { effect: 'none', completed: 1, observation: null, untouched: 1 };
  } });
  const receipt = await f.request(); assert.equal(receipt.completed, 1); assert.deepEqual(f.sent, ['fixture-0']);
});
test('unknown second field reports the prefix, unknown step and untouched suffix on timeout', async t => {
  const f = form(t, { timeoutMs: 20, send(method, params) { if (params.text === 'fixture-1') return new Promise(() => {}); },
    async dispatch(plan, ctx, p) {
      p.current(operations[0]); await ctx.session.send('Input.insertText', { text: 'fixture-0' }, 'page'); ctx.session.completeStep(0, 'verified');
      p.current(operations[1]); await ctx.session.send('Input.insertText', { text: 'fixture-1' }, 'page');
    } });
  // The two-field preflight has no suffix beyond its unknown field.
  const receipt = await f.request(); assert.equal(receipt.completed, 1);
  assert.equal(receipt.unknownStep, 1); assert.equal(receipt.untouched, 0); assert.equal(receipt.effect, 'unknown');
  assert.equal(f.authority.receipt('field-0').phase, 'verified'); assert.equal(f.authority.receipt('field-1').phase, 'unknown');
});
for (const mode of ['out-of-order', 'repeat', 'unfinished', 'unlisted', 'changed-ref', 'changed-value', 'revoked'])
  test('ordered transport refuses ' + mode, async t => {
    const f = form(t, { resolve(command) {
      const op = operations.find(op => op.args.value === command.params.text) ?? operations[1];
      if (mode === 'changed-value' || mode === 'unlisted') return { ...op,
        ...(mode === 'unlisted' ? { id: 'unlisted' } : {}), args: { value: 'unapproved' },
        transmission: { data: 'unapproved', destination: origin } };
      if (mode === 'changed-ref') return { ...op, scope: scope('rchanged') };
      return op;
    }, async dispatch(plan, ctx, p) {
      if (!['out-of-order', 'unlisted', 'changed-ref', 'changed-value'].includes(mode)) {
        p.current(operations[0]); await ctx.session.send('Input.insertText', { text: 'fixture-0' }, 'page');
        if (mode !== 'unfinished') ctx.session.completeStep(0, 'verified');
      }
      const index = mode === 'repeat' ? 0 : 1; p.current(operations[index]);
      if (mode === 'revoked') p.authority.user(p.user, 'revoke', { session: 'client' });
      if (mode === 'changed-ref') p.current({ scope: scope('rchanged') });
      const reason = mode === 'revoked' ? /TRANSPORT_AUTHORITY_REQUIRED/ :
        ['unlisted', 'changed-value', 'changed-ref'].includes(mode) ? /TRANSPORT_OPERATION_MISMATCH/ : /TRANSPORT_STEP_ORDER/;
      await assert.rejects(async () => ctx.session.send('Input.insertText', { text: mode === 'changed-value' || mode === 'unlisted' ? 'unapproved' : operations[index].args.value }, 'page'), reason);
      return { effect: 'unknown', completed: 0, observation: null };
    } });
    const receipt = await f.request(); assert.ok(f.sent.length <= 1); assert.notEqual(receipt.completed, 2);
  });
test('three-field timeout retains the unknown middle step and untouched final step', async t => {
  const ops = [...operations, { id: 'field-2', kind: 'fill', scope: scope('rthird'), args: { value: 'fixture-2' },
    consequence: 'ordinary', transmission: { data: 'fixture-2', destination: origin } }];
  const f = form(t, { ops, timeoutMs: 20, send(method, params) { if (params.text === 'fixture-1') return new Promise(() => {}); } });
  const receipt = await f.request();
  assert.equal(receipt.completed, 1); assert.equal(receipt.unknownStep, 1); assert.equal(receipt.untouched, 1);
  assert.equal(receipt.error.code, 'TIMEOUT'); assert.equal(receipt.error.completed, 1);
  assert.deepEqual(f.sent, ['fixture-0', 'fixture-1']); assert.equal(f.authority.receipt('field-2'), null);
});
test('revocation at the second coherent snapshot prevents the second physical field', async t => {
  let count = 0;
  const f = form(t); f.terminal(() => { if (++count === 2) f.authority.user(f.user, 'revoke', { session: 'client' }); });
  const receipt = await f.request();
  assert.equal(receipt.completed, 1); assert.equal(receipt.unknownStep, null); assert.equal(receipt.untouched, 1);
  assert.deepEqual(f.sent, ['fixture-0']);
});
test('the first exact field confirmation cannot authorize the second transmission', async t => {
  const f = form(t); f.authority.user(f.user, 'decline', { operation: operations[1] });
  const receipt = await f.request(); assert.equal(receipt.completed, 1); assert.equal(receipt.untouched, 1);
  assert.deepEqual(f.sent, ['fixture-0']);
});

const lease = { target: 'target', cdpSessionId: 'page', frame: 'frame', origin, document: 1, epoch: 1,
  browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn' };
const binding = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  leaseGeneration: 1, target: 'target', frame: 'frame', origin, document: 1, operation: 'upload', ref: 'rfile' };
async function upload(t, options = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-form-host-')); trackTemp(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.txt'), bytes = Buffer.from([0, 255, 128, 10, 65]); writeFileSync(path, bytes);
  let time = 100, alive = true, currentBinding = binding;
  const files = createFileAuthority({ approve: () => true, now: () => time, ttlMs: 10 });
  const token = await files.issue([path], binding), stage = files.stage(token, binding); t.after(() => stage.cleanup());
  const sent = [];
  const adapter = createScopedAdapter({ helpers: {}, checkLease: () => alive,
    nodeBinding: id => ({ ...lease, backendNodeId: id }), fileBinding: () => currentBinding, fileAuthority: files,
    session: { sessionId: 'root', on() {}, off() {}, send(method, params, route) {
      assert.ok(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject'].includes(method), method);
      assert.equal(route, 'page'); sent.push({ method, params });
      if (options.send) return options.send(method, params);
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 9 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'file-node' } });
      if (method === 'Runtime.callFunctionOn') return Promise.resolve({ result: { value: { transferred: true, count: 1 } } });
      return Promise.resolve({});
    } } });
  t.after(() => adapter.disconnect());
  const view = adapter.forLease(lease);
  await view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state' });
  sent.length = 0;
  return { files, token, stage, view, sent, path, bytes, input: { backendNodeId: 42, operation: 'upload', executionContextId: 9 },
    clock(value) { time = value; }, revoke() { alive = false; }, binding(value) { currentBinding = value; } };
}
test('preflight: consumed approval stages bytes and transfers once through the closed file entry', async t => {
  const f = await upload(t);
  assert.deepEqual(readFileSync(f.stage.paths[0]), f.bytes);
  const receipt = await f.view.setFilePayloads(f.input, f.stage);
  assert.equal(receipt.transfer.effect, 'transferred'); assert.equal(receipt.transfer.count, 1);
  assert.equal(receipt.cleanup.stage.retained, true);
  assert.equal(f.sent.filter(c => c.method === 'Runtime.callFunctionOn').length, 1);
  assert.equal(f.sent.some(c => c.method === 'DOM.setFileInputFiles'), false);
  await assert.rejects(f.view.setFilePayloads(f.input, f.stage));
  assert.equal(f.stage.cleanup().retained, false);
});
test('file transfer uses the original approved bytes despite exposed stage or original path mutation', async t => {
  const f = await upload(t); writeFileSync(f.path, 'replacement'); f.stage.payloads[0].buffer.fill(1);
  writeFileSync(f.stage.paths[0], 'staging replacement');
  await f.view.setFilePayloads(f.input, f.stage);
  const command = f.sent.find(c => c.method === 'Runtime.callFunctionOn');
  assert.deepEqual(Buffer.from(command.params.arguments[0].value[0].base64, 'base64'), f.bytes);
  assert.equal(command.params.objectId, 'file-node');
});
for (const mode of ['forged', 'token', 'expired', 'changed-ref', 'changed-destination', 'changed-operation', 'lost-lease', 'extra-keys', 'foreign-world', 'cleaned'])
  test('staged transfer refuses ' + mode + ' before the byte actuator', async t => {
    const f = await upload(t); let stage = f.stage, input = f.input;
    if (mode === 'forged') stage = { ...f.stage };
    if (mode === 'token') stage = f.token;
    if (mode === 'expired') f.clock(110);
    if (mode === 'changed-ref') f.binding({ ...binding, ref: 'other' });
    if (mode === 'changed-destination') f.binding({ ...binding, origin: 'https://other.invalid' });
    if (mode === 'changed-operation') input = { ...input, operation: 'other' };
    if (mode === 'lost-lease') f.revoke();
    if (mode === 'extra-keys') input = { ...input, payloads: [] };
    if (mode === 'foreign-world') input = { ...input, executionContextId: 10 };
    if (mode === 'cleaned') f.stage.cleanup();
    await assert.rejects(f.view.setFilePayloads(input, stage));
    assert.equal(f.sent.filter(c => c.method === 'Runtime.callFunctionOn').length, 0);
  });
test('byte actuator constructs browser-owned Files and keeps staged cleanup separate', async t => {
  const f = await upload(t); await f.view.setFilePayloads(f.input, f.stage);
  const command = f.sent.find(c => c.method === 'Runtime.callFunctionOn'), events = [];
  class Input { type = 'file'; multiple = false; dispatchEvent(e) { events.push(e.type); } }
  class Transfer { items = { add: f => this.files.push(f) }; files = []; }
  class File { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } }
  const fn = runInNewContext('(' + command.params.functionDeclaration + ')', { HTMLInputElement: Input,
    DataTransfer: Transfer, File, Uint8Array, atob: b => Buffer.from(b, 'base64').toString('binary'), Event: class { constructor(type) { this.type = type; } } });
  const node = new Input(), result = fn.call(node, command.params.arguments[0].value);
  assert.equal(result.transferred, true); assert.deepEqual(Buffer.from(node.files[0].parts[0]), f.bytes);
  assert.deepEqual(events, ['input', 'change']); assert.equal(node.files[0].name, 'fixture.txt');
  assert.equal(fn.call({ type: 'file' }, command.params.arguments[0].value).transferred, false);
});
test('an unsettled physical send cannot complete a step or start the next', async t => {
  let resolve;
  const p = policy(), plan = { target: 'target', orderedOperations: operations };
  p.transport(plan, context, { method: 'Input.insertText', params: { text: 'fixture-0' } },
    () => new Promise(r => { resolve = r; }));
  assert.throws(() => completeTransportStep(p.transport, plan, 0, 'verified'), /TRANSPORT_STEP_UNPROVED/);
  p.current(operations[1]);
  assert.throws(() => p.transport(plan, context, { method: 'Input.insertText', params: { text: 'fixture-1' } }, () => {}), /TRANSPORT_STEP_ORDER/);
  resolve({}); await Promise.resolve(); completeTransportStep(p.transport, plan, 0, 'verified');
  assert.deepEqual(completeTransport(p.transport, plan, 'unknown'), { completed: 1, unknownStep: null, untouched: 1 });
});
test('a field hidden in preparationOperations cannot bypass the ordered field list', () => {
  const p = policy(), plan = { target: 'target', orderedOperations: [operations[0]], preparationOperations: [operations[1]] };
  p.current(operations[1]); let sent = false;
  assert.throws(() => p.transport(plan, context, { method: 'Input.insertText', params: { text: 'fixture-1' } }, () => { sent = true; }), /TRANSPORT_ORDER_REQUIRED/);
  assert.equal(sent, false);
});
test('unknown byte transfer returns retained cleanup and cannot replay the stage', async t => {
  const f = await upload(t), ordinary = f.view;
  // A separate strict view shares the owned stage but rejects the byte command.
  const sent = [], adapter = createScopedAdapter({ helpers: {}, checkLease: () => true,
    nodeBinding: id => ({ ...lease, backendNodeId: id }), fileBinding: () => binding, fileAuthority: f.files,
    session: { sessionId: 'root', on() {}, off() {}, async send(method) {
      assert.ok(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject'].includes(method));
      sent.push(method);
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'unknown-node' } };
      if (method === 'Runtime.callFunctionOn' || method === 'Runtime.releaseObject') throw Error('transport lost');
      return {};
    } } });
  t.after(() => adapter.disconnect()); const view = adapter.forLease(lease);
  await view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state' });
  const receipt = await view.setFilePayloads(f.input, f.stage);
  assert.equal(receipt.transfer.effect, 'unknown'); assert.equal(receipt.cleanup.stage.retained, true);
  assert.equal(receipt.cleanup.object.retained, true); assert.equal(receipt.cleanup.object.objectId, 'unknown-node');
  await assert.rejects(ordinary.setFilePayloads(f.input, f.stage), /Invalid staged file capability/);
  assert.equal(sent.filter(method => method === 'Runtime.callFunctionOn').length, 1);
});
test('lease loss after byte dispatch cannot publish transferred proof', async t => {
  const f = await upload(t); let resolve, alive = true;
  const adapter = createScopedAdapter({ helpers: {}, checkLease: () => alive,
    nodeBinding: id => ({ ...lease, backendNodeId: id }), fileBinding: () => binding, fileAuthority: f.files,
    session: { sessionId: 'root', on() {}, off() {}, send(method) {
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 9 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'late-node' } });
      if (method === 'Runtime.callFunctionOn') return new Promise(r => { resolve = r; });
      assert.fail('unexpected command ' + method);
    } } });
  t.after(() => adapter.disconnect()); const view = adapter.forLease(lease);
  await view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state' });
  const pending = view.setFilePayloads(f.input, f.stage);
  while (!resolve) await Promise.resolve();
  alive = false; resolve({ result: { value: { transferred: true, count: 1 } } });
  const receipt = await pending; assert.equal(receipt.transfer.effect, 'unknown');
  assert.equal(receipt.cleanup.object.retained, true); assert.equal(receipt.cleanup.stage.retained, true);
});
for (const expired of [false, true]) test('staged bytes use the branded broker fence, terminal expiry=' + expired, async t => {
  const f = await upload(t), user = {}, uid = process.getuid?.() ?? 1000, secret = 'a'.repeat(64), sent = [];
  const op = { id: 'upload', kind: 'upload', scope: scope('rfile'), args: { files: [f.path] }, consequence: 'upload',
    transmission: { data: 'exact synthetic file selection', files: [f.path], destination: origin } };
  const read = { id: 'prepare-upload', kind: 'read', scope: scope('rread'), args: {}, consequence: 'ordinary' };
  let current = read.scope, time = 100;
  const authority = createAuthority({ current: () => current, now: () => time, snapshot: () => {
    if (expired && current.ref === 'rfile') time = 110;
    return { scope: current, time };
  },
    classify: value => value, authenticate: event => event === user });
  authority.user(user, 'grant', { session: 'client', origin, mode: 'session' }); authority.user(user, 'confirm', { operation: op });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, ctx, command) {
    current = command.method === 'Runtime.callFunctionOn' ? op.scope : read.scope;
    if (command.method === 'Runtime.callFunctionOn') {
      assert.equal(command.params.objectId, 'broker-file');
      assert.deepEqual(Buffer.from(command.params.arguments[0].value[0].base64, 'base64'), f.bytes);
      return op;
    }
    return read;
  } });
  const socket = { sessionId: 'root', on() {}, off() {}, async send(method, params, route) {
    assert.equal(route, 'page'); sent.push(method);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'broker-file' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { transferred: true, count: 1 } } };
    assert.equal(method, 'Runtime.releaseObject'); return {};
  } };
  const owner = createTransportOwner({ session: socket, helpers: {}, checkLease: () => true,
    nodeBinding: id => ({ ...lease, backendNodeId: id }), fileBinding: () => binding, fileAuthority: f.files });
  t.after(() => owner.close());
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => socket,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: frame => frame,
    prepare: () => ({ target: 'target', orderedOperations: [op], preparationOperations: [read] }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true,
    disconnect: () => true, redact: value => value, async dispatch(plan, ctx) {
      return owner.run(lease, ctx, async view => {
        await view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state' });
        const transfer = await view.setFilePayloads(f.input, f.stage);
        ctx.session.completePreparation(read.id, 'verified');
        if (expired) {
          assert.equal(transfer.transfer.effect, 'unknown');
          return { effect: 'unknown', completed: 0, untouched: 1, observation: transfer };
        }
        assert.equal(transfer.transfer.effect, 'transferred'); ctx.session.completeStep(0, 'verified');
        return { effect: 'verified', completed: 1, untouched: 0, observation: transfer };
      });
    } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'file-preflight' });
  const receipt = await client.request({ id: 'file-form', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref: 'rfile', value: { files: ['ffile'] } }] } });
  assert.equal(receipt.effect, expired ? 'unknown' : 'verified'); assert.equal(receipt.completed, expired ? 0 : 1);
  assert.equal(authority.receipt(op.id).effect, expired ? 'untouched' : 'verified');
  assert.equal(authority.receipt(read.id).effect, 'verified');
  assert.deepEqual(sent, ['Page.createIsolatedWorld', 'DOM.resolveNode', ...(expired ? [] : ['Runtime.callFunctionOn']), 'Runtime.releaseObject']);
});
