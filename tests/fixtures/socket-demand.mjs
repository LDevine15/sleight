// Offline detached session. Its idle close owns and collects all its resources.
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { callSocket, enterSessionContext, startSocketSession } from '../../plugins/sleight/lib/socket-bridge.mjs';
import { idleClock } from './socket-clock.mjs';
const directory = process.argv[2];
if (process.argv[3] === '--stop') {
  await callSocket({ tool: 'js', args: { code: 'stop' } }, { directory });
} else if (process.argv[3] === '--fail') {
  process.stderr.write('offline startup failure\n');
  process.exit(23);
} else if (process.argv[3] === '--stale') {
  const path = join(directory, 'session.sock');
  createServer().listen(path, () => { chmodSync(path, 0o600); process.exit(0); });
} else {
  enterSessionContext(directory);
  const clock = idleClock();
  const signals = new EventEmitter();
  process.on('message', message => { if (message.stop) signals.emit('SIGTERM'); });
  process.on('disconnect', () => signals.emit('SIGTERM'));
  const session = await startSocketSession({ directory, signals, idleClock: clock, accessibility: () => false, peerUid: async () => process.getuid(),
    startRelay: async options => ({ call: async (_tool, args) => {
      if (args.code === 'stop') setImmediate(() => clock.advance(600000));
      return { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, env: process.env, cwd: process.cwd(), relay: options }) }] };
    },
      close: async () => { writeFileSync(join(directory, 'collected'), 'yes'); } }),
  });
  const { error } = await session.closed;
  if (process.connected) process.disconnect();
  if (error) throw error;

}
