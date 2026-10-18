#!/usr/bin/env node
// The benchmark's stand-in for Claude Code's hooks when sleight runs inside Codex (LAWS, 2026-10-18). `codex exec` cannot
// show or answer an MCP form, and sleight's native panel would need a click. This stdio proxy sits between Codex and
// sleight-mcp for the benchmark arms codex-sleight and codex-sleight-sol only:
//
//   Codex  <->  this proxy  <->  plugins/sleight/bin/sleight-mcp
//
// It does what the Claude-hosted sleight arms' hooks do, with the same decision code and the same allowlists:
//  - It adds form elicitation to the client capabilities on `initialize`, so sleight forwards the engine's app, browser and
//    local-tool approvals as forms instead of opening its panel. The arms also set SLEIGHT_APPROVAL_PROMPT=client, so a
//    panel cannot open even if this step failed: sleight would cancel instead.
//  - It answers each `elicitation/create` itself: --policy race uses bench/fowl/origin-hook.mjs (the race's elicitation
//    hook), --policy bench uses bench/approve.mjs (the claim and world suites' hook). Anything outside those lists is
//    declined. The answer never carries `remember`, the one field sleight turns into "Always allow" in the owner's
//    ~/Library/Application Support/sleight/preapproved.json, so that file is never written. Codex sees none of it.
//  - --gate-window and --turbo-guard are the PreToolUse hooks of the same arms (origin-hook.mjs gateWindowCheck and
//    turbo/engine-browser-guard.mjs): a refused call gets an error result with the hook's reason and never reaches sleight.
// Every decision is appended to --log (approvals.jsonl in the run's folder). Nothing here reads or writes the owner's configuration.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// The server name the hooks compare against (Claude Code's name for sleight's plugin server).
export const HOOK_SERVER = 'plugin:sleight:computer';

