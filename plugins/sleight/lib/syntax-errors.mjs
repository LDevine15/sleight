// The engine reports a parse error as "[line:column-line:column]: message". Measured on engine
// 26.1007.71326 (7 parse errors, 2026-10-15): the line is 1-based and the column 0-based, both counted in
// the code the relay transmitted, which starts with sleight's setup lines (1261 of them at the time).
// Without this mapping the model sees "[1263:10-1263:11]" for line 2 of its own code.
export function syntaxOrigin(sent, code) {
  if (typeof sent !== 'string' || typeof code !== 'string' || !code) return;
  const start = sent.indexOf(code);
  if (start < 0 || sent.indexOf(code, start + 1) >= 0) return;
  const lineStart = start > 0 ? sent.lastIndexOf('\n', start - 1) + 1 : 0;
  return { line: sent.slice(0, start).split('\n').length, column: start - lineStart, lines: code.split('\n').length };
}

export function syntaxErrorHint(text, origin) {
  if (!origin || typeof text !== 'string') return;
  const at = /^(?:Error: )?\[(\d+):(\d+)-\d+:\d+\]: \S/.exec(text.split('\n')[0]);
  if (!at) return;
  const line = Number(at[1]) - origin.line + 1;
  if (line < 1 || line > origin.lines) return;
  const column = Number(at[2]) - (line === 1 ? origin.column : 0);
  if (column < 0) return;
  return /* lean notice */ `sleight: the engine's line counts sleight's setup code. In your code the error is at line ${line}, column ${column + 1}.`;
}
