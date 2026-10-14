// Engine coordinates can refer to relay wrappers. Show caller context only for a
// unique, unchanged copy of the submitted code in the actual transmitted source.
export function syntaxErrorHint(text, code, sent) {
  if (typeof text !== 'string' || typeof code !== 'string' || !code || typeof sent !== 'string') return;
  const first = text.split('\n')[0];
  const range = /^(?:Error: )?\[(\d+):(\d+)-\d+:\d+\]: (?:Unexpected token|Invalid (?:assignment|left-hand side))/.exec(first);
  const stack = /^(?:Error: )?SyntaxError:/.test(first) && /\bat <anonymous>:(\d+):(\d+)(?:\)|$)/m.exec(text);
  const at = range || stack;
  if (!at) return;
  const line = Number(at[1]), column = Number(at[2]);
  const unavailable = `Syntax error at reported line ${line}, column ${column}. Caller source context unavailable.`;
  const lines = sent.split('\n');
  if (!line || !column || line > lines.length || column > lines[line - 1].length + 1) return unavailable;
  const start = sent.indexOf(code);
  if (start < 0 || sent.indexOf(code, start + 1) >= 0) return unavailable;
  const offset = lines.slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0) + column - 1 - start;
  if (offset < 0 || offset > code.length) return unavailable;
  const before = code.slice(0, offset), callerLine = before.split('\n').length;
  const callerColumn = offset - before.lastIndexOf('\n');
  const context = (redact(code).split('\n')[callerLine - 1] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const clipped = context.length > 240 ? context.slice(0, 240) + ' [truncated]' : context;
  return `Syntax error at caller line ${callerLine}, column ${callerColumn}. Redacted source: ${clipped}`;
}

function redact(code) {
  let out = '', i = 0;
  const hidden = (end, label) => {
    out += label + (code.slice(i, end).match(/\n/g) ?? []).join('');
    i = end;
  };
  while (i < code.length) {
    if (code.startsWith('//', i)) {
      const end = code.indexOf('\n', i);
      hidden(end < 0 ? code.length : end, '<comment>');
    } else if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      hidden(end < 0 ? code.length : end + 2, '<comment>');
    } else if (code[i] === '"' || code[i] === "'") {
      const quote = code[i]; let end = i + 1;
      while (end < code.length) {
        if (code[end] === '\\') end += 2;
        else if (code[end++] === quote) break;
      }
      hidden(Math.min(end, code.length), '<string>');
    } else if (code[i] === '`' || code[i] === '/') {
      // Template interpolation and regex/division ambiguity need a parser. Hide
      // the remaining source rather than expose literal or comment contents.
      hidden(code.length, '<string>');
    } else out += code[i++];
  }
  return out;
}
