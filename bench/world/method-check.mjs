import ts from 'typescript';

const writers = /^(?:type|typeText|type_text|insert_text|setValue|fill|paste|cut|setClipboard|writeText)$/i;
const cutOrPaste = text => /(?:command|cmd|super|meta|ctrl|control)[+\s-]+(?:key[_-]?)?[xv]\b/i.test(text.replace(/["'\[\],]/g, ' '));
const readsAndControls = new Set(['getApp', 'getWindow', 'getAXState', 'getState', 'listApps', 'listWindows',
  'getWindows', 'click', 'doubleClick', 'drag', 'selectText', 'pressKey', 'press', 'keypress', 'keyPress',
  'getBoundingClientRect', 'write', 'log', 'menu', 'menuBar', 'getByRole', 'getByText', 'locator', 'getByLabel']);

// A method check supplements the saved artifacts. Unknown or unfinished evidence fails closed.
export function dragMethodAudit(transcript) {
  const audit = { drag: false, replacement: false, complete: true }, pending = new Map();
  let calls = 0;
  const inspect = (name, input, success) => {
    calls++;
    if (!input || typeof input !== 'object') { audit.complete = false; return; }
    if (typeof input.code === 'string') {
      const file = ts.createSourceFile('tool.js', input.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      if (file.parseDiagnostics.length) audit.complete = false;
      const visit = (node, deferred = false) => {
        deferred ||= ts.isFunctionLike(node);
        if (ts.isCallExpression(node)) {
          const expr = node.expression, method = ts.isPropertyAccessExpression(expr) ? expr.name.text : '';
          if (!method || !readsAndControls.has(method) || ts.isElementAccessExpression(expr)) audit.complete = false;
          if (writers.test(method)) audit.replacement = true;
          if (/^(pressKey|press|keypress|keyPress)$/.test(method) && node.arguments.some(arg => cutOrPaste(arg.getText(file)))) audit.replacement = true;
          if (method === 'drag' && !deferred && ts.isAwaitExpression(node.parent) &&
            ts.isExpressionStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent) && success) audit.drag = true;
          if (/^(eval|Function|run|execute|exec|apply|call|bind)$/.test(method)) audit.complete = false;
        }
        ts.forEachChild(node, child => visit(child, deferred));
      };
      visit(file);
    } else {
      const action = String(input.action ?? name.split('__').at(-1));
      if (/^(drag|mouse_drag|drag_and_drop)$/.test(action) && success) audit.drag = true;
      else if (writers.test(action) || /(?:type|paste|cut|clipboard)/i.test(action)) audit.replacement = true;
      else if (!/^(?:click|double_click|mouse_move|move|scroll|press|keypress|key|hotkey|screenshot|see|read|list|get|focus|select|menu)/i.test(action)) audit.complete = false;
      if (cutOrPaste(JSON.stringify(input))) audit.replacement = true;
    }
  };
  for (const line of String(transcript ?? '').split('\n').filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { audit.complete = false; continue; }
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
      const item = event.item;
      let input = item.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
      inspect(item.tool ?? '', input, item.status !== 'failed' && !!item.result && item.result.isError !== true && !item.error);
    }
    for (const item of event.message?.content ?? []) {
      if (item.type === 'tool_use') pending.set(item.id, item);
      if (item.type === 'tool_result') {
        const request = pending.get(item.tool_use_id);
        if (!request) { audit.complete = false; continue; }
        pending.delete(item.tool_use_id);
        inspect(request.name, request.input, item.is_error !== true);
      }
    }
  }
  if (!calls || pending.size) audit.complete = false;
  return audit;
}
