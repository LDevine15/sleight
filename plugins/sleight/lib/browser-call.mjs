// First filter only. Candidates keep native guards until the engine replies.
export function browserReply(reply) {
  return !reply.error && !reply.result?.isError &&
    reply.result?._meta?.['codex/toolSurface']?.kind === 'browserUse';
}

export function browserCall(code, handles = new Set(), nativeHandles = new Set(['app'])) {
  if (!code.trim()) return undefined;
  // Strings become "" and comments a space, so a comment can't hide what precedes a bracket.
  const source = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    match => (match.startsWith('/') ? ' ' : '""'));
  // This is a routing hint, not a JavaScript security boundary. Name native access rather than
  // trying to prove every other expression browser-only. The runtime guard still denies native input.
  if (/\b(?:getApp|computer|listApps|listWindows|getState)\b/.test(source) ||
      /\$\{[^`]*\b(?:getApp|computer|listApps|listWindows|getState)\b/.test(code) ||
      /\bcua\s*\[\s*["'](?:getApp|computer|listApps|listWindows|getState)["']\s*\]/.test(code)) return undefined;
  const bindings = new Set();
  for (const match of source.matchAll(/(?:(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.(?:getBrowser|getTab|createBrowserTab)\(/g)) {
    bindings.add(match[1]);
  }
  const factories = /\.(?:getByRole|getByText|getByLabel|getByPlaceholder|getByTestId|locator|frameLocator|filter|first|last|nth|and|or|new|get)\(/;
  for (const match of source.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)(\.[^;]*)/g)) {
    if ((handles.has(match[2]) || bindings.has(match[2])) && factories.test(match[3])) bindings.add(match[1]);
  }
  const roots = [...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*(?:\.|\[)/g)].map(m => m[1]);
  if (roots.some(h => nativeHandles.has(h) && !handles.has(h) && !bindings.has(h))) return undefined;
  return { handles: [...bindings] };
}
