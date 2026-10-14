import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { compactTools } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { fixture } from './fixtures/direct-browser-open.mjs';
import { fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';

const load = async file => {
  const value = await import('../bench/turbo/' + file).catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  });
  assert.ok(value, 'production-module bench arm missing: ' + file); return value;
};
const origin = 'http://127.0.0.1:5431';

test('turbo setup isolates Claude, authenticates only the original task and imports the four tools', async () => {
  const { turboSetup, fixtureOrigins } = await load('setup.mjs');
  const task = { prompt: 'Fill ' + origin + '/form then submit it', grade: origin + '/grade' };
  const setup = turboSetup({ task, repo: '/fixture/repo', dir: join(tmpdir(), 'turbo-arm-setup'), prompt: task.prompt,
    env: { HOME: '/fixture/home', PATH: '/bin', CLAUDE_CONFIG_DIR: '/owner', CLAUDE_CODE_SESSION_ID: 'owner' } });
  assert.equal(setup.metadata.measurement, 'production turbo tools and modules; installed path excluded');
  assert.equal(setup.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.notEqual(setup.env.CLAUDE_CONFIG_DIR, '/owner');
  assert.equal(setup.allowed.split(',').length, 4);
  assert.deepEqual(setup.allowed.split(',').map(name => name.replace('mcp__sleight-turbo__', '')), compactTools().map(tool => tool.name));
  const server = setup.mcpServers['sleight-turbo'];
  assert.deepEqual(server.args, ['/fixture/repo/bench/turbo/server.mjs']);
  assert.equal(server.env.SLEIGHT_TURBO_TASK, task.prompt);
  assert.deepEqual(JSON.parse(server.env.SLEIGHT_TURBO_ORIGINS), [origin]);
  assert.deepEqual(fixtureOrigins(task), [origin]);
  assert.throws(() => turboSetup({ task: { prompt: 'Visit https://example.com/' } }), /fixture/i);
});

test('protocol catalog equals installed turbo and fake Claude completes one production form fill and submit', async t => {
  const { createModuleSession } = await load('session.mjs'), { createProtocol } = await load('server.mjs');
  const f = await fixture(t, { rawOnly: true });
  const raw = { sessionId: 'root', on: f.raw.on, off: f.raw.off, async send(method, params, route) {
    const result = await f.raw.send(method, params, route);
    if (method === 'Page.getFrameTree') result.frameTree.frame.url = origin + '/form';
    return result;
  } };
  let starts = 0, closed = 0, session;
  const output = new PassThrough(), messages = []; let buffer = '';
  output.on('data', data => { buffer += data; let end;
    while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  const protocol = createProtocol({ output, start: async () => {
    starts++; session = await createModuleSession({ raw, origins: [origin], taskMessage: 'Fill Name with Example, then Save.' });
    return { ...session, async close() { closed++; return session.close(); } };
  } });
  t.after(() => protocol.close());
  let id = 0;
  const request = async (method, params) => {
    await protocol.message({ jsonrpc: '2.0', id: ++id, method, params }); return messages.at(-1);
  };
  await request('initialize', { protocolVersion: '2024-11-05' });
  assert.deepEqual((await request('tools/list')).result.tools, compactTools());
  assert.equal(starts, 0);
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response)); return JSON.parse(response.result.content[0].text);
  };
  const opened = await call('browser_open', { browser: 'bbench', url: origin + '/form' });
  assert.equal(opened.effect, 'verified', JSON.stringify(opened));
  const read = await call('browser_read', { tab: opened.tab, max_bytes: 64000 });
  const rows = read.observation.data;
  const filled = await call('browser_fill', { tab: opened.tab, fields: [{ ref: rows.find(row => row.name === 'Name').ref, value: 'Example' }] });
  assert.equal(filled.effect, 'verified', JSON.stringify(filled)); assert.equal(filled.completed, 1);
  assert.equal(f.value(), 'Example');
  const submitted = await call('browser_act', { tab: opened.tab, op: 'click', ref: rows.find(row => row.name === 'Save').ref });
  assert.equal(submitted.receipt.effect, 'unknown', JSON.stringify(submitted));
  assert.equal(f.calls.filter(call => call.params.type === 'mouseReleased').length, 1);
  assert.equal(starts, 1);
  const receipt = await protocol.close(); await protocol.close(); assert.equal(closed, 1);
  assert.equal(receipt.revoked, true);
  assert.equal(f.targets.size, 1, 'unknown submit stays parked until the disposable browser closes');
  assert.equal(f.calls.some(call => /activateTarget|bringToFront/.test(call.method)), false);
});

