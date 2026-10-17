import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { interactivePlan, interactiveAgentSetup, prepareInteractive, terminalGate, runInteractive } from '../bench/world/arms/claude-cu/interactive.mjs';
import { permissionDecision } from '../bench/world/arms/claude-cu/permission.mjs';

const enabled = { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: true } } };
function fixture(t, config = enabled) {
  const armDir = mkdtempSync(join(tmpdir(), 'sleight-cu-approval-')); t.after(() => removeTemp(armDir));
  const p = interactivePlan({ armDir, prompt: 'Read the fixture. Return RESULT ok.', allowedApps: ['Fixture Editor'], timeoutMs: 300 });
  if (config !== null) { mkdirSync(p.env.CLAUDE_CONFIG_DIR); writeFileSync(p.configFile, JSON.stringify(config)); }
  return p;
}
const card = (apps = ['Fixture Editor'], selected = 'deny') => '\nComputer Use wants to control these apps\n\n' +
  apps.map(app => `  ● ${app}`).join('\n') + '\n\n' +
  `${selected === 'deny' ? '❯' : ' '} Deny, and tell Claude what to do differently (esc)\n` +
  `${selected === 'allow' ? '❯' : ' '} Allow for this session (${apps.length} ${apps.length === 1 ? 'app' : 'apps'})\n`;

