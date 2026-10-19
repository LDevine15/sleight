#!/usr/bin/env node
// Elicitation hook for the sleight arm of FowlBrowser's rounds (bench/fowl/rounds.sh). The engine asks before its
// browser extension first reaches a site. FowlBrowser has no such step, and the Codex arm in FowlBrowser's own runs
// passed the Wikipedia and MDN tasks, so those sites were allowed there. This accepts the same prompt for the rounds'
// sites, for the session only (sleight never sends "always"), and declines everything else, as FowlBrowser's own
// elicitation hook declines every prompt.
// Browsers the h2h rounds use, plus the hand-off tasks' native apps, all on the benchmark allowlist (LAWS).
const APPS = ['Google Chrome', 'Helium', 'Firefox', 'Safari', 'Preview', 'TextEdit'];
const ORIGINS = ['https://en.wikipedia.org', 'https://developer.mozilla.org'];

// The benchmark's own pages on 127.0.0.1 (LAWS: extension access to them is approved) also get downloads: the hand-off
// invoice download was declined on 2026-10-12. Raw CDP stays declined everywhere, as in every earlier round.

// FowlBrowser's demo serves each site on its port and the next (the DemoID pop-up on 5421, the card frame on 5414).
const LOCAL_PORTS = ['5411', '5412', '5413', '5414', '5420', '5421', '5431', '5432'];

// The real-window gate (real-gate-setup.mjs) sets FOWL_GATE_WINDOW to {"apps": [...], "title": marker} for the Firefox and
// Safari sleight arms. Window selection in that browser is then accepted, and gateWindowCheck (the PreToolUse half) lets
// select_window through only for the gate's exact marker title. The marker carries the round's UUID, so only the owned
// process has it, and select_window itself refuses when two processes share the app. Unset, nothing changes.
export function gateWindow(env = process.env) {
  try {
    const gate = JSON.parse(env.FOWL_GATE_WINDOW ?? 'null');
    return gate && Array.isArray(gate.apps) && gate.apps.length && gate.apps.every(a => typeof a === 'string' && a) &&
      typeof gate.title === 'string' && /^Sleight Gate [\w-]{8,}$/.test(gate.title) ? gate : null;
  } catch { return null; }
}
export function gateWindowCheck(e, env = process.env) {
  if (!/(^|__)select_window$/.test(e.tool_name ?? '')) return null;
  const gate = gateWindow(env), input = e.tool_input ?? {};
  const keys = Object.keys(input).filter(k => input[k] !== undefined);
  // A Safari profile puts its name before the title: "<profile> — Sleight Gate <uuid>".
  const title = typeof input.title === 'string' ? input.title : '';
  const owned = title === gate?.title || (!!gate && title.endsWith(' — ' + gate.title) && /^[^—]*\S — /.test(title) && title.indexOf(' — ') === title.length - gate.title.length - 3);
  if (gate && gate.apps.includes(input.app) && owned && keys.every(k => ['app', 'title'].includes(k))) return null;
  return `Benchmark: select_window is allowed only for the gate's own window, app ${gate ? gate.apps[0] : '(none)'} with the exact title ` +
    `"${gate ? gate.title : '(none)'}" (or "<profile> — ${gate ? gate.title : '(none)'}"). Its title changes once a page loads; cua.getApp on the browser then addresses the same window.`;
}

export function answer(e, env = process.env) {
  const message = e.message ?? '';
  const origin = /^Allow Browser use to access (\S+)\?$/.exec(message)?.[1];
  const site = origin && origin.replace(/:\d+$/, '');
  // The whole message must be one of these forms, on one of the rounds' own servers, with no credentials. The engine's
  // download prompt reads "Allow download from <url>?" (the hand-off invoice, 2026-10-12 18:40 UTC).
  const url = /^Allow (?:Browser use to (?:access|download files from)|download from) (https?:\/\/[^\s?]+)\?$/.exec(message)?.[1];
  let local = false;
  try {
    const u = url && new URL(url);
    local = !!u && u.hostname === '127.0.0.1' && LOCAL_PORTS.includes(u.port) && !u.username && !u.password;
  } catch {}
  if (/\bCDP\b|devtools/i.test(message)) return 'decline';
  if (e.mcp_server_name === 'plugin:sleight:computer' && local) return 'accept';
  const selecting = /^Allow Claude to select a window in (.+)\? It changes the app's main window without activating the app\.$/.exec(message)?.[1];
  if (selecting) return e.mcp_server_name === 'plugin:sleight:computer' && gateWindow(env)?.apps.includes(selecting) ? 'accept' : 'decline';
  // The owner allowed sleight's drag in the gate's own browser during away rounds, as the native claim runs allow it (2026-10-17).
  const dragging = /^Allow Claude to drag in (.+?)\?/.exec(message)?.[1];
  if (dragging) return e.mcp_server_name === 'plugin:sleight:computer' && gateWindow(env)?.apps.includes(dragging) ? 'accept' : 'decline';
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1];
  return e.mcp_server_name === 'plugin:sleight:computer' && (ORIGINS.includes(site) || APPS.includes(app)) ? 'accept' : 'decline';
}

if (import.meta.main) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const e = JSON.parse(input);
  if (e.hook_event_name === 'PreToolUse') {
    const reason = gateWindowCheck(e);
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  } else {
    // Every declined prompt is logged next to the run, so a new prompt shows up in the report.
    if (answer(e) === 'decline') (await import('node:fs')).appendFileSync('/tmp/fb-rounds/declined-prompts.jsonl', JSON.stringify({ t: new Date().toISOString(), message: e.message, server: e.mcp_server_name }) + '\n');
    if (process.env.FOWL_HOOK_LOG) (await import('node:fs')).appendFileSync(process.env.FOWL_HOOK_LOG, JSON.stringify({ message: e.message, server: e.mcp_server_name, action: answer(e) }) + '\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: answer(e), content: {} } }));
  }
}
