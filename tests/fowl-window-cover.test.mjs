import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCover, watchCover, windowCover } from '../bench/fowl/window-cover.mjs';
import { coverCell } from '../bench/fowl/real-gate.mjs';

const binary = async () => '/fake/window-cover';

test('windowCover returns the helper\'s frame and covering list', async () => {
  const reply = { ok: true, frame: { x: 0, y: 0, width: 800, height: 600 }, covering: [{ owner: 'Terminal', layer: 0, fraction: 0.237 }] };
  let asked;
  const cover = await windowCover(4242, { binary, run: async (path, args) => { asked = [path, ...args]; return JSON.stringify(reply); } });
  assert.deepEqual(asked, ['/fake/window-cover', '4242']);
  assert.deepEqual(cover, { frame: reply.frame, covering: reply.covering });
});

test('windowCover with place asks the helper to move the window and records where it came from', async () => {
  const from = { frame: { x: 58, y: 62, width: 1324, height: 740 }, covering: [{ owner: 'Terminal', layer: 0, fraction: 0.4 }] };
  const reply = { ok: true, frame: { x: 2580, y: 20, width: 1324, height: 740 }, covering: [], moved: true, from };
  let asked;
  const cover = await windowCover(4242, { place: true, binary, run: async (path, args) => { asked = args; return JSON.stringify(reply); } });
  assert.deepEqual(asked, ['4242', 'place']);
  assert.deepEqual(cover, { frame: reply.frame, covering: [], moved: true, from });
  assert.deepEqual(await windowCover(4242, { place: true, binary, run: async () => JSON.stringify({ ok: true, frame: from.frame, covering: [], moved: false }) }),
    { frame: from.frame, covering: [], moved: false });
});

test('a window that stays says how many displays there were and how covered the best spot was', async () => {
  const frame = { x: 4, y: 33, width: 1280, height: 854 }, covering = [{ owner: 'Claude', layer: 0, fraction: 0.826 }];
  const reply = { ok: true, frame, covering, moved: false, screens: 1, bestOverlap: 0.826 };
  assert.deepEqual(await windowCover(4242, { place: true, binary, run: async () => JSON.stringify(reply) }),
    { frame, covering, moved: false, screens: 1, bestOverlap: 0.826 });
});

test('summarizeCover keeps each covering app once at its largest share and counts unread readings', () => {
  assert.deepEqual(summarizeCover([{ covering: [] }, { covering: [{ owner: 'Claude', fraction: 0.4 }] }, { error: 'timeout' }, null,
    { covering: [{ owner: 'Claude', fraction: 0.83 }, { owner: 'UserNotificationCenter', fraction: 0.019 }] }]),
  { readings: 5, errors: 2, covering: [{ owner: 'Claude', fraction: 0.83 }, { owner: 'UserNotificationCenter', fraction: 0.019 }] });
});

test('watchCover reads while the agent runs and once more at stop, never two reads at once, and only reads', async () => {
  let reads = 0, open = 0, most = 0;
  const read = async (pid, options) => {
    assert.equal(pid, 4242); assert.equal(options, undefined, 'no place: a watch never moves a window');
    open++; most = Math.max(most, open); reads++;
    await new Promise(resolve => setTimeout(resolve, 15));
    open--;
    return reads === 2 ? { covering: [{ owner: 'Claude', fraction: 0.83 }] } : { covering: [] };
  };
  const watch = watchCover(4242, { every: 5, read });
  await new Promise(resolve => setTimeout(resolve, 60));
  const seen = await watch.stop();
  assert.equal(most, 1);
  assert.ok(seen.readings >= 2, JSON.stringify(seen));
  assert.equal(seen.readings, reads);
  assert.deepEqual(seen.covering, [{ owner: 'Claude', fraction: 0.83 }]);
  const after = reads;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, after, 'no reads after stop');
  // A read that throws is kept as an unread reading.
  assert.deepEqual(await watchCover(1, { every: 1000, read: async () => { throw Error('boom'); } }).stop(), { readings: 1, errors: 1, covering: [] });
});

test('windowCover records an error instead of failing the round', async () => {
  assert.deepEqual(await windowCover(4242, { binary, run: async () => '{"ok":false,"error":"no-window"}' }), { error: 'no-window' });
  assert.deepEqual(await windowCover(undefined, { binary, run: async () => { throw Error('never'); } }), { error: 'no-pid' });
  assert.deepEqual(await windowCover(4242, { binary, run: async () => { throw Object.assign(Error('t'), { killed: true }); } }), { error: 'timeout' });
  assert.deepEqual(await windowCover(4242, { binary: async () => { throw Error('swiftc failed'); } }), { error: 'swiftc failed' });
});

test('coverCell names each covering app once with its largest share', () => {
  assert.equal(coverCell(null), 'not measured');
  assert.equal(coverCell({ error: 'timeout' }), 'unread (timeout)');
  assert.equal(coverCell({ covering: [] }), 'none');
  assert.equal(coverCell({ covering: [{ owner: 'Terminal', fraction: 0.237 }, { owner: 'Terminal', fraction: 0.5 }, { owner: 'Claude', fraction: 1 }] }), 'Terminal 50%, Claude 100%');
});
