import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { summarizeRead, runAcquisitionProbe, acquisitionEnvironment, engineIdentity } from '../bench/acquisition-probe.mjs';
import { openClient } from '../bench/compat/client.mjs';
import { fileURLToPath } from 'node:url';

const success = { content: [{ type: 'text', text: 'Window: "PRIVATE FILE", App: TextEdit.\nsecret document' }],
  _meta: { 'codex/toolSurface': { kind: 'computerUse', appId: 'com.apple.TextEdit' } } };
const timeout = { isError: true, content: [{ type: 'text', text: 'Error: Computer Use server error -10005: timeoutReached\nPRIVATE FILE' }] };
const calculator = { ...success, _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.calculator' } } } };

test('engine identity includes entrypoint bytes and argument changes without exposing unknown values', () => {
  const server = { version: '1', command: '/runtime/node', args: ['/engine/server.mjs', '--secret=PRIVATE'] };
  const first = engineIdentity(server, () => Buffer.from('first'));
  assert.ok(first.files['/engine/server.mjs']);
  assert.notEqual(first.fingerprint, engineIdentity(server, () => Buffer.from('second')).fingerprint);
  assert.notEqual(first.fingerprint, engineIdentity({ ...server, args: ['/engine/other.mjs'] }, () => Buffer.from('first')).fingerprint);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
});

function fixture(replies, options = {}) {
  const events = [], records = [], signals = new EventEmitter();
  let clock = 100, request = 0, lifecycle;
  const client = { pid: 42, call: async (_tool, args) => {
    events.push(['call', args.code]); clock += 500;
    const reply = replies[request++];
    if (reply instanceof Error) throw reply;
    return reply;
  }, endTurn: async () => { events.push(['end']); return {}; }, close: async () => {
    lifecycle?.({ event: 'close', pid: 42, code: options.exitCode ?? 0, signal: options.signal ?? null });
    events.push(['close']); return options.closed !== false;
  } };
  return { events, records, signals, client,
    deps: { mode: 'relay', record: item => records.push(item), signals, now: () => clock,
      open: async config => { lifecycle = config.onLifecycle; lifecycle?.({ event: 'spawn', pid: 42 }); return client; },
      admission: { check: async () => events.push(['check']), release: async () => events.push(['release']) },
      collect: async pid => { events.push(['collect', pid]); if (options.groupUncertain) throw Error('unconfirmed'); } } };
}

test('read summary preserves timeout identity without window text', () => {
  assert.deepEqual(summarizeRead(timeout), { isError: true, error: 'Computer Use server error -10005: timeoutReached',
    textItems: 1, textCharacters: timeout.content[0].text.length, appId: null, executionMs: null });
  assert.equal(summarizeRead(success).appId, 'com.apple.TextEdit');
  assert.doesNotMatch(JSON.stringify(summarizeRead(success)), /PRIVATE|secret/);
});

test('uses the current nested native target metadata', () => {
  assert.equal(summarizeRead({ ...success, _meta: { 'codex/toolSurface': {
    kind: 'computerUse', app: { appId: 'com.apple.TextEdit', kind: 'appId' } } } }).appId, 'com.apple.TextEdit');
});

test('diagnostic environment disables Turbo without changing grants', () => {
  const env = acquisitionEnvironment({ SLEIGHT_TURBO: '1', SLEIGHT_TRACE: 'private', SLEIGHT_PROMPT: 'owner' },
    { CUA_REPL_ENABLED_SURFACES: 'browser,computer' });
  assert.equal(env.SLEIGHT_TURBO, '0');
  assert.equal(env.SLEIGHT_TRACE, undefined);
  assert.equal(env.SLEIGHT_PROMPT, 'owner');
  assert.equal(env.SLEIGHT_SURFACES, 'computer');
  assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'computer');
});

test('stops the sequence at first error and records it before cleanup', async () => {
  const f = fixture([success, calculator, timeout]);
  const result = await runAcquisitionProbe(f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.failedStage, 'textedit-first');
  assert.equal(f.events.filter(e => e[0] === 'call').length, 3);
  assert.equal(result.reads[2].elapsedMs, 500);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(f.events.at(-1)[0], 'release');
});

test('a separately enabled diagnostic repeat never erases the first failure', async () => {
  const f = fixture([success, calculator, timeout, success]);
  const result = await runAcquisitionProbe({ ...f.deps, repeatOnce: true });
  assert.equal(result.passed, false);
  assert.deepEqual(result.reads.map(r => r.stage), ['inventory', 'calculator-first', 'textedit-first', 'textedit-diagnostic-repeat']);
  assert.equal(result.reads.at(-1).result.isError, false);
  assert.equal(result.failedStage, 'textedit-first');
});

