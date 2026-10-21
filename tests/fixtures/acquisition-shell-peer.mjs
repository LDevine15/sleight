// Offline MCP peer: echoes wire shape or emits a card then waits for owned EOF.
import { createInterface } from 'node:readline';
const phase = process.argv[2];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const card = () => send({ method: 'notifications/sleight/approval', params: {
  id: 'PRIVATE ID', state: 'waiting', app: 'PRIVATE DOCUMENT', deadline: Date.now() + 120000,
} });
let initialize;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initialize = message.params;
    if (phase === 'startup') return card();
    send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'offline', version: '1' } } });
  } else if (message.method === 'tools/call') {
    if (phase === 'read') return card();
    send({ id: message.id, result: { initialize, call: message.params } });
  }
});
