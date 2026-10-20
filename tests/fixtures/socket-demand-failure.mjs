import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnDemand } from './socket-demand-owner.mjs';
import { ensureSocketSession } from '../../plugins/sleight/lib/socket-bridge.mjs';

test('intentional failure still collects every detached fixture', async t => {
  const root = process.argv[2], f = { directory: join(root, 'shell'), cleanup: [] }, children = [];
  t.after(async () => {
    const results = await Promise.allSettled(f.cleanup.map(collect => collect()));
    writeFileSync(join(root, 'exits.json'), JSON.stringify(await Promise.all(children.map(child => child.sessionExit))));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  children.push(await spawnDemand(f));
  if (process.argv[3] === 'ready') {
    children.push(await spawnDemand(f));
    await ensureSocketSession({ ...f, notice() {}, spawnSession: async () => {} });
  }
  writeFileSync(join(root, 'pids.json'), JSON.stringify(children.map(child => child.pid)));
  assert.fail('intentional failure after fixture spawn');
});
