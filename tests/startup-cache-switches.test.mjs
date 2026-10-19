// Every sleight switch against the handshake cache (HS1, 2026-10-19). A session started with SLEIGHT_FS=1 right after
// sessions without it got the old session's cached tool list, then every call failed on "Engine tools changed".
// The cache now holds only the engine's own replies, keyed on what starts the engine, and the relay rewrites them per
// session. These tests fail if a switch changes what a warm session answers, or if an engine input leaves the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStartupCache, startupIdentity } from '../plugins/sleight/lib/startup-cache.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { INVENTORY_SENTENCE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const lib = new URL('../plugins/sleight/lib/', import.meta.url).pathname;
const root = new URL('../plugins/sleight/', import.meta.url).pathname;
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const engineTools = { tools: [
  { name: 'js', description: `Run code. Use cua.getState() only to find an app or browser you can't name. ${INVENTORY_SENTENCE} Then act.`,
    inputSchema: { type: 'object' } },
  { name: 'js_add_node_module_dir', inputSchema: { type: 'object' } },
  { name: 'turn_ended', inputSchema: { type: 'object' }, _meta: { ui: { visibility: [] } } }] };

function sources(directory = lib) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.m?js$/.test(entry.name) ? [readFileSync(join(directory, entry.name), 'utf8')] : []);
}
// Each SLEIGHT_* name in the plugin's code, with every value the code compares it to, plus on and off.
function switches() {
  const found = new Map();
  for (const text of sources()) {
    for (const [name] of text.matchAll(/SLEIGHT_[A-Z0-9_]+/g)) if (!found.has(name)) found.set(name, new Set(['1', '0']));
    for (const [, name, value] of text.matchAll(/(SLEIGHT_[A-Z0-9_]+)\s*[!=]==?\s*'([^']*)'/g)) found.get(name).add(value);
    for (const [, list, argument] of text.matchAll(/\[([^\]]*)\]\.includes\(([^)]*)\)/g)) {
      for (const [name] of argument.matchAll(/SLEIGHT_[A-Z0-9_]+/g)) for (const [, value] of list.matchAll(/'([^']*)'/g)) found.get(name).add(value);
    }
  }
  return found;
}

function session(t, directory, options = {}, clientInfo = { name: 'claude-code', version: '1' }) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const client = [], server = [];
  for (const [stream, messages] of [[clientOut, client], [serverIn, server]]) {
    stream.setEncoding('utf8').on('data', data => data.trim().split('\n').filter(Boolean).forEach(line => messages.push(JSON.parse(line))));
  }
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, stderr: { write() {} },
    startupCache: createStartupCache({ identity: { engine: 'fixture', sleight: 'fixture' }, directory }), ...options });
  t.after(() => relay.dispose());
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n'), reply = msg => serverOut.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo, capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const early = structuredClone(client);
  reply({ jsonrpc: '2.0', id: 1, result: structuredClone(init) });
  reply({ jsonrpc: '2.0', id: 2, result: structuredClone(engineTools) });
  return { early, client, server };
}

function withEnv(name, value, run) {
  const had = Object.hasOwn(process.env, name), before = process.env[name];
  process.env[name] = value;
  try { return run(); } finally { if (had) process.env[name] = before; else delete process.env[name]; }
}

test('every SLEIGHT_* switch: a warm session answers exactly as a cold session with the same switch', t => {
  const primed = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-switch-')));
  t.after(() => removeTemp(primed));
  session(t, primed);
  const found = switches();
  assert.ok(found.has('SLEIGHT_FS') && found.has('SLEIGHT_TS3') && found.size >= 60, [...found.keys()].join(' '));
  assert.ok(found.get('SLEIGHT_APPROVAL_SCOPE').has('document'));
  for (const [name, values] of found) for (const value of values) withEnv(name, value, () => {
    const empty = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-switch-')));
    t.after(() => removeTemp(empty));
    const cold = session(t, empty), warm = session(t, primed);
    const label = `${name}=${value}`;
    assert.equal(warm.early.length, 2, `${label}: the warm session answers from the cache`);
    assert.deepEqual(warm.early, cold.client, `${label}: the cached answer equals a cold session's`);
    assert.deepEqual(warm.client, cold.client, `${label}: the live replies verify without an error or a second answer`);
  });
});

