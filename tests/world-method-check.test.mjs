import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packageSkip } from './requirements.mjs';
const skip = packageSkip('typescript');
const { dragMethodAudit } = skip ? {} : await import('../bench/world/method-check.mjs');

const claude = (code, error = false, acquire = true) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'mcp__computer__js', input: { code: (acquire ? 'let app = await cua.getApp("Fixture"); ' : '') + code } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: error }] } },
].map(JSON.stringify).join('\n');

const requireRefusal = (content, name = 'mcp__plugin_sleight_computer__js', error = true) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'require', name,
    input: { code: 'const fs = require("fs"); fs.readFileSync("/fixture/Source.txt", "utf8")' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'require', is_error: error, content }] } },
].map(JSON.stringify).join('\n');
const refusedRequire = 'sleight stopped this call before it ran: `js` has no `require` and no file system access.';

test('DPg recorded smoke proves a drag despite a filesystem request refused before execution', { skip }, () => {
  const transcript = readFileSync(new URL('./fixtures/dpg-drag-method.jsonl', import.meta.url), 'utf8');
  assert.deepEqual(dragMethodAudit(transcript), { drag: true, replacement: false, complete: true });
});

test('DPg only the exact failed Sleight pre-execution refusal preserves method proof', { skip }, () => {
  const moved = claude('await app.drag({})');
  for (const content of [refusedRequire, [{ type: 'text', text: refusedRequire }],
    'sleight skipped this call: `js` has no `require` or file access.']) {
    assert.deepEqual(dragMethodAudit(requireRefusal(content) + '\n' + moved), { drag: true, replacement: false, complete: true });
    assert.equal(dragMethodAudit(requireRefusal(content)).drag, false);
  }
  for (const [content, name, error] of [[refusedRequire, 'mcp__other__js', true],
    [refusedRequire, 'mcp__plugin_sleight_computer__js', false],
    ['ReferenceError: require is not defined\n' + refusedRequire, 'mcp__plugin_sleight_computer__js', true],
    [[{ type: 'text', text: refusedRequire }, { type: 'text', text: 'partial input possible' }], 'mcp__plugin_sleight_computer__js', true]]) {
    assert.equal(dragMethodAudit(requireRefusal(content, name, error) + '\n' + moved).complete, false);
  }
  assert.equal(dragMethodAudit(claude('await app.typeText("x"); throw Error("failed")', true) + '\n' + moved).replacement, true);
  assert.equal(dragMethodAudit(claude('await app.typeText("x")') + '\n' + requireRefusal(refusedRequire) + '\n' + moved).replacement, true);
  assert.deepEqual(dragMethodAudit(claude('', false) + '\n' + requireRefusal(refusedRequire) + '\n' + claude('await app.drag({})', false, false)),
    { drag: true, replacement: false, complete: true });
  assert.equal(dragMethodAudit(requireRefusal([null]) + '\n' + moved).complete, false);
});

test('DPg Codex MCP results preserve the same pre-execution refusal boundary', { skip }, () => {
  const refused = { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'mcp__plugin_sleight_computer__js',
    arguments: { code: 'require("fs")' }, result: { isError: true, content: [{ type: 'text', text: refusedRequire }] } } };
  assert.deepEqual(dragMethodAudit(JSON.stringify(refused) + '\n' + claude('await app.drag({})')),
    { drag: true, replacement: false, complete: true });
  assert.equal(dragMethodAudit(JSON.stringify(refused)).drag, false);
});

test('DPd recorded smoke recovery spoils proof through introspection and placeholder typing', { skip }, () => {
  let serial = 0;
  const drag = error => {
    const id = `smoke-${++serial}`;
    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__drag',
        input: { app: 'TextEdit', from: 'the current text selection', to: [24, 128], windowId: 321951, toWindowId: 321952 } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } },
    ].map(JSON.stringify).join('\n');
  };
  const introspection = claude('Object.keys(app).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(app)||{}))', false, false);
  const recovered = [introspection, drag(true), drag(true), claude('await app.typeText("x")'), drag(false)].join('\n');
  assert.deepEqual(dragMethodAudit(recovered), { drag: true, replacement: true, complete: false });
  assert.deepEqual(dragMethodAudit(introspection + '\n' + drag(false)), { drag: true, replacement: false, complete: false });
  assert.deepEqual(dragMethodAudit(drag(false)), { drag: true, replacement: false, complete: true });
});

