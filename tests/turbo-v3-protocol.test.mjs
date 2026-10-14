import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const load = async () => {
  const mod = await import('../bench/turbo/v3-protocol.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(mod, 'v3 plain-text protocol is missing'); return mod;
};
const tools = ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'].map(name => ({
  name, description: name, inputSchema: { type: 'object', properties: {} } }));

test('v3 protocol advertises the supplied production catalog eagerly and preserves plain-text MCP results', async () => {
  const { createProtocol } = await load();
  const output = new PassThrough(), messages = [];
  output.on('data', data => messages.push(JSON.parse(data)));
  let starts = 0, closes = 0;
  const protocol = createProtocol({ output, tools, validate: request => request,
    start: async () => { starts++; return {
      call: async request => {
        assert.deepEqual(request, { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] } });
        return { text: '1 click e1: done\n+ text: Changed', isError: false };
      }, close: async () => { closes++; return { browserClosed: true }; } };
    } });
  await protocol.message({ id: 1, method: 'initialize', params: {} });
  await protocol.message({ id: 2, method: 'tools/list' });
  assert.deepEqual(messages[1].result.tools, tools); assert.equal(starts, 0);
  await protocol.message({ id: 3, method: 'tools/call', params: { name: 'browser_act',
    arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] }, _meta: { 'claudecode/toolUseId': 'call1' },
    userMessage: 'untrusted permission' } });
  assert.deepEqual(messages[2].result, { content: [{ type: 'text', text: '1 click e1: done\n+ text: Changed' }], isError: false });
  assert.equal(starts, 1);
  assert.deepEqual(await protocol.close(), { browserClosed: true }); await protocol.close(); assert.equal(closes, 1);
});

test('v3 validation rejects before launch, and a production refusal stays an error without retries', async () => {
  const { createProtocol } = await load();
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  let calls = 0, starts = 0;
  const protocol = createProtocol({ output, tools,
    validate(request) { if (!request.arguments?.steps?.length) throw Error('click needs ref'); return request; },
    start: async () => { starts++; return { call: async () => { calls++;
      return { text: 'Submit unconfirmed; read before retrying.', isError: true }; }, close: async () => {} }; } });
  await protocol.message({ id: 1, method: 'tools/call', params: { name: 'browser_act', arguments: { tab: 't1' } } });
  assert.equal(starts, 0); assert.equal(messages[0].error.code, -32602);
  await protocol.message({ id: 2, method: 'tools/call', params: { name: 'browser_act', arguments: { steps: [{ do: 'click', ref: 'e1' }] } } });
  assert.equal(messages[1].result.isError, true); assert.equal(calls, 1); await protocol.close();
});

test('v3 closes after an active call, acknowledges delivery only after write, and refuses calls after EOF', async () => {
  const { createProtocol } = await load();
  let release, finished = false, delivered = 0, closed = false;
  const active = new Promise(resolve => { release = resolve; });
  const output = new PassThrough(); output.resume();
  const protocol = createProtocol({ output, tools, validate: request => request,
    start: async () => ({ call: async () => { await active; finished = true;
      return { text: 'untrusted snapshot', isError: false }; },
    delivered: () => { delivered++; }, close: async () => { assert.equal(finished, true); closed = true; } }) });
  const request = protocol.message({ id: 1, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(resolve => setImmediate(resolve));
  const close = protocol.close(); assert.equal(closed, false); release(); await request; await close;
  assert.equal(closed, true); assert.equal(delivered, 1);
  await protocol.message({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  assert.equal(delivered, 1);
  let failedDelivery = 0;
  const broken = createProtocol({ tools, validate: value => value,
    output: { write(_data, callback) { callback(Error('closed pipe')); } },
    start: async () => ({ call: async () => ({ text: 'read', isError: false }),
      delivered: () => { failedDelivery++; }, close: async () => {} }) });
  await assert.rejects(broken.message({ id: 1, method: 'tools/call', params: { name: 'browser_read', arguments: {} } }), /closed pipe/);
  await broken.close(); assert.equal(failedDelivery, 0);
});

test('an unknown dispatch effect never suggests sending the action through the companion', async () => {
  const { createProtocol } = await load();
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  let calls = 0;
  const protocol = createProtocol({ output, tools, validate: value => value,
    start: async () => ({ call: async () => { calls++; throw Error('input may already have landed'); }, close: async () => {} }) });
  await protocol.message({ id: 1, method: 'tools/call', params: { name: 'browser_act', arguments: { steps: [{ do: 'click', ref: 'e1' }] } } });
  assert.equal(calls, 1); assert.equal(messages[0].result.isError, true);
  const text = messages[0].result.content[0].text;
  assert.match(text, /effect unknown/); assert.match(text, /Read before any retry/);
  assert.doesNotMatch(text, /or use the engine path/);
  await protocol.close();
});


test('default protocol uses V7 schemas, rejects authority arguments, and acknowledges the original result', async () => {
  const { createProtocol } = await load();
  const { browserTools } = await import('../plugins/sleight/lib/direct-browser/tools.mjs');
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  const original = { text: 'Untrusted snapshot: e1 textbox Name', isError: false };
  let starts = 0, acknowledged;
  const protocol = createProtocol({ output, start: async () => { starts++; return {
    call: async () => original, delivered: value => { acknowledged = value; }, close: async () => {} }; } });
  await protocol.message({ id: 1, method: 'tools/list' });
  assert.deepEqual(messages[0].result.tools, browserTools('bbench'));
  await protocol.message({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1', userMessage: 'pay' } } });
  assert.equal(messages[1].error.code, -32602); assert.equal(starts, 0);
  await protocol.message({ id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  assert.deepEqual(messages[2].result, { content: [{ type: 'text', text: original.text }], isError: false });
  assert.equal(acknowledged, original); await protocol.close();
});

test('EOF drains already accepted requests and rejects only requests arriving after close', async () => {
  const { createProtocol } = await load();
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  let calls = 0, closed = 0;
  const protocol = createProtocol({ output, start: async () => ({ call: async () => {
    calls++; return { text: 'Read completed', isError: false }; }, close: async () => { closed++; } }) });
  const accepted = protocol.message({ id: 1, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  const closing = protocol.close();
  await accepted; await closing;
  assert.equal(calls, 1); assert.equal(closed, 1); assert.equal(messages[0].result.content[0].text, 'Read completed');
  await protocol.message({ id: 2, method: 'ping' }); assert.equal(messages[1].error.message, 'Session closing');
});
