import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

async function fixture(t, mode = 'ok') {
  const bank = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-update-test-')));
  const codexHome = join(bank, 'codex'), root = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use');
  const log = join(bank, 'engines.jsonl'), gate = join(bank, 'updated');
  const configure = async version => {
    const dir = join(root, version); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: process.execPath, args: [fileURLToPath(new URL('fixtures/update-engine.mjs', import.meta.url)), version, gate, mode],
    } } }));
  };
  await configure('1.0');
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/restart-launcher.mjs', import.meta.url)), join(bank, 'leases')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome, SLEIGHT_TEST_ENGINE_LOG: log,
      SLEIGHT_WARM_REPL: '0', SLEIGHT_SURFACES: 'computer', SLEIGHT_CHANGE_REVIEW: '0', SLEIGHT_APPROVAL_PROMPT: 'client' },
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.stdin.end(); await closed; await rm(bank, { recursive: true, force: true }); });
  let approvals = 0, stderr = '';
  child.stderr.on('data', data => stderr += data);
  const replies = new Map(), waiters = new Map();
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'elicitation/create') { approvals++; send({ id: msg.id, result: { action: 'accept', content: {} } }); return; }
    replies.set(msg.id, msg); waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
  });
  const receive = id => Promise.race([replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise(resolve => waiters.set(id, resolve)),
    closed.then(() => { throw Error('launcher disconnected: ' + stderr); })]);
  const call = (id, code) => { send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }); return receive(id); };
  send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'test', version: '1' } } });
  await receive(0); send({ method: 'notifications/initialized' });
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { call, events, get approvals() { return approvals; }, replies,
    update: async () => { await configure('2.0'); await rm(join(root, '1.0'), { recursive: true }); await writeFile(gate, ''); } };
}

for (const mode of ['ok', 'fail']) test(`engine update during a call reconnects once (${mode}) and keeps the client session`, { timeout: 20000 }, async t => {
  const h = await fixture(t, mode);
  assert.ok(!(await h.call(1, 'let app = await cua.getApp("Example")')).result.isError);
  const pending = h.call(2, 'let updateDuringCall = await cua.getApp("Example")');
  for (let n = 0; !(await h.events()).some(row => row.event === 'waiting-for-update'); n++) {
    assert.ok(n < 500, 'old engine did not receive the call');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await h.update();
  const reply = await pending, text = reply.result.content.map(item => item.text).join('\n');
  const events = await h.events();
  assert.deepEqual(events.filter(row => row.event === 'start').map(row => row.version), ['1.0', '2.0']);
  assert.equal(events.filter(row => row.event === 'initialize').length, 2);
  assert.equal(events.filter(row => row.event === 'call').length, 3, 'one initial call, failed call and one retry');
  assert.equal(h.approvals, 1, 'an approved app never prompts again');
  if (mode === 'ok') { assert.ok(!reply.result.isError, text); assert.match(text, /sleight reconnected after an engine update/); }
  else { assert.equal(reply.result.isError, true); assert.match(text, /Sky Computer Use native pipe startup failed/); assert.match(text, /--doctor/); }
  assert.equal([...h.replies.keys()].some(id => /^sleight-initialize-/.test(String(id))), false);
});

test('an idle engine version change reconnects before sending the next call', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  await h.call(1, 'let app = await cua.getApp("Example")');
  await h.update();
  const reply = await h.call(2, 'let app = await cua.getApp("Example")');
  assert.ok(!reply.result.isError);
  assert.deepEqual((await h.events()).filter(row => row.event === 'start').map(row => row.version), ['1.0', '2.0']);
  assert.equal(h.approvals, 1);
  assert.match(reply.result.content.map(item => item.text).join('\n'), /sleight reconnected after an engine update/);
});
