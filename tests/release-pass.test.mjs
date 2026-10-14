import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan, executePass, inspectConditions, scrubText, verifyModels } from '../bench/release-pass.mjs';

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'release-pass-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const ready = () => ({ liveLock: false, hold: false, ownerAway: true, apiReady: true, loginReady: true,
  extensionsReady: true, productionTurboReady: true });
const stage = (id = 'native') => ({ id, runner: 'native', args: ['--suite', id === 'claim' ? 'world' : 'default',
  '--arm', 'sleight', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'api', '--owner-away'],
  artifacts: ['raw'], expectedModels: ['claude-haiku-5-5'] });
const events = model => JSON.stringify({ type: 'assistant', message: { model } }) + '\n';

test('plan lists all release stages without writing or executing', t => {
  const root = fixture(t);
  const before = readdirSync(root);
  const plan = createPlan({ root, conditions: ready() });
  assert.deepEqual(plan.stages.map(s => s.id), ['native', 'gate-normal', 'gate-swap', 'opus', 'claim']);
  assert.deepEqual(readdirSync(root), before);
  assert.equal(plan.stages.find(s => s.id === 'gate-normal').ready, false);
  assert.match(JSON.stringify(plan), /exact runner arguments/);
});

test('fake runners publish failures and all text evidence and verify event models', async t => {
  const root = fixture(t);
  const plan = createPlan({ root, stages: [stage(), stage('claim')], conditions: ready() });
  let calls = 0;
  const result = await executePass(plan, { root, date: '2026-10-14', home: '/Users/Owner', names: ['Jane Owner', 'owner'],
    conditions: ready, run: async () => {
      calls += 1;
      mkdirSync(join(root, 'raw'), { recursive: true });
      writeFileSync(join(root, 'raw', 'results.json'), JSON.stringify({ results: [{ passed: false, reason: '/Users/Owner JANE OWNER' }] }));
      writeFileSync(join(root, 'raw', 'events.jsonl'), events('claude-haiku-5-5'));
      writeFileSync(join(root, 'raw', 'failure.log'), 'Jane Owner at /Users/Owner');
      return { code: 1, stdout: 'OWNER failed', stderr: '/Users/Owner' };
    } });
  assert.equal(calls, 2);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stages[0].models.verified, true);
  const out = join(root, 'docs/benchmarks/2026-10-14-release-pass');
  assert.match(readFileSync(join(out, 'summary.md'), 'utf8'), /native.*failed/);
  assert.match(readFileSync(join(out, 'native/raw/results.json'), 'utf8'), /~ <user>/);
  assert.doesNotMatch(readFileSync(join(out, 'native/raw/failure.log'), 'utf8'), /Jane|Owner/);
});

for (const key of ['liveLock', 'hold', 'ownerAway', 'apiReady']) test(`precondition ${key} blocks before runner`, async t => {
  const root = fixture(t);
  const conditions = { ...ready(), [key]: ['liveLock', 'hold'].includes(key) };
  const plan = createPlan({ root, stages: [stage()], conditions });
  assert.equal(plan.stages[0].ready, false);
  const result = await executePass(plan, { root, date: '2026-10-14', names: ['Owner'], conditions: () => conditions,
    run: () => { throw new Error('must not run'); } });
  assert.equal(result.stages[0].status, 'blocked');
});

