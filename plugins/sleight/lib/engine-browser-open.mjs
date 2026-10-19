// browser_open on the engine path (SLEIGHT_BROWSER_CORE=1), for a browser turbo doesn't drive. Same name and fields as
// turbo's tool, so Claude learns one way to open a page. Every task in the Safari and Firefox race rounds (60 of 60,
// race-1017) spent a model turn on a lone getApp before its first tab, a median 3.6 to 4.1 s; this opens in one call.
// The relay runs it as two ordinary js calls (relay.mjs, engineOpen): the acquisition, then the keys, so every guard,
// lease and the tab continuation apply as they do to Claude's own js.
import { selectedTabShown, underDocument } from './menu-continuation.mjs';
import { hasIdentifier } from './document-scope.mjs';

const json = JSON.stringify;

export const engineBrowserOpen = (env = process.env) => env.SLEIGHT_BROWSER_CORE === '1';

const schema = { type: 'object', properties: { url: { type: 'string', maxLength: 2048 }, browser: { type: 'string', maxLength: 128 } },
  required: ['url', 'browser'], additionalProperties: false };
export const ENGINE_OPEN_TOOL = Object.freeze({ name: 'browser_open',
  description: 'First call for a web page in a named browser: opens the URL in a new tab in one call and returns the window (title, tabs, page tree) plus the js handle for the next actions. Use it instead of getApp when the task gives a URL.',
  inputSchema: schema });
export const LEAN_ENGINE_OPEN_DESCRIPTION = 'Open a URL in a new tab of a named browser in one call; returns the window\'s title, tabs, tree and js handle.';
export const BROWSER_OPEN_FIRST = 'For a web page in a named browser, call browser_open first; it returns the window.';
export function withBrowserOpenFirst(text) {
  if (typeof text !== 'string' || text.includes(BROWSER_OPEN_FIRST)) return text;
  const after = "Use cua.getState() only to find an app or browser you can't name.";
  if (text.includes(after)) return text.replace(after, after + ' ' + BROWSER_OPEN_FIRST);
  return text + ' ' + BROWSER_OPEN_FIRST;
}
export const engineOpenTool = prompt => prompt === 'lean' ? { ...ENGINE_OPEN_TOOL, description: LEAN_ENGINE_OPEN_DESCRIPTION } : { ...ENGINE_OPEN_TOOL };

// Turbo's own tool with one more sentence, and a browser field that takes any name: the relay routes by that name.
export function widenTurboOpen(tool, browser) {
  if (tool?.name !== 'browser_open') return tool;
  const { enum: _, ...field } = tool.inputSchema?.properties?.browser ?? { type: 'string' };
  return { ...tool, description: `${tool.description} Another browser app, by name, opens on the engine path in one call; act on it in js with the handle the result names. ${browser} is turbo's.`,
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, browser: field } } };
}

// Turbo's arguments when the call names turbo's browser (its value or its app's name) or none; undefined sends it to the engine.
export function turboRoute(args, turbo) {
  if (!turbo || !args || typeof args !== 'object') return undefined;
  if (args.browser === undefined) return args;
  const name = typeof args.browser === 'string' ? args.browser.trim().toLowerCase() : undefined;
  if (!name || ![turbo.browser, turbo.application].some(value => typeof value === 'string' && value.toLowerCase() === name)) return undefined;
  const { browser: _, ...rest } = args;
  return turbo.browser === undefined ? rest : { ...rest, browser: turbo.browser };
}