test('transport timeout never triggers another read', async () => {
  const f = fixture([success, calculator, Error('tools/call timed out after 45000 ms')]);
  const result = await runAcquisitionProbe({ ...f.deps, repeatOnce: true });
  assert.equal(result.passed, false);
  assert.equal(result.reads.length, 3);
  assert.equal(result.reads.at(-1).transportError, true);
});

for (const options of [{ closed: false }, { groupUncertain: true }]) {
  test(`retains admission after uncertain cleanup ${JSON.stringify(options)}`, async () => {
    const f = fixture([success, calculator, success], options);
    const result = await runAcquisitionProbe(f.deps);
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.confirmed, false);
    assert.equal(f.events.some(e => e[0] === 'release'), false);
  });
}

test('collects a known startup child and retains failure', async () => {
  const f = fixture([]);
  const result = await runAcquisitionProbe({ ...f.deps, open: async config => {
    config.onLifecycle({ event: 'spawn', pid: 73 });
    config.onLifecycle({ event: 'close', pid: 73, code: 1, signal: null });
    throw Error('startup failed');
  } });
  assert.equal(result.passed, false);
  assert.ok(f.events.some(e => e[0] === 'collect' && e[1] === 73));
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(f.events.at(-1)[0], 'release');
});

test('short native error retains its code and is not a transport timeout', () => {
  assert.equal(summarizeRead({ isError: true, content: [{ type: 'text', text: '-10005 timeoutReached' }] }).error,
    'Computer Use server error -10005: timeoutReached');
});

test('host denials retain only the fixed errno without private paths', () => {
  const summary = summarizeRead({ isError: true, content: [{ type: 'text', text: "Error: EPERM: operation not permitted, open '/PRIVATE/secret'" }] });
  assert.equal(summary.error, 'host-EPERM');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|secret/);
});

test('wrong target metadata fails and stops before TextEdit', async () => {
  const f = fixture([success, success, success]);
  const result = await runAcquisitionProbe(f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.failedStage, 'calculator-first');
  assert.equal(result.reads.length, 2);
});

for (const options of [{ exitCode: 7 }, { signal: 'SIGTERM' }]) {
  test(`successful reads cannot hide abnormal child termination ${JSON.stringify(options)}`, async () => {
    const f = fixture([success, calculator, success], options);
    const result = await runAcquisitionProbe(f.deps);
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.childExitAccepted, false);
  });
}

test('successful reads and normal child exit pass', async () => {
  const f = fixture([success, calculator, success]);
  assert.equal((await runAcquisitionProbe(f.deps)).passed, true);
});

test('unexpected elicitation is declined, recorded without message text, and stops further calls', async () => {
  const f = fixture([]);
  const result = await runAcquisitionProbe({ ...f.deps, open: async config => {
    config.onLifecycle({ event: 'spawn', pid: 42 });
    f.client.call = async () => {
      const answer = await config.approve({ message: 'SECRET OWNER DATA', _meta: { source: 'test' } });
      assert.deepEqual(answer, { action: 'decline' });
      return timeout;
    };
    return f.client;
  }, repeatOnce: true });
  assert.equal(result.approvals, 1);
  assert.equal(result.reads.length, 1);
  assert.doesNotMatch(JSON.stringify(f.records), /SECRET OWNER DATA/);
});

test('cancellation stops before another read and collects the session', async () => {
  const f = fixture([]);
  f.client.call = async () => { f.signals.emit('SIGINT'); return success; };
  const result = await runAcquisitionProbe(f.deps);
  assert.equal(result.passed, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.reads.length, 1);
  assert.equal(result.cleanup.confirmed, true);
});

test('shell initializer has empty capabilities, no turn metadata, and EOF owns cleanup', async () => {
  const f = fixture([success, calculator, success]);
  const open = f.deps.open;
  let settings;
  const result = await runAcquisitionProbe({ ...f.deps, mode: 'shell', open: async config => {
    settings = config;
    return open(config);
  } });
  assert.equal(settings.name, 'Grok Bot');
  assert.deepEqual(settings.capabilities, {});
  assert.equal(settings.turnMeta, false);
  assert.equal(f.events.some(event => event[0] === 'end'), false);
  assert.equal(result.passed, true);
  assert.equal(result.cleanup.lockReleased, true);
});

