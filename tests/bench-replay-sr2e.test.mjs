import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeClient } from '../bench/double-keys-client.mjs';
import { clientsFor } from '../bench/replay/run.mjs';
import { withNative } from '../bench/replay/fixtures.mjs';
import { createReplayRecorder, STDERR_LIMIT } from '../bench/replay/evidence.mjs';
import { openFixture, closeFixtures } from '../bench/real-fixture.mjs';

function bank(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sr2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function launcher(t, body) {
  const dir = bank(t), lib = join(dir, 'plugins/sleight/lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'launch.mjs'), `export async function run({ approvalStorage, paymentCardFactory, directBrowser } = {}) { ${body} }`);
  return dir;
}

test('replay startup disables turbo without passing a false trusted frontend', async t => {
  const dir = launcher(t, `
    if (directBrowser !== undefined) throw Error('TRUSTED_ROUTE_REQUIRED');
    if (process.env.SLEIGHT_TURBO !== '0') throw Error('turbo must stay off');
    if (approvalStorage.load().list().length) throw Error('unexpected approval');
    if (paymentCardFactory() !== undefined) throw Error('unexpected payment card');
    const { createInterface } = await import('node:readline');
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    });
  `);
  const client = await probeClient({ command: process.execPath, args: [resolve('bench/replay/server.mjs'), '--worktree', dir],
    env: { SLEIGHT_TURBO: '1' } }, { relay: false, record() {}, timeoutMs: 3000 });
  await client.close();
});

test('stderr evidence is capped per server, including the trace, and records truncation once', t => {
  const dir = bank(t), record = createReplayRecorder(dir);
  const server = 'plugin:sleight:computer';
  record({ event: 'stderr', server, text: 'startup failure\n' });
  record({ event: 'stderr', server, text: 'x'.repeat(STDERR_LIMIT * 2) });
  for (let i = 0; i < 10; i++) record({ event: 'stderr', server, text: 'ignored' });
  record({ event: 'engine-close', server, code: 1 });
  record({ event: 'stderr', server: 'sleight-turbo', text: 'other server\n' });
  const stderr = readFileSync(join(dir, 'computer.stderr.log'));
  assert.equal(stderr.length, STDERR_LIMIT);
  assert.ok(stderr.toString().startsWith('startup failure\n'));
  assert.equal(readFileSync(join(dir, 'turbo.stderr.log'), 'utf8'), 'other server\n');
  const rows = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.event === 'stderr-truncated').length, 1);
  assert.equal(rows.filter(row => row.event === 'stderr').reduce((n, row) => n + Buffer.byteLength(row.text), 0), STDERR_LIMIT + 13);
  assert.ok(rows.some(row => row.event === 'engine-close' && row.code === 1));
});

test('initialize failure retains stderr and confirms the exited nonzero server', async t => {
  const worktree = launcher(t, "process.stderr.write('injected startup failure\\n'); process.exitCode = 1;");
  const dir = bank(t), record = createReplayRecorder(dir);
  await assert.rejects(clientsFor({ policy: 'bench' }, {}, dir, record, worktree), error => {
    assert.match(error.message, /engine exited \(1\)/);
    assert.equal(error.cleanupConfirmed, true);
    return true;
  });
  assert.match(readFileSync(join(dir, 'computer.stderr.log'), 'utf8'), /injected startup failure/);
  assert.ok(readFileSync(join(dir, 'trace.jsonl'), 'utf8').includes('"code":1'));
});

test('the stderr cap does not expand a partial UTF-8 character in the trace', t => {
  const dir = bank(t), record = createReplayRecorder(dir), server = 'plugin:sleight:computer';
  record({ event: 'stderr', server, text: 'x' + '😀'.repeat(STDERR_LIMIT) });
  assert.equal(readFileSync(join(dir, 'computer.stderr.log')).length, STDERR_LIMIT);
  const rows = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const text = rows.filter(row => row.event === 'stderr').map(row => row.text).join('');
  assert.ok(Buffer.byteLength(text) <= STDERR_LIMIT);
  assert.ok(!text.includes('\uFFFD'));
});