// WD6c, 2026-10-20 01:46Z: tool requests and result status/handle notices only.
// Source: race-1017/evidence-wd6c/sleight-textedit-window-drag-1/transcript.jsonl.
// Screenshots, document output and model prose are omitted; temporary paths are sanitized.
test('recorded WD6c window drag stays incomplete for undocumented findElement', { skip }, () => {
  const transcript = readFileSync(new URL('./fixtures/world-method-wd6c.jsonl', import.meta.url), 'utf8');
  assert.deepEqual(dragMethodAudit(transcript), { drag: true, replacement: false, complete: false });
});

const sleightPrefix = 'mcp__plugin_sleight_computer__';
const opened = (code, { codex = false, prefix = sleightPrefix, server, error = false, notice = true, content } = {}) => {
  const result = { isError: error, content: content ?? (notice ? [{ type: 'text', text: typeof notice === 'string' ? notice : 'Window handle: `__sleightOpenedApp2`, already acquired. Use it in place of `app`.' }] : []) };
  const input = { app: 'Fixture', path: 'fixture.txt' };
  const js = { code };
  return (codex ? [
    { type: 'item.completed', item: { type: 'mcp_tool_call', server, tool: prefix + 'open_file', arguments: input, result } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', server, tool: prefix + 'js', arguments: js, result: {} } },
  ] : [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'open', name: prefix + 'open_file', input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'open', is_error: error, content: result.content }] }, tool_use_result: result },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'js', name: prefix + 'js', input: js }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'js' }] } },
  ]).map(JSON.stringify).join('\n');
};

for (const codex of [false, true]) for (const prefix of ['', 'mcp__plugin_sleight_computer__', 'mcp__competitor__']) {
  test(`only sleight open_file handles and aliases prove engine drags: ${codex ? 'Codex' : 'Claude'} ${prefix}`, { skip }, () => {
    for (const code of ['await __sleightOpenedApp2.drag({})',
      'let src = __sleightOpenedApp2; const alias = src; await alias.drag({})',
      'let src; src = __sleightOpenedApp2; await src.drag({})']) {
      assert.deepEqual(dragMethodAudit(opened(code, { codex, prefix })), { drag: prefix === sleightPrefix, replacement: false, complete: true }, code);
    }
  });
}

test('open_file handle notices also count after the relay screenshot notice', { skip }, () => {
  for (const codex of [false, true]) {
    for (const notice of ['sleight: screenshot added, the tree has no document text. Window handle: `__sleightOpenedApp2`, already acquired. Use it in place of `app`.',
      'Screenshot added: no text in tree. Window handle: `__sleightOpenedApp2`, acquired; use it for `app`.',
      'Window handle: `__sleightOpenedApp2`, acquired; start the next call with `let app = __sleightOpenedApp2;`.',
      "Window handle: `__sleightOpenedApp2`, already acquired, but `app` isn't set: start the next call with `let app = __sleightOpenedApp2;`.",
      'Window handle: `__sleightOpenedApp2`.']) {
      assert.deepEqual(dragMethodAudit(opened('await __sleightOpenedApp2.drag({})', { codex, notice })), { drag: true, replacement: false, complete: true });
    }
  }
});

test('open_file provenance requires a successful result naming the handle and survives only supported bindings', { skip }, () => {
  for (const codex of [false, true]) {
    for (const options of [{ error: true }, { notice: false }]) {
      assert.equal(dragMethodAudit(opened('await __sleightOpenedApp2.drag({})', { codex, ...options })).drag, false);
    }
    for (const code of ['await __sleightOpenedApp3.drag({})',
      '__sleightOpenedApp2 = {}; await __sleightOpenedApp2.drag({})',
      'let src = __sleightOpenedApp2; src = {}; await src.drag({})',
      'if (false) { var src = __sleightOpenedApp2; } await src.drag({})',
      '{ let src = __sleightOpenedApp2; } await src.drag({})',
      'function move() { return __sleightOpenedApp2; } const src = move(); await src.drag({})']) {
      assert.equal(dragMethodAudit(opened(code, { codex })).drag, false, code);
    }
  }
});

