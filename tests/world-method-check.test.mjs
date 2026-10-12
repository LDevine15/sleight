import test from 'node:test';
import assert from 'node:assert/strict';
import { dragMethodAudit } from '../bench/world/method-check.mjs';

const claude = (code, error = false) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'mcp__computer__js', input: { code } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: error }] } },
].map(JSON.stringify).join('\n');
test('drag audit requires a successful awaited call, not model prose or an uncalled function', () => {
  assert.deepEqual(dragMethodAudit(claude('await app.drag({ from: [1,2], to: [3,4] })')), { drag: true, replacement: false, complete: true });
  for (const code of ['nodeRepl.write("await app.drag()")', 'function move() { app.drag() }', 'const move = () => app.drag()', 'app.drag()', 'if (false) { await app.drag({}) }']) {
    assert.equal(dragMethodAudit(claude(code)).drag, false, code);
  }
  assert.equal(dragMethodAudit(claude('await app.drag({})', true)).drag, false);
  assert.equal(dragMethodAudit(claude('await app.drag({}); await other.unknownWriter()')).complete, false);
});
test('typing, field replacement and cut or paste invalidate drag-method proof', () => {
  for (const code of ['await app.typeText("x")', 'await app.setValue(1,"x")', 'await app.fill("x")', 'await app.pressKey("Command+x")', 'await app.pressKey("super+v")', 'await app.keypress({keys:["META","KEY_X"]})']) {
    assert.equal(dragMethodAudit(claude('await app.drag({}); ' + code)).replacement, true, code);
  }
  assert.equal(dragMethodAudit(claude('await app.drag({}); await app.pressKey("Command+s")')).replacement, false);
  const direct = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'keypress', arguments: { keys: ['CTRL', 'V'] }, result: {} } });
  assert.equal(dragMethodAudit(direct).replacement, true);
});
test('Codex MCP and direct MCP drag actions use the same audit, with incomplete evidence refusing proof', () => {
  const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'js', arguments: { code: 'await app.drag({})' }, result: { isError: false } } };
  assert.equal(dragMethodAudit(JSON.stringify(event)).drag, true);
  event.item.tool = 'drag'; event.item.arguments = { from_x: 1, to_x: 3 };
  assert.equal(dragMethodAudit(JSON.stringify(event)).drag, true);
  assert.equal(dragMethodAudit('').complete, false);
  assert.equal(dragMethodAudit('{broken').complete, false);
  assert.equal(dragMethodAudit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pending', name: 'drag', input: {} }] } })).complete, false);
});
