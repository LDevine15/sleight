// Offline preparation and readback for one short native benchmark pass. Never starts a live run.
import { constants, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { actionLogPath, logRoot, REASONS } from '../plugins/sleight/lib/action-outcomes.mjs';
import { intervalUnion } from './timing.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, max = 1000000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const nativeTools = new Set(['js', 'drag', 'hover', 'menu_bar', 'notifications', 'document_scope', 'flow_exception', 'open_file', 'replay', 'review_changes', 'select_window']);
const reasons = new Set([...REASONS, 'error', 'engine error', 'record cap', 'covered']);
const results = new Set(['ok', 'failed', 'refused', 'not run', 'not logged']);
const outcomes = new Set(['app changed', 'window changed', 'menu opened', 'menu closed', 'value matches', 'value differs', 'value changed',
  'state changed', 'element gone', 'focus moved', 'other lines changed', 'no visible change', 'unverified', 'checked with the next action', 'compacted', 'done']);
const roles = new Set(['standard window', 'floating window', 'system dialog', 'dialog', 'sheet', 'popover', 'menu bar item', 'menu bar',
  'menu button', 'menu item', 'menu', 'pop up button', 'radio button', 'check box', 'checkbox', 'toggle button', 'switch',
  'disclosure triangle', 'secure text field', 'search text field', 'search field', 'text entry area', 'text area', 'text field',
  'combo box', 'close button', 'full screen button', 'minimize button', 'zoom button', 'button', 'tab group', 'tab', 'scroll area',
  'scroll bar', 'slider', 'stepper', 'incrementor', 'value indicator', 'date field', 'time field', 'link', 'row', 'cell',
  'column header', 'static text', 'text', 'heading', 'image', 'group', 'toolbar', 'list', 'table', 'outline', 'web area', 'window']);
const names = new Set(['ok', 'cancel', 'save', 'save as', "don't save", 'close', 'done', 'submit', 'next', 'back', 'previous',
  'continue', 'apply', 'delete', 'remove', 'add', 'open', 'new', 'edit', 'replace', 'replace all', 'find', 'find next', 'search',
  'yes', 'no', 'allow', "don't allow", 'deny', 'accept', 'decline', 'reset', 'clear', 'undo', 'redo', 'copy', 'cut', 'paste',
  'select all', 'print', 'send', 'upload', 'download', 'share', 'settings', 'preferences', 'options', 'more', 'help', 'file',
  'view', 'format', 'insert', 'window', 'tools', 'table', 'bold', 'italic', 'underline', 'minimize', 'zoom', 'full screen',
  'go', 'sign in', 'log in', 'sign out', 'log out', 'name', 'email', 'username', 'password', 'date', 'time', 'title']);
const key = /^(?:(?:super|cmd|command|ctrl|control)\+(?:(?:super|cmd|command|ctrl|control|shift|alt|option|opt|fn)\+)*(?:[a-z0-9]|return|enter|escape|tab|space)|return|enter|escape|esc|tab|space|backspace|delete|forwarddelete|left|right|up|down|home|end|pageup|pagedown|f\d{1,2})$/i;
const callId = value => integer(value, Number.MAX_SAFE_INTEGER) || typeof value === 'string' && /^(?:\d{1,16}|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value);

function isolatedConfig(config) {
  try {
    const owner = join(homedir(), '.claude');
    const canonicalOwner = existsSync(owner) ? realpathSync(owner) : owner;
    if (typeof config !== 'string' || !isAbsolute(config) || resolve(config) !== config ||
        config === homedir() || owner.startsWith(config + '/') || config === owner || config.startsWith(owner + '/') ||
        canonicalOwner.startsWith(config + '/') || config === canonicalOwner || config.startsWith(canonicalOwner + '/') ||
        realpathSync(config) !== config) fail('ANALYTICS_CONFIG');
    const info = lstatSync(config);
    if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o022) fail('ANALYTICS_CONFIG');
    return config;
  } catch { fail('ANALYTICS_CONFIG'); }
}