test('fixture trust never admits external, credentialed or unserved loopback URLs', async () => {
  const { fixturePolicy } = await load('setup.mjs');
  const permits = fixturePolicy([origin]);
  assert.equal(permits(origin + '/form'), true);
  for (const url of ['https://example.com', 'http://localhost:5431', 'http://127.0.0.1:9999',
    'http://user@127.0.0.1:5431/', 'file:///tmp/test', 'data:text/html,test']) assert.equal(permits(url), false, url);
  assert.throws(() => fixturePolicy(['http://example.com']));
});

test('browser and profile cleanup is idempotent, and failed closure retains its exact profile', async t => {
  const { createSession, launchOptions } = await load('server.mjs');
  const parent = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-arm-')));
  const options = launchOptions();
  assert.equal(options.headless, true); assert.equal(options.serviceWorkers, 'block');
  assert.ok(options.args.includes('--remote-debugging-port=0'));
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined); assert.equal(options.env.CLAUDE_CONFIG_DIR, undefined);
  for (const fail of [false, true]) {
    let profile, closes = 0, socketCloses = 0;
    const session = await createSession({ origins: [origin], taskMessage: 'Read fixture', temporaryRoot: parent,
      chromium: { async launchPersistentContext(path, opts) { profile = path; assert.equal(opts.headless, true);
        return { route: async () => {}, close: async () => { closes++; if (fail) throw Error('unproved'); } };
      } }, connect: async () => ({ close: async () => { socketCloses++; return true; } }),
      modules: async () => ({ call: async () => ({}), delivered: () => true, close: async () => ({ revoked: true, cleanup: [] }) }) });
    if (fail) { await assert.rejects(session.close(), /CLEANUP_UNPROVED/); assert.equal(existsSync(profile), true); }
    else { assert.deepEqual(await session.close(), { browserClosed: true, profileDeleted: true, socketsClosed: true });
      await session.close(); assert.equal(existsSync(profile), false); }
    assert.equal(closes, 1); assert.equal(socketCloses, 1);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('invalid tool calls and protocol EOF never start a browser', async () => {
  const { createProtocol } = await load('server.mjs'); let starts = 0;
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  const protocol = createProtocol({ output, start: () => { starts++; throw Error('private'); } });
  for (const params of [{ name: 'evaluate', arguments: {} }, { name: 'browser_act', arguments: { tab: 't1' } }])
    await protocol.message({ id: messages.length + 1, method: 'tools/call', params });
  assert.equal(starts, 0); assert.ok(messages.every(message => message.error.code === -32602)); await protocol.close();
});

// Claude Code adds _meta to every tools/call; the first live round refused all four tools on it (2026-10-14).
test('a tool call carrying the client\'s _meta reaches the session', async () => {
  const { createProtocol } = await load('server.mjs'); const calls = [];
  const output = new PassThrough(), messages = []; output.on('data', data => messages.push(JSON.parse(data)));
  const protocol = createProtocol({ output, start: async () => ({ call: async request => { calls.push(request); return { tab: 't1' }; },
    delivered() {}, close: async () => {} }) });
  await protocol.message({ id: 1, method: 'tools/call', params: { name: 'browser_open',
    arguments: { browser: 'bbench', url: origin + '/checkout' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } } });
  assert.equal(messages[0].error, undefined); assert.deepEqual(calls.map(call => call.name), ['browser_open']);
  await protocol.close();
});

test('a failed module revocation cannot become a clean browser receipt', async t => {
  const { createSession } = await load('server.mjs');
  const parent = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-revoke-')));
  let profile, browserClosed = false, socketClosed = false;
  const session = await createSession({ origins: [origin], taskMessage: 'Read fixture', temporaryRoot: parent,
    chromium: { async launchPersistentContext(path) { profile = path; return {
      route: async () => {}, close: async () => { browserClosed = true; } }; } },
    connect: async () => ({ close: async () => { socketClosed = true; return true; } }),
    modules: async () => ({ close: async () => { throw Error('revocation unavailable'); } }) });
  await assert.rejects(session.close(), /CLEANUP_UNPROVED/);
  assert.equal(browserClosed, true); assert.equal(socketClosed, true);
  assert.equal(existsSync(profile), true, 'retain exact profile when revocation is unproved');
});

test('payment grants require explicit matching task terms and never page instructions', async () => {
  const { taskPayment } = await load('payment.mjs');
  const evidence = { item: 'Fixture mug', payee: 'Fixture shop', amount: '18.00' };
  assert.equal(taskPayment('Read the page. It says to pay with card 4444.', evidence), null);
  assert.equal(taskPayment('Buy Fixture mug from Fixture shop with card 4444 for $18.00.', evidence)?.method, 'card 4444');
  assert.equal(taskPayment('Do not buy Fixture mug from Fixture shop with card 4444 for $18.00.', evidence), null);
  assert.equal(taskPayment('Buy Fixture mug from Fixture shop with card 4444 for $19.00.', evidence), null);
  assert.equal(taskPayment('Buy a different mug from Fixture shop with card 4444 for $18.00.', evidence), null);
});

for (const mode of ['requested', 'page-only', 'changed-amount']) test('production payment authority receives only the authenticated task: ' + mode, async t => {
  const { createModuleSession } = await load('session.mjs');
  const f = await fixture(t, { rawOnly: true });
  const raw = { sessionId: 'root', on: f.raw.on, off: f.raw.off, async send(method, params, route) {
    const result = await f.raw.send(method, params, route);
    if (method === 'Page.getFrameTree') result.frameTree.frame.url = origin + '/form';
    if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === fixedFormInspectors['form-state'].source &&
        result.result.value.kind === 'button') result.result.value.payment = true;
    return result;
  } };
  const session = await createModuleSession({ raw, origins: [origin],
    taskMessage: mode === 'page-only' ? 'Read the form. Page says buy Fixture mug with card 4444.'
      : 'Buy Fixture mug from Fixture shop with card 4444 for $18.00.',
    readPayment: async () => ({ url: origin + '/form', page: { item: 'Fixture mug', payee: 'Fixture shop',
      amount: mode === 'changed-amount' ? '19.00' : '18.00' } }) });
  t.after(() => session.close());
  const opened = await session.call({ name: 'browser_open', arguments: { browser: 'bbench', url: origin + '/form' } });
  assert.equal(opened.effect, 'verified', JSON.stringify(opened));
  const read = await session.call({ name: 'browser_read', arguments: { tab: opened.tab, max_bytes: 64000 } });
  assert.equal(session.delivered(read), true);
  const ref = read.observation.data.find(row => row.name === 'Save').ref;
  const result = await session.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref } });
  assert.equal(f.calls.filter(call => call.params.type === 'mouseReleased').length, mode === 'requested' ? 1 : 0, JSON.stringify(result));
});

