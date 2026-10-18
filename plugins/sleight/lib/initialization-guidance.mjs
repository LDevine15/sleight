const DOCS = /^#{1,2} (?:Computer Use|API Reference|Other Browser APIs|Browser APIs)\n/;

export function initializationAdvice(content, failed, code = '') {
  if (!Array.isArray(content) || content.some(c => c.type !== 'text')) return;
  const texts = content.map(c => c.text ?? '');
  if (!texts.some(text => DOCS.test(text))) return;
  const outside = texts.map(withoutFences);
  const error = failed || outside.some(text => /^(?:Error|TypeError|ReferenceError|SyntaxError):/m.test(text));
  if (!error && outside.some(text => /^(?:Window: |Browser tab: |Tab: )/m.test(text))) return;
  if (!error && texts.some(text => text.trim() && !DOCS.test(text))) return;
  const browser = texts.some(text => /^#(?:#)? (?:Other Browser APIs|Browser APIs)\n/.test(text)) ||
    /\bcua\.(?:getBrowser|getTab|listTabs|createBrowserTab)\(/.test(code);
  const read = browser ? 'await cua.listTabs()' : 'await cua.getState()';
  // A runtime throw ran up to the error (a JSON.parse error did, 2026-10-16 probe); a syntax error never ran.
  const kind = /* lean notice */ !error ? 'sleight: the engine returned only required API documentation; execution is unconfirmed'
    : outside.some(text => /^SyntaxError:/m.test(text)) ? 'sleight: initialization documentation accompanied a syntax error; the code did not run'
    : 'sleight: initialization documentation accompanied an error; the code may have run up to the error';
  return /* lean notice */ `${kind}. Complete the documented initialization with one supported read: ${read}. Read current state before deciding what remains. Do not replay the pending input automatically. Existing approval requirements still apply.`;
}

function withoutFences(text) {
  let fence;
  return text.split('\n').filter(line => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n');
}