/** Each pass owns its settings, traces and log name. An existing isolated arm login may be reused. */
export function prepareAnalytics({ tempRoot = '/private/tmp', claudeConfig } = {}) {
  if (claudeConfig !== undefined) isolatedConfig(claudeConfig);
  const bank = realpathSync(mkdtempSync(join(realpathSync(tempRoot), 'lane-claude-analytics-')));
  for (const folder of ['arm', 'claude', 'traces']) mkdirSync(join(bank, folder), { mode: 0o700 });
  const log = `bench-analytics-${randomUUID()}.jsonl`;
  writeFileSync(join(bank, 'plan.json'), JSON.stringify({ version: 1, log, ...(claudeConfig !== undefined ? { claudeConfig } : {}) }) + '\n', { mode: 0o600, flag: 'wx' });
  return bank;
}

export function checkLocalFile(path, root) {
  let fd;
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.uid !== process.getuid() || directory.mode & 0o022 ||
        realpathSync(path) !== path || !path.startsWith(realpathSync(root) + '/')) fail('ANALYTICS_LOCAL');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024 * 1024) fail('ANALYTICS_LOCAL');
    return readFileSync(fd, 'utf8');
  } catch { fail('ANALYTICS_LOCAL'); } finally { if (fd !== undefined) closeSync(fd); }
}

export function analyticsArm(bank, { root = ROOT } = {}) {
  try {
    if (realpathSync(bank) !== bank || !bank.startsWith(realpathSync('/private/tmp') + '/') || !/\/lane-claude-analytics-[\w-]+$/.test(bank)) fail('ANALYTICS_BANK');
    for (const folder of [bank, ...['arm', 'claude', 'traces'].map(name => join(bank, name))]) {
      const info = lstatSync(folder);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(folder) !== folder) fail('ANALYTICS_BANK');
    }
    const plan = JSON.parse(checkLocalFile(join(bank, 'plan.json'), bank));
    if (!exact(plan, Object.hasOwn(plan, 'claudeConfig') ? ['version', 'log', 'claudeConfig'] : ['version', 'log']) ||
        plan.version !== 1 || !/^bench-analytics-[0-9a-f-]{36}\.jsonl$/.test(plan.log)) fail('ANALYTICS_BANK');
    const config = Object.hasOwn(plan, 'claudeConfig') ? isolatedConfig(plan.claudeConfig) : join(bank, 'claude');
    return { cwd: join(bank, 'arm'), env: { CLAUDE_CONFIG_DIR: config }, log: plan.log,
      server: { command: join(root, 'plugins/sleight/bin/sleight-mcp'), env: { SLEIGHT_ACTION_LOG: plan.log,
        SLEIGHT_TRACE: join(bank, 'traces'), SLEIGHT_TRACE_CODE: '0', SLEIGHT_HAND: '0', SLEIGHT_SURFACES: 'computer', SLEIGHT_APPROVAL_PROMPT: 'client' } } };
  } catch { fail('ANALYTICS_BANK'); }
}

export function writeAnalyticsMcp(bank, options) {
  const arm = analyticsArm(bank, options), path = join(arm.cwd, 'bench-mcp.json');
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) fail('ANALYTICS_CONFIG');
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify({ mcpServers: { 'plugin:sleight:computer': arm.server } }) + '\n');
    return path;
  } catch { fail('ANALYTICS_CONFIG'); } finally { if (fd !== undefined) closeSync(fd); }
}

