import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callSocket, ensureSocketSession, socketCommand, spawnDetachedSession, startSocketSession } from '../plugins/sleight/lib/socket-bridge.mjs';

function fixture(t) {
  const root = mkdtempSync(join('/private/tmp', 'sleight-demand-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { directory: join(root, 'shell'), signals: new EventEmitter(), peerUid: async () => process.getuid(),
    startRelay: async () => ({ call: async () => ({ content: [{ type: 'text', text: 'ok' }] }), close: async () => {} }) };
}

test('js starts a missing session once, reuses it, and reports a restart after idle exit', async t => {
  const f = fixture(t), sessions = [], notices = [];
  t.after(async () => { for (const s of sessions) await s.close(); });
  let starts = 0;
  const options = { directory: f.directory, notice: line => notices.push(line),
    spawnSession: async () => { starts++; sessions.push(await startSocketSession({ ...f, idleMs: 80 })); } };
  assert.equal(await socketCommand(['js', '1'], { ...options, out: () => {} }), 0);
  assert.equal(await socketCommand(['js', '2'], { ...options, out: () => {} }), 0);
  assert.equal(starts, 1);
  assert.match(notices.join('\n'), /started/);
  await sessions[0].closed;
  await socketCommand(['js', '3'], { ...options, out: () => {} });
  assert.equal(starts, 2);
  assert.match(notices.at(-1), /restarted.*JavaScript.*reset/i);
});

test('a failed dispatched call is never replayed or used to start another session', async t => {
  const f = fixture(t);
  let calls = 0;
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: async () => { calls++; throw new Error('uncertain effect'); }, close: async () => {},
  }) });
  t.after(() => session.close());
  await assert.rejects(socketCommand(['js', 'input()'], { directory: f.directory, out: () => {},
    notice: () => {}, spawnSession: () => assert.fail('must not restart') }), /uncertain effect/);
  assert.equal(calls, 1);
});

test('session owns image files in the cache directory and prunes them at idle exit', async t => {
  const f = fixture(t);
  const session = await startSocketSession({ ...f, idleMs: 80, startRelay: async () => ({
    call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] }),
    close: async () => {},
  }) });
  t.after(() => session.close());
  let output = '';
  await socketCommand(['js', 'screenshot()'], { directory: f.directory, notice: () => {}, out: s => { output += s; } });
  const path = output.trim();
  assert.ok(path.startsWith(f.directory + '/images-'));
  assert.equal(readFileSync(path, 'utf8'), 'png');
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  await session.closed;
  assert.equal(existsSync(path), false);
});

test('on-demand child has its own process group and exits after collecting its offline relay', { timeout: 15000 }, async t => {
  const f = fixture(t);
  let child, closed;
  t.after(async () => { await closed; });
  await ensureSocketSession({ directory: f.directory, notice: () => {}, spawnSession: async () => {
    child = await spawnDetachedSession({ command: process.execPath,
      args: [fileURLToPath(new URL('fixtures/socket-demand.mjs', import.meta.url)), f.directory],
      spawnChild: (command, args, options) => {
        assert.equal(options.detached, true);
        assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
        return spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
      } });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
    });
  } });
  const result = await callSocket({ tool: 'js', args: { code: '1' } }, f);
  assert.equal(JSON.parse(result.content[0].text).pid, child.pid);
  await closed;
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
  assert.equal(readFileSync(join(f.directory, 'collected'), 'utf8'), 'yes');
});

test('install-agent only prints an escaped plist and an explicit owner command', async () => {
  let output = '';
  assert.equal(await socketCommand(['session', '--install-agent'], { out: s => { output += s; },
    executable: '/a & b/sleight-mcp', spawnSession: () => assert.fail('no install or start') }), 0);
  assert.match(output, /<string>\/a &amp; b\/sleight-mcp<\/string>/);
  assert.match(output, /launchctl bootstrap/);
  assert.match(output, /owner|yourself/i);
});


test('concurrent session starters create just one relay', async t => {
  const f = fixture(t);
  let starts = 0;
  const options = { ...f, startRelay: async () => { starts++; return f.startRelay(); } };
  const results = await Promise.allSettled([startSocketSession(options), startSocketSession(options)]);
  const session = results.find(result => result.status === 'fulfilled').value;
  t.after(() => session.close());
  assert.equal(starts, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('a refused stale socket and old private images are reclaimed before dispatch', async t => {
  const f = fixture(t);
  mkdirSync(f.directory, { mode: 0o700 });
  const oldImages = mkdtempSync(join(f.directory, 'images-'));
  writeFileSync(join(oldImages, 'old.png'), 'old', { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/socket-demand.mjs', import.meta.url)),
    f.directory, '--stale'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('stale fixture failed')));
  });
  assert.equal(existsSync(join(f.directory, 'session.sock')), true);
  const session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(existsSync(oldImages), false);
  assert.equal((await callSocket({ tool: 'js', args: { code: '1' } }, f)).content[0].text, 'ok');
});

test('unready startup is bounded and never dispatches a call', async t => {
  const f = fixture(t);
  let starts = 0;
  await assert.rejects(ensureSocketSession({ directory: f.directory, startupMs: 60,
    spawnSession: async () => { starts++; }, notice: () => {} }), /did not become ready/);
  assert.equal(starts, 1);
});
