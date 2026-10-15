import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';

const [version, gate, mode] = process.argv.slice(2);
const log = event => appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ event, version, pid: process.pid }) + '\n');
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let initialized = false, notified = false, pending;
log('start');
createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    initialized = true; log('initialize');
    send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'update-fixture', version } } });
  } else if (msg.method === 'notifications/initialized') { notified = true; log('initialized'); }
  else if (msg.method === 'tools/call') {
    if (!initialized || !notified) throw Error('Fake engine needs the complete handshake');
    const { name, arguments: args } = msg.params;
    if (name === 'turn_ended' || name === 'js_reset') { send({ id: msg.id, result: { content: [] } }); return; }
    if (name !== 'js') throw Error('Unsupported fake engine tool: ' + name);
    log('call');
    if (args.code.includes('updateDuringCall') && version === '1.0') {
      log('waiting-for-update');
      while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
      send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] } });
    } else if (mode === 'fail' && args.code.includes('updateDuringCall')) {
      send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] } });
    } else {
      pending = msg.id;
      send({ id: 'approval', method: 'elicitation/create', params: { message: 'Allow Example?',
        _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'Example' }, riskLevel: 'low' } } });
    }
  } else if (msg.method === undefined && msg.id === 'approval') {
    log(msg.result.action);
    send({ id: pending, result: { content: [{ type: 'text', text: 'Window: "Untitled", App: Example.' }],
      _meta: { 'codex/toolSurface': { app: { appId: 'test.example' } } } } });
  } else throw Error('Unsupported fake engine method: ' + msg.method);
});