/** Native-only privacy schema. Unknown text fails, including unknown nested fields, rather than being scrubbed after storage. */
export function checkPrivacy(rows) {
  const fields = new Set(['time', 'pid', 'call', 'tool', 'app', 'kind', 'result', 'outcome', 'reason', 'ms', 'saved', 'target', 'chars', 'key', 'count']);
  const kinds = new Set(['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText', 'action', 'rest', 'call', 'read',
    ...nativeTools, 'menu_bar open', 'menu_bar choose', 'menu_bar press', 'menu_bar close', 'notifications press', 'review_changes review']);
  for (const row of rows) {
    if (!object(row) || Object.keys(row).some(field => !fields.has(field)) || !date(row.time) || !integer(row.pid) || row.pid === 0 ||
        !callId(row.call) || !nativeTools.has(row.tool) || !kinds.has(row.kind) || !results.has(row.result) || !integer(row.ms, 86400000)) fail('ANALYTICS_PRIVACY');
    if (row.app !== undefined && !['Calculator', 'com.apple.calculator'].includes(row.app)) fail('ANALYTICS_PRIVACY');
    for (const field of ['saved', 'chars', 'count']) if (row[field] !== undefined && !integer(row[field], field === 'chars' ? 1000000 : 1000)) fail('ANALYTICS_PRIVACY');
    if (row.reason !== undefined && !reasons.has(row.reason) && !/^stopped after \d{1,3}$/.test(row.reason)) fail('ANALYTICS_PRIVACY');
    if (row.key !== undefined && (typeof row.key !== 'string' || !key.test(row.key))) fail('ANALYTICS_PRIVACY');
    if (row.outcome !== undefined && (typeof row.outcome !== 'string' || row.outcome.split('; ').some(word => !outcomes.has(word) &&
        !/^(?:now (?:not )?(?:checked|unchecked|selected|unselected|expanded|collapsed|disabled)|(?:dialog|sheet|popover|window|system dialog) (?:opened|closed))$/.test(word)))) fail('ANALYTICS_PRIVACY');
    if (row.target !== undefined && (!object(row.target) || Object.keys(row.target).some(field => !['role', 'name', 'secure'].includes(field)) ||
        !roles.has(row.target.role) || row.target.secure !== undefined && row.target.secure !== true ||
        row.target.name !== undefined && (typeof row.target.name !== 'string' || !names.has(row.target.name.replace(/(?:…|\.\.\.)$/, '').trim().toLowerCase())))) fail('ANALYTICS_PRIVACY');
  }
}

export function parseStats(text) {
  try {
    const s = JSON.parse(text);
    if (!exact(s, ['log', 'files', 'skipped', 'days', 'from', 'to', 'calls', 'actions', 'timed', 'untimed', 'paths', 'readsSaved', 'refused', 'failed', 'notRun']) ||
        !/^~\/Library\/Logs\/sleight\/bench-analytics-[\w-]+\.jsonl$/.test(s.log) || s.days !== 1 ||
        !['files', 'skipped', 'calls', 'actions', 'timed', 'untimed', 'readsSaved', 'notRun'].every(field => integer(s[field])) ||
        !date(s.from) || !date(s.to) || Date.parse(s.from) > Date.parse(s.to) || !exact(s.paths, ['native', 'turbo', 'engine'])) fail('ANALYTICS_STATS');
    for (const path of Object.values(s.paths)) {
      if (!exact(path, ['actions', 'timed', 'median', 'p90']) || !integer(path.actions) || !integer(path.timed) || path.timed > path.actions ||
          !['median', 'p90'].every(field => path.timed ? Number.isFinite(path[field]) && path[field] >= 0 && path[field] <= 86400 : path[field] === null)) fail('ANALYTICS_STATS');
    }
    for (const part of [s.refused, s.failed]) if (!exact(part, ['count', 'reasons']) || !integer(part.count) || !object(part.reasons) ||
      Object.entries(part.reasons).some(([word, n]) => !reasons.has(word) && word !== 'other' || !integer(n))) fail('ANALYTICS_STATS');
    return s;
  } catch { fail('ANALYTICS_STATS'); }
}