test('preconditions are refreshed before every stage and cleanup lock stops later stages', async t => {
  const root = fixture(t);
  let calls = 0;
  const result = await executePass(createPlan({ root, stages: [stage(), stage('claim')], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: () => ({ ...ready(), liveLock: calls > 0 }),
    run: async () => { calls += 1; return { code: 1 }; } });
  assert.equal(calls, 1);
  assert.equal(result.stages[1].status, 'blocked');
});

test('model verification never trusts requested models or missing events', () => {
  assert.equal(verifyModels([], ['claude-haiku-5-5']).verified, false);
  assert.equal(verifyModels([events('claude-haiku-4-5')], ['claude-haiku-5-5']).verified, false);
  assert.equal(verifyModels([events('claude-haiku-5-5')], ['claude-haiku-5-5']).verified, true);
  assert.equal(verifyModels(['broken json'], ['claude-haiku-5-5']).verified, false);
});

test('scrubbing is Unicode aware and case insensitive with word boundaries', () => {
  assert.equal(scrubText('/Users/Owner JANE OWNER jane owner OWNER ownerless', '/Users/Owner', ['Jane Owner', 'Owner']),
    '~ <user> <user> <user> ownerless');
});

test('refuses output collisions', async t => {
  const root = fixture(t);
  mkdirSync(join(root, 'docs/benchmarks/2026-10-14-release-pass'), { recursive: true });
  await assert.rejects(executePass(createPlan({ root, stages: [stage()], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: ready, run: () => { throw new Error('must not run'); } }), /exists/);
});

test('artifact symlinks block before the runner and external files are not published', async t => {
  const root = fixture(t);
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'private.txt'), 'do not collect');
  symlinkSync(join(root, 'outside'), join(root, 'raw'));
  const result = await executePass(createPlan({ root, stages: [stage()], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: ready, run: () => { throw new Error('must not run'); } });
  assert.equal(result.stages[0].status, 'blocked');
  assert.match(result.stages[0].issues.join(), /symlink/);
  assert.deepEqual(result.stages[0].files, []);
});

test('missing or unexpected event models preserve evidence but cannot qualify a successful runner', async t => {
  const root = fixture(t);
  const result = await executePass(createPlan({ root, stages: [stage()], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: ready, run: async () => {
      mkdirSync(join(root, 'raw'));
      writeFileSync(join(root, 'raw', 'results.json'), JSON.stringify({ model: 'claude-haiku-5-5', results: [{ passed: true }] }));
      writeFileSync(join(root, 'raw', 'events.jsonl'), events('claude-haiku-4-5'));
      return { code: 0 };
    } });
  assert.equal(result.stages[0].status, 'unqualified');
  assert.equal(result.stages[0].passed, 1);
  assert.equal(result.stages[0].files.length, 2);
});

test('API admission refuses malformed and unresolved spend without creating a config', t => {
  const root = fixture(t);
  const keyFile = join(root, 'key');
  const ledgerFile = join(root, 'spend.json');
  writeFileSync(keyFile, 'sk-ant-fake-test-key', { mode: 0o600 });
  const now = new Date('2026-10-14T12:00:00Z');
  writeFileSync(ledgerFile, JSON.stringify({ month: '2026-10', usd: 12 }));
  assert.equal(inspectConditions({ keyFile, ledgerFile, now }).apiReady, true);
  for (const ledger of [{ month: '2026-10', usd: 190 }, { month: '2026-09', usd: 12, unpriced: true }, { month: '2026-10', usd: 'oops' }]) {
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    assert.equal(inspectConditions({ keyFile, ledgerFile, now }).apiReady, false);
  }
  assert.equal(inspectConditions({ keyFile, ledgerFile, now, ownerAway: true,
    receipt: { expiresAt: '2026-10-14T11:00:00Z', ownerAway: true, loginVerified: true } }).ownerAway, false);
  assert.deepEqual(readdirSync(root).sort(), ['key', 'spend.json']);
});

test('stage arguments enforce model, effort, funding and order', () => {
  for (const args of [stage().args.map(a => a === 'claude-haiku-5-5' ? 'haiku' : a),
    stage().args.map(a => a === 'high' ? 'low' : a), [...stage().args, '--dry-run'],
    stage().args.map(a => a === 'api' ? 'login' : a)]) {
    assert.throws(() => createPlan({ stages: [{ ...stage(), args }], conditions: ready() }));
  }
});

test('runner exception still publishes a failed stage', async t => {
  const root = fixture(t);
  const result = await executePass(createPlan({ root, stages: [stage()], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: ready, run: async () => { throw new Error('fake launch failed'); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stages[0].status, 'failed');
});

const gate = (id = 'gate-normal', model = 'claude-haiku-5-5') => ({ id, runner: 'fowl',
  args: ['--world', '--model', model, '--effort', model.includes('opus') ? 'medium' : 'high', '--surface', 'sleight', '--out', '/private/tmp/fb-rounds/fake',
    ...(id === 'gate-swap' ? ['--swap'] : [])], artifacts: ['raw'], expectedModels: [model] });
for (const key of ['extensionsReady', 'productionTurboReady']) test(`turbo gate requires ${key}`, () => {
  assert.equal(createPlan({ stages: [gate()], conditions: { ...ready(), [key]: false } }).stages[0].ready, false);
});
test('Opus requires isolated login and both gate orders use exact argument vectors', () => {
  assert.equal(createPlan({ stages: [gate('opus', 'claude-opus-5-5')], conditions: { ...ready(), loginReady: false } }).stages[0].ready, false);
  const plan = createPlan({ stages: [gate(), gate('gate-swap')], conditions: ready() });
  assert.equal(plan.stages[1].ready, true);
  assert.deepEqual(plan.stages[1].commandArgs, ['bench/fowl/rounds.sh', ...gate('gate-swap').args]);
  assert.throws(() => createPlan({ stages: [{ ...gate(), args: gate().args.filter(a => a !== '--world') }], conditions: ready() }), /isolated/);
});

test('a malformed result still preserves the remaining failure evidence', async t => {
  const root = fixture(t);
  const result = await executePass(createPlan({ root, stages: [stage()], conditions: ready() }), {
    root, date: '2026-10-14', names: ['Owner'], conditions: ready, run: async () => {
      mkdirSync(join(root, 'raw'));
      writeFileSync(join(root, 'raw', 'a.json'), '{broken');
      writeFileSync(join(root, 'raw', 'z.log'), 'remaining failure evidence');
      return { code: 1 };
    } });
  assert.equal(result.stages[0].files.length, 2);
});
