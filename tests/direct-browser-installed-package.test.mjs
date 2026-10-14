import test from 'node:test';
import assert from 'node:assert/strict';
import { installedFixture } from './fixtures/direct-browser-installed-runtime.mjs';

test('changed installed entry bytes fence physical work before any root command', async t => {
  let current = true;
  const f = await installedFixture(t, { runtime: { packageCurrent: () => current } }), direct = await f.begin();
  current = false;
  const result = await direct.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: 'https://fixture.invalid' } });
  assert.ok(result.error, JSON.stringify(result)); assert.equal(f.calls.length, 0);
  await assert.rejects(f.begin('next'), /VERSION_MISMATCH/);
});
test('genuine user messages are immutable and disappear when the private turn ends', async t => {
  const f = await installedFixture(t); await f.begin('turn', 'My exact current request');
  const message = f.runtime.userMessage();
  assert.equal(message.text, 'My exact current request'); assert.equal(Object.isFrozen(message), true);
  f.runtime.endTurn(); assert.equal(f.runtime.userMessage(), null);
});
test('idle provider loss revokes current turn and changes broker state immediately', async t => {
  let lose;
  const f = await installedFixture(t, { runtime: { onConnectionLoss(fn) { lose = fn; return () => {}; } } });
  const direct = await f.begin(); assert.equal(f.runtime.broker.status().state, 'connected');
  assert.equal(typeof lose, 'function'); lose();
  assert.equal(f.runtime.userMessage(), null); assert.equal(f.runtime.broker.status().state, 'disconnected');
  assert.equal((await direct.call({ name: 'browser_read', arguments: { tab: 'tfixture' } })).error.effect, 'none');
});
