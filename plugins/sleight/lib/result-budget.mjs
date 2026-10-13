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
      if (size(out) <= limit) return trimBrowserResults(out, '', { limit, countDocs: true });
      out = out.map((c) => {
        if (pending || c.type !== 'text' || !BROWSER_DOCS.test(c.text)) return c;
        const at = c.text.indexOf(REFERENCE);
        if (at < 0) return c;
        pending = c.text.slice(at + 1);
        return { ...c, text: `${c.text.slice(0, at)}\n\nsleight: the browser API reference (${pending.length} characters) follows at the start of your next result, to keep this one under Claude Code's size limit. Until then, use only the methods named above.` };
      });
      return trimBrowserResults(out, '', { limit, countDocs: true });
    },
  };
}