function traceCalls(traces) {
  const calls = new Map();
  for (const { pid, events } of traces) {
    const prompts = new Map(), active = new Map();
    let previous = -Infinity;
    for (const e of events) {
      const time = Date.parse(e.t), id = e.msg?.id, k = JSON.stringify([pid, id]);
      if (!Number.isFinite(time) || time < previous) fail('ANALYTICS_TRACE');
      previous = time;
      if (e.direction === 'from-server' && e.msg?.method === 'elicitation/create') {
        // Engine prompts carry no parent RPC id. Bind only when one call can own the wait.
        if (active.size !== 1 || prompts.has(id)) fail('ANALYTICS_UNOBSERVABLE_PROMPT');
        const owner = active.values().next().value;
        owner.waits.set(id, time); prompts.set(id, owner);
        continue;
      }
      if (e.direction === 'to-client' && e.msg?.method === 'elicitation/create') {
        if (!prompts.has(id)) fail('ANALYTICS_UNOBSERVABLE_PROMPT');
        continue;
      }
      if (e.direction === 'to-server' && e.msg?.method === undefined && prompts.has(id)) {
        const owner = prompts.get(id);
        owner.intervals.push([owner.waits.get(id), time]); owner.waits.delete(id); prompts.delete(id);
        continue;
      }
      if (e.direction === 'call-received' && nativeTools.has(e.msg?.params?.name)) {
        if (calls.has(k)) fail('ANALYTICS_TRACE');
        const call = { tool: e.msg.params.name, received: time, intervals: [], waits: new Map() };
        calls.set(k, call); active.set(k, call);
      }
      const call = calls.get(k);
      if (!call) continue;
      if (e.direction === 'to-server' && e.msg?.method === 'tools/call') call.sent ??= time;
      if (e.direction === 'to-client' && e.msg?.method === undefined) { call.end = time; active.delete(k); }
    }
  }
  return calls;
}

/** Compare only this bank's calls. Rebuild the native aggregate without the product's summarizer. */
export function validateAnalytics({ rows, stats, traces }) {
  checkPrivacy(rows);
  parseStats(JSON.stringify(stats));
  if (!rows.length) fail('ANALYTICS_EMPTY');
  const calls = traceCalls(traces), groups = new Map(), samples = [];
  let maxTimingDeltaMs = 0, actions = 0, readsSaved = 0, activeCalls = 0, notRun = 0;
  const refused = {}, failed = {};
  for (const row of rows) {
    const k = JSON.stringify([row.pid, row.call]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const [k, group] of groups) {
    const first = group[0], call = calls.get(k);
    if (group.some(row => row.ms !== first.ms || row.time !== first.time || row.tool !== first.tool)) fail('ANALYTICS_CALL');
    if (!call || call.tool !== first.tool || call.end === undefined) fail('ANALYTICS_TRACE');
    const start = call.sent ?? call.received, end = call.end;
    const pauses = [...call.intervals, ...[...call.waits.values()].map(t => [t, end])];
    const traceMs = end - start - intervalUnion(pauses.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]));
    const delta = Math.abs(first.ms - traceMs);
    if (traceMs < 0 || delta > Math.max(250, traceMs * 0.1)) fail('ANALYTICS_TIMING');
    maxTimingDeltaMs = Math.max(maxTimingDeltaMs, delta);
    if (Math.abs(Date.parse(first.time) - end) > 2000) fail('ANALYTICS_TRACE');
    let ran = 0;
    for (const row of group) {
      readsSaved += row.saved ?? 0;
      if (row.result === 'refused' || row.result === 'failed') {
        const into = row.result === 'refused' ? refused : failed;
        const word = reasons.has(row.reason) ? row.reason : 'other'; into[word] = (into[word] ?? 0) + 1;
      }
      if (row.result === 'not run') notRun += row.kind === 'rest' ? row.count ?? 0 : 1;
      if (row.kind !== 'read') ran += ['ok', 'failed'].includes(row.result) ? 1 : row.result === 'not logged' ? row.count ?? 0 : 0;
    }
    if (ran) {
      activeCalls++; actions += ran;
      if (actions > 10000) fail('ANALYTICS_TOO_LARGE');
      for (let n = 0; n < ran; n++) samples.push(first.ms / 1000 / ran);
    }
  }
  samples.sort((a, b) => a - b);
  const quantile = q => {
    if (!samples.length) return null;
    const at = (samples.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
    return Math.round((samples[low] + (samples[high] - samples[low]) * (at - low)) * 1000) / 1000;
  };
  const sameReasons = (part, expected) => part.count === Object.values(expected).reduce((a, b) => a + b, 0) &&
    Object.keys(part.reasons).length === Object.keys(expected).length && Object.entries(expected).every(([word, n]) => part.reasons[word] === n);
  const times = rows.map(row => row.time).sort();
  if (!actions || stats.files !== 1 || stats.skipped || stats.untimed || stats.calls !== activeCalls || stats.actions !== actions || stats.timed !== actions ||
      stats.from !== times[0] || stats.to !== times.at(-1) || stats.readsSaved !== readsSaved || stats.notRun !== notRun ||
      !sameReasons(stats.refused, refused) || !sameReasons(stats.failed, failed) ||
      stats.paths.native.actions !== actions || stats.paths.native.timed !== actions || stats.paths.native.median !== quantile(0.5) || stats.paths.native.p90 !== quantile(0.9) ||
      stats.paths.turbo.actions || stats.paths.turbo.timed || stats.paths.engine.actions || stats.paths.engine.timed) fail('ANALYTICS_STATS_MISMATCH');
  return { calls: activeCalls, actions, readsSaved, maxTimingDeltaMs, tolerance: 'max(250 ms, 10% of trace call time)' };
}

