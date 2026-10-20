// Offline JSON-RPC peer for timeout and shutdown tests. It owns no apps or helpers.
import { createInterface } from 'node:readline';
if (process.argv.includes('stubborn')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || process.argv.includes('no-init')) return;
  const reply = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'done' }] } }) + '\n');
  setTimeout(reply, msg.params?.arguments?.delay ?? 0);
});
