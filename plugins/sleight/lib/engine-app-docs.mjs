// The engine delivers per-app instructions with a getApp tree. For a browser they read "prefer opening a new tab",
// and Haiku opened the tab in a call of its own in 12 of 42 openings (about 3.5 s each, b3 2026-10-18).
// One sentence appended to that block puts the one-call rule where the model reads it last.
export const TAB_URL_SENTENCE = 'Open the tab and send its URL in the same call.';

const BLOCK = /(<app_specific_instructions>\r?\n## Browser Computer Use\b[\s\S]*?)(\r?\n<\/app_specific_instructions>)/;

export function rewriteBrowserInstructions(text, trace = () => {}) {
  const m = BLOCK.exec(text);
  if (!m || m[1].includes(TAB_URL_SENTENCE)) return text;
  trace('browser-instructions', { status: 'rewritten' });
  return text.slice(0, m.index) + m[1].trimEnd() + ' ' + TAB_URL_SENTENCE + m[2] + text.slice(m.index + m[0].length);
}

// The native getState lists apps without windows, and 26 of 36 runs then called listWindows, listBrowsers or listTabs
// (8 paid a separate refused call, 1.0 to 1.5 s each).
export const WINDOWS_LINE = "Windows: a window's title is the `Window:` header of `cua.getApp(...)`'s tree; there is no listWindows or listBrowsers here.";
// That line arrives after the turn is spent. Engine-path browser tasks that name a window opened with getState in
// 37 of 58 race runs (2026-10-18), a mean 2.75 s turn, so SLEIGHT_TS3=1 says it in the js description, before call one.
export const FIRST_CALL_WINDOWS = "cua.getState() lists no windows: to find a window by its title, start with getApp and read the result's `Window:` header.";
const GETSTATE_SENTENCE = "Use cua.getState() only to find an app or browser you can't name. ";

// After the description's getState sentence, else after its first sentence.
export function withFirstCallWindows(text) {
  if (typeof text !== 'string' || text.includes(FIRST_CALL_WINDOWS)) return text;
  const at = text.includes(GETSTATE_SENTENCE) ? text.indexOf(GETSTATE_SENTENCE) + GETSTATE_SENTENCE.length : text.indexOf('. ') + 2;
  return at < 2 ? text : text.slice(0, at) + FIRST_CALL_WINDOWS + ' ' + text.slice(at);
}

export function isNativeGetState(code, result) {
  if (typeof code !== 'string' || !/(?<![\w$.])cua\s*\.\s*getState\s*\(/.test(code)) return false;
  if (!result || result.isError || result._meta?.['codex/toolSurface']?.kind === 'browserUse') return false;
  return (result.content ?? []).some(c => c.type === 'text' && /^\s*\{\s*"apps"\s*:/.test(c.text ?? ''));
}
