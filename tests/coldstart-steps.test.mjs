import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldstartSteps, coldstartMode } from '../bench/fowl/coldstart-steps.mjs';

test('empty-only sends one value and never calls any app or browser API', async () => {
  const sent = [];
  const row = await coldstartSteps(async code => { sent.push(code); return { ms: 1, chars: 10, error: false }; }, { emptyOnly: true });
  assert.deepEqual(sent, ['1']);
  assert.deepEqual(Object.keys(row), ['empty']);
});

test('the complete probe keeps the original call order and both tab-open variants', async () => {
  for (const open of ['create', 'new']) {
    const sent = [];
    const row = await coldstartSteps(async code => { sent.push(code); return { ms: 1 }; }, { browserId: 'fixture', url: 'https://example.test', open });
    assert.equal(sent.length, 5);
    assert.equal(sent[0], '1');
    assert.match(sent[1], /cua.getBrowser/);
    assert.match(sent[2], open === 'new' ? /b.tabs.new/ : /cua.createBrowserTab/);
    assert.deepEqual(sent.slice(3), ['await t.getAXState()', 'await t.getAXState()']);
    assert.deepEqual(Object.keys(row), ['empty', 'getBrowser', 'createTab', 'read', 'second']);
  }
});

test('six concurrent trials are restricted to empty-only and delays are bounded', () => {
  assert.deepEqual(coldstartMode({}, []), { emptyOnly: false, concurrency: 1, prepareMs: 0 });
  assert.deepEqual(coldstartMode({ concurrency: '6', 'prepare-ms': '2500' }, ['--empty-only']),
    { emptyOnly: true, concurrency: 6, prepareMs: 2500 });
  assert.throws(() => coldstartMode({ concurrency: '6' }, []), /empty-only/);
  assert.throws(() => coldstartMode({ 'prepare-ms': '10001' }, []), /Invalid/);
});
