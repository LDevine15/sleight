// Claude in Chrome rounds only: press Allow on the extension's own permission prompt, for the round's sites only.
// Owner decision, docs/status/LAWS.md (2026-10-18). Without it every navigate in the arm returned "No response to the Claude in
// Chrome permission prompt before it timed out" (smoke 2026-10-17).
//
// The prompt is a small Chrome window the extension opens. A Swift helper (chrome-allow.swift) reads that window through
// Accessibility and presses a button by AX action, so nothing takes focus and the pointer stays where it is. This module holds
// the policy: which window counts as Claude's prompt, which hosts it may name, which button to press. Everything else is
// declined and logged. approvals.jsonl records site, button and time, never page text.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { swiftModuleCache } from '../swift-cache.mjs';

export const CLAUDE_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const SURFACE = 'claude-in-chrome';
export const DEFAULT_HOSTS = ['en.wikipedia.org', 'developer.mozilla.org'];
const LOCAL = new Set(['127.0.0.1', 'localhost']);

// The hosts a round may name: the defaults plus every host in a URL the round's tasks mention. A local host is allowed on the
// ports the tasks name (a URL without a port means 80), so another local service stays declined.
export function roundSites(tasks, { defaults = DEFAULT_HOSTS } = {}) {
  const hosts = new Set(defaults), ports = new Map([...LOCAL].map(host => [host, new Set()]));
  const visit = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?/gi)) {
        const host = match[1].toLowerCase().replace(/\.$/, '');
        if (LOCAL.has(host)) ports.get(host).add(Number(match[2] || 80));
        else hosts.add(host);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(tasks);
  return { hosts: [...hosts].sort(), ports: Object.fromEntries([...ports].map(([host, set]) => [host, [...set].sort((a, b) => a - b)])) };
}

// Hostnames, IPv4 literals and localhost named in prompt text, with a port when one is written. A full URL counts by its host
// alone, so a dot in its path is not read as another host.
export function hostsIn(text) {
  const found = [];
  const add = match => found.push({ host: match[1].toLowerCase(), port: match[2] ? Number(match[2]) : null });
  const name = '((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}|localhost|\\d{1,3}(?:\\.\\d{1,3}){3})(?::(\\d{2,5}))?';
  const bare = text.replace(new RegExp(`https?://${name}(?![a-z0-9-])(?:[/?#]\\S*)?`, 'gi'), (whole, host, port) => { add([whole, host, port]); return ' '; });
  for (const match of bare.matchAll(new RegExp(`(?<![a-z0-9._-])${name}(?![a-z0-9-])`, 'gi'))) add(match);
  return found;
}

function hostAllowed({ host, port }, sites) {
  if (LOCAL.has(host)) {
    const allowed = sites.ports[host] || [];
    return port === null ? allowed.length > 0 : allowed.includes(port);
  }
  return sites.hosts.includes(host) && (port === null || port === 443 || port === 80);
}

const walk = (node, visit, path = []) => {
  visit(node, path);
  (node.children || []).forEach((child, index) => walk(child, visit, [...path, index]));
};
const labelOf = node => node.title || node.desc || node.value || '';
const SMALL = { w: 700, h: 800 };
const MAX_DECLINES = 30;

// Does this window deserve a look? Cheap, from the window list alone. A normal browser window (it has a tab strip) never does.
export function isCandidate(window) {
  if (window.tabs) return false;
  return /claude/i.test(window.title || '') || (window.w > 0 && window.h > 0 && window.w <= SMALL.w && window.h <= SMALL.h);
}

// What the first live run should learn from: roles, subroles, identifiers and button labels. Text, links and values are
// reduced to their length, because a page can put anything in them.
export function skeleton(tree, limit = 120) {
  const rows = [];
  walk(tree, (node, path) => {
    if (rows.length >= limit) return;
    const row = { d: path.length, role: node.role };
    if (node.subrole) row.subrole = node.subrole;
    if (node.id) row.id = node.id.slice(0, 60);
    if (node.role === 'AXButton' && labelOf(node)) row.label = labelOf(node).slice(0, 80);
    else if (labelOf(node)) row.len = labelOf(node).length;
    if (node.url) { try { const url = new URL(node.url); row.url = url.protocol === 'chrome-extension:' ? `${url.protocol}//${url.host}` : url.protocol; } catch { row.url = 'unparsed'; } }
    rows.push(row);
  });
  return rows;
}

