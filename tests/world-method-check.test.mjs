import test from 'node:test';
import assert from 'node:assert/strict';
import { packageSkip } from './requirements.mjs';
const skip = packageSkip('typescript');
const { dragMethodAudit } = skip ? {} : await import('../bench/world/method-check.mjs');

const claude = (code, error = false, acquire = true) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'mcp__computer__js', input: { code: (acquire ? 'let app = await cua.getApp("Fixture"); ' : '') + code } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: error }] } },
].map(JSON.stringify).join('\n');
test('drag audit requires a successful awaited call, not model prose or an uncalled function', { skip }, () => {
  assert.deepEqual(dragMethodAudit(claude('await app.drag({ from: [1,2], to: [3,4] })')), { drag: true, replacement: false, complete: true });
  for (const code of ['nodeRepl.write("await app.drag()")', 'function move() { app.drag() }', 'const move = () => app.drag()', 'app.drag()', 'if (false) { await app.drag({}) }']) {
    assert.equal(dragMethodAudit(claude(code)).drag, false, code);
  }
  assert.equal(dragMethodAudit(claude('await app.drag({})', true)).drag, false);
  assert.equal(dragMethodAudit(claude('await app.drag({}); await other.unknownMethod()')).complete, false);
});

for (const code of ['await app.getScreenshot()', 'await app.getAXStateAndScreenshot()', 'await loc.waitFor({state:"visible"})',
  'await app.scroll(1,"down")', 'console.log(JSON.stringify(await app.getAXState()))',
  '(await cua.listWindows()).find(w => w.title === "fixture")', '(await cua.listWindows()).filter(w => w.title)',
  'await cua.listApps()', 'await cua.getState()', 'await app.getAXState()']) {
  test(`read and control calls preserve drag evidence: ${code}`, { skip }, () => {
    assert.deepEqual(dragMethodAudit(claude(code + '; await app.drag({})')), { drag: true, replacement: false, complete: true });
  });
}

for (const tool of ['js_reset', 'hover', 'open_file', 'ToolSearch']) {
  test(`ordinary tool preserves drag evidence: ${tool}`, { skip }, () => {
    const transcript = claude('await app.drag({})') + '\n' + [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ordinary', name: tool, input: { query: 'fixture' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ordinary', is_error: false }] } },
    ].map(JSON.stringify).join('\n');
    assert.deepEqual(dragMethodAudit(transcript), { drag: true, replacement: false, complete: true });
  });
}

for (const code of ['const r = await app.drag({})', 'let r = await app.drag({})']) {
  test(`awaited drag result counts in supported statement forms: ${code}`, { skip }, () => {
    assert.deepEqual(dragMethodAudit(claude(code)), { drag: true, replacement: false, complete: true });
  });
}
test('typing, field replacement and cut or paste invalidate drag-method proof', { skip }, () => {
  for (const code of ['await app.typeText("x")', 'await app.setValue(1,"x")', 'await app.fill("x")', 'await app.pressKey("Command+x")', 'await app.pressKey("super+v")', 'await app.keypress({keys:["META","KEY_X"]})']) {
    assert.equal(dragMethodAudit(claude('await app.drag({}); ' + code)).replacement, true, code);
  }
  assert.equal(dragMethodAudit(claude('await app.drag({}); await app.pressKey("Command+s")')).replacement, false);
  const direct = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'keypress', arguments: { keys: ['CTRL', 'V'] }, result: {} } });
  assert.equal(dragMethodAudit(direct).replacement, true);
});
test('Codex MCP and direct MCP drag actions use the same audit, with incomplete evidence refusing proof', { skip }, () => {
  const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'js', arguments: { code: 'let app = await cua.getApp("Fixture"); await app.drag({})' }, result: { isError: false } } };
  assert.equal(dragMethodAudit(JSON.stringify(event)).drag, true);
  event.item.tool = 'drag'; event.item.arguments = { from_x: 1, to_x: 3 };
  assert.equal(dragMethodAudit(JSON.stringify(event)).drag, true);
  assert.equal(dragMethodAudit('').complete, false);
  assert.equal(dragMethodAudit('{broken').complete, false);
  assert.equal(dragMethodAudit(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pending', name: 'drag', input: {} }] } })).complete, false);
});