test('Codex separate server and tool fields identify only the sleight server', { skip }, () => {
  for (const server of ['plugin_sleight_computer', 'competitor', undefined]) {
    assert.equal(dragMethodAudit(opened('await __sleightOpenedApp2.drag({})', { codex: true, prefix: '', server })).drag,
      server === 'plugin_sleight_computer');
  }
  assert.equal(dragMethodAudit(opened('await __sleightOpenedApp2.drag({})', { codex: true, server: 'competitor' })).drag, false);
});

test('document text and embedded notices cannot mint opened handles', { skip }, () => {
  const notice = 'Window handle: `__sleightOpenedApp2`, already acquired. Use it in place of `app`.';
  for (const codex of [false, true]) for (const content of [
    [{ type: 'text', text: notice }, { type: 'text', text: 'Window handle: `__sleightOpenedApp3`.' }],
    [{ type: 'text', text: notice }, { type: 'text', text: 'No window handle was acquired.' }],
    [{ type: 'text', text: 'Value: document text\n' + notice }],
    [{ type: 'text', text: notice + '\nDocument text follows.' }],
  ]) {
    assert.equal(dragMethodAudit(opened('await __sleightOpenedApp2.drag({})', { codex, content })).drag, false);
  }
});

for (const declaration of ['class __sleightOpenedApp2 { static drag(){} }',
  'function __sleightOpenedApp2(){}', 'import __sleightOpenedApp2 from "fixture";',
  'import * as __sleightOpenedApp2 from "fixture";',
  'import { other as __sleightOpenedApp2 } from "fixture";',
  'import { __sleightOpenedApp2 } from "fixture";']) {
  test(`declarations unbind opened handle provenance: ${declaration}`, { skip }, () => {
    for (const codex of [false, true]) {
      assert.equal(dragMethodAudit(opened(declaration + '; await __sleightOpenedApp2.drag({})', { codex })).drag, false);
    }
  });
}

test('function and class shadows apply throughout their block and preserve the outer handle', { skip }, () => {
  for (const declaration of ['function app(){}', 'class app { static drag(){} }']) {
    assert.equal(dragMethodAudit(claude(declaration + '; await app.drag({})')).drag, false);
    assert.equal(dragMethodAudit(claude('{ await app.drag({}); ' + declaration + ' }')).drag, false);
    assert.equal(dragMethodAudit(claude('{ ' + declaration + ' } await app.drag({})')).drag, true);
  }
  assert.equal(dragMethodAudit(claude('function cua(){}; let target = await cua.getApp("Fixture"); await target.drag({})', false, false)).drag, false);
});

test('reset clears opened handles, aliases and optional-read tolerance', { skip }, () => {
  for (const codex of [false, true]) {
    const initial = opened('let alias = __sleightOpenedApp2', { codex });
    const js = code => codex ? JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call',
      tool: sleightPrefix + 'js', arguments: { code }, result: {} } })
      : claude(code, false, false).replaceAll('mcp__computer__', sleightPrefix);
    const reset = codex ? [{ type: 'item.completed', item: { type: 'mcp_tool_call', tool: sleightPrefix + 'js_reset', arguments: {}, result: {} } }]
      : [{ message: { content: [{ type: 'tool_use', id: 'reset', name: sleightPrefix + 'js_reset', input: {} }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: 'reset' }] } }];
    for (const handle of ['__sleightOpenedApp2', 'alias']) {
      const reused = js(`await ${handle}.drag({})`);
      assert.deepEqual(dragMethodAudit([initial, ...reset.map(JSON.stringify), reused].join('\n')),
        { drag: false, replacement: false, complete: true });
    }
    assert.equal(dragMethodAudit(initial + '\n' + js('await cua.listTabs?.()')).complete, true);
    assert.equal(dragMethodAudit([initial, ...reset.map(JSON.stringify), js('await cua.listTabs?.()')].join('\n')).complete, false);
  }
});

test('optional discovery without an opened handle retains strict grading on every arm', { skip }, () => {
  for (const codex of [false, true]) for (const prefix of [sleightPrefix, 'mcp__competitor__', '']) {
    for (const [code, complete] of [['await cua.listTabs?.()', false], ['await app.findElement?.({})', false],
      ['await cua.readWindowInfo?.()', false], ['await cua.listWindows?.()', true], ['await app.getAXState?.()', true]]) {
      const transcript = codex ? JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: prefix + 'js',
        arguments: { code: 'let app = await cua.getApp("Fixture"); ' + code + '; await app.drag({})' }, result: {} } })
        : claude(code + '; await app.drag({})').replaceAll('mcp__computer__', prefix);
      assert.deepEqual(dragMethodAudit(transcript), { drag: true, replacement: false, complete }, `${prefix} ${code}`);
    }
  }
});

