import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { appRefusal, pageRefusal, sitesLimited } from '../plugins/sleight/lib/permissions.mjs';
import { OWN_HOST_LINE } from '../plugins/sleight/lib/own-host.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { ENGINE_OPEN_TOOL, LEAN_ENGINE_OPEN_DESCRIPTION, parseEngineOpen, turboRoute, acquisitionCode, openCode, widenTurboOpen,
  engineBrowserOpen } from '../plugins/sleight/lib/engine-browser-open.mjs';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

test('the flag reads SLEIGHT_BROWSER_CORE=1 only', () => {
  assert.equal(engineBrowserOpen({ SLEIGHT_BROWSER_CORE: '1' }), true);
  for (const value of [undefined, '0', 'true', '']) assert.equal(engineBrowserOpen({ SLEIGHT_BROWSER_CORE: value }), false);
});

test('the tool mirrors turbo: browser_open with url and browser, and the lean text is shorter', () => {
  assert.equal(ENGINE_OPEN_TOOL.name, 'browser_open');
  assert.deepEqual(Object.keys(ENGINE_OPEN_TOOL.inputSchema.properties).sort(), ['browser', 'url']);
  assert.deepEqual(ENGINE_OPEN_TOOL.inputSchema.required.sort(), ['browser', 'url']);
  assert.equal(ENGINE_OPEN_TOOL.inputSchema.additionalProperties, false);
  assert.ok(LEAN_ENGINE_OPEN_DESCRIPTION.length <= ENGINE_OPEN_TOOL.description.length * 0.71);
  // App-agnostic: the description names no browser.
  assert.doesNotMatch(ENGINE_OPEN_TOOL.description + LEAN_ENGINE_OPEN_DESCRIPTION, /Safari|Firefox|Chrome|Helium/);
});

test('parseEngineOpen accepts an http(s) URL and a browser name, and refuses everything that could type more than a URL', () => {
  assert.deepEqual(parseEngineOpen({ url: 'https://example.com/a?b=1#c', browser: 'Some Browser' }),
    { url: 'https://example.com/a?b=1#c', browser: 'Some Browser' });
  assert.deepEqual(parseEngineOpen({ url: 'http://127.0.0.1:5413/settings', browser: 'org.example.browser' }).url, 'http://127.0.0.1:5413/settings');
  const bad = [
    {}, { url: 'https://example.com' }, { browser: 'B' }, { url: 'https://example.com', browser: 'B', extra: 1 },
    { url: 'javascript:alert(1)', browser: 'B' }, { url: 'file:///etc/passwd', browser: 'B' }, { url: 'ftp://example.com', browser: 'B' },
    { url: 'https://user:pass@example.com/', browser: 'B' }, { url: 'https://example.com/a b', browser: 'B' },
    { url: 'https://example.com/\nrm -rf ~', browser: 'B' }, { url: 'https://example.com/\t', browser: 'B' },
    { url: 'https://example.com/\u0007', browser: 'B' }, { url: 'https://example.com/ ', browser: 'B' }, { url: 'not a url', browser: 'B' },
    { url: `https://example.com/${'a'.repeat(2048)}`, browser: 'B' }, { url: 'https://example.com', browser: '' },
    { url: 'https://example.com', browser: 7 }, { url: 'https://example.com', browser: 'B'.repeat(129) },
    { url: 'https://example.com', browser: 'B\nC' }, { url: 7, browser: 'B' }, null, 'https://example.com',
  ];
  for (const args of bad) assert.throws(() => parseEngineOpen(args), /^Error: browser_open: /, JSON.stringify(args));
});

test('the code is one acquisition and then Cmd+T, the URL as text, Return and a read, every value JSON-quoted', () => {
  assert.equal(acquisitionCode('sleightBrowser1', 'Some "Browser"'), 'let sleightBrowser1 = await cua.getApp("Some \\"Browser\\"");');
  assert.equal(openCode('sleightBrowser1', 'https://example.com/"x"'), 'await sleightBrowser1.pressKey("super+t");\n' +
    'await sleightBrowser1.typeText("https://example.com/\\"x\\"");\nawait sleightBrowser1.pressKey("Return");\nawait sleightBrowser1.getAXState();');
});

