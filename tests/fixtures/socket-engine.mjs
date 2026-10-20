// Offline engine fixture. No app, window, input, permission or native helper calls.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = event => appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ ...event, pid: process.pid }) + '\n');
log({ event: 'start' });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result = { content: [] };
  if (msg.method === 'initialize') {
    log({ event: 'initialize', clientInfo: msg.params.clientInfo });
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'offline fixture', version: '1' } };
  } else if (msg.method === 'tools/list') result = { tools: ['js', 'js_reset', 'turn_ended'].map(name => ({ name, inputSchema: { type: 'object' } })) };
  else if (msg.params?.name === 'js') result = { content: [{ type: 'text', text: '42' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
lines.on('close', () => setTimeout(() => { log({ event: 'exit' }); }, 80));
