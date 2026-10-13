import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { outsideGit, CLAUDE_VERSION, defaultArmRoot } from '../browser.mjs';
import { PRICES, runCost } from '../../../api-auth.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
export function interactivePlan({ armDir = join(defaultArmRoot(), 'claude-cu'), workDir, prompt = '', model = 'claude-haiku-5-5',
  effort = 'high', sessionId = randomUUID(), timeoutMs = 300000, command, hostEnv = process.env } = {}) {
  armDir = resolve(armDir); outsideGit(armDir);
  if (existsSync(armDir) && lstatSync(armDir).isSymbolicLink()) throw new Error('arm root must not be a symlink');
  let parent = armDir;
  while (!existsSync(parent)) parent = dirname(parent);
  armDir = join(realpathSync(parent), relative(parent, armDir));
  if (!prompt || /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt)) throw new Error('task prompt is empty or contains terminal control characters');
  if (/^\s*[!/]/.test(prompt)) throw new Error('interactive prompts must start with task text, not a CLI command');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('session ID must be a UUID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeout must be positive');
  const cwd = workDir ? resolve(workDir) : join(armDir, 'work'), config = join(armDir, 'claude');
  outsideGit(cwd);
  const settingsFile = join(armDir, 'interactive-settings.json'), mcpFile = join(armDir, 'empty-mcp.json');
  const turnFile = join(armDir, `turn-${sessionId}.json`), nonce = randomUUID();
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TERM'].filter(k => typeof hostEnv[k] === 'string').map(k => [k, hostEnv[k]]));
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TERM: 'xterm-256color',
    ANTHROPIC_SMALL_FAST_MODEL: model });
  Object.assign(env, { BENCH_CU_TURN_RECEIPT: turnFile, BENCH_CU_SESSION: sessionId, BENCH_CU_NONCE: nonce });
  return { armDir, cwd, prompt, model, effort, sessionId, timeoutMs, env, settingsFile, mcpFile, turnFile, nonce,
    configFile: join(config, '.claude.json'), command: command ?? join(armDir, 'node_modules/.bin/claude'),
    args: ['--session-id', sessionId, '--model', model, '--effort', effort, '--no-chrome', '--setting-sources', '',
      '--settings', settingsFile, '--strict-mcp-config', '--mcp-config', mcpFile, '--tools', 'ToolSearch,WaitForMcpServers', '--disable-slash-commands'],
    auth: 'isolated direct-plan login', version: CLAUDE_VERSION };
}

export function interactiveAgentSetup({ dir, prompt, model, effort, task, armDir, hostEnv = process.env } = {}) {
  const plan = interactivePlan({ armDir, workDir: dir, prompt, model, effort, timeoutMs: (task?.budgetSeconds ?? 600) * 1000, hostEnv });
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), '--run', '--parent-lock', '--arm-dir', plan.armDir,
    '--work-dir', plan.cwd, '--prompt', prompt, '--model', plan.model, '--effort', plan.effort, '--timeout-ms', String(plan.timeoutMs)],
    prompt, env: plan.env, mcpConfig: null, metadata: { interactive: true, auth: plan.auth, claudeVersion: CLAUDE_VERSION } };
}