test('turboRoute sends turbo its own browser, by its value or app name, and every other browser to the engine path', () => {
  const turbo = { browser: 'bfixture', application: 'Fixture Browser' };
  assert.deepEqual(turboRoute({ url: 'https://e.test' }, turbo), { url: 'https://e.test' });
  assert.deepEqual(turboRoute({ url: 'https://e.test', browser: 'bfixture' }, turbo), { url: 'https://e.test', browser: 'bfixture' });
  assert.deepEqual(turboRoute({ url: 'https://e.test', browser: 'fixture browser' }, turbo), { url: 'https://e.test', browser: 'bfixture' });
  assert.equal(turboRoute({ url: 'https://e.test', browser: 'Other' }, turbo), undefined);
  assert.equal(turboRoute({ url: 'https://e.test', browser: 'bfixture' }, undefined), undefined);
});

test('the widened turbo tool keeps its url field and description, and takes any browser name', () => {
  const tool = { name: 'browser_open', description: 'Open an owned background tab.', inputSchema: { type: 'object',
    properties: { url: { type: 'string', maxLength: 65536 }, browser: { type: 'string', enum: ['bfixture'] } }, required: ['url'], additionalProperties: false } };
  const wide = widenTurboOpen(tool, 'bfixture');
  assert.ok(wide.description.startsWith('Open an owned background tab. '));
  assert.match(wide.description, /bfixture/);
  assert.deepEqual(wide.inputSchema.properties.url, tool.inputSchema.properties.url);
  assert.equal(wide.inputSchema.properties.browser.enum, undefined);
  assert.deepEqual(wide.inputSchema.required, ['url']);
  assert.deepEqual(tool.inputSchema.properties.browser.enum, ['bfixture'], 'the original is not changed');
  assert.equal(widenTurboOpen({ name: 'browser_read' }, 'bfixture').name, 'browser_read');
});

// Relay: a fake engine and client, the input lease on, the user's permissions as the launcher gives them.
const LINE = 'You blocked sleight in Blocked App (sleight-mcp permissions unblock com.example.blocked lifts it).';
const BROWSERS = new Set(['com.example.browser']);
function blocks(perms = { state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: [] }) {
  return { app: query => appRefusal(perms, query), page: page => pageRefusal(perms, page), sitesLimited: () => sitesLimited(perms), noteApp() {} };
}
function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-engine-open-'));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', permissions: blocks(),
    inputLease: new InputLease({ directory, holder: 'A' }), webBrowser: id => BROWSERS.has(id) ? true : id === 'com.example.pending' ? undefined : false,
    engineBrowserOpen: true, ownHostPid: () => false, ...options });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return {
    toServer, toClient, call,
    open: (id, args) => call(id, 'browser_open', args),
    list: id => { clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n'); },
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
    reply: id => toClient.find(m => m.id === id),
    engineCalls: () => toServer.filter(m => m.method === 'tools/call'),
  };
}
const tree = (id, app, appId, title, body = '\t1 tab (selected) Start\n\t2 text field Address') => ({ jsonrpc: '2.0', id, result: {
  content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}\n${body}` }],
  _meta: { 'codex/toolSurface': { app: { appId } } } } });
const code = msg => msg.params.arguments.code;
const text = msg => msg.result.content.map(item => item.text ?? '').join('\n');

async function listed(t, options) {
  const h = harness(t, options);
  h.list(1); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: 'Run JavaScript.', inputSchema: { type: 'object' } }] } });
  await settle();
  return h.reply(1).result.tools;
}

test('relay: the flag adds browser_open to the tool list; without it the list is unchanged', async t => {
  const on = await listed(t), off = await listed(t, { engineBrowserOpen: false });
  assert.deepEqual(on.find(tool => tool.name === 'browser_open').inputSchema, ENGINE_OPEN_TOOL.inputSchema);
  assert.equal(off.some(tool => tool.name === 'browser_open'), false);
  assert.deepEqual(on.filter(tool => tool.name !== 'browser_open'), off);
  const lean = await listed(t, { prompt: 'lean' });
  assert.equal(lean.find(tool => tool.name === 'browser_open').description, LEAN_ENGINE_OPEN_DESCRIPTION);
  assert.equal(localToolDefinitions({ SLEIGHT_BROWSER_CORE: '1' }).some(tool => tool.name === 'browser_open'), false,
    'the relay owns the tool, not the local tool server');
});

test('relay: a browser opens in two engine calls, the acquisition then the tab keys, and Claude gets one result naming the handle', async t => {
  const h = harness(t);
  h.open(7, { url: 'https://example.com/a?b=1', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  assert.notEqual(first.id, 7, 'the acquisition is the relay\'s own call');
  assert.match(code(first), /let sleightBrowser\d+ = await cua\.getApp\("Example Browser"\)/);
  assert.equal(h.reply(7), undefined);
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  const second = h.engineCalls().find(m => m.id === 7);
  assert.ok(second, 'the tab keys go out under Claude\'s call id');
  assert.equal(second.params.name, 'js');
  const handle = /let (sleightBrowser\d+)/.exec(code(first))[1];
  for (const part of [`${handle}.pressKey("super+t")`, `${handle}.typeText("https://example.com/a?b=1")`, `${handle}.pressKey("Return")`]) {
    assert.ok(code(second).includes(part), part);
  }
  assert.notEqual(code(second), openCode(handle, 'https://example.com/a?b=1'), 'the second call is wrapped by the guard like any js call');
  h.fromServer(tree(7, 'Example Browser', 'com.example.browser', 'Example Domain',
    '\t1 tab Start\n\t2 tab (selected) Example Domain\n\t3 HTML content URL: https://example.com/a?b=1\n\t\t4 link More')); await settle();
  const result = h.reply(7).result;
  assert.notEqual(result.isError, true);
  assert.match(text(h.reply(7)), new RegExp(`\`${handle}\``));
  assert.match(text(h.reply(7)), /Start Page/, 'the acquisition\'s tree comes first');
  assert.match(text(h.reply(7)), /4 link More/);
});

