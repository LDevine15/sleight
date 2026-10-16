#!/usr/bin/env node
// Bench-only PreToolUse hook for the turbo arm. The arm's browser is an owned
// headless Chromium, while the engine path beside it reaches the user's real
// browsers, with the user's own approvals (2026-10-15: a Haiku agent launched
// the owner's Chrome to the front this way). Engine calls that name a browser
// are refused and pointed at the turbo tools; every other engine call passes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const browserCall = /\b(listBrowsers|getBrowser|createBrowserTab|getTab|listTabs|chrome|chromium|helium|safari|firefox|brave|arc|edge|opera|vivaldi)\b/i;
export function decide(input, browser = 'bbench') {
  if (input?.tool_name !== 'mcp__plugin_sleight_computer__js' || !browserCall.test(String(input.tool_input?.code ?? ''))) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `In this benchmark, the task's browser is turbo's ${browser}. Use the mcp__sleight-turbo__browser_* tools for web pages; ` +
      'engine calls that reach real browsers are off here.' } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let decision = null;
  try { decision = decide(JSON.parse(readFileSync(0, 'utf8')), process.argv[2]); }
  catch { decision = decide({ tool_name: 'mcp__plugin_sleight_computer__js', tool_input: { code: 'chrome' } }, process.argv[2]); }
  if (decision) process.stdout.write(JSON.stringify(decision));
}
