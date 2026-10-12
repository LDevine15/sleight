import test from 'node:test';
import assert from 'node:assert/strict';
import { callClass, resultKinds, runAnatomy } from '../bench/fowl/anatomy.mjs';

test('anatomy splits a result into doc sections, trees and the rest', () => {
  const k = resultKinds('## Computer Use\nuse js\n# API Reference\nx\nBrowser tab: 1, Title: "a"\n1 button Go\n\nRESULT ok');
  assert.ok(k.docs['Computer Use'] > 0);
  assert.ok(k.docs['API Reference'] > 0);
  assert.ok(k.tree > 0);
  assert.equal(k.other, '\nRESULT ok\n'.length);
});

test('anatomy classes calls by what their code does, and per-intent tools by name', () => {
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'await tab.click(3); nodeRepl.write(await tab.getAXState())' }), 'action+read');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'await tab.click(3)' }), 'action');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'nodeRepl.write(await tab.getAXState())' }), 'read');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: "let b = await cua.getBrowser({ extensionInstanceId: 'x' })" }), 'setup');
  assert.equal(callClass('ToolSearch', { query: 'select:x' }), 'toolsearch');
  assert.equal(callClass('mcp__fowlbrowser__snapshot', {}), 'read');
  assert.equal(callClass('mcp__fowlbrowser__click', {}), 'action+read');
});

test('anatomy counts turns once per message and flags a read after a read and a call after an error', () => {
  const msg = (id, t, content, usage = {}) => ({ type: 'assistant', t, message: { id, content, usage } });
  const res = (t, id, text, isError = false) => ({ type: 'user', t, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  const use = (id, code) => ({ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code } });
  const r = runAnatomy([
    { type: 'system', subtype: 'init', t: 0 },
    msg('m1', 1000, [use('a', 'await tab.click(1)')], { cache_creation_input_tokens: 10 }),
    res(1500, 'a', 'boom', true),
    msg('m2', 2500, [use('b', 'nodeRepl.write(await tab.getAXState())')]),
    res(2600, 'b', 'Browser tab: 1\n1 button'),
    msg('m3', 3000, [use('c', 'nodeRepl.write(await tab.title())')]),
    res(3100, 'c', 'ok'),
    msg('m4', 4000, [{ type: 'text', text: 'done' }]),
    { type: 'result', t: 4100, duration_ms: 4100, total_cost_usd: 0.01 },
  ]);
  assert.equal(r.turns, 4);
  assert.equal(r.calls, 3);
  assert.equal(r.errors, 1);
  assert.equal(r.avoidable.afterError, 1);
  assert.equal(r.avoidable.readAfterRead, 1);
  assert.equal(r.startMs, 1000);
  assert.equal(r.toolMs, 700);
  assert.equal(r.usage.cacheWrite, 10);
});
