import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowCover } from '../bench/fowl/window-cover.mjs';
import { coverCell } from '../bench/fowl/real-gate.mjs';

const binary = async () => '/fake/window-cover';

test('windowCover returns the helper\'s frame and covering list', async () => {
  const reply = { ok: true, frame: { x: 0, y: 0, width: 800, height: 600 }, covering: [{ owner: 'Terminal', layer: 0, fraction: 0.237 }] };
  let asked;
  const cover = await windowCover(4242, { binary, run: async path => { asked = path; return JSON.stringify(reply); } });
  assert.equal(asked, '/fake/window-cover');
  assert.deepEqual(cover, { frame: reply.frame, covering: reply.covering });
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
