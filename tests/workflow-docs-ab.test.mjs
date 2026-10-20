import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectWorkflow, makeWorkflowPlan, productionGate, runWorkflow, workflowEnvironment } from '../bench/validation/workflow-docs-ab.mjs';

const build = 'a'.repeat(40), engine = '26.1013.40934';
const pins = { build, pluginTree: 'b'.repeat(40), harnessHash: 'c'.repeat(64) };
const plan = out => makeWorkflowPlan({ build, engine, out, pins });
const sandbox = t => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-docs-ab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(realpathSync(dir), 'out');
};
const runtime = (p, overrides = {}) => ({
  now: () => new Date('2026-10-21T15:00:00Z'), verifyPins: () => {},
  readEngine: () => ({ version: engine }), gate: () => {},
  run: async () => ({ code: 0, signal: null }),
  collect: round => ({ safe: true, rows: round.tasks.map(task => ({ task, passed: true, seconds: 2 })) }),
  ...overrides,
});

test('WF3 selects existing identities, 3 rounds per side and 42 task executions', () => {
  const p = plan(join(tmpdir(), 'workflow-docs-never-written'));
  assert.equal(p.rounds.length, 30);
  assert.equal(p.rounds.reduce((n, r) => n + r.tasks.length, 0), 42);
  assert.deepEqual(p.groups.map(g => g.id), ['as3-safari', 'as3-firefox', 'cc-dropdown-slow-firefox',
    'cc-dropdown-slow-safari', 'cc-calendar-ambiguous-firefox']);
  for (const group of p.groups) {
    assert.deepEqual(p.rounds.filter(r => r.group === group.id).map(r => r.side),
      ['docs0', 'default', 'default', 'docs0', 'docs0', 'default']);
    for (const side of ['docs0', 'default']) assert.equal(p.rounds.filter(r => r.group === group.id && r.side === side).length, 3);
  }
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.equal(p.effort, 'high');
  assert.ok(p.groups.every(g => Object.values(g.taskPins).every(t => t.prompt && /^[a-f0-9]{64}$/.test(t.hash))));
});

test('only the requested flag differs; host experiment flags and credentials do not leak', () => {
  const host = { PATH: '/bin', HOME: '/home/test', SLEIGHT_WORKFLOW_DOCS: '0', SLEIGHT_RS: '0',
    ANTHROPIC_API_KEY: 'never-copy', CLAUDE_CONFIG_DIR: 'old', NODE_OPTIONS: '--inspect' };
  const a = workflowEnvironment('docs0', host), b = workflowEnvironment('default', host);
  assert.equal(a.SLEIGHT_WORKFLOW_DOCS, '0');
  assert.ok(!Object.hasOwn(b, 'SLEIGHT_WORKFLOW_DOCS'));
  delete a.SLEIGHT_WORKFLOW_DOCS;
  assert.deepEqual(a, b);
  for (const key of ['SLEIGHT_RS', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS']) assert.ok(!(key in b));
});

test('quota refusal precedes every callback and output write', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    now: () => new Date('2026-10-21T14:59:59.999Z'), gate: () => calls++, verifyPins: () => calls++,
  }) }), /quota reset/);
  assert.equal(calls, 0); assert.equal(existsSync(out), false);
});

test('owner-away refusal precedes engine, hold, lock and output access', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { runtime: runtime(p, { gate: () => calls++, readEngine: () => calls++ }) }), /owner-away/);
  assert.equal(calls, 0); assert.equal(existsSync(out), false);
});

test('hold and lock refuse without output or runner invocation', async t => {
  for (const message of ['Benchmark hold is active', 'Live lock is held']) {
    const out = sandbox(t), p = plan(out);
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      gate: () => { throw Error(message); }, run: () => assert.fail('runner reached'),
    }) }), new RegExp(message));
    assert.equal(existsSync(out), false);
  }
});

test('an injected offline run preserves failed rounds, pins and exact command receipts', async t => {
  const out = sandbox(t), p = plan(out), calls = [];
  const result = await runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    run: async (round, invocation) => { calls.push({ round, invocation }); return { code: 1, signal: null }; },
    collect: round => ({ safe: true, rows: round.tasks.map(task => ({ task, passed: false, seconds: 7 })) }),
  }) });
  assert.equal(calls.length, 30); assert.equal(result.rows.length, 42);
  assert.equal(result.complete, true); assert.equal(result.passes, 0);
  const first = JSON.parse(readFileSync(join(out, `${p.rounds[0].id}.receipt.json`)));
  assert.equal(first.code, 1); assert.equal(first.build, build); assert.equal(first.engine, engine);
  assert.ok(first.invocation.args.includes('--only'));
  assert.ok(calls.filter(c => c.round.runner === 'native').every(c => c.invocation.args.includes('--owner-away')));
  assert.ok(calls.filter(c => c.round.runner === 'browser').every(c => c.invocation.args.includes('sleight')));
  assert.ok(existsSync(join(out, 'summary.json')));
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p) }), /already exists/);
});

