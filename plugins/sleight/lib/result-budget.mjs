// Claude Code saves a tool result over about 50 KB to a file and shows Claude a 2 KB preview (the smallest
// spilled result was 52.2 KB, 2026-10-12). A first call that picks a browser and opens a tab gets the
// engine's general docs, its browser docs, sleight's skill and the page, about 56 KB, and in 32 of 39
// benchmark runs Claude started without any of it. This keeps results under RESULT_LIMIT: on macOS it drops
// the engine's Linux- and Windows-only paragraphs, and if the result is still too big it moves the browser
// API reference to the start of the next result. Safety and confirmation sections never move.
export const RESULT_LIMIT = 45000;

const GENERAL_DOCS = /^## Computer Use\n/;
const BROWSER_DOCS = /^# Other Browser APIs\n/;
const POLICY = '\n# Computer Use Confirmations Policy';
const REFERENCE = '\n# API Reference\n';
const OTHER_PLATFORM = /\b(?:Linux|Windows)\b/;

function dropOtherPlatforms(text) {
  const cut = text.indexOf(POLICY);
  const head = cut < 0 ? text : text.slice(0, cut);
  const kept = head.split('\n\n').filter((p) => !OTHER_PLATFORM.test(p) || /\bmacOS\b/.test(p)).join('\n\n');
  return cut < 0 ? kept : kept + text.slice(cut);
}

const size = (content) => content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);

export function createResultBudget({ platform = process.platform, limit = RESULT_LIMIT } = {}) {
  let pending = null;
  return {
    apply(content) {
      let out = content.map((c) => (platform === 'darwin' && c.type === 'text' && GENERAL_DOCS.test(c.text)
        ? { ...c, text: dropOtherPlatforms(c.text) } : c));
      if (pending) { out = [{ type: 'text', text: pending }, ...out]; pending = null; }
      if (size(out) <= limit) return out;
      return out.map((c) => {
        if (pending || c.type !== 'text' || !BROWSER_DOCS.test(c.text)) return c;
        const at = c.text.indexOf(REFERENCE);
        if (at < 0) return c;
        pending = c.text.slice(at + 1);
        return { ...c, text: `${c.text.slice(0, at)}\n\nsleight: the browser API reference (${pending.length} characters) follows at the start of your next result, to keep this one under Claude Code's size limit. Until then, use only the methods named above.` };
      });
    },
  };
}
