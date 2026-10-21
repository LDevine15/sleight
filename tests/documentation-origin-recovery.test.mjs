import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../bench/documentation-origin-recovery.mjs');
const original = {
  id: 'documentation-bootstrap', status: 'fail', completed: true, prompts: 0, removedCharacters: 0,
  policyUnchanged: true, outsideFenceUnchanged: true, resultKeys: ['_meta', 'content', 'isError'],
  metadataShape: { 'codex/nodeReplExecutionDurationMs': 'number' },
  items: [
    { type: 'text', keys: ['text', 'type'], characters: 21477, sha256: '6e37238c68d5d51dbb3391e8c59ec5642c3b4cb5b25705acb7c622816134156f' },
    { type: 'text', keys: ['text', 'type'], characters: 22, sha256: 'b38a6404fecae5e80bc63016f0c591ecb9ac5905c4dd8d1fb15171aa62843902' },
  ],
  reason: 'live lock retained because owned child or process-group collection is unproved',
  cleanup: { started: true, childPid: 7822, groupId: 7822, childCollected: true, groupCollected: false },
  ms: 744, lockRetained: true,
};
const bytes = Buffer.from(JSON.stringify(original, null, 2) + '\n');
const lock = { path: '/tmp/sleight-live.lock', dev: 16777232, ino: 2259500286, uid: 501, mode: 0o755, birthtimeMs: 1792547223859.208 };
function boundary(fault) {
  const events = [], saved = [];
  let inspectCalls = 0;
  return { events, saved, deps: {
    read: () => fault === 'receipt' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes,
    inspect: path => {
      assert.equal(path, '/tmp/sleight-live.lock'); inspectCalls++;
      return { ...lock, ino: fault === 'lock' || fault === 'late-lock' && inspectCalls > 1 ||
        fault === 'final-lock' && inspectCalls > 4 ? 3 : lock.ino };
    },
    entries: path => { assert.equal(path, '/tmp/sleight-live.lock'); return fault === 'nonempty' ? ['foreign'] : []; },
    absent: async pid => { assert.equal(pid, 7822); events.push('absence'); return fault === 'group'
      ? { gone: false, state: 'present', samples: [] } : { gone: true, state: 'absent', samples: [{ code: 'ESRCH' }] }; },
    writer: () => ({ save: record => {
      events.push('save'); if (fault === 'write' && record.status === 'pass') throw Error('write refused');
      saved.push(JSON.parse(JSON.stringify(record)));
    }, close() { events.push('close'); } }),
    remove: path => { assert.equal(path, '/tmp/sleight-live.lock'); events.push('remove'); },
  } };
}

test('fixed docs recovery syncs its separate receipt before removing the attested empty lock', async () => {
  const { recoverDocumentationOrigin } = await load(), b = boundary();
  const result = await recoverDocumentationOrigin({ recover: true, ...b.deps });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.lockReleased, true);
  assert.equal(b.events.filter(event => event === 'remove').length, 1);
  assert.ok(b.events.lastIndexOf('save') < b.events.indexOf('remove'));
  assert.equal(b.saved.at(-1).lockRelease.confirmed, false);
  assert.equal(b.saved.at(-1).originalSha256, '73e29565b8ec97823419d88f0d2060ef1e9a9b5a155f231dd6d446fca6dd9e1f');
});

for (const fault of ['receipt', 'lock', 'late-lock', 'final-lock', 'group', 'nonempty', 'write']) {
  test(`fixed docs recovery retains the lock on ${fault} failure`, async () => {
    const { recoverDocumentationOrigin } = await load(), b = boundary(fault);
    const result = await recoverDocumentationOrigin({ recover: true, ...b.deps });
    assert.equal(result.status, 'fail');
    assert.equal(result.lockRetained, true);
    assert.equal(b.events.includes('remove'), false);
  });
}

test('fixed docs recovery requires explicit opt-in without touching any dependency', async () => {
  const { recoverDocumentationOrigin } = await load();
  const result = await recoverDocumentationOrigin({ writer: () => { throw Error('must not write'); } });
  assert.equal(result.status, 'refused');
});
