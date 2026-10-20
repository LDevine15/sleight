// Offline child for the runner's EOF/interrupt tests. This process never imports native code or opens UI.
import { createInterface } from 'node:readline';
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const lines = createInterface({ input: process.stdin });
emit({ outcome: 'boot', pid: process.pid, step: 'setup' });
lines.on('line', () => {});
lines.on('close', () => {
  emit({ outcome: 'cleanup', visible: 0, pending: 0, reason: 'stdin-eof', step: 'setup' });
});