test('unsafe or missing evidence stops after one child and retains failure/receipt', async t => {
  const out = sandbox(t), p = plan(out);
  let calls = 0;
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
    run: async () => { calls++; return { code: 1, signal: null }; },
    collect: () => { throw Error('missing cleanup receipt'); },
  }) }), /missing cleanup/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(out, `${p.rounds[0].id}.receipt.json`))).safe, false);
  assert.ok(existsSync(join(out, 'failure.json')));
  assert.equal(existsSync(join(out, 'summary.json')), false);
});

test('build or engine drift and a newly held lock stop before the next child', async t => {
  for (const kind of ['pins', 'engine', 'gate']) {
    const out = sandbox(t), p = plan(out); let calls = 0;
    const rt = runtime(p, { run: async () => { calls++; return { code: 0, signal: null }; } });
    if (kind === 'pins') rt.verifyPins = () => { if (calls) throw Error('build changed'); };
    if (kind === 'engine') rt.readEngine = () => ({ version: calls ? '99.1' : engine });
    if (kind === 'gate') rt.gate = () => { if (calls) throw Error('Live lock is held'); };
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: rt }), /changed|lock/);
    assert.equal(calls, 1); assert.ok(existsSync(join(out, 'failure.json')));
  }
});

test('bad exit and signal cannot be rescued by otherwise safe artifacts', async t => {
  for (const exit of [{ code: 2, signal: null }, { code: null, signal: 'SIGINT' }]) {
    const out = sandbox(t), p = plan(out); let calls = 0;
    await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p, {
      run: async () => { calls++; return exit; },
    }) }), /exit|signal/);
    assert.equal(calls, 1);
  }
});

test('production gate checks hold, lock and local pause without manipulating them', () => {
  for (const [path, message] of [['/tmp/sleight-hold', /hold/], ['/tmp/sleight-live.lock', /lock/], ['/output/pause', /pause/]])
    assert.throws(() => productionGate('/output', candidate => candidate === path), message);
  productionGate('/output', () => false);
});

const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function browserFixture(t, side = 'docs0') {
  const out = sandbox(t), p = plan(out), round = p.rounds.find(r => r.runner === 'browser' && r.side === side);
  const stem = join(out, round.id), group = p.groups.find(g => g.id === round.group);
  put(join(stem, 'cleanup.json'), { browserClosed: true });
  put(join(stem, 'engine.json'), { version: engine, changed: false });
  put(join(stem, 'commits.json'), { build: { commit: build, dirty: 0 }, harness: { commit: build, dirty: 0 }, fowlbrowser: { commit: p.upstream } });
  const rows = round.tasks.map(task => ({ task: { name: task, browser: round.browser, prompt: group.taskPins[task].prompt },
    run: { groupClean: true, result: { modelUsage: { [p.model]: {} }, duration_api_ms: 200, num_turns: 4 } },
    outcome: { ok: true }, wallMs: 7000 }));
  put(join(stem, 'results.json'), rows);
  for (const task of round.tasks) put(join(stem, task, 'mcp.json'), { mcpServers: {
    'plugin:sleight:computer': { env: { SLEIGHT_TURBO: '0', ...(side === 'docs0' ? { SLEIGHT_WORKFLOW_DOCS: '0' } : {}) } },
  } });
  return { p, round, stem, rows };
}

test('production collector accepts both browser modes using actual artifact schemas', t => {
  for (const side of ['docs0', 'default']) {
    const { p, round } = browserFixture(t, side);
    const result = collectWorkflow(round, p);
    assert.equal(result.safe, true); assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].apiMs, 200);
  }
});

