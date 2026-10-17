import ts from 'typescript';

const writers = /^(?:type|typeText|type_text|insert_text|setValue|fill|paste|cut|setClipboard|writeText)$/i;
const cutOrPaste = text => /(?:command|cmd|super|meta|ctrl|control)[+\s-]+(?:(?:command|cmd|super|meta|ctrl|control|shift|alt|option)[+\s-]+)*(?:key[_-]?)?[xv]\b|shift[+\s-]+(?:key[_-]?)?insert\b/i.test(text.replace(/["'\[\],]/g, ' '));
const writeAction = /(?:^|[_\s.-])(?:type|paste|cut)(?:$|[_\s.-])|^(?:set|write)[_\s.-]?clipboard$|^clipboard[_\s.-](?:set|write)$/i;
const indirect = /^(?:eval|Function|apply|call|bind)$/;
const builtins = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'Number', 'String', 'Boolean']);
const ordinaryTools = new Set(['notifications', 'turn_ended', 'blocked_app', 'hover', 'open_file', 'js_reset', 'ToolSearch']);
const methods = new Set(['getApp', 'getState', 'listApps', 'listWindows', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot',
  'click', 'doubleClick', 'rightClick', 'scroll', 'drag', 'pressKey', 'press', 'keypress', 'keyPress', 'selectText',
  'performAction', 'performSecondaryAction', 'focus', 'hover', 'waitFor', 'log', 'stringify', 'find', 'filter',
  // Pure string and array reads. The engine API has no method by these names, so none can type or paste.
  'slice', 'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'trim', 'split', 'join', 'map', 'some', 'every',
  'match', 'test', 'toString', 'toLowerCase', 'toUpperCase', 'at', 'keys', 'values', 'entries']);
const logical = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
function literal(node) {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(literal);
  return ts.isObjectLiteralExpression(node) && node.properties.every(p =>
    ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && literal(p.initializer));
}
// Supplement saved artifacts with drag and prohibited replacement patterns.
export function dragMethodAudit(transcript) {
  const audit = { drag: false, replacement: false, complete: true }, pending = new Map(), apps = new Set();
  let calls = 0, engine = true;
  const inspect = (name, input, success) => {
    calls++;
    if (!input || typeof input !== 'object' || Array.isArray(input)) { audit.complete = false; return; }
    const tool = name.split('__').at(-1);
    if (tool === 'replay') audit.complete = false;
    if (tool === 'blocked_app' && input.op === 'type') audit.replacement = true;
    if (typeof input.code === 'string') {
      const file = ts.createSourceFile('tool.js', input.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      if (file.parseDiagnostics.length) audit.complete = false;
      if (!success) apps.clear();
      const bind = (name, value, deferred) => {
        if (!ts.isIdentifier(name)) { apps.clear(); return; }
        if (name.text === 'cua') { engine = false; apps.clear(); audit.complete = false; }
        const call = value && ts.isAwaitExpression(value) ? value.expression : undefined;
        const acquired = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'cua' &&
          call.expression.name.text === 'getApp' && !(call.flags & ts.NodeFlags.OptionalChain);
        if (acquired && engine && !deferred && success) apps.add(name.text);
        else apps.delete(name.text);
      };
      const visit = (node, deferred = false) => {
        deferred ||= ts.isFunctionLike(node) || ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isIterationStatement(node, false) ||
          ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isCatchClause(node) || ts.isTryStatement(node);
        if (ts.isSourceFile(node) || ts.isBlock(node)) {
          const locals = new Map();
          let stopped;
          for (const statement of node.statements) {
            if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped)) for (const declaration of statement.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name) && !locals.has(declaration.name.text)) locals.set(declaration.name.text, apps.has(declaration.name.text));
            }
            const end = visit(statement, deferred);
            if (!deferred && end !== undefined) { stopped = end; deferred = true; }
          }
          if (ts.isBlock(node)) for (const [name, known] of locals) { if (known) apps.add(name); else apps.delete(name); }
          return stopped;
        }
        if (ts.isLabeledStatement(node)) {
          const end = visit(node.statement, deferred);
          return end === ts.SyntaxKind.ReturnStatement || end === ts.SyntaxKind.ThrowStatement ? end : undefined;
        }
        if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer, deferred);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          if (ts.isIdentifier(node.left)) bind(node.left, node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined, deferred);
          else { apps.clear(); audit.complete = false; }
        }
        if (ts.isCallExpression(node)) {
          const expr = node.expression, method = ts.isPropertyAccessExpression(expr) ? expr.name.text :
            ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression) ? expr.argumentExpression.text : '';
          const known = ts.isPropertyAccessExpression(expr) ? methods.has(method) || writers.test(method) || ['nodeRepl.write', 'nodeRepl.emitImage'].includes(expr.getText(file)) : ts.isIdentifier(expr) && builtins.has(expr.text);
          if (!known || indirect.test(method)) audit.complete = false;
          if (writers.test(method)) audit.replacement = true;
          if (/^(pressKey|press|keypress|keyPress)$/.test(method)) {
            if (!node.arguments.length || !node.arguments.every(literal)) audit.complete = false;
            if (node.arguments.some(arg => cutOrPaste(arg.getText(file)))) audit.replacement = true;
          }
          if (method === 'drag' && !deferred && !(node.flags & ts.NodeFlags.OptionalChain) &&
            ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && apps.has(expr.expression.text) &&
            ts.isAwaitExpression(node.parent) && success) audit.drag = true;
        }
        const shortCircuit = ts.isBinaryExpression(node) && logical.has(node.operatorToken.kind);
        ts.forEachChild(node, child => { visit(child, deferred || (shortCircuit && child === node.right)); });
        if (!deferred && (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node) || ts.isThrowStatement(node))) return node.kind;
      };
      visit(file);
    } else {
      const action = String(input.action ?? input.op ?? tool);
      if (tool === 'js_reset') { apps.clear(); engine = true; }
      // A refused drag moved nothing and typed nothing, so it neither proves nor spoils the method (WD1, 2026-10-17).
      if (/^(drag|mouse_drag|drag_and_drop)$/.test(action)) { if (success) audit.drag = true; }
      else if (writers.test(action) || writeAction.test(action)) audit.replacement = true;
      else if (!ordinaryTools.has(tool) && !/^(?:click|double_click|mouse_move|move|scroll|press|keypress|key|hotkey|screenshot|see|read|list|get|focus|select|menu)(?:$|[_\s.-])/i.test(action)) audit.complete = false;
      if (cutOrPaste(JSON.stringify(input))) audit.replacement = true;
    }
  };
  for (const line of String(transcript ?? '').split('\n').filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { audit.complete = false; continue; }
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
      const item = event.item;
      let input = item.arguments === undefined ? {} : item.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
      inspect(item.tool ?? '', input, item.status !== 'failed' && !!item.result && item.result.isError !== true && !item.error);
    }
    for (const item of event.message?.content ?? []) {
      if (item.type === 'tool_use') pending.set(item.id, item);
      if (item.type === 'tool_result') {
        const request = pending.get(item.tool_use_id);
        if (!request) { audit.complete = false; continue; }
        pending.delete(item.tool_use_id);
        inspect(request.name, request.input, item.is_error !== true && event.tool_use_result?.isError !== true);
      }
    }
  }
  if (!calls || pending.size) audit.complete = false;
  return audit;
}
