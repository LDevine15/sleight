import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripDP1Trace, withoutTitles } from '../plugins/sleight/lib/dp1-trace.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

test('DP1 strips diagnostics from mixed results and removes titles recursively', () => {
  const event = { decision: 'kept-read', reason: 'windows non-empty', inventoryHasPid: false, rowHasPid: false,
    row: { id: 'fixture.app', displayName: 'Fixture', isRunning: true, title: 'private',
      windows: [{ id: 44, app: 'Fixture', title: 'private', metadata: { windowTitle: 'private', visible: true } }] } };
  const events = [];
  const content = [{ type: 'text', text: 'before[sleight:dp1]' + JSON.stringify(event) + '\nafter' },
    { type: 'text', text: '[sleight:dp1]{invalid}\n[sleight:dp1]{"decision":"other"}\n' },
    { type: 'image', data: 'same' }];
  assert.deepEqual(stripDP1Trace(content, event => events.push(event)),
    [{ type: 'text', text: 'beforeafter' }, { type: 'image', data: 'same' }]);
  assert.deepEqual(events, [{ decision: event.decision, reason: event.reason }]);
  assert.deepEqual(withoutTitles(event).row.windows, [{ id: 44, app: 'Fixture', metadata: { visible: true } }]);
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('the relay traces DP1 decisions by call id even on error replies and hides them from the model', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [], replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => relay.dispose());
  clientOut.on('data', chunk => replies.push(JSON.parse(chunk)));
  const event = { decision: 'kept-read', reason: 'error' };
  clientIn.write(JSON.stringify({ id: 8, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } }) + '\n');
  serverOut.write(JSON.stringify({ id: 8, result: { isError: true, content: [{ type: 'text',
    text: '[sleight:dp1]' + JSON.stringify(event) + '\nnoWindowsAvailable' }] } }) + '\n');
  assert.deepEqual(traces.filter(t => t.direction === 'dp1-decision').map(t => t.msg), [{ id: 8, ...event }]);
  assert.ok(!JSON.stringify(replies).includes('[sleight:dp1]'));
  assert.ok(JSON.stringify(replies).includes('noWindowsAvailable'));
});

test('DPi only records bounded whitelisted scalar fields from DP1 diagnostics', () => {
  const event = { decision: 'skipped-read', reason: 'no windows', source: 'caller-read', status: 'ok', pid: 123,
    processStart: 1, running: true, windowCount: 0, modalCount: 0, match: 'native-ax+leased-pid',
    content: 'private', row: { document: 'private' }, title: 'private' };
  const events = [];
  const trace = value => [{ type: 'text', text: '[sleight:dp1]' + JSON.stringify(value) + '\n' }];
  stripDP1Trace(trace(event), event => events.push(event));
  const { content, row, title, ...allowed } = event;
  assert.deepEqual(events, [allowed]);
  stripDP1Trace(trace({ decision: 'kept-read', reason: 'x'.repeat(5000) }), event => events.push(event));
  assert.equal(events.length, 1, 'oversized records are not parsed or traced');
  stripDP1Trace(trace({ decision: 'kept-read', reason: 'error', source: { document: 'private' },
    pid: 'private', match: 'x'.repeat(257) }), event => events.push(event));
  assert.deepEqual(events[1], { decision: 'kept-read', reason: 'error' });
});

test('DPi the relay leaves diagnostic-looking text in non-JS and untracked replies unchanged', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [], replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => relay.dispose());
  clientOut.on('data', chunk => replies.push(JSON.parse(chunk)));
  clientIn.write(JSON.stringify({ id: 9, method: 'tools/call', params: { name: 'list_apps', arguments: {} } }) + '\n');
  const content = [{ type: 'text', text: '[sleight:dp1]{"decision":"kept-read","reason":"document text"}\n' }];
  for (const id of [9, 10]) serverOut.write(JSON.stringify({ id, result: { content } }) + '\n');
  assert.deepEqual(replies.filter(reply => [9, 10].includes(reply.id)).map(reply => reply.result.content), [content, content]);
  assert.equal(traces.filter(trace => trace.direction === 'dp1-decision').length, 0);
});