const ALWAYS_SCOPED = host => new RegExp(`\\b(?:always allow|allow always)\\b.*\\b(?:this (?:site|domain|website)|${host.replaceAll('.', '\\.')})\\b`, 'i');
const WIDE = /\b(?:all|every|any)\b/i;
const ONCE = /^allow(?: once| this time)?$/i;

// The decision for one window. `window` is the helper's window row, `tree` its AX tree. Returns
//   { action: 'press', path, label, site, basis }  or  { action: 'decline', reason, ... }.
// Anything the function cannot place with certainty is a decline.
export function judge(window, tree, sites) {
  const areas = [], buttons = [], texts = [];
  let inputs = 0;
  walk(tree, (node, path) => {
    if (node.role === 'AXWebArea') areas.push(node);
    else if (node.role === 'AXButton') buttons.push({ node, path });
    else if (['AXTextField', 'AXTextArea', 'AXSecureTextField', 'AXComboBox'].includes(node.role)) inputs++;
    else if (labelOf(node)) texts.push(labelOf(node));
  });
  const urls = areas.map(area => area.url).filter(Boolean);
  let basis;
  if (urls.length) {
    if (!urls.every(url => url.startsWith(`chrome-extension://${CLAUDE_EXTENSION_ID}/`))) return { action: 'decline', reason: 'not-claude-extension', claude: false };
    basis = 'extension-url';
  } else if (/^claude\b/i.test(window.title || '') && !window.tabs) basis = 'title';
  else return { action: 'decline', reason: 'not-claude', claude: false };
  if (inputs) return { action: 'decline', reason: 'prompt-has-input', claude: true, basis };
  const named = texts.flatMap(hostsIn);
  const unlisted = named.filter(entry => !hostAllowed(entry, sites));
  if (!named.length) return { action: 'decline', reason: 'no-site-in-prompt', claude: true, basis };
  if (unlisted.length) return { action: 'decline', reason: 'unlisted-site', claude: true, basis, sites: [...new Set(unlisted.map(entry => entry.host))] };
  const site = [...new Set(named.map(entry => entry.host + (entry.port ? ':' + entry.port : '')))].join(',');
  const usable = buttons.filter(({ node }) => node.enabled !== false && labelOf(node));
  const hosts = [...new Set(named.map(entry => entry.host))];
  const scoped = usable.filter(({ node }) => !WIDE.test(labelOf(node)) && hosts.length === 1 && ALWAYS_SCOPED(hosts[0]).test(labelOf(node)));
  const once = usable.filter(({ node }) => ONCE.test(labelOf(node).trim()));
  const pick = scoped.length === 1 ? scoped : once.length === 1 ? once : null;
  if (!pick) return { action: 'decline', reason: usable.length ? 'no-unique-allow-button' : 'no-button', claude: true, basis, site };
  return { action: 'press', path: pick[0].path, label: labelOf(pick[0].node), site, basis };
}