function ordinary(path) {
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('interactive arm paths must not be symlinks');
  }
}
export function prepareInteractive(plan) {
  outsideGit(plan.armDir); ordinary(plan.armDir); ordinary(plan.env.CLAUDE_CONFIG_DIR); ordinary(plan.configFile);
  ordinary(plan.cwd); ordinary(plan.settingsFile); ordinary(plan.mcpFile);
  ordinary(plan.turnFile);
  if (existsSync(join(plan.env.CLAUDE_CONFIG_DIR, '.config.json'))) throw new Error('legacy arm config needs owner migration before computer use');
  if (transcriptFiles(plan).length) throw new Error('interactive session transcript already exists');
  if (existsSync(plan.turnFile)) throw new Error('interactive session Stop receipt already exists');
  mkdirSync(plan.cwd, { recursive: true, mode: 0o700 }); mkdirSync(plan.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const config = existsSync(plan.configFile) ? JSON.parse(readFileSync(plan.configFile, 'utf8')) : {};
  config.projects ??= {};
  config.projects[plan.cwd] = { ...config.projects[plan.cwd], enabledMcpServers: ['computer-use'], hasTrustDialogAccepted: true };
  writeFileSync(plan.configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(plan.mcpFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  writeFileSync(plan.settingsFile, JSON.stringify({ autoMemoryEnabled: false,
    claudeMdExcludes: ['**', '**/.claude/**', '**/.claude/**/.*'],
    pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } }, enabledPlugins: {},
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${fileURLToPath(new URL('./turn-ended.mjs', import.meta.url))}"`, timeout: 5 }] }] } }), { mode: 0o600 });
}

function transcriptFiles(plan) {
  const projects = join(plan.env.CLAUDE_CONFIG_DIR, 'projects');
  ordinary(projects);
  if (!existsSync(projects)) return [];
  return readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory())
    .map(d => join(projects, d.name, `${plan.sessionId}.jsonl`)).filter(existsSync);
}

export class SessionTranscript {
  constructor(sessionId) { this.sessionId = sessionId; this.pending = ''; this.messages = new Map(); this.tools = new Set(); this.results = new Set(); this.answer = undefined; this.offset = 0; this.decoder = new StringDecoder('utf8'); }
  append(chunk) {
    this.pending += chunk;
    if (this.pending.length > 16000000) throw new Error('interactive transcript line exceeds 16 MB');
    let end;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.sessionId && event.sessionId !== this.sessionId || event.isSidechain || event.parent_tool_use_id) continue;
      const t = Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : Date.now();
      if (event.type === 'user' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block.type === 'tool_result' && this.tools.has(block.tool_use_id) && !this.results.has(block.tool_use_id)) {
          this.results.add(block.tool_use_id);
          const content = Array.isArray(block.content) ? block.content.filter(c => c.type === 'text') : block.content;
          this.onEvent?.({ type: 'user', t, message: { content: [{ ...block, content }] }, imagesOmitted: Array.isArray(block.content) && block.content.some(c => c.type === 'image') });
        }
      }
      if (event.type !== 'assistant' || !event.message?.id || !Array.isArray(event.message.content)) continue;
      const m = event.message, prior = this.messages.get(m.id) ?? { usage: {}, model: m.model };
      for (const [key, value] of Object.entries(m.usage ?? {})) if (typeof value === 'number') prior.usage[key] = Math.max(prior.usage[key] ?? 0, value);
      this.messages.set(m.id, prior);
      for (const block of m.content) {
        if (block.type === 'tool_use') {
          if (!this.tools.has(block.id)) this.onEvent?.({ type: 'assistant', t, message: { id: m.id, content: [block], usage: m.usage } });
          this.tools.add(block.id);
          if (!/^(?:mcp__computer[-_]use__|ToolSearch$|WaitForMcpServers$)/.test(block.name ?? '')) this.foreignTool = true;
        }
        if (block.type === 'text') {
          const matches = [...block.text.matchAll(/^RESULT[^\r\n]*$/gm)];
          if (matches.length) this.answer = matches.at(-1)[0];
        }
      }
    }
  }
  update(plan) {
    if (!this.file) {
      const files = transcriptFiles(plan);
      if (files.length > 1) throw new Error('interactive transcript is ambiguous');
      this.file = files[0];
    }
    if (!this.file) return;
    ordinary(this.file);
    const size = statSync(this.file).size;
    if (size < this.offset) throw new Error('interactive transcript was replaced or truncated');
    const fd = openSync(this.file, 'r'), buffer = Buffer.alloc(65536);
    try {
      while (this.offset < size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!count) break;
        this.offset += count; this.append(this.decoder.write(buffer.subarray(0, count)));
      }
    } finally { closeSync(fd); }
  }
  summary() {
    const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage = {};
    for (const m of this.messages.values()) {
      for (const key of Object.keys(usage)) usage[key] += m.usage[key] ?? 0;
      if (m.model) {
        const u = modelUsage[m.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        for (const [key, source] of Object.entries({ inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' })) u[key] += m.usage[source] ?? 0;
      }
    }
    return { answer: this.answer, calls: this.tools.size, modelCalls: this.messages.size, usage, modelUsage, foreignTool: !!this.foreignTool };
  }
}

export function terminalGate(raw, prompt) {
  let text = raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
  if (prompt) {
    const pending = text.trim().replace(/^❯\s*/, '').replace(/\s+/g, ' ');
    const task = prompt.trim().replace(/\s+/g, ' ');
    if (pending && pending !== task && task.startsWith(pending)) return { blocked: undefined, ready: false };
    const index = text.indexOf(prompt.trim());
    if (index >= 0) text = text.slice(index + prompt.trim().length);
    else if (prompt.length < 4096) {
      const echo = prompt.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = new RegExp(echo).exec(text);
      if (match) text = text.slice(match.index + match[0].length);
    }
  }
  const blocked = /Allow for this session|Allow computer use|Allow .*to (?:use|control)|permission.*(?:allow|approve)|Grant Accessibility|Screen Recording|Try again|Enter to (?:confirm|select)|Do you want to (?:allow|proceed|use)/i.test(text) ? 'approval required'
    : /Do you trust|Trust this folder|trust the files/i.test(text) ? 'workspace trust required'
    : /(?:^|\n)\s*(?:Sign in to Claude|Log in to Claude|(?:Select |Choose (?:a |your )?)?login method|Pro or Max plan)\s*(?:$|\n|[.:])/i.test(text) ? 'direct-plan login required' : undefined;
  return { blocked, ready: !blocked && /(?:^|\n)\s*❯\s*(?:\n|$)/.test(text) };
}

export function verifyInteractiveCLI(plan) {
  const version = execFileSync(plan.command, ['--version'], { env: plan.env, encoding: 'utf8', timeout: 10000 }).trim();
  if (version !== `${CLAUDE_VERSION} (Claude Code)`) throw new Error(`interactive arm requires Claude Code ${CLAUDE_VERSION}`);
}
export function launchPty(plan, onOutput, { onSpawn } = {}) {
  const bridge = fileURLToPath(new URL('./pty-bridge.py', import.meta.url));
  const child = spawn('/usr/bin/python3', [bridge, '/usr/bin/script', '-q', '/dev/null', plan.command, ...plan.args],
    { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let cleanupReceipt = '';
  child.stdout.on('data', data => onOutput(data.toString()));
  child.stderr.on('data', data => { cleanupReceipt = (cleanupReceipt + data).slice(-4096); onOutput(data.toString()); });
  let timer, spawnError;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error.code; });
    child.once('close', code => {
      clearTimeout(timer);
      child.stdin.destroy(); resolve({ code, clean: !spawnError && cleanupReceipt.includes('[sleight-cu-cleanup:ok]') });
    });
  });
  const control = { closed, write: text => child.stdin.write(text), stop: async () => {
    child.stdin.write('\x03'); child.stdin.end();
    timer = setTimeout(() => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 1000);
    await Promise.race([closed, wait(5500)]);
  } };
  if (child.pid) {
    try { onSpawn?.(child.pid); } catch { void control.stop(); }
  }
  return control;
}

export async function runInteractive(plan, { dryRun = false, prepare = prepareInteractive, verify = verifyInteractiveCLI,
  launch = launchPty, transcript = new SessionTranscript(plan.sessionId), turnEnded = p => {
    if (!existsSync(p.turnFile)) return false;
    ordinary(p.turnFile); const receipt = JSON.parse(readFileSync(p.turnFile, 'utf8'));
    return receipt.sessionId === p.sessionId && receipt.nonce === p.nonce;
  }, pollMs = 100, signal, onSpawn, onEvent } = {}) {
  if (dryRun) return { dryRun: true, plan };
  if (signal?.aborted) return { type: 'result', is_error: true, result: '', reason: 'cancelled', duration_ms: 0, groupClean: true };
  const start = Date.now(); prepare(plan); verify(plan);
  if (signal?.aborted) return { type: 'result', is_error: true, result: '', reason: 'cancelled', duration_ms: Date.now() - start, groupClean: true };
  if (onEvent) transcript.onEvent = onEvent;
  let screen = '', closed, sent = false, exiting = false, reason, timedOut = false, gateBlocked;
  const pty = launch(plan, data => { screen = (screen + data).slice(-65536); }, { onSpawn });
  pty.closed.then(result => { closed = result; });
  try {
    for (;;) {
      transcript.update?.(plan);
      const state = transcript.summary(), gate = terminalGate(screen, sent ? plan.prompt : undefined);
      if (gate.blocked) { gateBlocked = true; reason = gate.blocked; break; }
      if (state.foreignTool) { reason = 'foreign tool observed'; break; }
      if (signal?.aborted) { reason = 'cancelled'; break; }
      if (closed) { if (!exiting) reason = 'session exited before confirmed RESULT and idle prompt'; break; }
      if (Date.now() - start >= plan.timeoutMs) { timedOut = true; reason = 'interactive task timeout'; break; }
      if (!sent && gate.ready) { sent = true; screen = ''; pty.write('\x1b[200~' + plan.prompt + '\x1b[201~\r'); }
      else if (sent && state.answer && gate.ready && turnEnded(plan) && !exiting) {
        exiting = true; screen = ''; pty.write('\x04'); await wait(50);
        if (!closed) pty.write('\x04');
      }
      await wait(pollMs);
    }
  } catch (error) { reason = error.message; }
  finally { if (!closed) { await pty.stop(); closed = await Promise.race([pty.closed, wait(100).then(() => undefined)]); } }
  const state = transcript.summary(), clean = !reason && closed?.clean === true && closed.code === 0;
  const priced = Object.keys(state.modelUsage).length && Object.keys(state.modelUsage).every(m => PRICES[m]);
  return { type: 'result', subtype: clean ? 'success' : 'error', is_error: !clean, result: state.answer ?? '',
    duration_ms: Date.now() - start, num_turns: state.modelCalls, calls: state.calls, usage: state.usage, modelUsage: state.modelUsage,
    ...(priced && { total_cost_usd: runCost({ modelUsage: state.modelUsage }) }), groupClean: closed?.clean === true, timedOut,
    ...(gateBlocked && { gateBlocked }),
    ...(reason && { reason }), requestedModel: plan.model, effort: plan.effort, session_id: plan.sessionId, auth: plan.auth };
}

async function main() {
  try {
    const options = {}, args = process.argv.slice(2); let live = false, dryRun = false, parentLock = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') live = true;
      else if (args[i] === '--dry-run') dryRun = true;
      else if (args[i] === '--parent-lock') parentLock = true;
      else if (['--arm-dir', '--work-dir', '--prompt', '--prompt-file', '--model', '--effort', '--timeout-ms'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); options[key] = args[++i];
      } else throw new Error('unknown or incomplete interactive option');
    }
    if (live && dryRun) throw new Error('choose --run or --dry-run');
    const { promptFile, ...rest } = options;
    if (promptFile && rest.prompt) throw new Error('choose prompt or prompt-file');
    const plan = interactivePlan({ ...rest, ...(rest.timeoutMs && { timeoutMs: Number(rest.timeoutMs) }), prompt: promptFile ? readFileSync(promptFile, 'utf8') : rest.prompt });
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    let release, result;
    try {
      if (live) {
        if (existsSync('/tmp/sleight-hold')) throw new Error('timed window is held');
        if (parentLock) {
          if (!existsSync('/tmp/sleight-live.lock') || !statSync('/tmp/sleight-live.lock').isDirectory()) throw new Error('parent benchmark lock is absent');
        } else release = await (await import('../../../live-lock.mjs')).acquireLiveLock();
      }
      result = await runInteractive(plan, { dryRun: !live, signal: controller.signal, onEvent: event => process.stdout.write(JSON.stringify(event) + '\n') });
      console.log(JSON.stringify(result)); if (live && result.is_error) process.exitCode = 1;
    } finally {
      if (release && (!result || result.groupClean)) await release();
      else if (release) console.error('interactive cleanup is unverified; retain the live lock for sleight-arch');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
