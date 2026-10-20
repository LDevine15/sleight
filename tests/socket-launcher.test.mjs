import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { callSocket, createShellRelay, startSocketSession } from '../plugins/sleight/lib/socket-bridge.mjs';

for (const stop of ['idle', 'SIGTERM']) test(`${stop} collects the production launcher's offline engine before session exit`, { timeout: 15000 }, async t => {
  const bank = mkdtempSync(join('/private/tmp', 'sleight-shell-launch-'));
  let session;
  t.after(async () => { await session?.close(); rmSync(bank, { recursive: true, force: true }); });
  const codexHome = join(bank, 'codex'), config = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
    command: process.execPath, args: [fileURLToPath(new URL('fixtures/socket-engine.mjs', import.meta.url))],
  } } }));
  const log = join(bank, 'engine.jsonl'), traces = join(bank, 'trace');
  const signals = new EventEmitter(), directory = join(bank, 'socket');
  session = await startSocketSession({ directory, signals, idleMs: stop === 'idle' ? 40 : 600000,
    peerUid: async () => process.getuid(), startRelay: () => createShellRelay({
      args: [fileURLToPath(new URL('fixtures/socket-launcher.mjs', import.meta.url)), join(bank, 'leases')],
      env: { ...process.env, HOME: bank, CODEX_HOME: codexHome, SLEIGHT_TEST_ENGINE_LOG: log, SLEIGHT_TRACE: traces,
        SLEIGHT_HAND: '0', SLEIGHT_SURFACES: 'computer', SLEIGHT_WARM_REPL: '0', SLEIGHT_WARM_ENGINE: '0',
        SLEIGHT_CHANGE_REVIEW: '0', SLEIGHT_SKILL: 'none', SLEIGHT_TURBO: '1', SLEIGHT_CONFIRM_PAYMENTS: 'never',
        SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TEST_CONFIRM: '1' },
    }),
  });
  await callSocket({ tool: 'js', args: { code: 'let app = await cua.getApp("Firefox")' } }, { directory });
  const result = await callSocket({ tool: 'js', args: { code: 'await app.click(88)' } }, { directory });
  assert.equal(result.content[0].text, '42');
  if (stop === 'SIGTERM') signals.emit('SIGTERM');
  assert.equal((await session.closed).error, undefined);
  const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.event), ['start', 'initialize', 'policy', 'panel', 'card-answer', 'exit']);
  assert.equal(events[0].pid, events.at(-1).pid);
  assert.equal(events[1].clientInfo.name, 'Grok Bot');
  assert.equal(events.find(e => e.event === 'policy').payment.setting, 'always');
  const panel = events.find(e => e.event === 'panel');
  assert.deepEqual(panel.choices, ['once', 'cancel']);
  assert.equal(panel.data.operation.scope, 'Allow this action once');
  assert.equal(events.find(e => e.event === 'card-answer').result.action, 'cancel');
  assert.doesNotMatch(JSON.stringify(panel), /remember|Always|This session/);
});
