import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const load = () => import('../bench/turbo/v3-session.mjs');
const origin = 'http://127.0.0.1:5431';

export function fakeFork(begin, close = async () => ({ revoked: true, cleanup: [] })) {
  return (_path, _args, options) => {
    assert.deepEqual(options.execArgv, []); assert.ok(options.stdio.includes('ipc'));
    const child = new EventEmitter(), endpoint = new EventEmitter();
    child.connected = endpoint.connected = true;
    child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
    endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
    child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
    child.unref = () => {};
    const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin, close });
    queueMicrotask(() => worker.ready()); return child;
  };
}

test('benchmark session binds the original task privately through V7 and never accepts tool authority', async () => {
  const { createSession } = await load();
  const events = []; let closes = 0;
  const original = 'Read the fixture; do not buy anything.';
  const session = await createSession({ origins: [origin], taskMessage: original,
    forkWorker: fakeFork(async event => {
      events.push(event);
      return { call: async input => { events.push(input); return { text: 'Untrusted page', isError: false }; },
        delivered: result => { events.push(result); return true; }, end: async () => ({ revoked: true, cleanup: [] }) };
    }, async () => { closes++; return { revoked: true, cleanup: [] }; }) });
  assert.equal(events[0].source, 'user'); assert.equal(events[0].text, original);
  assert.ok(events[0].session); assert.ok(events[0].turn);
  const result = await session.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(result.text, 'Untrusted page'); assert.equal(session.delivered({ ...result }), false);
  assert.equal(session.delivered(result), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).text, 'Untrusted page');
  const bad = await session.call({ name: 'browser_read', arguments: { tab: 't1', consent: true } });
  assert.equal(bad.isError, true); assert.equal(events.filter(e => e.name).length, 1);
  assert.deepEqual(await session.close(), { revoked: true, cleanup: [] }); await session.close(); assert.equal(closes, 1);
});

test('benchmark worker without the pinned headless browser reports unavailable before launching and its fork exits', { timeout: 15000 }, async () => {
  const { createSession } = await load();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'sleight-v3-nobrowser-'));
  let exited;
  try {
    await assert.rejects(createSession({ origins: [origin], taskMessage: 'Read fixture',
      forkWorker(path, args, options) {
        assert.match(String(path), /bench\/turbo\/v3-worker.mjs$/);
        const child = fork(path, args, { ...options, env: { ...options.env, HOME: home } });
        exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        return child;
      } }), /V3_RUNTIME_UNAVAILABLE|BENCH_BROWSER_MISSING/);
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalid fixture/task input never forks and missing cleanup evidence stays unavailable', async () => {
  const { createSession, cleanupMetric } = await load();
  let forks = 0;
  for (const args of [{ origins: ['https://example.com'], taskMessage: 'read' }, { origins: [origin], taskMessage: null }])
    await assert.rejects(createSession({ ...args, forkWorker: () => forks++ }));
  assert.equal(forks, 0);
  assert.deepEqual(cleanupMetric({ revoked: true, cleanup: [] }), { version: 3, phase: 'cleanup', turboTabsLeft: null,
    tabsAfterBrowserClose: null, browserClosed: false, profileDeleted: false, socketsClosed: false });
  const proof = { turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true };
  assert.deepEqual(cleanupMetric(proof), { version: 3, phase: 'cleanup', ...proof });
});

test('runner setup selects all five v3 tools, private task, metrics and v3 guidance beside the companion', async () => {
  const { turboSetup } = await import('../bench/turbo/setup.mjs');
  const { browserTools } = await import('../plugins/sleight/lib/direct-browser/tools.mjs');
  const task = { prompt: 'Read ' + origin + '/form' };
  const setup = turboSetup({ task, repo: '/fixture/repo', dir: '/private/tmp/fixture-task', prompt: task.prompt });
  assert.deepEqual(setup.mcpServers['sleight-turbo'].args, ['/fixture/repo/bench/turbo/v3-server.mjs']);
  assert.deepEqual(setup.allowed.split(',').filter(name => name.startsWith('mcp__sleight-turbo__')),
    browserTools('bbench').map(tool => 'mcp__sleight-turbo__' + tool.name));
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_TASK, task.prompt);
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_METRICS, '/private/tmp/fixture-task/turbo-metrics.jsonl');
  assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'browser,computer');
  assert.match(setup.promptPrefix, /Act takes 1 to 12 `steps`/);
  assert.match(setup.promptPrefix, /Never translate refs or handles between paths/);
  assert.equal(setup.metadata.turboVersion, 3);
});

test('cleanup metrics are append-only and never manufacture zero tabs or follow symlinks', async t => {
  const { recordCleanup } = await import('../bench/turbo/v3-server.mjs');
  const { mkdtempSync, readFileSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const parent = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-v3-metrics-')));
  const file = join(realpathSync(parent), 'turbo-metrics.jsonl');
  recordCleanup(file, { revoked: true, cleanup: [] });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).turboTabsLeft, null);
  recordCleanup(file, { turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.throws(() => recordCleanup(join(parent, 'elsewhere.jsonl'), {}), /Invalid metrics destination/);
  const link = join(parent, 'linked'); symlinkSync(parent, link);
  assert.throws(() => recordCleanup(join(link, 'turbo-metrics.jsonl'), {}), /Invalid metrics destination/);
});