for (const during of ['startup', 'read']) test(`shell native card during ${during} stops and records only an enum`, async () => {
  const f = fixture([success, calculator, success]);
  const open = f.deps.open;
  let config;
  const notify = () => config.onNotification({ method: 'notifications/sleight/approval', params: {
    id: 'PRIVATE ID', state: 'waiting', app: 'PRIVATE DOCUMENT', deadline: 9999999,
  } });
  const result = await runAcquisitionProbe({ ...f.deps, mode: 'shell', repeatOnce: true, open: async settings => {
    config = settings;
    const client = await open(settings);
    if (during === 'startup') assert.equal(notify(), 'close');
    else client.call = async () => { assert.equal(notify(), 'close'); await client.close(); throw Error('client closed'); };
    return client;
  } });
  assert.equal(result.passed, false);
  assert.equal(result.approvals, 1);
  assert.equal(result.reads.length, during === 'startup' ? 0 : 1);
  assert.equal(f.events.some(event => event[0] === 'end'), false);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.cleanup.lockReleased, true);
  assert.ok(f.records.some(record => record.event === 'approval-notification' && record.state === 'waiting'));
  assert.doesNotMatch(JSON.stringify(f.records), /PRIVATE/);
});

const shellPeer = fileURLToPath(new URL('./fixtures/acquisition-shell-peer.mjs', import.meta.url));
test('shell options select a fresh direct launcher and sanitized session environment', async () => {
  const { acquisitionClientOptions, parseAcquisitionArgs } = await import('../bench/acquisition-probe.mjs');
  const receipt = ['', 'private', 'tmp', 'offline.jsonl'].join('/');
  assert.deepEqual(parseAcquisitionArgs(['--live', '--mode', 'shell', '--receipt', receipt]),
    { repeatOnce: false, live: true, mode: 'shell', receipt });
  const options = acquisitionClientOptions('shell', { command: '/engine/node', args: ['/engine/main.mjs'],
    env: { PRIVATE_SERVER: 'secret' } }, { NODE_OPTIONS: '--loader=private', CODEX_HOME: '/PRIVATE',
    SLEIGHT_GUARD: 'off', SLEIGHT_CHATGPT_APP: '/Applications/ChatGPT.app' });
  assert.equal(options.command, process.execPath);
  assert.deepEqual(options.args, [fileURLToPath(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url)), '--socket-relay']);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.CODEX_HOME, undefined);
  assert.equal(options.env.PRIVATE_SERVER, undefined);
  assert.equal(options.env.SLEIGHT_GUARD, undefined);
  assert.equal(options.env.SLEIGHT_HAND, '0');
  assert.equal(options.env.SLEIGHT_SURFACES, 'computer');
  assert.equal(options.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(options.env.SLEIGHT_CHATGPT_APP, '/Applications/ChatGPT.app');
});

test('compat client sends the shell initializer and calls without external metadata on the wire', async () => {
  const client = await openClient({ command: process.execPath, args: [shellPeer], name: 'Grok Bot', capabilities: {}, turnMeta: false });
  try {
    const wire = await client.call('js', { code: 'await cua.getState();' });
    assert.deepEqual(wire.initialize.capabilities, {});
    assert.deepEqual(wire.initialize.clientInfo, { name: 'Grok Bot', version: '1' });
    assert.equal(Object.hasOwn(wire.call, '_meta'), false);
    assert.deepEqual(Object.keys(wire.call), ['name', 'arguments']);
  } finally { assert.equal(await client.close(), true); }
});

for (const during of ['startup', 'read']) test(`compat client closes its exact child on ${during} notification`, async () => {
  const lifecycle = [], notifications = [];
  let client;
  try {
    client = await openClient({ command: process.execPath, args: [shellPeer, during], capabilities: {},
      startupTimeoutMs: 1000, timeoutMs: 1000,
      onLifecycle: event => lifecycle.push(event),
      onNotification: message => { notifications.push(message.method); return 'close'; } });
    await assert.rejects(client.call('js', { code: 'read' }), /closed|exited/);
  } catch (error) {
    if (during !== 'startup') throw error;
    assert.match(error.message, /closed|exited/);
  } finally { if (client) await client.close(); }
  assert.deepEqual(notifications, ['notifications/sleight/approval']);
  assert.deepEqual(lifecycle.map(event => event.event), ['spawn', 'close']);
  assert.equal(lifecycle[0].pid, lifecycle[1].pid);
  assert.equal(lifecycle[1].code, 0);
});