function jsonLines(text, code) {
  try {
    return text.trimEnd().split('\n').map(line => {
      const value = JSON.parse(line);
      // Both writers emit JSON.stringify rows. This also rejects duplicate keys hiding earlier personal values.
      if (JSON.stringify(value) !== line) fail(code);
      return value;
    });
  } catch { fail(code); }
}

// Read-only after the driver has exited and flushed. Raw rows and trace text never reach stdout or a repository artifact.
export function checkAnalytics(bank, { root = ROOT } = {}) {
  const arm = analyticsArm(bank, { root }), log = actionLogPath(arm.log), traces = [];
  if (['.1', '.2', '.lock'].some(suffix => existsSync(log + suffix))) fail('ANALYTICS_ROTATED');
  const raw = checkLocalFile(log, logRoot());
  const rows = jsonLines(raw, 'ANALYTICS_LOG_PARSE');
  checkPrivacy(rows);
  for (const name of readdirSync(join(bank, 'traces'))) {
    if (!/^trace-\d+\.jsonl$/.test(name)) fail('ANALYTICS_TRACE');
    // The existing trace writer uses the user's umask. Containment and no links still bind the private bank.
    const path = join(bank, 'traces', name), info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || realpathSync(path) !== path || info.size > 32 * 1024 * 1024) fail('ANALYTICS_TRACE');
    traces.push({ pid: Number(name.slice(6, -6)), events: jsonLines(readFileSync(path, 'utf8'), 'ANALYTICS_TRACE_PARSE') });
  }
  const output = execFileSync(arm.server.command, ['stats', '--log', arm.log, '--days', '1', '--json'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: homedir(), CLAUDE_CONFIG_DIR: arm.env.CLAUDE_CONFIG_DIR } });
  const stats = parseStats(output);
  if (stats.log !== `~/Library/Logs/sleight/${arm.log}`) fail('ANALYTICS_STATS_LOG');
  const result = validateAnalytics({ rows, stats, traces });
  if (checkLocalFile(log, logRoot()) !== raw) fail('ANALYTICS_LOG_CHANGED');
  return { ...result, privacy: 'native schema passed', local: 'single-link 0600 file in the local sleight log root' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, bank, ...rest] = process.argv.slice(2);
    if (command === 'prepare' && bank === undefined) console.log(prepareAnalytics());
    else if (command === 'prepare' && bank === '--claude-config' && rest.length === 1) console.log(prepareAnalytics({ claudeConfig: rest[0] }));
    else if (command === 'check' && bank && !rest.length) console.log(JSON.stringify(checkAnalytics(bank), null, 2));
    else fail('ANALYTICS_USAGE: prepare [--claude-config DIRECTORY] | check BANK');
  } catch (error) {
    console.error(/^ANALYTICS_[A-Z_]+(?::.*)?$/.test(error.message) ? error.message : 'ANALYTICS_CHECK_FAILED');
    process.exitCode = 1;
  }
}