test('a nonzero exit after initialize still fails the run with collection confirmed', async t => {
  const worktree = launcher(t, `
    const { createInterface } = await import('node:readline');
    createInterface({ input: process.stdin }).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    }).on('close', () => { process.exitCode = 1; });
  `);
  const dir = bank(t);
  const clients = await clientsFor({ policy: 'bench' }, {}, dir, createReplayRecorder(dir), worktree);
  await assert.rejects(clients.close(), error => {
    assert.match(error.message, /server exited \(1\)/);
    assert.equal(error.cleanupConfirmed, true);
    assert.equal(error.cleanupUnconfirmed, false);
    return true;
  });
});

for (const exited of [true, false]) test(`early collected engine exit cleans the fixture and ${exited ? 'confirms' : 'refuses'} its exact PID exit`, async t => {
  const dir = bank(t), quits = [], checks = [];
  const worktree = launcher(t, "process.stderr.write('fixture startup failure\\n'); process.exitCode = 1;");
  const ctx = { dir: join(dir, 'fixture'), nonce: 'nonce' };
  const definition = {
    setup: async c => openFixture(c, { app: 'TextEdit', bundle: 'com.apple.TextEdit', mode: 'document',
      target: join(c.dir, 'nonce.txt'), token: 'nonce.txt' }, {
      helper: async () => ({ command: 'fake', args: [] }), open: async () => {},
      exited: async (pid, started) => { checks.push([pid, started]); return exited; },
      run: async (_command, args, options) => {
        const request = JSON.parse(args.at(-1));
        if (request.mode === 'quit') {
          quits.push(request);
          return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"quit"}\n' };
        }
        options.onStdout('{"stage":"armed","running":false,"pid":42,"processStartedAtMs":5000}\n{"stage":"ready"}\n');
        return new Promise(resolve => {
          const poll = setInterval(() => {
            if (JSON.parse(readFileSync(request.control, 'utf8')).command !== 'close') return;
            clearInterval(poll);
            resolve({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' });
          }, 5);
          options.signal.addEventListener('abort', () => { clearInterval(poll); resolve({ groupClean: true, exit: { code: 0 } }); }, { once: true });
        });
      },
    }),
    prompt: () => 'fixture', check: () => assert.fail('no task check after failed initialize'), cleanup: closeFixtures,
  };
  const result = await withNative({ metadata: {}, task: { id: 'textedit-drag' } }, {
    dir: ctx.dir, prepared: { native: { definition, ctx } }, beforeCall: async () => {}, permissionCheck: async () => false,
    drive: async () => clientsFor({ policy: 'bench' }, {}, dir, createReplayRecorder(dir), worktree),
  });
  assert.match(result.lifecycle.reason, /owned .* engine exited \(1\)/);
  assert.equal(result.lifecycle.groupClean, true);
  assert.equal(quits.length, 1);
  assert.equal(quits[0].pid, 42);
  assert.equal(quits[0].processStartedAtMs, 5000);
  assert.deepEqual(checks, [[42, 5000]]);
  assert.equal(result.cleanupConfirmed, exited);
  if (!exited) assert.equal(result.lifecycle.exitDisagreements[0].pid, 42);
});

test('uncollected engine failure leaves fixture cleanup blocked', async t => {
  const dir = bank(t), ctx = { dir };
  const result = await withNative({ metadata: {}, task: { id: 'textedit-drag' } }, {
    dir, prepared: { native: { ctx, definition: { setup() {}, prompt: () => 'fixture', check: () => false,
      cleanup: () => assert.fail('engine can still act') } } },
    beforeCall: async () => {}, permissionCheck: async () => false,
    drive: async () => { throw Object.assign(Error('engine uncollected'), { cleanupUnconfirmed: true }); },
  });
  assert.equal(result.cleanupConfirmed, false);
  assert.match(result.lifecycle.cleanupError, /process group cleanup unconfirmed/);
});