// Relay settings the launcher derives from switches (launch.mjs createRelay options), with values other than their defaults.
for (const [label, options, clientInfo] of [
  ['SLEIGHT_APPROVAL_SCOPE=document', { approvalScope: 'document' }],
  ['SLEIGHT_FIRST_CALL_BATCH=nosavestop', { firstCallBatch: 'nosavestop' }],
  ['a Codex client without the mod', { modHost: () => false }, { name: 'codex-mcp-client', version: '9.0.0' }],
  ['SLEIGHT_FIRST_CALL_BATCH', { firstCallBatch: true }],
  ['SLEIGHT_FIRST_CALL_BATCH=merge', { firstCallBatch: 'merge' }],
  ['SLEIGHT_CHANGE_REVIEW=0', { changeReview: false }],
  ['SLEIGHT_PROMPT=lean', { prompt: 'lean' }],
  ['SLEIGHT_LEAN_CALLS=1', { leanCalls: true }],
  ['SLEIGHT_FS=1', { firstCallSteering: true, firstCallWindows: true }],
  ['SLEIGHT_TS3=1', { firstCallWindows: true }],
  ['SLEIGHT_BROWSER_CORE=1', { engineBrowserOpen: true }],
  ['local tools (SLEIGHT_DRAG, SLEIGHT_HOVER and others)', { localTools: { tools: [{ name: 'drag', inputSchema: { type: 'object' } }] } }],
  ['a host without the mod', { modHost: () => false }],
]) test(`${label}: a warm session answers exactly as a cold one`, t => {
  const primed = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-switch-'))), empty = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-switch-')));
  t.after(() => { removeTemp(primed); removeTemp(empty); });
  session(t, primed, {}, clientInfo);
  const cold = session(t, empty, options, clientInfo), warm = session(t, primed, options, clientInfo);
  assert.equal(warm.early.length, 2);
  assert.deepEqual(warm.early, cold.client);
  assert.deepEqual(warm.client, cold.client);
});

test('the key covers every engine spawn input and only per-session values are left out', () => {
  const server = { version: '1', command: '/engine', args: ['/engine.mjs'], env: { CUA_REPL_ENABLED_SURFACES: 'computer' } };
  const base = startupIdentity(server, root, {});
  for (const changed of [{ ...server, version: '2' }, { ...server, command: '/other' }, { ...server, args: ['/other.mjs'] },
    { ...server, env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer' } }, { ...server, env: { ...server.env, NEW_SETTING: '1' } }]) {
    assert.notDeepEqual(startupIdentity(changed, root, {}), base, JSON.stringify(changed));
  }
  for (const name of ['CUA_ANY', 'NODE_REPL_TOOL_OVERRIDES', 'NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER', 'SKY_ANY', 'BROWSER_USE_TINYSKY_ENABLED',
    'CODEX_HOME', 'CODEX_CLI_PATH']) {
    assert.notDeepEqual(startupIdentity(server, root, { [name]: 'x' }), base, name);
  }
  for (const name of ['SLEIGHT_FS', 'SLEIGHT_TRACE', 'CUA_SESSION_ID', 'BROWSER_USE_ACCESS_ID', 'NODE_REPL_AUTH_TOKEN', 'PATH', 'HOME']) {
    assert.deepEqual(startupIdentity(server, root, { [name]: 'x' }), base, name);
  }
});

test('switches that pick the engine reach the key through the server the launcher spawns', t => {
  const home = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-switch-')));
  t.after(() => removeTemp(home));
  const plugin = join(home, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: '/engine', args: ['/engine.mjs'], env: {} } } }));
  const identity = env => startupIdentity(resolveServer({ CODEX_HOME: home, ...env }), root, {});
  assert.notDeepEqual(identity({ SLEIGHT_SURFACES: 'browser,computer' }), identity({}), 'SLEIGHT_SURFACES');
  // The launcher keys the cache on the same server object it spawns, and adds nothing else to the engine's environment.
  const launch = readFileSync(join(lib, 'launch.mjs'), 'utf8');
  assert.match(launch, /spawn\(activeServer\.command, activeServer\.args, \{[^}]*env: \{ \.\.\.process\.env, \.\.\.activeServer\.env \} \}\)/);
  assert.match(launch, /startupIdentity\(activeServer, /);
});
