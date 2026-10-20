// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan, executePass, scrubText } from '../bench/release-pass.mjs';

const ready = () => ({ liveLock: false, hold: false, ownerAway: true, apiReady: true,
  loginReady: true, extensionsReady: true, productionTurboReady: true });
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'release-pass-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
};
const native = (id = 'native') => ({ id, runner: 'native', args: ['--suite', id === 'claim' ? 'world' : 'default',
  '--arm', 'sleight', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--owner-away'],
  artifacts: ['raw'], expectedModels: ['claude-haiku-5-5'] });
const opus = args => ({ id: 'opus', runner: 'fowl', args: ['--world', '--model', 'opus', '--effort', 'high',
  '--out', `${MAC_TMP}/fb-rounds/review-only`, ...args], artifacts: ['raw'], expectedModels: ['claude-opus-5-5'] });

test('every published name, issue, log and content scrubs the same owner aliases', async t => {
  const root = fixture(t), bank = 'Jane-Owner-bank';
  const aliases = ['Jane-Owner', 'JANE_OWNER', 'janeowner_x', 'jane.owner', '-Users-jane-owner-', 'Jane...Owner42', 'JANE._-OWNER'];
  const text = aliases.join('\n');
  const stage = { ...native(), artifacts: [bank] };
  const result = await executePass(createPlan({ root, stages: [stage], conditions: ready() }), {
    root, home: `${MAC_USERS}jane.owner`, names: ['Jane Owner', 'jane.owner'], date: '2026-10-14', conditions: ready,
    run: async () => {
      mkdirSync(join(root, bank));
      writeFileSync(join(root, bank, 'jane.owner_bad.json'), '{broken ' + text);
      writeFileSync(join(root, bank, 'JANE_OWNER.bin'), Buffer.from([0]));
      writeFileSync(join(root, bank, 'Jane-Owner.log'), text);
      return { code: 1, stdout: text, stderr: text };
    } });
  for (const path of readdirSync(result.out, { recursive: true })) {
    assert.doesNotMatch(path, /jane[._ -]*owner/iu);
    if (path.endsWith('.json') || path.endsWith('.md') || path.endsWith('.log'))
      assert.doesNotMatch(readFileSync(join(result.out, path), 'utf8'), /jane[._ -]*owner/iu, path);
  }
  const manifest = JSON.parse(readFileSync(join(result.out, 'manifest.json'), 'utf8'));
  const malformed = manifest.stages[0].files.find(path => path.endsWith('_bad.json'));
  assert.ok(malformed);
  assert.ok(manifest.stages[0].issues.some(issue => issue.endsWith(malformed)), 'retained-file issues use the actual mapped destination');
  assert.equal(readFileSync(join(root, bank, 'Jane-Owner.log'), 'utf8'), text);
  assert.doesNotMatch(scrubText(text, `${MAC_USERS}jane.owner`, ['Jane Owner', 'jane.owner']), /jane[._ -]*owner/iu);
  assert.equal(scrubText('ownerless', `${MAC_USERS}jane.owner`, ['Owner']), 'ownerless');
});

test('an owner called User cannot change an existing placeholder or its mapped issue path', async t => {
  const once = scrubText('USER_User2', `${MAC_USERS}User`, ['User']);
  assert.equal(scrubText(once, `${MAC_USERS}User`, ['User']), once);
  const root = fixture(t);
  const result = await executePass(createPlan({ root, stages: [native()], conditions: ready() }), {
    root, home: `${MAC_USERS}User`, names: ['User'], date: '2026-10-14', conditions: ready, run: async () => {
      mkdirSync(join(root, 'raw')); writeFileSync(join(root, 'raw', 'User_bad.json'), '{broken');
      return { code: 1 };
    } });
  const manifest = JSON.parse(readFileSync(join(result.out, 'manifest.json'), 'utf8'));
  assert.ok(manifest.stages[0].issues.some(issue => issue.endsWith(manifest.stages[0].files[0])));
});

for (const mode of ['task override', 'selected surface', 'duplicate tasks', 'duplicate surface']) test(`Opus refuses API-only funding before a runner: ${mode}`, async t => {
  const root = fixture(t), tasks = join(root, 'tasks.json'), safe = join(root, 'safe.json');
  writeFileSync(tasks, JSON.stringify([{ surface: 'browser-use' }]));
  writeFileSync(safe, JSON.stringify([{ surface: 'fowlbrowser' }]));
  const args = mode === 'selected surface' ? ['--surface', 'browser-use'] : mode === 'duplicate surface'
    ? ['--surface', 'fowlbrowser', '--surface', 'browser-use'] : mode === 'duplicate tasks'
    ? ['--tasks', safe, '--tasks', tasks] : ['--surface', 'fowlbrowser', '--tasks', tasks];
  let calls = 0;
  const result = await executePass(createPlan({ root, stages: [opus(args)], conditions: ready() }), {
    root, names: ['Owner'], date: '2026-10-14', conditions: ready, run: async () => { calls++; return { code: 0 }; } });
  assert.equal(calls, 0); assert.equal(result.stages[0].status, 'blocked');
  assert.match(result.stages[0].issues.join(), /Opus.*account/i);
});

test('Opus funding follows effective task surfaces rather than an overridden API-only default', async t => {
  const root = fixture(t), tasks = join(root, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ surface: 'fowlbrowser' }]));
  let calls = 0;
  await executePass(createPlan({ root, stages: [opus(['--surface', 'browser-use', '--tasks', tasks])], conditions: ready() }), {
    root, names: ['Owner'], date: '2026-10-14', conditions: ready, run: async () => { calls++; return { code: 1 }; } });
  assert.equal(calls, 1);
});

for (const surface of [['browser-use'], 'fowlbrowser\nbrowser-use']) test('malformed Opus task surfaces cannot hide API funding: ' + JSON.stringify(surface), async t => {
  const root = fixture(t), tasks = join(root, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ surface }]));
  let calls = 0;
  const result = await executePass(createPlan({ root, stages: [opus(['--tasks', tasks])], conditions: ready() }), {
    root, names: ['Owner'], date: '2026-10-14', conditions: ready, run: async () => { calls++; return { code: 0 }; } });
  assert.equal(calls, 0); assert.equal(result.stages[0].status, 'blocked');
});

for (const code of [130, 143]) test(`numeric child exit ${code} stops later stages while preserving failure evidence`, async t => {
  const root = fixture(t); let calls = 0;
  const result = await executePass(createPlan({ root, stages: [native(), native('claim')], conditions: ready() }), {
    root, names: ['Owner'], date: '2026-10-14', conditions: ready,
    run: async () => { calls++; return { code, stderr: 'synthetic interrupt' }; } });
  assert.equal(calls, 1); assert.equal(result.stages[0].code, code);
  assert.equal(result.stages[0].status, 'failed'); assert.equal(result.stages[1].status, 'blocked');
  assert.match(result.stages[1].issues.join(), /interrupted/);
  assert.equal(readFileSync(join(result.out, 'native/stderr.log'), 'utf8'), 'synthetic interrupt');
});