const fail = message => { throw new Error(`browser_open: ${message}`); };
// The URL is typed into the address field, so nothing but a plain http(s) URL may reach typeText: no whitespace, control
// or separator characters (a newline would be a second Return), no credentials, and the length turbo allows less a margin.
export function parseEngineOpen(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('needs { url, browser }.');
  const extra = Object.keys(args).find(key => !['url', 'browser'].includes(key));
  if (extra !== undefined) fail(`unknown field ${json(extra.slice(0, 40))}.`);
  const { url, browser } = args;
  if (typeof browser !== 'string' || !browser.trim() || browser.length > 128 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(browser)) fail('browser must name a browser app.');
  if (typeof url !== 'string' || url.length > 2048) fail('url must be an http(s) URL of at most 2,048 characters.');
  if (/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(url)) fail('url must not contain spaces or control characters.');
  // The address field reads the typed text, not the parsed URL: `https:host` or a backslash can turn it into a search or
  // another host than the one the site limits judged.
  if (!/^https?:\/\/[^/?#\\]/i.test(url) || url.includes('\\')) fail('url must start with http:// or https:// and a host, with no backslashes.');
  let parsed;
  try { parsed = new URL(url); } catch { fail('url must be an http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) fail('url must be an http(s) URL.');
  if (parsed.username || parsed.password) fail('url must not carry credentials.');
  return { url, browser };
}

// The destination for the user's site limits, as permissions.pageRefusal reads a page.
export const siteOf = url => { const parsed = new URL(url); return { host: parsed.host, scheme: parsed.protocol.slice(0, -1) }; };

export const acquisitionCode = (handle, browser) => `let ${handle} = await cua.getApp(${json(browser)});`;
// A compact same-window re-read can follow the full acquisition. Reuse that full block only when the last block
// explicitly says nothing changed and repeats its header. A changed window, sheet or partial diff stays fail-closed.
export function acquisitionTree(text) {
  const blocks = typeof text === 'string' ? text.match(/^Window: [^\n]*\n[\s\S]*?(?=^Window: |$(?![\s\S]))/gm) ?? [] : [];
  while (blocks.length > 1) {
    const last = blocks.at(-1), previous = blocks.at(-2);
    if (last.split('\n')[0] !== previous.split('\n')[0] || !/^0 standard window(?: |,|$)/m.test(last) || !last.includes('sleight: no change since the last full tree you saw for this window') ||
        [...last.matchAll(/^\t*\d+ /gm)].length !== 1) break;
    blocks.pop();
  }
  // A raw newline in page text can spell another Window header. Only the compact, identical-header suffix above
  // can be removed safely; a remaining second block leaves the acquisition ambiguous.
  return blocks.length === 1 ? blocks[0] : '';
}
// Values can contain raw newlines. A complete tree's numbered stream must reach the native menu bar after the
// window: a page's forged numbered lines collide with the engine's following entries. Only that complete stream
// lets us use chrome after content or a tab's Value. Without the native tail, retain the conservative prefix.
function browserEntries(text) {
  const entries = [...acquisitionTree(text).matchAll(/^(\t*)(\d+) (.*)$/gm)].map(([, depth, number, line]) => ({ depth: depth.length, number: Number(number), line }));
  // A forged prefix in a window title must not hide the real entries with the same numbers.
  if (entries.some((entry, i) => entry.number !== i)) return { entries, trusted: [] };
  const bar = entries.findIndex(entry => entry.depth === 0 && entry.line === 'menu bar');
  if (bar > 0 && entries[0].depth === 0 && entries.length > bar + 1 &&
      entries.slice(1, bar).every(entry => entry.depth > 0) && entries.slice(bar + 1).every(entry => entry.depth > 0)) {
    return { entries, trusted: entries.slice(0, bar) };
  }
  let payload = false;
  const trusted = [];
  for (const entry of entries) {
    if (payload || (entry.number > 0 && entry.depth === 0)) break;
    trusted.push(entry);
    payload = /^(?:HTML content|web area|document|text area|text entry area)(?: |,|$)/i.test(entry.line) ||
      /^text(?: |,|$)(?!field(?: |,|$))/i.test(entry.line) || /(?:^|[ ,])Value: /.test(entry.line);
  }
  return { entries, trusted };
}
function openRoute(text) {
  const { entries, trusted } = browserEntries(text);
  const chromeId = (id, role) => {
    const matches = entries.filter(entry => hasIdentifier(entry.line, id));
    if (matches.length !== 1) return false;
    // ID-looking text in a value is payload, even on a real chrome field. Never treat it as an AX identifier.
    if (entries.some(entry => {
      const value = /(?:^|[ ,])Value: /.exec(entry.line);
      return value && entry.line.slice(value.index).includes(id);
    })) return false;
    const at = trusted.indexOf(matches[0]);
    if (at < 0 || !role.test(matches[0].line) || underDocument(trusted, at)) return false;
    for (let i = at - 1, depth = matches[0].depth; i >= 0 && depth > 0; i--) {
      if (trusted[i].depth >= depth) continue;
      depth = trusted[i].depth;
      if (/^toolbar(?: |,|$)/.test(trusted[i].line)) return depth === 1;
    }
    return false;
  };
  const tree = trusted.map(e => '\t'.repeat(e.depth) + e.number + ' ' + e.line).join('\n');
  if (selectedTabShown(tree)) return 'keyboard';
  if (chromeId('NewTabButton', /^button(?: |,|$)/) && chromeId('WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD', /^text field(?: |,|$)/)) return 'toolbar';
  return undefined;
}
export const openCode = (handle, url, text) => {
  const route = openRoute(text);
  if (!route) fail('no safe new-tab route, so nothing was typed. Read the window with js.');
  return [...(route === 'toolbar' ? [`await ${handle}.click({ id: "NewTabButton" });`, `await ${handle}.setValue({ id: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }, ${json(url)});`]
    : [`await ${handle}.pressKey("super+t");`, `await ${handle}.typeText(${json(url)});`]),
    `await ${handle}.pressKey("Return");`, `await ${handle}.getAXState();`].join('\n');
};

export const openedNote = handle => `browser_open: the new tab is in the window below. In js, \`${handle}\` is its app handle (await ${handle}.click(N)).`;
export const notBrowserNote = app => `browser_open: ${app || 'that app'} isn't a web browser, so nothing was typed. Name a browser app.`;
export const unknownBrowserNote = app => `browser_open: sleight doesn't know yet whether ${app || 'that app'} is a web browser, so nothing was typed. Try again in a moment.`;
// Nobody has seen the window before the keys go, so the acquisition's own tree must show a browser window ready for a
// tab: a standard window root, a tab strip outside any page, and no sheet, dialog or alert, which Return could answer.
// A settings window has no tab strip. Undefined when it may take the keys, else the reason.
export function browserWindowProblem(text, app) {
  const { entries, trusted } = browserEntries(text);
  const name = app || 'the browser';
  if (!entries.length || entries[0].number !== 0) return `browser_open: ${name} shows no window, so nothing was typed.`;
  if (!/^standard window(?: |,|$)/.test(entries[0].line)) return `browser_open: ${name}'s front window isn't a standard window, so nothing was typed.`;
  if (entries.some(entry => /^(?:sheet|dialog|system dialog|alert)(?: |,|$)/.test(entry.line))) return `browser_open: ${name} has a sheet or dialog open, so nothing was typed. Read it with js.`;
  if (!trusted.some((entry, i) => /^tab group(?: |,|$)/.test(entry.line) && !underDocument(trusted, i))) return `browser_open: ${name}'s front window shows no tab strip, so nothing was typed.`;
  if (!openRoute(text)) return `browser_open: ${name} shows no safe new-tab route, so nothing was typed. Read the window with js.`;
  return undefined;
}
// js's own wording while a turn's tab cleanup runs.
export const CLEANUP_NOTE = 'Wait for turn_ended, tab cleanup is pending.';
export const DOCUMENT_SCOPE_NOTE = 'browser_open: not in document scope. Use js.';
// The wording leaseStop gives every call a Stop ended.
export const STOPPED_NOTE = 'Input lease: this call was stopped.';
