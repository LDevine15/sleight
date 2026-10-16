import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPlan, executePass, inspectConditions } from '../bench/release-pass.mjs';

for (const ledger of [{}, { usd: 199 }, { month: 'not-a-month', usd: 199 }]) test('missing or invalid spend month refuses API admission: ' + JSON.stringify(ledger), t => {
  const root = mkdtempSync(join(tmpdir(), 'rp2-spend-repro-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, 'key'), ledgerFile = join(root, 'spend.json');
  writeFileSync(keyFile, 'sk-ant-fake-test-key', { mode: 0o600 });
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  const result = inspectConditions({ keyFile, ledgerFile, now: new Date('2026-10-14T12:00:00Z') });
  assert.equal(result.apiReady, false, JSON.stringify({ ledger, apiReady: result.apiReady }));
});

test('published file paths scrub owner names and match the manifest', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rp2-name-repro-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = { id: 'native', runner: 'native', args: ['--suite', 'default', '--arm', 'sleight', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--owner-away'], artifacts: ['raw'], expectedModels: ['claude-haiku-5-5'] };
  const conditions = () => ({ liveLock: false, hold: false, ownerAway: true, apiReady: true, loginReady: true, extensionsReady: true, productionTurboReady: true });
  const result = await executePass(createPlan({ root, stages: [stage], conditions: conditions() }), {
    root, names: ['Jane Owner', 'janeowner'], home: '/Users/janeowner', date: '2026-10-14', conditions,
    run: async () => {
      mkdirSync(join(root, 'raw', '-Users-janeowner-Projects-fixture'), { recursive: true });
      writeFileSync(join(root, 'raw', 'Jane Owner.log'), 'Jane Owner at /Users/janeowner');
      writeFileSync(join(root, 'raw', '-Users-janeowner-Projects-fixture', 'session.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5' } }) + '\n');
      writeFileSync(join(root, 'raw', 'results.json'), JSON.stringify({ results: [{ passed: true }] }));
      return { code: 0 };
    }
  });
  const paths = readdirSync(result.out, { recursive: true });
  const published = JSON.parse(readFileSync(join(result.out, 'manifest.json'), 'utf8'));
  const missingManifestPaths = published.stages[0].files.filter(p => !existsSync(join(result.out, p)));
  assert.equal(paths.some(p => /Jane Owner|janeowner/i.test(p)), false, JSON.stringify({ paths, missingManifestPaths }));
  assert.deepEqual(missingManifestPaths, []);
});

test('spend rollover accepts only valid prior records and refuses unknown accounting before a runner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rp2-spend-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, 'key'), ledgerFile = join(root, 'spend.json');
  writeFileSync(keyFile, 'sk-ant-fake-test-key', { mode: 0o600 });
  const now = new Date('2026-10-14T12:00:00Z');
  for (const ledger of [null, [], { month: null, usd: 0 }, { month: '2026-00', usd: 0 },
    { month: ['2026-10'], usd: 199 },
    { month: '2026-13', usd: 0 }, { month: '2026-11', usd: 0 },
    { month: '2026-09' }, { month: '2026-09', usd: '199' }, { month: '2026-09', usd: -1 },
    { month: '2026-09', usd: null }, { month: '2026-09', usd: 12, unpriced: true },
    { month: '2026-10', usd: 190 }]) {
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    assert.equal(inspectConditions({ keyFile, ledgerFile, now }).apiReady, false, JSON.stringify(ledger));
  }
  for (const ledger of [{ month: '2026-09', usd: 199 }, { month: '2026-10', usd: 189.99 }]) {
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    assert.equal(inspectConditions({ keyFile, ledgerFile, now }).apiReady, true);
    assert.deepEqual(JSON.parse(readFileSync(ledgerFile)), ledger, 'admission never rewrites the ledger');
  }
  writeFileSync(ledgerFile, '{}');
  const stage = { id: 'native', runner: 'native', args: ['--suite', 'default', '--arm', 'sleight', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--owner-away'], artifacts: ['raw'], expectedModels: ['claude-haiku-5-5'] };
  // Claude stages run on the account login (LAWS, 2026-10-15): an unverified login blocks before a runner, whatever the spend ledger says.
  const conditions = () => ({ liveLock: false, hold: false, ownerAway: true,
    apiReady: inspectConditions({ keyFile, ledgerFile, now }).apiReady, loginReady: false });
  let dispatched = 0;
  const result = await executePass(createPlan({ root, stages: [stage], conditions: conditions() }), {
    root, names: ['Owner'], date: '2026-10-14', conditions, run: async () => { dispatched++; return { code: 0 }; } });
  assert.equal(dispatched, 0); assert.equal(result.stages[0].status, 'blocked');
});

test('scrubbed roots, slug directories and colliding names preserve every artifact and source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rp2-path-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = join(root, 'Jane Owner-bank'), sources = new Map();
  const paths = ['Jane Owner.log', 'janeowner.log', '<user>.log', 'JANE-OWNER.log', 'janeowner-2.log',
    'Jane Owner.txt', 'janeowner.txt/session.log',
    'Jane Owner/same.log', 'janeowner/same.log', '-Users-janeowner-Projects-fixture/session.log',
    'JÓSE_NÚÑEZ.log', 'Jóse Núñez'.normalize('NFD') + '/same.log'];
  const stage = { id: 'native', runner: 'native', args: ['--suite', 'default', '--arm', 'sleight', '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--owner-away'], artifacts: [raw], expectedModels: ['claude-haiku-5-5'] };
  const conditions = () => ({ liveLock: false, hold: false, ownerAway: true, apiReady: true, loginReady: true });
  const result = await executePass(createPlan({ root, stages: [stage], conditions: conditions() }), {
    root, names: ['Jane Owner', 'janeowner', 'Jóse Núñez'], home: '/Users/janeowner', date: '2026-10-14', conditions,
    run: async () => {
      for (const [i, path] of paths.entries()) {
        const file = join(raw, path); mkdirSync(join(file, '..'), { recursive: true });
        sources.set(file, 'evidence-' + i); writeFileSync(file, sources.get(file));
      }
      sources.set(join(raw, 'events.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5' } }) + '\n');
      sources.set(join(raw, 'results.json'), JSON.stringify({ results: [{ passed: true }] }));
      for (const [file, text] of sources) writeFileSync(file, text);
      return { code: 0 };
    } });
  assert.equal(result.exitCode, 0);
  const manifest = JSON.parse(readFileSync(join(result.out, 'manifest.json'), 'utf8'));
  const files = manifest.stages[0].files;
  assert.deepEqual(files, result.stages[0].files);
  assert.equal(files.length, sources.size); assert.equal(new Set(files).size, sources.size);
  const contents = files.map(path => {
    assert.ok(!relative(result.out, join(result.out, path)).startsWith('..'));
    assert.ok(existsSync(join(result.out, path)), path);
    return readFileSync(join(result.out, path), 'utf8');
  });
  assert.deepEqual(contents.sort(), [...sources.values()].sort());
  assert.doesNotMatch(readdirSync(result.out, { recursive: true }).join('\n').normalize('NFC'), /Jane[ _-]Owner|janeowner|Jóse[ _-]Núñez/iu);
  for (const [file, text] of sources) assert.equal(readFileSync(file, 'utf8'), text);
});