test('relay: an app that is not a web browser gets no keys or text, and pending browser lookups refuse too', async t => {
  for (const [appId, pattern] of [['com.example.terminal', /isn't a web browser/], ['com.example.pending', /doesn't know yet/], [undefined, /isn't a web browser/]]) {
    const h = harness(t);
    h.open(1, { url: 'https://example.com/', browser: 'Some App' }); await settle();
    const [first] = h.engineCalls();
    h.fromServer(tree(first.id, 'Some App', appId, 'Shell')); await settle();
    assert.equal(h.engineCalls().length, 1, `${appId}: nothing after the acquisition`);
    assert.equal(h.reply(1).result.isError, true);
    assert.match(text(h.reply(1)), pattern);
    assert.doesNotMatch(text(h.reply(1)), /sleightBrowser/);
  }
});

test('relay: a failed acquisition answers Claude with its error and sends nothing more', async t => {
  const h = harness(t);
  h.open(1, { url: 'https://example.com/', browser: 'Missing' }); await settle();
  const [first] = h.engineCalls();
  h.fromServer({ jsonrpc: '2.0', id: first.id, result: { isError: true, content: [{ type: 'text', text: 'App not found: Missing' }] } }); await settle();
  assert.equal(h.engineCalls().length, 1);
  assert.equal(h.reply(1).result.isError, true);
  assert.match(text(h.reply(1)), /App not found/);
});

test('relay: a bad URL, a blocked app, sleight\'s own host and a blocked site never reach the engine', async t => {
  const h = harness(t, { permissions: blocks({ state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: ['https://bestbuy.com'] }) });
  h.open(1, { url: 'javascript:alert(1)', browser: 'Example Browser' });
  h.open(2, { url: 'https://example.com/', browser: 'Blocked App' });
  h.open(3, { url: 'https://example.com/', browser: 'consent-host' });
  h.open(4, { url: 'https://www.bestbuy.com/site/x', browser: 'Example Browser' });
  await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /^browser_open: /);
  assert.equal(text(h.reply(2)), LINE);
  assert.equal(text(h.reply(3)), OWN_HOST_LINE);
  assert.match(text(h.reply(4)), /You blocked sleight on https:\/\/bestbuy\.com/);
  for (const id of [1, 2, 3, 4]) assert.equal(h.reply(id).result.isError, true);
});

test('relay: an allow-only list refuses a destination outside it before the engine', async t => {
  const h = harness(t, { permissions: blocks({ state: 'ok', apps: [], sites: [], only: ['https://allowed.example'] }) });
  h.open(1, { url: 'https://other.example/', browser: 'Example Browser' }); await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /You allow sleight only on/);
});

test('relay: document scope refuses browser_open', async t => {
  const h = harness(t, { approvalScope: 'document', ask: async () => 'accept' });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.deepEqual(h.engineCalls(), []);
  assert.match(text(h.reply(1)), /document scope/);
});

