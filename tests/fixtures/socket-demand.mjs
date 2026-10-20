// Offline detached session. Its idle close owns and collects all its resources.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startSocketSession } from '../../plugins/sleight/lib/socket-bridge.mjs';
const directory = process.argv[2];
if (process.argv[3] === '--stale') {
  const path = join(directory, 'session.sock');
  createServer().listen(path, () => { chmodSync(path, 0o600); process.exit(0); });
} else {
  const session = await startSocketSession({ directory, idleMs: 500, peerUid: async () => process.getuid(),
    startRelay: async () => ({ call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ pid: process.pid }) }] }),
      close: async () => { writeFileSync(join(directory, 'collected'), 'yes'); } }),
  });
  const { error } = await session.closed;
  if (error) throw error;

}
