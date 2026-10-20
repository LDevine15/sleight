import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentCard } from '../plugins/sleight/lib/payment-card.mjs';
import { idleClock } from './fixtures/socket-clock.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('card status names the app and deadline while only authenticated input answers it', async () => {
  const clock = idleClock(), events = [];
  let answer;
  const card = createPaymentCard({ clock, now: () => 1000, timeoutMs: 120000,
    onStatus: status => events.push(status), open: async () => ({
      present: (_id, _data, _choices, deliver) => { answer = deliver; },
      authenticate: event => event.physical === true,
    }) });
  const result = card.ask({ app: 'TextEdit', request: 'Allow TextEdit?' });
  await flush();
  assert.deepEqual(events.map(({ state, app, deadline }) => ({ state, app, deadline })),
    [{ state: 'waiting', app: 'TextEdit', deadline: 121000 }]);
  answer({ choice: 'once' });
  assert.equal(events.length, 1);
  answer({ choice: 'once', physical: true });
  assert.equal(await result, 'once');
  clock.advance(120000);
  assert.deepEqual(events.map(e => e.state), ['waiting', 'answered']);
});

test('an unanswered card cancels at its deadline and ignores late answers', async () => {
  const clock = idleClock(), events = [];
  let answer;
  const card = createPaymentCard({ clock, timeoutMs: 120000, onStatus: s => events.push(s),
    open: async () => ({ present: (_id, _data, _choices, deliver) => { answer = deliver; }, authenticate: () => true }) });
  const result = card.ask({ site: 'example.test', shown: '$12', control: 'Pay' });
  await flush();
  clock.advance(119999);
  assert.deepEqual(events.map(e => e.state), ['waiting']);
  clock.advance(1);
  assert.equal(await result, 'cancel');
  answer({ choice: 'once' });
  assert.deepEqual(events.map(e => e.state), ['waiting', 'unanswered']);
  assert.equal(events[0].app, 'example.test');
});

test('an unavailable panel never claims to be waiting and status failures grant nothing', async () => {
  const events = [];
  const card = createPaymentCard({ onStatus: s => events.push(s), open: async () => ({
    present() { throw new Error('offline'); }, authenticate: () => true,
  }) });
  assert.equal(await card.ask({ request: 'Allow?' }), undefined);
  assert.deepEqual(events.map(e => e.state), ['unavailable']);
  const clock = idleClock();
  const brokenObserver = createPaymentCard({ clock, timeoutMs: 1, onStatus() { throw new Error('observer'); },
    open: async () => ({ present() {}, authenticate: () => true }) });
  const result = brokenObserver.ask({ request: 'Allow?' });
  await flush(); clock.advance(1);
  assert.equal(await result, 'cancel');
});