test('relay: a flow rule stops the typed URL, and a flow exception lets the identical browser_open retry once', async t => {
  const h = harness(t, { flowRules: new FlowRules({ version: 1, rules: [{ id: 'private', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] }),
    ask: async () => 'accept' });
  const args = { url: 'https://example.com/?q=SECRET', browser: 'Example Browser' };
  h.open(1, args); await settle();
  const [first] = h.engineCalls();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 1), false, 'the typed URL never reached the engine');
  assert.match(text(h.reply(1)), /private.*flow_exception/s);
  h.call(2, 'flow_exception', {}); await settle(); await settle();
  h.open(3, args); await settle();
  const again = h.engineCalls().at(-1);
  h.fromServer(tree(again.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.ok(h.engineCalls().some(m => m.id === 3), 'the identical retry goes through once');
  h.fromServer(tree(3, 'Example Browser', 'com.example.browser', 'Example', '\t1 tab (selected) Example\n\t2 HTML content URL: https://example.com/?q=SECRET'));
  await settle();
  h.open(4, args); await settle();
  const third = h.engineCalls().at(-1);
  h.fromServer(tree(third.id, 'Example Browser', 'com.example.browser', 'Example')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 4), false, 'the exception was for one retry');
});

test('relay: Stop between the two calls ends browser_open without the tab keys', async t => {
  const h = harness(t, { stopEngine: async () => {} });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  h.call(2, 'turn_ended', { sleight_stop: true }); await settle();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.equal(h.engineCalls().some(m => m.id === 1), false);
});

// Turbo on: its own browser stays on turbo, any other browser takes the engine path.
async function v3Frontend(t, calls) {
  const child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call: async request => { calls.push(request); return { text: 'turbo result', isError: false }; }, delivered: () => true,
      async end() { return { revoked: true, cleanup: [] }; } };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => session.ready()); return child; } });
  t.after(() => bridge.detach());
  assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'open the page' }), true);
  return createV3Frontend(bridge);
}

test('relay with turbo: turbo keeps its browser, another browser goes to the engine path, and the list shows one widened tool', async t => {
  const calls = [];
  const directBrowser = await v3Frontend(t, calls);
  const h = harness(t, { directBrowser });
  h.list(1); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: 'Run JavaScript.', inputSchema: { type: 'object' } }] } });
  await settle();
  const opens = h.reply(1).result.tools.filter(tool => tool.name === 'browser_open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].inputSchema.properties.browser.enum, undefined);
  h.open(2, { url: 'https://example.com/', browser: 'bfixture' }); await settle(); await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name ?? calls[0].request?.name, 'browser_open');
  assert.deepEqual(h.engineCalls(), []);
  h.open(3, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  assert.equal(calls.length, 1);
  assert.match(code(h.engineCalls()[0]), /cua\.getApp\("Example Browser"\)/);
});

test('relay: with the window helper, the tab keys wait for the lease admission on the window the acquisition showed', async t => {
  const asked = [];
  const h = harness(t, { changeReview: false, windowIdentity: async window => { asked.push(window);
    return { ...window, status: 'ok', matches: 1, epoch: 'helper', windowNumber: 4, pid: 123, processStart: 1 }; } });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  h.fromServer(tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page')); await settle();
  assert.ok(asked.some(window => window.appId === 'com.example.browser' && window.title === 'Start Page'), JSON.stringify(asked));
  assert.ok(h.engineCalls().some(m => m.id === 1), 'the keys go out after the admission');
});

test('relay: as the first call of a session, browser_open still delivers the skill rules with every pinned safety passage', async t => {
  const { skillRules } = await import('../plugins/sleight/lib/launch.mjs');
  const { readFileSync } = await import('node:fs');
  const safety = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url))).skillSafety;
  const h = harness(t, { firstCallRules: skillRules(new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url)) });
  h.open(1, { url: 'https://example.com/', browser: 'Example Browser' }); await settle();
  const [first] = h.engineCalls();
  const reply = tree(first.id, 'Example Browser', 'com.example.browser', 'Start Page');
  reply.result.content[0].text = '## Computer Use\nNative reference.\n' + reply.result.content[0].text;
  h.fromServer(reply); await settle();
  h.fromServer(tree(1, 'Example Browser', 'com.example.browser', 'Example', '\t1 tab (selected) Example\n\t2 HTML content URL: https://example.com/')); await settle();
  const all = text(h.reply(1));
  assert.match(all, /Top-level `await`, no `return`/);
  for (const passage of safety) assert.ok(all.includes(passage), passage);
});