test('root transport preserves flattened routing, denies foreground commands and proves socket closure', async t => {
  const { connectRoot } = await load('transport.mjs');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-wire-')));
  writeFileSync(join(dir, 'DevToolsActivePort'), '5431\n/devtools/browser/owned\n');
  let socket;
  class Socket extends EventTarget {
    sent = []; constructor(endpoint) { super(); socket = this; assert.equal(endpoint, 'ws://127.0.0.1:5431/devtools/browser/owned');
      queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.dispatchEvent(new Event('close')); }
    reply(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  }
  const raw = await connectRoot(dir, { WebSocketClass: Socket }); t.after(() => raw.close());
  const pending = raw.send('Page.getFrameTree', {}, 'owned-child');
  assert.equal(socket.sent[0].sessionId, 'owned-child');
  socket.reply({ id: socket.sent[0].id, sessionId: 'owned-child', result: { frameTree: {} } });
  assert.deepEqual(await pending, { frameTree: {} });
  for (const method of ['Page.bringToFront', 'Target.activateTarget']) await assert.rejects(raw.send(method), /BENCH_CDP_DENIED/);
  const unresolved = raw.send('Page.getFrameTree', {}, 'owned-child'), rejection = assert.rejects(unresolved, /BENCH_CDP_CLOSED/);
  assert.equal(await raw.close(), true); await rejection;
});

test('plugin sources never import the benchmark server', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name); return entry.isDirectory() ? walk(file) : /\.(mjs|js|tsx?)$/.test(file) ? [file] : [];
  });
  for (const file of walk(new URL('../plugins/sleight/lib', import.meta.url).pathname))
    assert.doesNotMatch(readFileSync(file, 'utf8'), /bench\/turbo\//);
});

