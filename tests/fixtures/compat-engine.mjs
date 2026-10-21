// A stdio MCP server standing in for the raw engine (or sleight's launcher) in the compatibility suite's tests.
// COMPAT_FAKE_MODE: ok, launcher, no-turn-end (tools/list lacks turn_ended), new-policy (the policy text changed),
// probe-missing (cua.getTab gone), hang (never answers a tool call). As the real engine does, it defines the browser
// methods only when CUA_REPL_ENABLED_SURFACES includes browser (unset: all of them).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const mode = process.env.COMPAT_FAKE_MODE || 'ok';
// The outer owned client's group cleanup must collect this bounded descendant,
// even when the fake leader exits first. It cannot live longer than 500 ms.
if (mode === 'group-child') {
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'ignore' });
  process.stdin.once('end', () => process.exit(0));
}
const fixture = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const policy = mode === 'new-policy' ? fixture('engine-confirmations-policy.txt').replace('Delete data', 'Remove data') : fixture('engine-confirmations-policy.txt');
const docs = `## Computer Use\n\nControl native apps.\n\n## API\n\n\`\`\`typescript\n${fixture('engine-api-26.1007.71326.ts')}\`\`\`\n\n## Notes\n\nSome notes.\n\n${policy}`;
const tools = [
  { name: 'js', description: fixture('engine-js-description.txt').trimEnd(), inputSchema: { type: 'object', properties: {
    code: { type: 'string' }, timeout_ms: { type: 'integer' }, title: { type: 'string' } }, required: ['code'] } },
  { name: 'js_reset', inputSchema: { type: 'object', properties: {} } },
  ...(mode === 'no-turn-end' ? [] : [{ name: 'turn_ended', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: [] } } }]),
  ...(mode === 'launcher' ? [{ name: 'select_window', inputSchema: { type: 'object', properties: {} } }] : []),
];
const surfaces = process.env.CUA_REPL_ENABLED_SURFACES;
const browser = surfaces === undefined || surfaces.split(',').includes('browser');
const methods = ['getApp', 'getState', 'listApps', ...(browser ? ['listBrowsers', 'getBrowser', 'getTab', 'createBrowserTab', 'listTabs'] : [])];
const absent = browser ? [] : ['listBrowsers', 'getBrowser', 'getTab', 'createBrowserTab', 'listTabs'];

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (mode !== 'initialize-hang') send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  }
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools } });
  else if (msg.method === 'tools/call') {
    if (mode === 'hang') return;
    const code = msg.params.arguments?.code ?? '';
    if (msg.params.name === 'turn_ended') return send({ id: msg.id, result: { content: [] } });
    if (code.includes('__sleightDocumentGuardSetup')) return send({ id: msg.id, result: { content: [
      { type: 'text', text: fixture('native-api-docs.txt') }, { type: 'text', text: '[sleight:guard-ready]\n' },
    ] } });
    if (code.includes('no-such-app')) return send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: docs }, { type: 'text', text: 'Invalid app: com.landoclusters.sleight.no-such-app' }] } });
    if (code.includes('sleight-compat-probe:')) {
      const kinds = Object.fromEntries([...methods.map(name => [name, mode === 'probe-missing' && name === 'getTab' ? 'undefined' : 'function']),
        ...absent.map(name => [name, 'undefined'])]);
      const probe = { kinds: { ...kinds, 'nodeRepl.write': 'function', 'nodeRepl.emitImage': 'function' },
        state: { apps: { '[]': { id: 'string', isRunning: 'boolean', windows: { '[]': { id: 'number', app: 'string', title: 'string' } } } }, browsers: { '[]': {} } },
        apps: { '[]': { id: 'string', windows: { '[]': { id: 'number', app: 'string', title: 'string' } } } } };
      return send({ id: msg.id, result: { content: [{ type: 'text', text: '{"apps":[]}' }, { type: 'text', text: 'sleight-compat-probe:' + JSON.stringify(probe) }] } });
    }
    send({ id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
});
