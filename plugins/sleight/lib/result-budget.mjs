// Claude Code saves a tool result over about 50 KB to a file and shows Claude a 2 KB preview (the smallest
// spilled result was 52.2 KB, 2026-10-12). A first call that picks a browser and opens a tab gets the
// engine's general docs, its browser docs, sleight's skill and the page, about 56 KB, and in 32 of 39
// benchmark runs Claude started without any of it. This keeps results under RESULT_LIMIT: on macOS it drops
// the engine's Linux- and Windows-only paragraphs, and if the result is still too big it moves the browser
// API reference to the start of the next result. Safety and confirmation sections never move.
import { trimBrowserResults } from './browser-read-cap.mjs';

export const RESULT_LIMIT = 45000;

const GENERAL_DOCS = /^## Computer Use\n/;
const BROWSER_DOCS = /^# Other Browser APIs\n/;
const POLICY = '\n# Computer Use Confirmations Policy';
const REFERENCE = '\n# API Reference\n';
const OTHER_PLATFORM = /\b(?:Linux|Windows)\b/;
const NATIVE_REFERENCE = /\bsleight\.nativeDocumentation\s*\(/;
const POLICY_REFERENCE = /\bcua(?:\.rewriteDocumentation|\[\s*(['"])rewriteDocumentation\1\s*\])\s*\(/;
export const requestsFullDocumentation = (code = '') => POLICY_REFERENCE.test(code);
const NATIVE_NOTICE = 'sleight: Read the native reference with `nodeRepl.write("Full native reference:\\n" + await sleight.nativeDocumentation())` when needed. It documents `cua.getTab`, `cua.listTabs`, `cua.getState`, `cua.getApp` and the rest.';

function dropOtherPlatforms(text) {
  const cut = text.indexOf(POLICY);
  const head = cut < 0 ? text : text.slice(0, cut);
  const kept = head.split('\n\n').filter((p) => !OTHER_PLATFORM.test(p) || /\bmacOS\b/.test(p)).join('\n\n');
  return cut < 0 ? kept : kept + text.slice(cut);
}

// Engine docs are 81% of what sleight's results send Claude (571,870 of 705,611 characters over 13 runs, 2026-10-12),
// and every later call reads them again. Across 3,483 calls Claude wrote that day it never used these reference types,
// so they're left out; their members stay, so a fetch through the engine's own docs still finds them.
const UNUSED_TYPES = /^(?:BrowserHistory\w*|TabDev\w*|TabClipboardAPI|TabClipboardItem|ContentAPI|BrowserUser\w*|PlaywrightFileChooser)$/;
// Standard Playwright methods keep their signatures and lose the comment, which repeats Playwright's own docs. Every
// other comment stays, since some carry the engine's own limits (read-only evaluate, timeouts).
const STANDARD = new Set(['all', 'allTextContents', 'and', 'blur', 'boundingBox', 'check', 'clear', 'click', 'count', 'dblclick',
  'fill', 'filter', 'first', 'focus', 'getAttribute', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId',
  'getByText', 'getByTitle', 'hover', 'innerHTML', 'innerText', 'inputValue', 'isChecked', 'isDisabled', 'isEditable', 'isEnabled',
  'isHidden', 'isVisible', 'last', 'locator', 'nth', 'or', 'press', 'pressSequentially', 'scrollIntoViewIfNeeded', 'selectOption',
  'setChecked', 'textContent', 'type', 'uncheck', 'waitFor']);

function trimReference(text) {
  return text.replace(/\n(?:interface|type) (\w+)[^\n]*\{[\s\S]*?\n\};?\n?/g, (block, name) => {
    if (UNUSED_TYPES.test(name)) return '\n';
    if (!name.startsWith('Playwright')) return block;
    return block.replace(/^( {2}(\w+)(?:<[^>]*>)?\([^\n]*?;) \/\/ [^\n]*$/gm, (line, kept, method) => (STANDARD.has(method) ? kept : line));
  });
}

const ENGINE_LIMIT = /read[- ]only|timeout|maximum time|must\b|\bonly\b|\bnever\b|\bcannot\b|\bunsupported\b|\bnot supported\b|\bbefore\b|\brequir(?:e|es|ed)\b/i;

function leanReference(text, minimal = false) {
  const at = text.indexOf(REFERENCE) + REFERENCE.length;
  const rest = text.slice(at);
  const block = /^```(?:ts|typescript)\n([\s\S]*?)^```[ \t]*$/m.exec(rest);
  if (!block || /\n# /.test(rest.slice(0, block.index))) return text;
  // Keep quoted strings intact, and retain complete comments that carry engine restrictions.
  const limits = [];
  const index = block[1].replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (part, quoted, comment) => {
      if (quoted) return quoted;
      if (!ENGINE_LIMIT.test(comment)) return '';
      limits.push(comment.replace(/^\/\/\s*|^\/\*\*?\s*|\s*\*\/$/g, '').replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim());
      return comment;
    })
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  const topicCall = /# Additional Documentation\n[\s\S]*?`(await agent\.documentation\.get\("<name>"\))`/.exec(text)?.[1];
  const fullCall = /\bdocumentation\(\): Promise<string>/.test(block[1])
    ? 'On your `cua.getBrowser(...)` handle (here `b`), read the full reference with `nodeRepl.write("Full browser reference:\\n" + await b.documentation())`.'
    : 'Use SLEIGHT_ENGINE_DOCS=full for the full reference.';
  const notice = `${fullCall}${topicCall ? ` Topic documentation: \`${topicCall}\`.` : ''}`;
  if (minimal) return text.slice(0, at) + `\n${notice}\n\n` + limits.map(line => `- ${line}`).join('\n') + '\n' +
    rest.slice(block.index + block[0].length);
  return text.slice(0, at) + `\n${notice}\n\n` + rest.slice(0, block.index) +
    block[0].replace(block[1], index) + rest.slice(block.index + block[0].length);
}

const size = (content) => content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
// Claude Code measures the serialized result, where each tab and newline is two characters (`\t`, `\n`). A tab-heavy
// tree of 44,967 characters serialized to 52.5 KB (2026-10-17), over the 52.2 KB spill, so trees are trimmed on both.
const wire = (text) => Buffer.byteLength(JSON.stringify(text)) - 2;
const wireSize = (content) => content.reduce((n, c) => n + (c.type === 'text' ? wire(c.text) : 0), 0);
const WIRE_MARGIN = 2500;

// A tree block runs from its header to the next `Window:` header or focus line. Firefox's tab strip puts bare `Close tab`
// lines among the numbered rows, so continuation lines can't be required to start with tabs and a number. A blank line
// inside the tree ends nothing when an indented row follows: MDN's tree has one after its answer (2026-10-18), which cut the
// match to a quarter of the page.
const TREE = /^(?:Window: |Browser tab: )[^\n]+\n(?:[+~-] )?\d+ [^\n]*(?:\n(?!Window: |Browser tab: |The focused UI element)[^\n]+|\n(?=\n+(?:[+~-] )?\t+\d+ ))*/gm;

// A one-line item is a tree row that arrived as its own content item (a continued call's head, 381 items), which no
// regex over one item can see as a tree. Runs of them behind a one-line header are joined so they trim like any tree.
const ROW_ITEM = /^$|^(?:[+~-] )?\t*\d+ |^\t|^Close tab$|^The focused UI element/;
const lineItem = c => c?.type === 'text' && typeof c.text === 'string' && !c.text.includes('\n') && ROW_ITEM.test(c.text);
function joinTreeItems(content) {
  const out = [];
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c?.type !== 'text' || !/^(?:Window: |Browser tab: )[^\n]+$/.test(c.text ?? '') || !lineItem(content[i + 1])) { out.push(c); continue; }
    const lines = [c.text];
    while (lineItem(content[i + 1])) { lines.push(content[++i].text); if (content[i].text.startsWith('The focused UI element')) break; }
    out.push({ ...c, text: lines.join('\n') });
  }
  return out;
}

// Trees are trimmed oldest first, from their last row, so the final page (the one Claude asked for, with its answer near
// the top) is cut last and keeps its head. `force` returns the shortest result the trees allow when the limit is out of
// reach, since a result Claude Code rejects (126,517 characters, 2026-10-18) costs a whole re-read.
function trimResultTrees(content, limit, force = false) {
  let excess = size(content) - limit, wireExcess = wireSize(content) - (limit + WIRE_MARGIN);
  if (excess <= 0 && wireExcess <= 0) return content;
  const joined = joinTreeItems(content);
  const out = joined.map(c => {
    if ((excess <= 0 && wireExcess <= 0) || c.type !== 'text' || /^(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/.test(c.text)) return c;
    const text = c.text.replace(TREE, tree => {
      if (excess <= 0 && wireExcess <= 0) return tree;
      const lines = tree.split('\n'), total = lines.length;
      const note = () => `\nsleight: ${total - lines.length} tree lines omitted to keep the result and engine docs within the size limit. Use a filtered read for missing information.`;
      let gone = 0, goneWire = 0;
      const short = () => { const n = note(); return gone - n.length < excess || goneWire - wire(n) < wireExcess; };
      while (lines.length > 2 && short()) { const line = lines.pop(); gone += line.length + 1; goneWire += wire(line) + 2; }
      const out = lines.join('\n') + note();
      excess -= tree.length - out.length;
      wireExcess -= wire(tree) - wire(out);
      return out;
    });
    return text === c.text ? c : { ...c, text };
  });
  return excess > 0 || wireExcess > 0 ? (force ? out : content) : out;
}

export function createResultBudget({ platform = process.platform, limit = RESULT_LIMIT, fullDocs = process.env.SLEIGHT_ENGINE_DOCS === 'full',
  leanDocs = process.env.SLEIGHT_ENGINE_DOCS === 'lean', minDocs = process.env.SLEIGHT_ENGINE_DOCS === 'min' } = {}) {
  let pending = null;
  let browserFirst, nativeDocs, nativeDelivered = false;
  const requests = new Map();
  return {
    request(id, { browser, code = '' }) {
      browserFirst ??= browser;
      requests.set(id, { browser, reference: NATIVE_REFERENCE.test(code) });
    },
    finish(id) { requests.delete(id); },
    code(code) {
      if (!nativeDocs || !NATIVE_REFERENCE.test(code)) return code;
      return `globalThis.sleight ??= {}; globalThis.sleight.nativeDocumentation = async () => ${JSON.stringify(nativeDocs)};\n` + code;
    },
    apply(content, { id, native = false } = {}) {
      let out = content.map((c) => (platform === 'darwin' && c.type === 'text' && GENERAL_DOCS.test(c.text)
        ? { ...c, text: dropOtherPlatforms(c.text) } : c));
      if (browserFirst && !fullDocs) {
        const request = requests.get(id);
        const nativeCall = request && (native || !request.browser) && !request.reference;
        if (nativeCall && !nativeDelivered && nativeDocs && !out.some(c => c.type === 'text' && GENERAL_DOCS.test(c.text))) {
          out = [{ type: 'text', text: nativeDocs }, ...out];
        }
        const deliver = (nativeCall && !nativeDelivered) || request?.reference;
        out = out.map(c => {
          if (c.type !== 'text' || !GENERAL_DOCS.test(c.text)) return c;
          const policy = c.text.indexOf(POLICY);
          if (policy < 0) return c;
          nativeDocs = c.text;
          if (deliver) { nativeDelivered = true; return c; }
          return { ...c, text: (nativeDelivered ? '' : NATIVE_NOTICE + '\n') + c.text.slice(policy + 1) };
        });
        if (request?.reference && nativeDocs && out.some(c => c.type === 'text' && c.text.includes(nativeDocs))) nativeDelivered = true;
      }
      if (!fullDocs) out = out.map((c) => (c.type === 'text' && BROWSER_DOCS.test(c.text) && c.text.includes(REFERENCE)
        ? { ...c, text: minDocs || leanDocs ? leanReference(c.text, minDocs) : trimReference(c.text) } : c));
      if (pending) { out = [{ type: 'text', text: pending }, ...out]; pending = null; }
      // Spend the tree's rows before delaying reference text; policy and caller prose stay whole.
      // With no reference to delay, the trees are all there is to give.
      const deferrable = out.some(c => c.type === 'text' && BROWSER_DOCS.test(c.text) && c.text.includes(REFERENCE));
      out = trimResultTrees(trimBrowserResults(out, '', { limit, countDocs: true }), limit, !deferrable);
      if (size(out) <= limit) return out;
      out = out.map((c) => {
        if (pending || c.type !== 'text' || !BROWSER_DOCS.test(c.text)) return c;
        const at = c.text.indexOf(REFERENCE);
        if (at < 0) return c;
        pending = c.text.slice(at + 1);
        return { ...c, text: `${c.text.slice(0, at)}\n\nsleight: the browser API reference (${pending.length} characters) follows at the start of your next result, to keep this one under Claude Code's size limit. Until then, use only the methods named above.` };
      });
      return trimResultTrees(trimBrowserResults(out, '', { limit, countDocs: true }), limit, true);
    },
  };
}