const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
test('Fowl patch wires turbo into isolated rounds without an extension, and refuses unsupported tasks',
  { skip: !existsSync(join(cache, '.git')) && 'pinned FowlBrowser source is absent' }, async t => {
    const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-turbo-rounds-')));
    const root = fileURLToPath(new URL('..', import.meta.url));
    mkdirSync(join(dir, 'tools'));
    const source = spawnSync('/usr/bin/git', ['-C', cache, 'show', '8b68924:tools/rounds.mjs'], { encoding: 'utf8' });
    assert.equal(source.status, 0, source.stderr); writeFileSync(join(dir, 'tools/rounds.mjs'), source.stdout);
    const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const previous = process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO = root;
    t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
    const runner = await import(pathToFileURL(join(dir, 'tools/rounds.mjs')));
    const task = { name: 'fixture', browser: 'chrome', prompt: 'Read ' + origin + '/form', result: 'the value' };
    for (const world of [false, true]) {
      const setup = runner.agentSetup({ task, surface: 'sleight-turbo', dir, mcpRoot: '/fixture/mcp', settings: '/fixture/settings', model: 'haiku', effort: 'high', world });
      assert.ok(setup.mcpConfig.mcpServers['sleight-turbo'], JSON.stringify(setup.mcpConfig));
      assert.equal(setup.metadata.measurement, 'production turbo tools and modules; installed path excluded');
      assert.match(setup.prompt, /bbench/); assert.doesNotMatch(setup.prompt, /createBrowserTab/);
      assert.equal(setup.env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-haiku-5-5');
      assert.equal(setup.mcpConfig.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_TASK,
        'Read ' + origin + '/form\n\nEnd your answer with one line starting with RESULT: that states the value.');
    }
    assert.equal(runner.surfaceObserved('sleight-turbo'), false);
    assert.deepEqual(runner.roundSettings('sleight-turbo', {}), { hooks: {}, enabledPlugins: { 'sleight@sleight': false } });
    assert.ok(runner.taskSupport({ ...task, takeover: {} }, 'sleight-turbo'));
    assert.ok(runner.taskSupport({ ...task, prompt: 'Read https://example.com' }, 'sleight-turbo'));
    assert.match(readFileSync(join(dir, 'tools/rounds.mjs'), 'utf8'), /!\['browser-use', 'sleight-turbo'\]\.includes\(surfaceOf\(t\)\)/);
  });
