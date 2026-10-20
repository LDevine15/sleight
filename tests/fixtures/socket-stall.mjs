// Offline JSON-RPC peer for timeout and shutdown tests. It owns no apps or helpers.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('stubborn')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || process.argv.includes('no-init')) return;
  const reply = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
    ...(msg.params?.arguments?.error ? { error: { code: -32603, message: 'bare timeout' } }
      : { result: { content: [{ type: 'text', text: 'done' }] } }) }) + '\n');
  if (msg.params?.arguments?.approval) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/sleight/approval', params: {
      id: 'offline-card', state: 'waiting', app: 'TextEdit', deadline: Date.now() + 120000,
    } }) + '\n');
  }
  if (msg.params?.arguments?.release) {
    const timer = setInterval(() => { if (existsSync(msg.params.arguments.release)) { clearInterval(timer); reply(); } }, 20);
    return;
  }
  setTimeout(reply, msg.params?.arguments?.delay ?? 0);
});
