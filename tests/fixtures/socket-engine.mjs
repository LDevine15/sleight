// Offline engine fixture. No app, window, input, permission or native helper calls.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = event => appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ ...event, pid: process.pid }) + '\n');
log({ event: 'start' });
let paymentCall;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.id === 'fixture-payment') {
    log({ event: 'card-answer', result: msg.result });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: paymentCall, result: { content: [{ type: 'text', text: '42' }] } }) + '\n');
    return;
  }
  let result = { content: [] };
  if (msg.method === 'initialize') {
    log({ event: 'initialize', clientInfo: msg.params.clientInfo });
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'offline fixture', version: '1' } };
  } else if (msg.method === 'tools/list') result = { tools: ['js', 'js_reset', 'turn_ended'].map(name => ({ name, inputSchema: { type: 'object' } })) };
  else if (msg.params?.name === 'js') {
    const code = msg.params.arguments.code;
    if (process.env.SLEIGHT_TEST_CARD_MODE && code.includes('cua.getApp("TextEdit")')) {
      paymentCall = msg.id;
      log({ event: 'app-request' });
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'fixture-payment', method: 'elicitation/create', params: {
        message: process.env.SLEIGHT_TEST_CARD_KIND === 'action' ? 'Submit this form?' : 'Allow TextEdit?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app: 'TextEdit' } },
      } }) + '\n');
      return;
    }
    if (process.env.SLEIGHT_TEST_CONFIRM === '1' && code.includes('let app = await cua.getApp("Firefox")')) {
      result = { content: [{ type: 'text', text: readFileSync(new URL('payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8') }],
        _meta: { 'codex/toolSurface': { app: { appId: 'org.mozilla.firefox' } } } };
    } else if (process.env.SLEIGHT_TEST_CONFIRM === '1' && code.includes('app.click')) {
      const setup = /__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(code);
      log({ event: 'policy', payment: setup ? JSON.parse(setup[1]).payment : null });
      // Preserve the actual launcher-assigned id while the engine waits for the card.
      paymentCall = msg.id;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'fixture-payment', method: 'elicitation/create', params: {
        message: 'Pay $268?', requestedSchema: { type: 'object', properties: {} },
        _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app: 'Firefox' } },
      } }) + '\n');
      return;
    } else result = { content: [{ type: 'text', text: '42' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
lines.on('close', () => setTimeout(() => { log({ event: 'exit' }); }, 80));
