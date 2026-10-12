#!/usr/bin/env node
// Elicitation hook for the sleight arm of FowlBrowser's rounds (bench/fowl/rounds.sh). The engine asks before its
// browser extension first reaches a site. FowlBrowser has no such step, and the Codex arm in FowlBrowser's own runs
// passed the Wikipedia and MDN tasks, so those sites were allowed there. This accepts the same prompt for the rounds'
// sites, for the session only (sleight never sends "always"), and declines everything else, as FowlBrowser's own
// elicitation hook declines every prompt.
// The two browsers the rounds use, on the benchmark allowlist (LAWS).
const APPS = ['Google Chrome', 'Helium'];
const ORIGINS = ['http://127.0.0.1', 'https://en.wikipedia.org', 'https://developer.mozilla.org'];

export function answer(e) {
  const origin = /^Allow Browser use to access (\S+)\?$/.exec(e.message ?? '')?.[1];
  const site = origin && origin.replace(/:\d+$/, '');
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1];
  return e.mcp_server_name === 'plugin:sleight:computer' && (ORIGINS.includes(site) || APPS.includes(app)) ? 'accept' : 'decline';
}

if (import.meta.main) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const e = JSON.parse(input);
  if (process.env.FOWL_HOOK_LOG) (await import('node:fs')).appendFileSync(process.env.FOWL_HOOK_LOG, JSON.stringify({ message: e.message, server: e.mcp_server_name, action: answer(e) }) + '\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: answer(e), content: {} } }));
}
