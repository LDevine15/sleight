import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { packageSkip } from './requirements.mjs';

// A stand-in `codex` on PATH that prints `codex exec --json` events, then waits with a child of its own.
function fakeCodex(events, { hang = false } = {}) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fake-codex-')));
  const script = join(dir, 'codex');
  writeFileSync(script, `#!/bin/sh\n${events.map(e => `echo '${JSON.stringify(e)}'`).join('\n')}\n${hang ? 'sleep 60 &\nwait\n' : ''}`);
  chmodSync(script, 0o755);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('runCodex reads the answer, counts engine calls and flags a shell', async () => {
  const fake = fakeCodex([{ type: 'thread.started', thread_id: 'none' },
    { type: 'item.completed', item: { type: 'mcp_tool_call', result: { _meta: { 'codex/nodeReplExecutionDurationMs': 120 } } } },
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex } = await import('../bench/codex-arm.mjs');
    const run = await runCodex('task', { cwd: fake.dir, model: 'm', effort: 'medium', timeoutMs: 10000 });
    assert.equal(run.code, 0); assert.equal(run.groupClean, true);
    assert.equal(run.out.result, 'Done.'); assert.equal(run.toolCalls, 1); assert.equal(run.engineMs, 120);
    assert.deepEqual(run.forbidden, ['command_execution']);
    assert.equal(run.out.usage.input_tokens, 10);
  } finally { process.env.PATH = path; fake.done(); }
});

test('the Codex world drag audit reads completed MCP tool arguments', { skip: packageSkip('typescript') }, async () => {
  const fake = fakeCodex([{ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'js',
    arguments: { code: 'let app = await cua.getApp("Fixture"); await app.drag({})' }, result: { isError: false } } }]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex } = await import('../bench/codex-arm.mjs');
    const run = await runCodex('task', { cwd: fake.dir, model: 'm', effort: 'medium', timeoutMs: 10000, auditDrag: true });
    assert.deepEqual(run.methodAudit, { drag: true, replacement: false, complete: true });
  } finally { process.env.PATH = path; fake.done(); }
});

test('an abort stops Codex and the processes it started, and says the group is gone', async () => {
  const fake = fakeCodex([{ type: 'thread.started', thread_id: 'none' }], { hang: true });
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex } = await import('../bench/codex-arm.mjs');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 300);
    const run = await runCodex('task', { cwd: fake.dir, model: 'm', effort: 'medium', timeoutMs: 10000, signal: controller.signal });
    assert.equal(run.cancelled, true); assert.equal(run.groupClean, true); assert.notEqual(run.code, 0);
  } finally { process.env.PATH = path; fake.done(); }
});

test('a Codex run reports the model its rollout says it ran, beside the one it was asked for', async () => {
  const home = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-codex-home-')));
  const sessions = join(home, 'sessions', '2026', '10', '18');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'rollout-2026-10-18T10-00-00-thread-ran.jsonl'), [
    { type: 'session_meta', payload: {} }, { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'token_count' } }, { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { type: 'event_msg', payload: { type: 'token_count' } }].map(line => JSON.stringify(line)).join('\n'));
  const fake = fakeCodex([{ type: 'thread.started', thread_id: 'thread-ran' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }]);
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const { runCodex, modelsRan } = await import('../bench/codex-arm.mjs');
    const run = await runCodex('task', { cwd: fake.dir, model: 'gpt-6-luna', effort: 'high', timeoutMs: 10000, home });
    assert.equal(run.modelRequested, 'gpt-6-luna');
    assert.deepEqual(run.modelsRan, ['gpt-6.1-sol']);
    assert.deepEqual(Object.keys(run.out.modelUsage), ['gpt-6.1-sol']);
    assert.equal(run.out.num_turns, 2);
    assert.deepEqual(modelsRan(undefined), []);
    const none = await runCodex('task', { cwd: fake.dir, model: 'gpt-6-luna', effort: 'high', timeoutMs: 10000, home: join(home, 'empty') });
    assert.deepEqual(none.modelsRan, []); assert.deepEqual(Object.keys(none.out.modelUsage), ['gpt-6-luna']);
  } finally { process.env.PATH = path; fake.done(); rmSync(home, { recursive: true, force: true }); }
});