for (const code of ['false && await app.drag({})', 'true || await app.drag({})', '1 ?? await app.drag({})',
  'const result = false && await app.drag({})', 'await app?.drag({})']) {
  test(`a successful tool result does not prove a conditional drag ran: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(code)).drag, false);
  });
}

for (const code of ['await app[method]({})', 'await app["drag"]({})', 'await eval("app.drag({})")',
  'await Function("return app.drag({})")()', 'await app.drag.call(app, {})', 'await app.drag.apply(app, [{}])',
  'await app.pressKey(key)', 'await app.keypress({ keys })', 'await app.keypress({ keys: [modifier, "V"] })']) {
  test(`indirect methods and key arguments leave method evidence incomplete: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude('await app.drag({}); ' + code)).complete, false);
  });
}

for (const tool of ['read_clipboard', 'get_clipboard', 'execute', 'execute_command']) {
  test(`tool action words do not misread a read or execute as replacement: ${tool}`, { skip }, () => {
    const transcript = claude('await app.drag({})') + '\n' + [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ordinary', name: tool, input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ordinary', is_error: false }] } },
    ].map(JSON.stringify).join('\n');
    const audit = dragMethodAudit(transcript);
    assert.equal(audit.replacement, false);
    if (/^(read|get)_/.test(tool)) assert.equal(audit.complete, true);
  });
}

for (const tool of ['clipboard_write', 'paste_text', 'cut_text', 'type_text']) {
  test(`whole write action words still reject replacement: ${tool}`, { skip }, () => {
    const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool, arguments: {}, result: {} } };
    assert.equal(dragMethodAudit(JSON.stringify(event)).replacement, true);
  });
}

test('Codex reads without an arguments field count as empty input', { skip }, () => {
  const read = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'read_clipboard', result: {} } });
  assert.deepEqual(dragMethodAudit(claude('await app.drag({})') + '\n' + read), { drag: true, replacement: false, complete: true });
});

test('an engine error result cannot prove a drag ran', { skip }, () => {
  const events = claude('await app.drag({})').split('\n').map(JSON.parse);
  events[1].tool_use_result = { isError: true };
  assert.equal(dragMethodAudit(events.map(JSON.stringify).join('\n')).drag, false);
});

for (const tool of ['notifications', 'turn_ended', 'blocked_app']) {
  test(`exact Sleight tool names preserve drag evidence: ${tool}`, { skip }, () => {
    for (const prefix of ['', 'mcp__plugin_sleight_computer__', 'mcp__other__']) {
      const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: prefix + tool, arguments: {}, result: {} } };
      assert.equal(dragMethodAudit(claude('await app.drag({})') + '\n' + JSON.stringify(event)).complete, true);
      event.item.tool += '_extra';
      assert.equal(dragMethodAudit(JSON.stringify(event)).complete, false);
    }
  });
}

for (const code of ['setTimeout(() => {}, 1)', 'clearTimeout(timer)', 'parseInt("1")', 'parseFloat("1.2")',
  'Number("1")', 'String(1)', 'Boolean(1)', 'isNaN("x")', 'isFinite(1)', 'setInterval(() => {}, 1)']) {
  test(`named JavaScript builtins preserve drag evidence: ${code}`, { skip }, () => {
    assert.deepEqual(dragMethodAudit(claude(code + '; await app.drag({})')), { drag: true, replacement: false, complete: true });
  });
}

test('blocked-app type operations are replacements', { skip }, () => {
  for (const action of [undefined, 'read']) {
    const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'mcp__plugin_sleight_computer__blocked_app', arguments: { op: 'type', action, text: 'replacement' }, result: {} } };
    assert.deepEqual(dragMethodAudit(claude('await app.drag({})') + '\n' + JSON.stringify(event)), { drag: true, replacement: true, complete: true });
  }
});

