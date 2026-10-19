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
  assert.deepEqual(events, [withoutTitles(event)]);
  assert.deepEqual(events[0].row.windows, [{ id: 44, app: 'Fixture', metadata: { visible: true } }]);
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
  serverOut.write(JSON.stringify({ id: 8, result: { isError: true, content: [{ type: 'text',
    text: '[sleight:dp1]' + JSON.stringify(event) + '\nnoWindowsAvailable' }] } }) + '\n');
  assert.deepEqual(traces.filter(t => t.direction === 'dp1-decision').map(t => t.msg), [{ id: 8, ...event }]);
  assert.ok(!JSON.stringify(replies).includes('[sleight:dp1]'));
  assert.ok(JSON.stringify(replies).includes('noWindowsAvailable'));
});