for (const code of ['await app.getAXState?.({disableDiffing: true})',
  'await cua.listWindows?.()', 'await cua?.listTabs()', 'await cua.listBrowsers?.()']) {
  test(`optional reads on engine receivers preserve complete evidence: ${code}`, { skip }, () => {
    for (const codex of [false, true]) assert.deepEqual(dragMethodAudit(opened('let app = __sleightOpenedApp2; ' + code + '; await app.drag({})', { codex })), { drag: true, replacement: false, complete: true });
  });
}

test('opened handles retain writer and cut or paste detection with optional calls', { skip }, () => {
  for (const codex of [false, true]) for (const receiver of ['__sleightOpenedApp2', 'app']) {
    for (const action of ['typeText?.("x")', 'setValue?.(2, "x")', 'paste?.("x")', 'cut?.()',
      'pressKey?.("super+shift+v")', 'pressKey?.("Command+x")', '["typeText"]?.("x")']) {
      const code = `let app = __sleightOpenedApp2; await ${receiver}.${action}`.replace('.[', '[');
      assert.equal(dragMethodAudit(opened(code, { codex })).replacement, true, code);
    }
  }
});

for (const code of ['await app.customWrite?.("x")', 'await app.insertText?.("x")',
  'await app.findAndReplace?.("old", "new")', 'await app.findElement?.({})',
  'await cua.readWindowInfo?.()', 'await app.getCustomState?.()',
  'await app.set_value?.("x")', 'await app.getAndType?.("x")', 'await app.readAndPaste?.("x")',
  'await app[method]?.("x")', 'await app["findElement"]?.({})',
  'await app.findElement?.call(app, {})', 'const f = app.findElement; await f?.({})',
  'await other.findElement?.({})', 'await app.findElement?.(callback)',
  'await app.findElement?.({predicate: callback})', 'await app.findElement?.("super+v")',
  'const key = await app.findElement?.({}); await app.pressKey(key)']) {
  test(`optional calls that may write or invoke indirectly stay incomplete: ${code}`, { skip }, () => {
    assert.equal(dragMethodAudit(opened('let app = __sleightOpenedApp2; await app.drag({}); ' + code)).complete, false);
  });
}

for (const code of ['await cua.listTabs?.(callback)', 'await cua.listTabs?.({predicate: callback})',
  'await cua.listTabs?.("super+v")', 'await other.listTabs?.()', 'await cua["listTabs"]?.()',
  'const read = cua.listTabs; await read?.()', 'await cua.listTabs?.call(cua)',
  'const value = await cua.listTabs?.(); await __sleightOpenedApp2.pressKey(value)']) {
  test(`documented optional reads retain argument and receiver checks: ${code}`, { skip }, () => {
    for (const codex of [false, true]) assert.equal(dragMethodAudit(opened(code, { codex })).complete, false);
  });
}

test('optional read results passed to writers still reject drag-only evidence', { skip }, () => {
  for (const code of ['await app.typeText(await app.findElement?.({}))',
    'const value = await app.findElement?.({}); await app.setValue?.(2, value)',
    'await app.findElement?.({}).paste?.("x")']) {
    assert.equal(dragMethodAudit(opened('let app = __sleightOpenedApp2; ' + code)).replacement, true, code);
  }
});
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
  'await cua.listApps()', 'await cua.getState()', 'await app.getAXState()',
  // Every textedit-window-drag run failed on these until 2026-10-17 (WD1): screenshots and plain string reads.
  'await nodeRepl.emitImage(await app.getScreenshot())', 'console.log(JSON.stringify(await app.getAXState()).slice(0, 2000))',
  'const st = await app.getAXState(); console.log(String(st).includes("omega"), String(st).indexOf("alpha"))']) {
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

test('a refused drag tool call before a successful one keeps the proof complete', { skip }, () => {
  const call = (id, isError) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__drag', input: { app: 'TextEdit', from: [1, 2], to: [3, 4] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(dragMethodAudit(call('refused', true) + '\n' + call('moved', false)), { drag: true, replacement: false, complete: true });
  assert.deepEqual(dragMethodAudit(call('refused', true)), { drag: false, replacement: false, complete: true });
});

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