// sleight words its local-tool prompts for the host it runs under ("Allow Codex Mcp Client to drag in ..."). The hooks match
// the Claude wording, so the host's name goes back to "Claude" before they see the message. The log keeps the original.
export function normalizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/^Allow (?!Claude\b|Computer Use\b|Browser use\b|download\b)([^"?]+?) to (drag|hover|open files|select a window) in /, 'Allow Claude to $2 in ')
    .replace(/^Allow (?!Claude\b|Computer Use\b|Browser use\b|download\b)([^"?]+?) to use (.+)'s menu bar item\?$/, "Allow Claude to use $2's menu bar item?");
}

// What an accepted form carries: the one required choice when the schema asks for it, never `remember`.
export function acceptedContent(schema) {
  const choices = schema?.properties?.choice?.enum ?? [];
  return choices.length ? { choice: choices.includes('session') ? 'session' : choices.includes('once') ? 'once' : choices[0] } : {};
}

// One elicitation/create request's answer, from the policy's own hook code. Unknown policies and unlisted prompts decline.
export async function answerElicitation(params, { policy, env = process.env, hooks = {} } = {}) {
  const message = normalizeMessage(params?.message);
  const event = { message, mcp_server_name: HOOK_SERVER, mode: params?.mode, requested_schema: params?.requestedSchema };
  if (params?.mode === 'url') return { action: 'decline', message };
  if (policy === 'race') {
    const { answer } = hooks.race ?? await import('./fowl/origin-hook.mjs');
    return answer(event, env) === 'accept' ? { action: 'accept', content: acceptedContent(params?.requestedSchema), message } : { action: 'decline', message };
  }
  if (policy === 'bench') {
    const { benchmarkDecision } = hooks.bench ?? await import('./approve.mjs');
    const output = benchmarkDecision(event, env)?.hookSpecificOutput;
    return output?.action === 'accept' ? { action: 'accept', content: acceptedContent(params?.requestedSchema), message } : { action: 'decline', message };
  }
  return { action: 'decline', message };
}

// The PreToolUse halves: a reason string when the call must not reach sleight.
export async function guardReason(name, args, { gateWindow = false, turboBrowser, env = process.env, hooks = {} } = {}) {
  if (gateWindow && name === 'select_window') {
    const { gateWindowCheck } = hooks.race ?? await import('./fowl/origin-hook.mjs');
    return gateWindowCheck({ tool_name: name, tool_input: args ?? {} }, env) ?? undefined;
  }
  if (turboBrowser && name === 'js') {
    const { decide } = hooks.turbo ?? await import('./turbo/engine-browser-guard.mjs');
    return decide({ tool_name: 'mcp__plugin_sleight_computer__js', tool_input: args ?? {} }, turboBrowser)?.hookSpecificOutput.permissionDecisionReason;
  }
  return undefined;
}

// The proxy itself. input/output are Codex's side; the child is sleight-mcp. Resolves to the child's exit code.
export function runProxy({ command, args = [], env = process.env, policy, gateWindow = false, turboBrowser, log, hooks,
  input = process.stdin, output = process.stdout, errput = process.stderr, spawnChild = spawn } = {}) {
  const record = entry => { if (log) try { appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), policy, ...entry }) + '\n'); } catch {} };
  const child = spawnChild(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  child.stdin?.on('error', () => {}); // sleight ended first; its exit code is the result
  const toChild = message => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n'); };
  const toClient = message => output.write(JSON.stringify(message) + '\n');
  // Codex's lines reach sleight untouched, except the three this proxy owns. The substring checks keep the hop to a
  // scan for the common call; only a candidate line is parsed.
  const candidate = gateWindow || turboBrowser ? /"(?:initialize|tools\/call)"/ : /"initialize"/;
  createInterface({ input }).on('line', line => {
    if (!candidate.test(line)) { if (child.stdin.writable) child.stdin.write(line + '\n'); return; }
    let message;
    try { message = JSON.parse(line); } catch { if (child.stdin.writable) child.stdin.write(line + '\n'); return; }
    if (message.method === 'initialize') {
      const capabilities = message.params?.capabilities ?? {};
      message = { ...message, params: { ...message.params, capabilities: { ...capabilities, elicitation: { ...capabilities.elicitation, form: {} } } } };
      toChild(message); return;
    }
    if (message.method === 'tools/call' && message.id !== undefined && (gateWindow || turboBrowser)) {
      guardReason(message.params?.name, message.params?.arguments, { gateWindow, turboBrowser, env, hooks }).then(reason => {
        if (!reason) return toChild(message);
        record({ kind: 'tool-refused', tool: message.params?.name, reason });
        toClient({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: reason }] } });
      }, error => {
        record({ kind: 'tool-refused', tool: message.params?.name, reason: `guard failed: ${error.message}` });
        toClient({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Benchmark guard unavailable; the call was not made.' }] } });
      });
      return;
    }
    toChild(message);
  }).on('close', () => { if (!child.stdin.destroyed) child.stdin.end(); });
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.includes('"elicitation/create"')) { output.write(line + '\n'); return; }
    let message;
    try { message = JSON.parse(line); } catch { output.write(line + '\n'); return; }
    if (message.method !== 'elicitation/create' || message.id === undefined) { output.write(line + '\n'); return; }
    // Codex never sees this request: the benchmark's hooks answer it, exactly where Claude Code's hooks do.
    answerElicitation(message.params, { policy, env, hooks }).then(({ message: seen, ...answer }) => {
      record({ kind: 'elicitation', message: message.params?.message, ...(seen !== message.params?.message ? { normalized: seen } : {}), action: answer.action });
      toChild({ jsonrpc: '2.0', id: message.id, result: answer });
    }, error => {
      record({ kind: 'elicitation', message: message.params?.message, action: 'decline', error: error.message });
      toChild({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
    });
  });
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'], forward = signal => { child.kill(signal); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); };
  for (const signal of signals) process.once(signal, forward);
  return new Promise(resolve => {
    child.once('error', error => { errput.write(`codex-sleight-proxy: ${error.message}\n`); resolve(127); });
    child.once('close', (code, signal) => { for (const name of signals) process.removeListener(name, forward); resolve(code ?? (signal ? 1 : 0)); });
  });
}

export function parseArgs(argv) {
  const dash = argv.indexOf('--');
  if (dash < 1 || dash === argv.length - 1) throw Error('usage: codex-sleight-proxy.mjs --policy race|bench [--log file] [--gate-window] [--turbo-guard browser] -- command [args]');
  const out = { command: argv[dash + 1], args: argv.slice(dash + 2) };
  for (let i = 0; i < dash; i++) {
    const key = argv[i];
    if (key === '--policy') out.policy = argv[++i];
    else if (key === '--log') out.log = argv[++i];
    else if (key === '--turbo-guard') out.turboBrowser = argv[++i];
    else if (key === '--gate-window') out.gateWindow = true;
    else throw Error(`unknown option ${key}`);
  }
  if (!['race', 'bench'].includes(out.policy)) throw Error('--policy must be race or bench');
  return out;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
  const code = await runProxy(options);
  // Codex may still hold stdin open; the proxy's job ended with sleight's.
  process.stdout.write('', () => process.exit(code));
}
