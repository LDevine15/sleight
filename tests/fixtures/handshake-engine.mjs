import { createInterface } from 'node:readline';
// Deliberately no host imports or executable tool implementation.
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} },
    serverInfo: { name: 'bare-handshake', version: '1' } }
    : msg.method === 'tools/list' ? { tools: [{ name: 'js', inputSchema: { type: 'object' }, description: 'Offline fixture' }] } : undefined;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(result ? { result }
    : { error: { code: -32601, message: 'Offline fixture refuses tool execution' } }) }) + '\n');
});