test('browser collection rejects missing cleanup, wrong model, engine, build, flag and prompt', t => {
  for (const kind of ['cleanup', 'model', 'engine', 'build', 'flag', 'prompt', 'permission', 'harness']) {
    const { p, round, stem, rows } = browserFixture(t);
    if (kind === 'cleanup') rmSync(join(stem, 'cleanup.json'));
    if (kind === 'model') { rows[0].run.result.modelUsage = { other: {} }; put(join(stem, 'results.json'), rows); }
    if (kind === 'engine') put(join(stem, 'engine.json'), { version: engine, changed: true });
    if (kind === 'build') put(join(stem, 'commits.json'), { build: { commit: 'd'.repeat(40) } });
    if (kind === 'flag') put(join(stem, round.tasks[0], 'mcp.json'), { mcpServers: {} });
    if (kind === 'prompt') { rows[0].task.prompt += ' changed'; put(join(stem, 'results.json'), rows); }
    if (kind === 'permission') { rows[0].run.permissionRefusal = true; put(join(stem, 'results.json'), rows); }
    if (kind === 'harness') put(join(stem, 'harness-failure.json'), { reason: 'stop' });
    assert.throws(() => collectWorkflow(round, p), undefined, kind);
  }
});

function nativeFixture(t) {
  const out = sandbox(t), p = plan(out), round = p.rounds.find(r => r.runner === 'native');
  const source = join(out, 'source.json'), log = join(out, 'round.log');
  const raw = { sleight: { commit: build, dirty: 0 }, engine: { version: engine, changed: false },
    model: p.model, effort: 'high', ownerAway: true, leftWindows: [], hygiene: { errors: [], trackingErrors: [] },
    results: [{ task: round.tasks[0], arm: 'sleight', models: [p.model], groupClean: true, passed: false, seconds: 8,
      timing: { modelMs: 6000, toolWallMs: 1500, engineMs: 1200 } }] };
  put(source, raw); writeFileSync(log, `results: ${source}\n`);
  return { p, round, source, log, raw };
}

test('native collector preserves failed tasks and copies the production result without requiring an absent prompt', t => {
  const { p, round, source, log } = nativeFixture(t);
  const result = collectWorkflow(round, p, log);
  assert.equal(result.rows[0].passed, false); assert.equal(result.safe, true);
  assert.equal(result.rows[0].apiMs, 6000); assert.equal(result.rows[0].toolMs, 1500);
  assert.equal(readFileSync(join(p.out, `${round.id}.json`), 'utf8'), readFileSync(source, 'utf8'));
});

test('native collection refuses unsafe cleanup, wrong effort, model, dirty build and unexpected prompt', t => {
  for (const kind of ['cleanup', 'effort', 'model', 'dirty', 'prompt', 'permission']) {
    const { p, round, source, log, raw } = nativeFixture(t);
    if (kind === 'cleanup') raw.leftWindows.push({ id: 1 });
    if (kind === 'effort') raw.effort = 'low';
    if (kind === 'model') raw.results[0].models = ['other'];
    if (kind === 'dirty') raw.sleight.dirty = 1;
    if (kind === 'prompt') raw.results[0].prompt = 'changed';
    if (kind === 'permission') raw.results[0].permissionPrompt = true;
    put(source, raw);
    assert.throws(() => collectWorkflow(round, p, log), undefined, kind);
  }
});

test('CC prompt normalization accepts only the fixture URL substitution', t => {
  const { p, round, source, log, raw } = nativeFixture(t);
  raw.results[0].prompt = p.groups.find(g => g.id === round.group).taskPins[round.tasks[0]].prompt
    .replace('{url}', 'http://127.0.0.1:8123/held-out/dropdown-slow/test_nonce/');
  put(source, raw);
  assert.equal(collectWorkflow(round, p, log).safe, true);
});

test('CLI dry plan is offline before reset and does not create output', t => {
  const out = sandbox(t), script = new URL('../bench/validation/workflow-docs-ab.mjs', import.meta.url);
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = spawnSync(process.execPath, [script.pathname, '--plan', '--build', head, '--engine', engine, '--out', out],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rounds.length, 30);
  assert.equal(existsSync(out), false);
});

test('malformed pins and altered study plans refuse', async t => {
  for (const [badBuild, badEngine] of [['HEAD', engine], [build, 'unknown']])
    assert.throws(() => makeWorkflowPlan({ build: badBuild, engine: badEngine, pins }), /requires/);
  const out = sandbox(t), p = plan(out);
  p.rounds[0].tasks = ['invented-task'];
  await assert.rejects(runWorkflow(p, { ownerAway: true, runtime: runtime(p) }), /plan changed/);
  assert.equal(existsSync(out), false);
});
