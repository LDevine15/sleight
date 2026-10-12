import { PassThrough } from 'node:stream';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';
import { createStartupCache } from '../../plugins/sleight/lib/startup-cache.mjs';

// A delayed protocol fixture, with no engine, app, browser or helper process.
const serverIn = new PassThrough(), serverOut = new PassThrough();
let timer;
serverIn.setEncoding('utf8').on('data', data => {
  for (const line of data.trim().split('\n').filter(Boolean)) {
    const msg = JSON.parse(line);
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' } } : msg.method === 'tools/list' ? {
      tools: [{ name: 'js', description: 'fixture', inputSchema: { type: 'object' } }],
    } : undefined;
    if (!result) continue;
    const reply = () => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') timer = setTimeout(reply, 110);
    else reply();
  }
});
const relay = createRelay({ clientIn: process.stdin, clientOut: process.stdout, serverIn, serverOut,
  startupCache: createStartupCache({ identity: { engine: 'fixture-1', sleight: 'fixture-1' }, directory: process.argv[2] }),
});
process.stdin.on('end', () => { clearTimeout(timer); relay.dispose(); });