const execFileAsync = promisify(execFile);
async function compileHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-chrome-allow-'));
  try {
    const binary = join(dir, 'chrome-allow');
    await execFileAsync('/usr/bin/swiftc', ['-module-cache-path', swiftModuleCache(), fileURLToPath(new URL('./chrome-allow.swift', import.meta.url)), '-o', binary], { timeout: 120000 });
    return { binary, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

// The real adapter: one helper process per call, killed when the watcher stops.
function helperAdapter(binary, live) {
  const call = async args => {
    const child = execFileAsync(binary, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    live.add(child.child);
    try {
      const reply = JSON.parse((await child).stdout);
      if (!reply.ok) throw Error(reply.error);
      return reply;
    } finally { live.delete(child.child); }
  };
  return {
    windows: async pid => (await call(['windows', String(pid)])).windows,
    tree: async (pid, window) => (await call(['tree', String(pid), String(window.index), window.title])).tree,
    press: async (pid, window, path, label) => call(['press', String(pid), String(window.index), window.title, path.join(','), label]),
  };
}

// The watcher. `adapter` is injectable for tests; `pid` is the harness-launched Chrome and nothing else.
export function watchChromePrompts({ pid, sites, file, adapter, now = Date.now, intervalMs = 400, cooldownMs = 1500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('chrome-allow needs the round\'s Chrome pid');
  const write = entry => appendFileSync(file, JSON.stringify({ t: now(), at: new Date(now()).toISOString(), ...entry }) + '\n');
  const seen = new Map(), counts = { allowed: 0, declined: 0, errors: 0 };
  let stopped = false, lastPress = -Infinity, lastError;
  write({ kind: 'started', pid, sites });
  const poll = async () => {
    const windows = await adapter.windows(pid);
    const present = new Set();
    for (const window of windows) {
      if (!isCandidate(window)) continue;
      const key = `${window.index}:${window.title}`;
      present.add(key);
      const tree = await adapter.tree(pid, window);
      if (stopped) return;
      const verdict = judge(window, tree, sites);
      const signature = verdict.action === 'press' ? `press:${verdict.label}:${verdict.site}` : `${verdict.reason}:${verdict.sites || ''}:${JSON.stringify(skeleton(tree, 40))}`;
      const previous = seen.get(key);
      if (verdict.action === 'press') {
        if (now() - lastPress < cooldownMs || (previous?.signature === signature && previous.tries >= 3)) continue;
        seen.set(key, { signature, tries: previous?.signature === signature ? previous.tries + 1 : 1 });
        const result = await adapter.press(pid, window, verdict.path, verdict.label).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
        if (result.ok) { lastPress = now(); counts.allowed++; write({ kind: 'allow', site: verdict.site, button: verdict.label, basis: verdict.basis }); }
        else { counts.errors++; write({ kind: 'error', site: verdict.site, button: verdict.label, message: result.error }); }
      } else if (previous?.signature !== signature) {
        seen.set(key, { signature, tries: 0 });
        counts.declined++;
        // Every declined candidate logs its skeleton, so one live run shows the prompt's real shape.
        if (counts.declined > MAX_DECLINES) { if (counts.declined === MAX_DECLINES + 1) write({ kind: 'decline-log-capped', limit: MAX_DECLINES }); continue; }
        write({ kind: 'decline', reason: verdict.reason, ...(verdict.sites ? { sites: verdict.sites } : {}), ...(verdict.site ? { site: verdict.site } : {}),
          size: [window.w, window.h], skeleton: skeleton(tree) });
      }
    }
    for (const key of seen.keys()) if (!present.has(key)) seen.delete(key);
  };
  const loop = (async () => {
    while (!stopped) {
      try { await poll(); lastError = undefined; }
      catch (error) {
        if (!stopped && error.message !== lastError) { lastError = error.message; counts.errors++; write({ kind: 'error', message: error.message }); }
      }
      if (!stopped) await sleep(intervalMs);
    }
  })();
  return { counts, stop: async () => {
    if (stopped) return; stopped = true;
    await loop.catch(() => {});
    write({ kind: 'stopped', ...counts });
  } };
}

// Wiring for a round. Null unless the round is Claude in Chrome in Chrome; a compile or startup failure is logged and the round
// goes on without the watcher (the prompts then time out exactly as before).
export async function startRoundAllow(plan, browser, { out = plan.out, compile = compileHelper, watch = watchChromePrompts, ...options } = {}) {
  if (plan.surface !== SURFACE || browser?.browser !== 'chrome') return null;
  const file = join(out, 'approvals.jsonl'), sites = roundSites(plan.arms.map(arm => arm.task));
  const live = new Set();
  let helper;
  try { helper = options.adapter ? null : await compile(); }
  catch (error) {
    appendFileSync(file, JSON.stringify({ t: Date.now(), kind: 'error', message: `chrome-allow helper unavailable: ${error.message}` }) + '\n');
    console.error(`Claude in Chrome prompts will not be answered: ${error.message}`);
    return null;
  }
  const watcher = watch({ pid: browser.pid, sites, file, adapter: options.adapter || helperAdapter(helper.binary, live), ...options });
  return { sites, file, stop: async () => {
    try {
      const stopping = watcher.stop();
      for (const child of live) child.kill('SIGKILL');
      await stopping;
    } finally { helper?.cleanup(); }
  } };
}

// What a dry run shows.
export function allowPlan(plan) {
  return plan.surface === SURFACE ? { enabled: true, file: join(plan.out, 'approvals.jsonl'), sites: roundSites(plan.arms.map(arm => arm.task)) } : { enabled: false };
}