test('telemetry opt-out still loads the owner cached computer-use entitlement', () => {
  const p = interactivePlan({ armDir: '/private/tmp/cu-env-fixture', prompt: 'RESULT ok',
    hostEnv: { CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '0', ANTHROPIC_API_KEY: 'fixture' } });
  assert.equal(p.env.DISABLE_TELEMETRY, '1');
  assert.equal(p.env.DO_NOT_TRACK, '1');
  assert.equal(p.env.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF, '1');
  assert.equal(p.env.ANTHROPIC_API_KEY, undefined);
});
for (const [name, config] of [['absent config', null], ['absent feature', {}], ['disabled', { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: false } } }],
  ['truthy string', { cachedGrowthBookFeatures: { tengu_malort_pedway: { enabled: 'true' } } }]]) {
  test(`preparation refuses ${name} before writing trust or settings`, t => {
    const p = fixture(t, config), before = existsSync(p.configFile) && readFileSync(p.configFile, 'utf8');
    assert.throws(() => prepareInteractive(p), /cached.*computer.use.*enabled/i);
    assert.equal(existsSync(p.settingsFile), false);
    assert.equal(existsSync(p.cwd), false);
    assert.equal(existsSync(p.configFile) && readFileSync(p.configFile, 'utf8'), before);
  });
}
test('ready input accepts the pinned CLI placeholder but not typed input or an approval', () => {
  for (const input of ['❯ Try "refactor <filepath>"\n', '❯ Try"fix lint errors"\n', '\x1b[32m❯\x1b[0m Try "write a test"\n'])
    assert.equal(terminalGate(input).ready, true, input);
  for (const input of ['❯ Try "unfinished', '❯ typed task\n', '❯ Try "fix lint errors"\nAllow for this session'])
    assert.equal(terminalGate(input).ready, false, input);
});
test('task allowlist survives adapter and CLI serialization instead of inheriting the host', t => {
  const p = fixture(t);
  const setup = interactiveAgentSetup({ armDir: p.armDir, dir: p.cwd, prompt: p.prompt,
    task: { allowedApps: ['Fixture Editor', 'Fixture Viewer'] }, hostEnv: { BENCH_CU_ALLOWED_APPS: '["Other App"]' } });
  assert.equal(setup.env.BENCH_CU_ALLOWED_APPS, '["Fixture Editor","Fixture Viewer"]');
  assert.equal(setup.args[setup.args.indexOf('--allowed-apps') + 1], '["Fixture Editor","Fixture Viewer"]');
  const dry = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/interactive.mjs', import.meta.url).pathname,
    '--arm-dir', p.armDir, '--prompt', p.prompt, '--allowed-apps', '["Fixture Editor"]'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).plan.allowedApps, ['Fixture Editor']);
});
test('browser adapter selects only its task browser from the benchmark allowlist', () => {
  const setup = interactiveAgentSetup({ armDir: '/private/tmp/cu-adapter-fixture', dir: '/private/tmp/cu-adapter-work',
    prompt: 'RESULT ok', task: { browser: 'helium' } });
  assert.equal(setup.env.BENCH_CU_ALLOWED_APPS, '["Helium"]');
});
async function session(p, { screens = [card()], cancel = false } = {}) {
  const writes = []; let finish, output, answer, exitKeys = 0, timer;
  const closed = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const result = await runInteractive(p, { prepare() {}, verify() {}, pollMs: 1, signal: controller.signal,
    transcript: { update() {}, summary: () => ({ answer, calls: 1, modelCalls: 1, usage: {}, modelUsage: {} }) }, turnEnded: () => true,
    launch: (_p, callback) => {
      output = callback; queueMicrotask(() => output('\n❯ \n'));
      return { closed, write(value) {
        writes.push(value);
        if (value.startsWith('\x1b[200~')) {
          if (cancel) controller.abort();
          output(screens[0]);
          if (screens.length > 1) timer = setTimeout(() => output(screens[1]), 15);
        } else if (value === '\x1b[B') output(card(['Fixture Editor'], 'allow'));
        else if (value === '\r') { answer = 'RESULT ok'; output('\n❯ Try "write a test"\n'); }
        else if (value === '\x04' && ++exitKeys === 2) finish({ code: 0, clean: true });
      }, async stop() { clearTimeout(timer); finish({ code: 130, clean: true }); } };
    } });
  return { result, writes };
}
test('a complete allowlisted card navigates from Deny and confirms only the selected session option', async t => {
  const p = fixture(t), { result, writes } = await session(p);
  assert.equal(result.is_error, false, result.reason);
  assert.deepEqual(writes, ['\x1b[200~' + p.prompt + '\x1b[201~\r', '\x1b[B', '\r', '\x04', '\x04']);
});
test('fragmented cards wait for the whole app list and both options before accepting', async t => {
  const p = fixture(t), full = card(['Fixture Editor'], 'allow'), split = full.indexOf('Allow for');
  const { result, writes } = await session(p, { screens: [full.slice(0, split), full.slice(split)] });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes.filter(v => v === '\r').length, 1);
});
test('the pinned card supports requested clipboard flags and already granted task apps', async t => {
  const screen = card(['Fixture Editor'], 'allow').replace('  ● Fixture Editor',
    '  ✔ Fixture Editor (already granted)\n  ● Fixture Editor Two\n\nAlso requested:\n  · clipboardRead\n  · clipboardWrite\n  · systemKeyCombos');
  const p = fixture(t); p.allowedApps.push('Fixture Editor Two');
  const { result, writes } = await session(p, { screens: [screen] });
  assert.equal(result.is_error, false, result.reason);
  assert.equal(writes.filter(value => value === '\r').length, 1);
});
for (const [name, screen] of [['foreign app', card(['Fixture Editor', 'Other App'], 'allow')],
  ['substring app', card(['Fixture Editor Pro'], 'allow')], ['count mismatch', card().replace('(1 app)', '(2 apps)')],
  ['hidden apps', card().replace('  ● Fixture Editor', '  ● Fixture Editor\n  … +1 more app not shown, and not included in this grant.')],
  ['unknown option', card().replace('Allow for this session (1 app)', 'Always allow')],
  ['macOS gate', card() + 'Grant Accessibility and Screen Recording\n'], ['trust gate', card() + 'Trust this folder\n'],
  ['unmarked app', card().replace('  ● Fixture Editor', '  Fixture Editor')],
  ['foreign app below options', card(['Fixture Editor'], 'allow') + '  ● Other App\n'],
  ['unrelated approval', card(['Fixture Editor'], 'allow') + 'Do you want to proceed?\n'],
  ['unknown extra grant', card(['Fixture Editor'], 'allow').replace('  ● Fixture Editor', '  ● Fixture Editor\nAlso requested:\n  · fullControl')]]) {
  test(`${name} card receives no navigation or acceptance`, async t => {
    const { result, writes } = await session(fixture(t), { screens: [screen] });
    assert.equal(result.is_error, true);
    assert.equal(writes.length, 1);
  });
}
test('cancellation takes precedence over an otherwise allowed card', async t => {
  const { result, writes } = await session(fixture(t), { cancel: true });
  assert.equal(result.reason, 'cancelled'); assert.equal(writes.length, 1);
});
test('prepared permission hook allows only bound computer-use calls within the task allowlist', t => {
  const p = fixture(t); prepareInteractive(p);
  const settings = JSON.parse(readFileSync(p.settingsFile, 'utf8'));
  assert.ok(settings.hooks.PermissionRequest?.length, 'computer-use permission hook is installed');
  const command = settings.hooks.PermissionRequest[0].hooks[0].command;
  const invoke = (tool, input, extra = {}) => {
    const result = spawnSync(command, { shell: true, input: JSON.stringify({ hook_event_name: 'PermissionRequest',
      session_id: p.sessionId, cwd: p.cwd, tool_name: tool, tool_input: input, ...extra }), env: p.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.decision.behavior;
  };
  assert.equal(invoke('mcp__computer-use__request_access', { apps: ['Fixture Editor'] }), 'allow');
  assert.equal(invoke('mcp__computer-use__screenshot', {}), 'allow');
  assert.equal(invoke('mcp__computer-use__open_application', { app: 'Fixture Editor' }), 'allow');
  for (const input of [{ apps: ['Other App'] }, { apps: ['Fixture Editor', 'Other App'] }, { apps: [] }, {}, { apps: 'Fixture Editor' }])
    assert.equal(invoke('mcp__computer-use__request_access', input), 'deny');
  assert.equal(invoke('mcp__computer-use__open_application', { bundle_id: 'com.other.App' }), 'deny');
  assert.equal(invoke('Bash', { command: 'anything' }), 'deny');
  assert.equal(invoke('mcp__computer-use__screenshot', {}, { session_id: 'foreign' }), 'deny');
});
for (const event of ['PermissionRequest', 'PreToolUse']) {
  test(`${event} checks batch targets, cwd and malformed or empty allowlists`, t => {
    const p = fixture(t), input = { hook_event_name: event, session_id: p.sessionId, cwd: p.cwd,
      tool_name: 'mcp__computer-use__computer_batch', tool_input: { actions: [{ action: 'open_application', app: 'Fixture Editor' }] } };
    const behavior = (value, env = p.env) => {
      const output = permissionDecision(value, env).hookSpecificOutput;
      return output?.decision?.behavior ?? output?.permissionDecision;
    };
    assert.equal(behavior(input), event === 'PermissionRequest' ? 'allow' : undefined);
    for (const denied of [{ ...input, cwd: '/private/tmp/foreign' },
      { ...input, tool_input: { actions: [{ action: 'open_application', app: 'Other App' }] } },
      { ...input, tool_input: { actions: [{ action: 'app_click', bundle_id: 'com.other.App' }] } }])
      assert.equal(behavior(denied), 'deny');
    for (const list of ['[', '[]', '[42]', '[" Fixture Editor"]'])
      assert.equal(behavior(input, { ...p.env, BENCH_CU_ALLOWED_APPS: list }), 'deny');
  });
}