test('replay does not prove a drag-only method without inspecting its steps', { skip }, () => {
  for (const input of [{}, { action: 'read' }, { code: 'await app.getAXState()' }, { script: { steps: [{ tool: 'blocked_app', args: { op: 'type', text: 'replacement' } }] } }]) {
    const event = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'replay', arguments: input, result: {} } };
    assert.equal(dragMethodAudit(claude('await app.drag({})') + '\n' + JSON.stringify(event)).complete, false);
  }
});

for (const code of ['x ||= await app.drag({})', 'x &&= await app.drag({})', 'x ??= await app.drag({})',
  'return; await app.drag({})', 'throw new Error("stop"); await app.drag({})',
  'stop: { break stop; await app.drag({}); }', 'stop: { break; await app.drag({}); }']) {
  test(`skipped or unreachable drags get no credit: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(code)).drag, false);
  });
}

for (const code of ['let app = {drag: async () => {}}; await app.drag({})', 'await app.drag({})',
  'let app = await other.getApp("Fixture"); await app.drag({})',
  'let app = await cua.getApp("Fixture"); app = {drag: async () => {}}; await app.drag({})',
  'if (false) { app = await cua.getApp("Fixture"); } await app.drag({})']) {
  test(`only an acquired app proves an engine drag: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(code, false, false)).drag, false);
  });
}

for (const code of ['{ return; } await app.drag({})', '{ throw new Error("stop"); } await app.drag({})',
  'stop: { return; } await app.drag({})', '{ var app = {}; } await app.drag({})',
  'cua = {getApp: async () => ({drag: async () => {}})}; app = await cua.getApp("Fixture"); await app.drag({})']) {
  test(`nested exits and overwritten engine handles cannot prove a drag: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(code)).drag, false);
  });
}

test('block-local app handles stay scoped and a local shadow leaves the outer app intact', { skip }, () => {
  assert.equal(dragMethodAudit(claude('{ let target = await cua.getApp("Fixture"); } await target.drag({})', false, false)).drag, false);
  assert.equal(dragMethodAudit(claude('{ let app = {}; } await app.drag({})')).drag, true);
});

test('an acquired app persists across successful calls and loses provenance on reassignment', { skip }, () => {
  const acquire = claude('let target = await cua.getApp("Fixture")', false, false);
  assert.equal(dragMethodAudit(acquire + '\n' + claude('await target.drag({})', false, false)).drag, true);
  assert.equal(dragMethodAudit(acquire + '\n' + claude('target = {}; await target.drag({})', false, false)).drag, false);
  assert.equal(dragMethodAudit(claude('let target = await cua.getApp("Fixture")', true, false) + '\n' + claude('await target.drag({})', false, false)).drag, false);
});

for (const code of ['await app.insertText("x")', 'await app.customWrite("x")']) {
  test(`unknown property calls leave evidence incomplete: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude('await app.drag({}); ' + code)).complete, false);
  });
}

for (const key of ['super+shift+v', 'shift+Insert', 'Command+Shift+V', 'Control+Alt+X']) {
  test(`modified cut or paste shortcuts count as replacement: ${key}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(`await app.drag({}); await app.pressKey(${JSON.stringify(key)})`)).replacement, true);
  });
}

test('bare calls outside the named builtin set remain incomplete', { skip }, () => {
  for (const code of ['sleep(1)', 'custom()', 'eval("1")', 'Function("return 1")()']) {
    assert.equal(dragMethodAudit(claude(code + '; await app.drag({})')).complete, false);
  }
});

for (const code of [
  'switch (0) { case 1: await app.drag({}); break; }',
  'switch (0) { case 0: break; default: await app.drag({}); }',
  'try { } catch (error) { await app.drag({}); }',
  'try { await app.drag({}); } catch (error) { console.log(error); }',
  'try { throw Error("skip"); await app.drag({}); } catch (error) { console.log(error); }',
  'try { await app.drag({}); } finally { return; }',
]) {
  test(`a caught or conditional drag is not proved by overall tool success: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(claude(code)).drag, false);
  });
}
